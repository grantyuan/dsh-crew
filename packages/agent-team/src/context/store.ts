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
import { CONTEXT_SCHEMA_VERSION, openContextDatabase, type ContextFtsCapabilities } from './schema.ts'
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

export interface StoredContextVector {
  readonly unitId: string
  readonly model: string
  readonly dim: number
  readonly values: Float32Array
}

export interface ContextSearchHit {
  readonly unitId: string
  readonly score: number
}

export type ContextFacetQuery =
  | { readonly dimension: 'time'; readonly startMs: number; readonly endMs: number }
  | { readonly dimension: 'space' | 'topic' | 'role' | 'subject'; readonly value: string }

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

interface VectorRow {
  readonly owner_id: string
  readonly model: string
  readonly dim: number
  readonly vector: Uint8Array
}

/** Decode the little-endian float32 blob written by {@link encodeVector}. */
function decodeVector(blob: Uint8Array): Float32Array {
  const values = new Float32Array(Math.floor(blob.byteLength / 4))
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  for (let index = 0; index < values.length; index += 1) values[index] = view.getFloat32(index * 4, true)
  return values
}

/** Encode a vector as a portable little-endian float32 blob. */
function encodeVector(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index] ?? 0, true)
  return bytes
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/gu, character => `\\${character}`)
}

export class ContextStore {
  private readonly database: DatabaseSync
  private readonly statements = new Map<string, Statement>()
  readonly capabilities: ContextStoreCapabilities

