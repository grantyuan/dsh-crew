/**
 * SQLite persistence for the derived context index.
 *
 * Writes are idempotent per `(member, session, seq)`: an unchanged unit is a
 * no-op, and a changed unit replaces its terms, facets and FTS rows inside one
 * transaction. The outbox is the only asynchronous edge — it records that a
 * unit is worth a model enrichment pass without ever blocking the write.
 * @module @grantyuan/dsh-crew/context/store
 */

import type { DatabaseSync } from 'node:sqlite'
import { openContextDatabase, type ContextFtsCapabilities } from './schema.ts'
import type {
  ContextFacet,
  ContextImportance,
  ContextKeyword,
  ContextOutboxRow,
  ContextTermKind,
  ContextTermSource,
  ContextTimeGranularity,
  ContextUnitKind,
  ContextUnitRecord,
  ContextUnitRole,
  ContextUnitWriteResult,
  ContextFacetDimension,
  ContextFacetSource,
} from './types.ts'

type Statement = ReturnType<DatabaseSync['prepare']>

export interface ContextStoreOptions {
  readonly path: string
  /** Exercise the `LIKE` fallback path in tests. */
  readonly disableFts?: boolean
}

export interface WriteContextUnitOptions {
  /** Queue an asynchronous enrichment pass when the unit is worth one. */
  readonly enqueueEnrichment?: boolean
}

export interface ContextStoreCapabilities extends ContextFtsCapabilities {
  readonly schemaVersion: number
}

export interface StoredContextUnit {
  readonly unitId: string
  readonly memberId: string
  readonly sessionId: string
  readonly seq: number
  readonly role: ContextUnitRole
  readonly kind: ContextUnitKind
  readonly importance: ContextImportance
  readonly text: string
  readonly textHash: string
  readonly chars: number
  readonly recordedAt: string
  readonly createdAt: string
  readonly timezone?: string
  readonly eventType?: string
  readonly toolName?: string
}

export interface ContextModelExtras {
  readonly keywords: readonly ContextKeyword[]
  readonly facets: readonly ContextFacet[]
}

export interface FailOutboxOptions {
  readonly now?: number
  readonly backoffMs?: number
  readonly maxAttempts?: number
}

interface UnitRow {
  readonly unit_id: string
  readonly member_id: string
  readonly session_id: string
  readonly seq: number
  readonly role: string
  readonly kind: string
  readonly importance: number
  readonly text: string
  readonly text_hash: string
  readonly chars: number
  readonly recorded_at: string
  readonly timezone: string | null
  readonly event_type: string | null
  readonly tool_name: string | null
  readonly created_at: string
}

interface TermRow {
  readonly term: string
  readonly term_kind: string
  readonly weight: number
  readonly source: string
}

interface FacetRow {
  readonly dimension: string
  readonly value: string
  readonly raw: string | null
  readonly start_ms: number | null
  readonly end_ms: number | null
  readonly granularity: string | null
  readonly tz: string | null
  readonly confidence: number
  readonly source: string
}

interface OutboxRow {
  readonly id: number
  readonly member_id: string
  readonly session_id: string
  readonly unit_id: string
  readonly kind: string
  readonly payload: string
  readonly attempts: number
}

export class ContextStore {
  private readonly database: DatabaseSync
  private readonly statements = new Map<string, Statement>()
  readonly capabilities: ContextStoreCapabilities

  constructor(options: ContextStoreOptions) {
    const opened = openContextDatabase(options.path, options.disableFts === true ? { disableFts: true } : {})
    this.database = opened.db
    this.capabilities = { ...opened.fts, schemaVersion: 1 }
  }

  close(): void {
    this.database.close()
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.database.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // A failed rollback must not mask the original write error.
      }
      throw error
    }
  }

  /** Insert or replace one unit and everything derived from it. */
  writeUnit(record: ContextUnitRecord, options: WriteContextUnitOptions = {}): ContextUnitWriteResult {
    const existing = this.statement('SELECT * FROM unit WHERE member_id = ? AND session_id = ? AND seq = ?')
      .get(record.memberId, record.sessionId, record.seq) as UnitRow | undefined

    if (existing !== undefined && existing.text_hash === record.textHash) {
      return { unitId: record.unitId, inserted: false, changed: false, enrichQueued: false }
    }

    const enqueue = options.enqueueEnrichment === true

    this.transaction(() => {
      if (existing === undefined) {
        this.statement(`INSERT INTO unit (
          unit_id, member_id, session_id, seq, role, kind, importance, text, text_hash, chars,
          recorded_at, timezone, event_type, tool_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.unitId,
          record.memberId,
          record.sessionId,
          record.seq,
          record.role,
          record.kind,
          record.importance,
          record.text,
          record.textHash,
          record.chars,
          record.recordedAt,
          record.timezone ?? null,
          record.eventType ?? null,
          record.toolName ?? null,
          record.createdAt,
        )
      } else {
        this.statement(`UPDATE unit SET
          unit_id = ?, role = ?, kind = ?, importance = ?, text = ?, text_hash = ?, chars = ?,
          recorded_at = ?, timezone = ?, event_type = ?, tool_name = ?, created_at = ?
          WHERE member_id = ? AND session_id = ? AND seq = ?`).run(
          record.unitId,
          record.role,
          record.kind,
          record.importance,
          record.text,
          record.textHash,
          record.chars,
          record.recordedAt,
          record.timezone ?? null,
          record.eventType ?? null,
          record.toolName ?? null,
          record.createdAt,
          record.memberId,
          record.sessionId,
          record.seq,
        )
        this.deleteDerived(record.unitId)
      }

      this.insertDerived(record)
      this.statement("DELETE FROM outbox WHERE unit_id = ? AND kind = 'enrich'").run(record.unitId)
      if (enqueue) this.insertOutbox(record)
    })

    const inserted = existing === undefined
    return { unitId: record.unitId, inserted, changed: !inserted, enrichQueued: enqueue }
  }

  private deleteDerived(unitId: string): void {
    this.statement("DELETE FROM term WHERE owner_kind = 'unit' AND owner_id = ?").run(unitId)
    this.statement("DELETE FROM facet WHERE owner_kind = 'unit' AND owner_id = ?").run(unitId)
    if (this.capabilities.word) this.statement('DELETE FROM unit_fts WHERE unit_id = ?').run(unitId)
    if (this.capabilities.trigram) this.statement('DELETE FROM unit_fts_trigram WHERE unit_id = ?').run(unitId)
  }

  private insertDerived(record: ContextUnitRecord): void {
    const insertTerm = this.statement(
      "INSERT OR IGNORE INTO term (owner_kind, owner_id, term, term_kind, weight, source) VALUES ('unit', ?, ?, ?, ?, ?)",
    )
    for (const keyword of record.keywords) {
      insertTerm.run(record.unitId, keyword.term, keyword.kind, keyword.weight, keyword.source)
    }

    const insertFacet = this.statement(`INSERT OR IGNORE INTO facet (
      owner_kind, owner_id, dimension, value, raw, start_ms, end_ms, granularity, tz, confidence, source
    ) VALUES ('unit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const facet of record.facets) {
      insertFacet.run(
        record.unitId,
        facet.dimension,
        facet.value,
        facet.raw ?? null,
        facet.startMs ?? null,
        facet.endMs ?? null,
        facet.granularity ?? null,
        facet.tz ?? null,
        facet.confidence,
        facet.source,
      )
    }

    if (this.capabilities.word) {
      this.statement('INSERT INTO unit_fts (unit_id, body) VALUES (?, ?)').run(record.unitId, record.text)
    }
    if (this.capabilities.trigram) {
      this.statement('INSERT INTO unit_fts_trigram (unit_id, body) VALUES (?, ?)').run(record.unitId, record.text)
    }
  }

  private insertOutbox(record: ContextUnitRecord): void {
    const now = Date.now()
    const payload = JSON.stringify({
      ref: record.unitId,
      role: record.role,
      text: record.text,
      keywords: record.keywords.slice(0, 12).map(keyword => keyword.term),
      facets: record.facets.slice(0, 20).map(facet => ({
        dimension: facet.dimension,
        value: facet.value,
        ...(facet.raw === undefined ? {} : { raw: facet.raw }),
      })),
    })
    this.statement(`INSERT INTO outbox (member_id, session_id, unit_id, kind, payload, attempts, available_at, created_at)
      VALUES (?, ?, ?, 'enrich', ?, 0, ?, ?)`).run(
      record.memberId,
      record.sessionId,
      record.unitId,
      payload,
      now,
      record.createdAt,
    )
  }

  /** Read one unit, or `undefined` when the row is absent. */
  getUnit(unitId: string): StoredContextUnit | undefined {
    const row = this.statement('SELECT * FROM unit WHERE unit_id = ?').get(unitId) as UnitRow | undefined
    if (row === undefined) return undefined
    return {
      unitId: row.unit_id,
      memberId: row.member_id,
      sessionId: row.session_id,
      seq: row.seq,
      role: row.role as ContextUnitRole,
      kind: row.kind as ContextUnitKind,
      importance: row.importance as ContextImportance,
      text: row.text,
      textHash: row.text_hash,
      chars: row.chars,
      recordedAt: row.recorded_at,
      createdAt: row.created_at,
      ...(row.timezone === null ? {} : { timezone: row.timezone }),
      ...(row.event_type === null ? {} : { eventType: row.event_type }),
      ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    }
  }

  /** Every keyword attached to one unit. */
  listKeywords(unitId: string): ContextKeyword[] {
    const rows = this.statement(
      "SELECT term, term_kind, weight, source FROM term WHERE owner_kind = 'unit' AND owner_id = ? ORDER BY weight DESC, term",
    ).all(unitId) as unknown as TermRow[]
    return rows.map(row => ({
      term: row.term,
      kind: row.term_kind as ContextTermKind,
      weight: row.weight,
      source: row.source as ContextTermSource,
    }))
  }

  /** Every facet attached to one unit. */
  listFacets(unitId: string): ContextFacet[] {
    const rows = this.statement(
      "SELECT dimension, value, raw, start_ms, end_ms, granularity, tz, confidence, source FROM facet WHERE owner_kind = 'unit' AND owner_id = ? ORDER BY dimension, value",
    ).all(unitId) as unknown as FacetRow[]
    return rows.map(row => ({
      dimension: row.dimension as ContextFacetDimension,
      value: row.value,
      ...(row.raw === null ? {} : { raw: row.raw }),
      ...(row.start_ms === null ? {} : { startMs: row.start_ms }),
      ...(row.end_ms === null ? {} : { endMs: row.end_ms }),
      ...(row.granularity === null ? {} : { granularity: row.granularity as ContextTimeGranularity }),
      ...(row.tz === null ? {} : { tz: row.tz }),
      confidence: row.confidence,
      source: row.source as ContextFacetSource,
    }))
  }

  /**
   * Apply model extras without overwriting any existing rule value.
   * A term already present in any kind blocks a model duplicate; a facet with
   * the same `(dimension, value)` blocks a model duplicate.
   */
  applyEnrichment(unitId: string, extras: ContextModelExtras): { termsAdded: number; facetsAdded: number } {
    const termExists = this.statement(
      "SELECT 1 AS hit FROM term WHERE owner_kind = 'unit' AND owner_id = ? AND term = ? LIMIT 1",
    )
    const facetExists = this.statement(
      "SELECT 1 AS hit FROM facet WHERE owner_kind = 'unit' AND owner_id = ? AND dimension = ? AND value = ? LIMIT 1",
    )
    const dimensionExists = this.statement(
      "SELECT 1 AS hit FROM facet WHERE owner_kind = 'unit' AND owner_id = ? AND dimension = ? LIMIT 1",
    )
    const insertTerm = this.statement(
      "INSERT OR IGNORE INTO term (owner_kind, owner_id, term, term_kind, weight, source) VALUES ('unit', ?, ?, ?, ?, ?)",
    )
    const insertFacet = this.statement(`INSERT OR IGNORE INTO facet (
      owner_kind, owner_id, dimension, value, raw, start_ms, end_ms, granularity, tz, confidence, source
    ) VALUES ('unit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    let termsAdded = 0
    let facetsAdded = 0
    this.transaction(() => {
      for (const keyword of extras.keywords) {
        if (termExists.get(unitId, keyword.term) !== undefined) continue
        insertTerm.run(unitId, keyword.term, keyword.kind, keyword.weight, keyword.source)
        termsAdded += 1
      }
      for (const facet of extras.facets) {
        if (facet.dimension === 'time' && dimensionExists.get(unitId, 'time') !== undefined) continue
        if (facetExists.get(unitId, facet.dimension, facet.value) !== undefined) continue
        insertFacet.run(
          unitId,
          facet.dimension,
          facet.value,
          facet.raw ?? null,
          facet.startMs ?? null,
          facet.endMs ?? null,
          facet.granularity ?? null,
          facet.tz ?? null,
          facet.confidence,
          facet.source,
        )
        facetsAdded += 1
      }
    })
    return { termsAdded, facetsAdded }
  }

  /** Count pending outbox rows, optionally of one kind. */
  pendingOutboxCount(kind?: string): number {
    const row = kind === undefined
      ? this.statement('SELECT COUNT(*) AS count FROM outbox').get()
      : this.statement('SELECT COUNT(*) AS count FROM outbox WHERE kind = ?').get(kind)
    return Number((row as { count: number } | undefined)?.count ?? 0)
  }

  /** Claim up to `limit` enrichment rows that are due. */
  claimEnrichment(limit: number, now = Date.now()): ContextOutboxRow[] {
    const rows = this.statement(`SELECT id, member_id, session_id, unit_id, kind, payload, attempts
      FROM outbox WHERE kind = 'enrich' AND available_at <= ? ORDER BY id ASC LIMIT ?`)
      .all(now, limit) as unknown as OutboxRow[]
    return rows.map(row => ({
      id: row.id,
      memberId: row.member_id,
      sessionId: row.session_id,
      unitId: row.unit_id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
    }))
  }

  /** Remove one completed outbox row. */
  completeOutbox(id: number): void {
    this.statement('DELETE FROM outbox WHERE id = ?').run(id)
  }

  /** Push one row back without counting an attempt (role off, queue full). */
  deferOutbox(id: number, availableAt = Date.now() + 30_000): void {
    this.statement('UPDATE outbox SET available_at = ? WHERE id = ?').run(availableAt, id)
  }

  /** Record a failed attempt; the third failure drops the row. */
  failOutbox(id: number, message: string, options: FailOutboxOptions = {}): { dropped: boolean; attempts: number } {
    const row = this.statement('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number } | undefined
    if (row === undefined) return { dropped: true, attempts: 0 }
    const attempts = row.attempts + 1
    const maxAttempts = options.maxAttempts ?? 3
    if (attempts >= maxAttempts) {
      this.statement('DELETE FROM outbox WHERE id = ?').run(id)
      return { dropped: true, attempts }
    }
    const now = options.now ?? Date.now()
    this.statement('UPDATE outbox SET attempts = ?, available_at = ?, last_error = ? WHERE id = ?')
      .run(attempts, now + (options.backoffMs ?? 30_000), message.slice(0, 300), id)
    return { dropped: false, attempts }
  }

  /** Read the persisted recall cursor/state for one Member Session. */
  getRecallState(memberId: string, sessionId: string, key: string): string | undefined {
    const row = this.statement('SELECT value FROM recall_state WHERE member_id = ? AND session_id = ? AND key = ?')
      .get(memberId, sessionId, key) as { value: string } | undefined
    return row?.value
  }

  /** Persist one recall cursor/state value. */
  setRecallState(memberId: string, sessionId: string, key: string, value: string, now = new Date()): void {
    this.statement(`INSERT INTO recall_state (member_id, session_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(member_id, session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(memberId, sessionId, key, value, now.toISOString())
  }
}