  constructor(options: ContextStoreOptions) {
    const opened = openContextDatabase(options.path, options.disableFts === true ? { disableFts: true } : {})
    this.database = opened.db
    this.capabilities = { ...opened.fts, schemaVersion: CONTEXT_SCHEMA_VERSION }
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
    return row === undefined ? undefined : this.toStoredUnit(row)
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

  /** Store or replace one unit vector; model identifies the embedding space. */
  upsertVector(unitId: string, model: string, values: Float32Array, now = new Date()): void {
    this.statement(`INSERT INTO vector (owner_kind, owner_id, model, dim, vector, updated_at)
      VALUES ('unit', ?, ?, ?, ?, ?)
      ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
        model = excluded.model, dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`)
      .run(unitId, model, values.length, encodeVector(values), now.toISOString())
  }

  /** Read one unit vector, if it has been embedded. */
  getVector(unitId: string): StoredContextVector | undefined {
    const row = this.statement("SELECT owner_id, model, dim, vector FROM vector WHERE owner_kind = 'unit' AND owner_id = ?")
      .get(unitId) as VectorRow | undefined
    return row === undefined ? undefined : this.toStoredVector(row)
  }

  /** Every embedded unit for one Member, optionally restricted to one model. */
  listVectors(memberId: string, model?: string): StoredContextVector[] {
    const rows = model === undefined
      ? this.statement(`SELECT v.owner_id, v.model, v.dim, v.vector FROM vector v
          JOIN unit u ON u.unit_id = v.owner_id WHERE v.owner_kind = 'unit' AND u.member_id = ?`).all(memberId)
      : this.statement(`SELECT v.owner_id, v.model, v.dim, v.vector FROM vector v
          JOIN unit u ON u.unit_id = v.owner_id WHERE v.owner_kind = 'unit' AND u.member_id = ? AND v.model = ?`).all(memberId, model)
    return (rows as unknown as VectorRow[]).map(row => this.toStoredVector(row))
  }

  /** Units still waiting for an embedding pass, oldest first. */
  pendingVectorUnits(limit: number, memberId?: string): StoredContextUnit[] {
    const rows = memberId === undefined
      ? this.statement(`SELECT u.* FROM unit u
          LEFT JOIN vector v ON v.owner_kind = 'unit' AND v.owner_id = u.unit_id
          WHERE v.owner_id IS NULL ORDER BY u.recorded_at ASC LIMIT ?`).all(limit)
      : this.statement(`SELECT u.* FROM unit u
          LEFT JOIN vector v ON v.owner_kind = 'unit' AND v.owner_id = u.unit_id
          WHERE v.owner_id IS NULL AND u.member_id = ? ORDER BY u.recorded_at ASC LIMIT ?`).all(memberId, limit)
    return (rows as unknown as UnitRow[]).map(row => this.toStoredUnit(row))
  }

  /** Exact-term route: units sharing the most query identifiers. */
  searchExactTerms(memberId: string, terms: readonly string[], limit: number): ContextSearchHit[] {
    if (terms.length === 0) return []
    const placeholders = terms.map(() => '?').join(', ')
    const rows = this.statement(`SELECT t.owner_id AS unit_id, COUNT(DISTINCT t.term) AS matches
      FROM term t JOIN unit u ON u.unit_id = t.owner_id
      WHERE u.member_id = ? AND t.term_kind = 'exact' AND t.term IN (${placeholders})
      GROUP BY t.owner_id ORDER BY matches DESC, MAX(u.recorded_at) DESC LIMIT ?`)
      .all(memberId, ...terms, limit) as unknown as { unit_id: string; matches: number }[]
    return rows.map(row => ({ unitId: row.unit_id, score: Number(row.matches) }))
  }

  /** Facet route: one query per filter, merged by distinct matching filters. */
  searchFacetFilters(memberId: string, filters: readonly ContextFacetQuery[], limit: number): ContextSearchHit[] {
    const scores = new Map<string, number>()
    for (const filter of filters) {
      const rows = filter.dimension === 'time'
        ? this.statement(`SELECT f.owner_id AS unit_id FROM facet f JOIN unit u ON u.unit_id = f.owner_id
            WHERE u.member_id = ? AND f.dimension = 'time' AND f.start_ms IS NOT NULL AND f.end_ms IS NOT NULL
              AND f.start_ms < ? AND f.end_ms > ?
            ORDER BY u.recorded_at DESC LIMIT ?`).all(memberId, filter.endMs, filter.startMs, limit)
        : this.statement(`SELECT f.owner_id AS unit_id FROM facet f JOIN unit u ON u.unit_id = f.owner_id
            WHERE u.member_id = ? AND f.dimension = ? AND f.value = ?
            ORDER BY u.recorded_at DESC LIMIT ?`).all(memberId, filter.dimension, filter.value, limit)
      for (const row of rows as unknown as { unit_id: string }[]) {
        scores.set(row.unit_id, (scores.get(row.unit_id) ?? 0) + 1)
      }
    }
    return [...scores.entries()]
      .map(([unitId, score]) => ({ unitId, score }))
      .sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))
      .slice(0, limit)
  }

  /** FTS route; the caller chooses the tokenizer that matches the term script. */
  searchLexicalFts(memberId: string, query: string, limit: number, tokenizer: 'word' | 'trigram'): ContextSearchHit[] {
    const table = tokenizer === 'trigram' ? 'unit_fts_trigram' : 'unit_fts'
    if (tokenizer === 'trigram' ? !this.capabilities.trigram : !this.capabilities.word) return []
    const rows = this.statement(`SELECT ${table}.unit_id AS unit_id, bm25(${table}) AS rank
      FROM ${table} JOIN unit u ON u.unit_id = ${table}.unit_id
      WHERE ${table} MATCH ? AND u.member_id = ?
      ORDER BY rank LIMIT ?`).all(query, memberId, limit) as unknown as { unit_id: string; rank: number }[]
    return rows.map(row => ({ unitId: row.unit_id, score: -Number(row.rank) }))
  }

  /** `LIKE` fallback used when FTS5 or a tokenizer is unavailable. */
  searchLexicalLike(memberId: string, terms: readonly string[], limit: number): ContextSearchHit[] {
    const unique = [...new Set(terms.filter(term => term !== ''))]
    if (unique.length === 0) return []
    const condition = unique.map(() => "LOWER(u.text) LIKE ? ESCAPE '\\'").join(' OR ')
    const rows = this.statement(`SELECT u.unit_id, u.text FROM unit u
      WHERE u.member_id = ? AND (${condition})
      ORDER BY u.recorded_at DESC LIMIT ?`).all(
      memberId,
      ...unique.map(term => `%${escapeLike(term.toLowerCase())}%`),
      limit,
    ) as unknown as { unit_id: string; text: string }[]
    return rows.map(row => {
      const lower = row.text.toLowerCase()
      const score = unique.reduce((total, term) => total + (lower.includes(term.toLowerCase()) ? 1 : 0), 0)
      return { unitId: row.unit_id, score }
    })
  }

  private toStoredVector(row: VectorRow): StoredContextVector {
    const values = decodeVector(row.vector)
    return { unitId: row.owner_id, model: row.model, dim: row.dim, values: values.length === row.dim ? values : values.slice(0, row.dim) }
  }

  private toStoredUnit(row: UnitRow): StoredContextUnit {
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
