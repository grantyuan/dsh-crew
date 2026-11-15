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
  ContextCommitmentInput,
  ContextCommitmentRecord,
  ContextDigest,
  ContextEdgeInput,
  ContextEdgeKind,
  ContextEdgeRecord,
  ContextEpochRecord,
  ContextFacet,
  ContextGenerationRecord,
  ContextGraphHit,
  ContextImportance,
  ContextKeyword,
  ContextNodeInput,
  ContextNodeLevel,
  ContextNodeRecord,
  ContextNodeStatus,
  ContextOutboxRow,
  ContextPendingCommitment,
  ContextSegmentInput,
  ContextSegmentRecord,
  ContextTermKind,
  ContextTermSource,
  ContextTimeGranularity,
  ContextUnitKind,
  ContextUnitRecord,
  ContextUnitRole,
  ContextUnitStatus,
  ContextUnitWriteResult,
  ContextFacetDimension,
  ContextFacetSource,
} from './types.ts'
import { contextNodeId } from './units.ts'

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

interface NodeRow {
  readonly node_id: string
  readonly member_id: string
  readonly session_id: string
  readonly level: string
  readonly kind: string
  readonly label: string
  readonly ref: string
  readonly status: string
  readonly confidence: number
  readonly valid_from: string
  readonly valid_to: string | null
  readonly superseded_by: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface EdgeRow {
  readonly member_id: string
  readonly src_id: string
  readonly dst_id: string
  readonly kind: string
  readonly weight: number
  readonly valid_from: string
  readonly valid_to: string | null
  readonly created_at: string
}

interface StatusRow {
  readonly ref: string
  readonly status: string
  readonly valid_to: string | null
  readonly superseded_ref: string | null
}

interface GraphRow {
  readonly ref: string
  readonly depth: number
  readonly weight: number
}

interface SegmentRow {
  readonly segment_id: string
  readonly member_id: string
  readonly session_id: string
  readonly level: string
  readonly kind: string
  readonly label: string
  readonly from_seq: number
  readonly to_seq: number
  readonly frontier_seq: number
  readonly digest_json: string
  readonly digest_hash: string
  readonly status: string
  readonly valid_from: string
  readonly valid_to: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface EpochRow {
  readonly member_id: string
  readonly session_id: string
  readonly frontier_seq: number
  readonly pending_json: string | null
  readonly pending_hash: string | null
  readonly pending_from_seq: number | null
  readonly pending_to_seq: number | null
  readonly pending_at: string | null
  readonly updated_at: string
}

interface CommitmentRow {
  readonly commitment_id: string
  readonly member_id: string
  readonly session_id: string
  readonly segment_id: string
  readonly kind: string
  readonly text: string
  readonly quote: string
  readonly quote_hash: string
  readonly ref: string
  readonly status: string
  readonly valid_from: string
  readonly valid_to: string | null
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
      // Every unit is an L1 graph node. The node carries belief state
      // (status/confidence/validity) so recall can filter stale versions
      // without mutating the immutable unit text.
      this.syncUnitNode(record)
      this.linkUnitNode(record)
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

  /**
   * Create or refresh the L1 node for a unit. Belief state is never revived:
   * a later rewrite of the same unit does not make a superseded version current.
   */
  private syncUnitNode(record: ContextUnitRecord): void {
    this.statement(`INSERT INTO memory_node (
      node_id, member_id, session_id, level, kind, label, ref, status, confidence,
      valid_from, created_at, updated_at
    ) VALUES (?, ?, ?, 'L1', ?, ?, ?, 'current', 1.0, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      session_id = excluded.session_id,
      kind = excluded.kind,
      label = excluded.label,
      updated_at = excluded.updated_at`).run(
      contextNodeId(record.unitId),
      record.memberId,
      record.sessionId,
      record.kind,
      record.text.slice(0, 120),
      record.unitId,
      record.recordedAt,
      record.createdAt,
      record.createdAt,
    )
  }

  /**
   * Structural edges created without a model: `continues` keeps Session order
   * walkable, and `same_subject` joins units that share an explicit subject.
   * Both are cheap, deterministic, and rebuilt idempotently on rewrite.
   */
  private linkUnitNode(record: ContextUnitRecord): void {
    const nodeId = contextNodeId(record.unitId)
    // Rewriting a unit may change its subject set, so rebuild only its own
    // outgoing structural edges; incoming edges authored by other units stay.
    this.statement("DELETE FROM memory_edge WHERE member_id = ? AND src_id = ? AND kind IN ('continues', 'same_subject')")
      .run(record.memberId, nodeId)
    const previous = this.statement(
      'SELECT unit_id FROM unit WHERE member_id = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1',
    ).get(record.memberId, record.sessionId, record.seq) as { unit_id: string } | undefined
    if (previous !== undefined) {
      this.insertEdge({
        memberId: record.memberId,
        srcId: nodeId,
        dstId: contextNodeId(previous.unit_id),
        kind: 'continues',
        weight: 1,
        validFrom: record.recordedAt,
        now: new Date(record.createdAt),
      })
    }
    const subjects = [...new Set(record.facets.filter(facet => facet.dimension === 'subject').map(facet => facet.value))]
    if (subjects.length === 0) return
    const peers = this.statement(`SELECT u.unit_id FROM facet f JOIN unit u ON u.unit_id = f.owner_id
      WHERE f.owner_kind = 'unit' AND f.dimension = 'subject' AND f.value = ? AND u.member_id = ? AND u.unit_id <> ?
      ORDER BY u.recorded_at DESC LIMIT 3`)
    for (const subject of subjects) {
      for (const peer of peers.all(subject, record.memberId, record.unitId) as unknown as { unit_id: string }[]) {
        this.insertEdge({
          memberId: record.memberId,
          srcId: nodeId,
          dstId: contextNodeId(peer.unit_id),
          kind: 'same_subject',
          weight: 0.8,
          validFrom: record.recordedAt,
          now: new Date(record.createdAt),
        })
      }
    }
  }

  /** Upsert one edge without reviving a retired edge. */
  private insertEdge(input: ContextEdgeInput): void {
    const now = input.now ?? new Date()
    const createdAt = now.toISOString()
    this.statement(`INSERT INTO memory_edge (member_id, src_id, dst_id, kind, weight, valid_from, valid_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_id, src_id, dst_id, kind) DO UPDATE SET
        weight = excluded.weight,
        valid_from = excluded.valid_from,
        valid_to = COALESCE(excluded.valid_to, memory_edge.valid_to)`).run(
      input.memberId,
      input.srcId,
      input.dstId,
      input.kind,
      input.weight ?? 1,
      input.validFrom ?? createdAt,
      input.validTo ?? null,
      createdAt,
    )
  }

  /** Create or refresh a graph node; see `syncUnitNode` for the no-revival rule. */
  upsertNode(input: ContextNodeInput): ContextNodeRecord {
    const now = input.now ?? new Date()
    const createdAt = now.toISOString()
    this.statement(`INSERT INTO memory_node (
      node_id, member_id, session_id, level, kind, label, ref, status, confidence,
      valid_from, valid_to, superseded_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      session_id = excluded.session_id,
      level = excluded.level,
      kind = excluded.kind,
      label = excluded.label,
      ref = excluded.ref,
      confidence = excluded.confidence,
      valid_from = excluded.valid_from,
      valid_to = COALESCE(excluded.valid_to, memory_node.valid_to),
      superseded_by = COALESCE(excluded.superseded_by, memory_node.superseded_by),
      status = CASE WHEN excluded.status = 'current' AND memory_node.status <> 'current'
        THEN memory_node.status ELSE excluded.status END,
      updated_at = excluded.updated_at`).run(
      input.nodeId,
      input.memberId,
      input.sessionId,
      input.level,
      input.kind,
      input.label,
      input.ref,
      input.status ?? 'current',
      Math.max(0, Math.min(1, input.confidence ?? 1)),
      input.validFrom ?? createdAt,
      input.validTo ?? null,
      input.supersededBy ?? null,
      createdAt,
      createdAt,
    )
    const node = this.getNode(input.nodeId)
    if (node === undefined) throw new Error(`graph node "${input.nodeId}" disappeared after upsert`)
    return node
  }

  /** Read one node, or `undefined` when absent. */
  getNode(nodeId: string): ContextNodeRecord | undefined {
    const row = this.statement('SELECT * FROM memory_node WHERE node_id = ?').get(nodeId) as NodeRow | undefined
    return row === undefined ? undefined : toStoredNode(row)
  }

  /** Nodes of one Member, optionally narrowed by level or ref. */
  listNodes(memberId: string, filter: { level?: ContextNodeLevel; ref?: string } = {}): ContextNodeRecord[] {
    const clauses = ['member_id = ?']
    const values: (string | number)[] = [memberId]
    if (filter.level !== undefined) {
      clauses.push('level = ?')
      values.push(filter.level)
    }
    if (filter.ref !== undefined) {
      clauses.push('ref = ?')
      values.push(filter.ref)
    }
    const rows = this.statement(`SELECT * FROM memory_node WHERE ${clauses.join(' AND ')} ORDER BY created_at, node_id`)
      .all(...values) as unknown as NodeRow[]
    return rows.map(toStoredNode)
  }

  /** Create or refresh one edge; existing edges keep their `valid_to`. */
  upsertEdge(input: ContextEdgeInput): ContextEdgeRecord {
    this.insertEdge(input)
    const row = this.statement(`SELECT * FROM memory_edge WHERE member_id = ? AND src_id = ? AND dst_id = ? AND kind = ?`)
      .get(input.memberId, input.srcId, input.dstId, input.kind) as EdgeRow | undefined
    if (row === undefined) throw new Error(`graph edge ${input.kind} disappeared after upsert`)
    return toStoredEdge(row)
  }

  /**
   * Record that `supersedingUnitId` replaces `supersededUnitId`: the old node
   * becomes `superseded` with `valid_to`/`superseded_by`, and a directed
   * `supersedes` edge preserves the chain. The old unit row and its text stay
   * untouched, so the historical record remains auditable.
   */
  supersedeUnit(supersedingUnitId: string, supersededUnitId: string, at = new Date()): void {
    const newNode = this.getNode(contextNodeId(supersedingUnitId))
    const oldNode = this.getNode(contextNodeId(supersededUnitId))
    if (newNode === undefined || oldNode === undefined) {
      throw new Error('supersedeUnit requires both units to exist in the derived index')
    }
    if (newNode.memberId !== oldNode.memberId) {
      throw new Error('supersedeUnit cannot cross Member boundaries')
    }
    const instant = at.toISOString()
    this.transaction(() => {
      this.statement(`UPDATE memory_node SET status = 'superseded', valid_to = ?, superseded_by = ?, updated_at = ?
        WHERE node_id = ?`).run(instant, newNode.nodeId, instant, oldNode.nodeId)
      this.insertEdge({
        memberId: newNode.memberId,
        srcId: newNode.nodeId,
        dstId: oldNode.nodeId,
        kind: 'supersedes',
        weight: 1,
        validFrom: instant,
        now: at,
      })
    })
  }

  /** Belief state per unit, resolved from its L1 node with the replacing ref joined in. */
  unitStatuses(memberId: string, unitIds: readonly string[]): Map<string, ContextUnitStatus> {
    const unique = [...new Set(unitIds)]
    const statuses = new Map<string, ContextUnitStatus>()
    if (unique.length === 0) return statuses
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.statement(`SELECT n.ref AS ref, n.status AS status, n.valid_to AS valid_to, s.ref AS superseded_ref
      FROM memory_node n LEFT JOIN memory_node s ON s.node_id = n.superseded_by
      WHERE n.member_id = ? AND n.level = 'L1' AND n.ref IN (${placeholders})`)
      .all(memberId, ...unique) as unknown as StatusRow[]
    for (const row of rows) {
      statuses.set(row.ref, {
        status: row.status as ContextNodeStatus,
        ...(row.superseded_ref === null ? {} : { supersededByRef: row.superseded_ref }),
        ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
      })
    }
    return statuses
  }

  /**
   * Undirected walk from seed nodes over live edges. Neighbours are reached in
   * both directions (an edge written new→old is still a relation), cycles are
   * cut by the path string, and only L1 unit nodes are returned. Depth is
   * clamped to 3 so one call cannot fan out across the whole graph.
   */
  graphNeighbors(memberId: string, seedNodeIds: readonly string[], depth = 3, limit = 50): ContextGraphHit[] {
    const seeds = [...new Set(seedNodeIds)].slice(0, 8)
    if (seeds.length === 0) return []
    const walkDepth = Math.max(1, Math.min(3, Math.floor(depth)))
    const placeholders = seeds.map(() => '?').join(', ')
    const rows = this.statement(`WITH RECURSIVE
      neighbor(src, dst, weight) AS (
        SELECT src_id, dst_id, weight FROM memory_edge WHERE member_id = ? AND valid_to IS NULL
        UNION ALL
        SELECT dst_id, src_id, weight FROM memory_edge WHERE member_id = ? AND valid_to IS NULL
      ),
      walk(node_id, depth, weight, path) AS (
        SELECT n.dst, 1, n.weight, '>' || n.src || '>' || n.dst FROM neighbor n WHERE n.src IN (${placeholders})
        UNION ALL
        SELECT n.dst, w.depth + 1, w.weight * n.weight, w.path || '>' || n.dst
        FROM walk w JOIN neighbor n ON n.src = w.node_id
        WHERE w.depth < ? AND instr(w.path, '>' || n.dst || '>') = 0
      )
      SELECT ref, depth, weight FROM (
        SELECT n.ref AS ref, w.depth AS depth, w.weight AS weight,
          ROW_NUMBER() OVER (PARTITION BY n.ref ORDER BY w.depth ASC, w.weight DESC) AS rank
        FROM walk w JOIN memory_node n ON n.node_id = w.node_id
        WHERE n.member_id = ? AND n.level = 'L1'
      )
      WHERE rank = 1
      ORDER BY depth ASC, weight DESC
      LIMIT ?`).all(memberId, memberId, ...seeds, walkDepth, memberId, limit) as unknown as GraphRow[]
    return rows.map(row => ({ ref: row.ref, depth: row.depth, weight: row.weight }))
  }

  /** Read one unit, or `undefined` when the row is absent. */
  getUnit(unitId: string): StoredContextUnit | undefined {
    const row = this.statement('SELECT * FROM unit WHERE unit_id = ?').get(unitId) as UnitRow | undefined
    return row === undefined ? undefined : this.toStoredUnit(row)
  }

  /** Read the compaction frontier and any pre-generated digest. */
  getEpoch(memberId: string, sessionId: string): ContextEpochRecord {
    const row = this.statement('SELECT * FROM context_epoch WHERE member_id = ? AND session_id = ?')
      .get(memberId, sessionId) as EpochRow | undefined
    return row === undefined
      ? { memberId, sessionId, frontierSeq: 0, updatedAt: new Date(0).toISOString() }
      : toStoredEpoch(row)
  }

  /** Store the pre-generated digest; the commit point may reuse it without a model call. */
  savePendingEpoch(input: {
    readonly memberId: string
    readonly sessionId: string
    readonly digest: ContextDigest
    readonly commitments: readonly ContextPendingCommitment[]
    readonly hash: string
    readonly fromSeq: number
    readonly toSeq: number
    readonly now?: Date
  }): ContextEpochRecord {
    const now = input.now ?? new Date()
    const at = now.toISOString()
    // A pending digest never advances the committed frontier; only commitSegment does.
    // A fresh row therefore starts at zero, and the conflict path leaves it untouched.
    this.statement(`INSERT INTO context_epoch (
      member_id, session_id, frontier_seq, pending_json, pending_hash,
      pending_from_seq, pending_to_seq, pending_at, updated_at
    ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id, session_id) DO UPDATE SET
      pending_json = excluded.pending_json,
      pending_hash = excluded.pending_hash,
      pending_from_seq = excluded.pending_from_seq,
      pending_to_seq = excluded.pending_to_seq,
      pending_at = excluded.pending_at,
      updated_at = excluded.updated_at`).run(
      input.memberId,
      input.sessionId,
      JSON.stringify({ digest: input.digest, commitments: input.commitments }),
      input.hash,
      input.fromSeq,
      input.toSeq,
      at,
      at,
    )
    return this.getEpoch(input.memberId, input.sessionId)
  }

  /** Discard a stale pending digest after the frontier moved or the range changed. */
  clearPendingEpoch(memberId: string, sessionId: string, now = new Date()): void {
    this.statement(`UPDATE context_epoch SET pending_json = NULL, pending_hash = NULL,
      pending_from_seq = NULL, pending_to_seq = NULL, pending_at = NULL, updated_at = ?
      WHERE member_id = ? AND session_id = ?`).run(now.toISOString(), memberId, sessionId)
  }

  /**
   * Commit one collapsed window: cache the digest, record its exact-quote
   * commitments, advance the frontier, and clear the consumed pending digest.
   */
  commitSegment(input: ContextSegmentInput, commitments: readonly ContextCommitmentInput[] = []): ContextSegmentRecord {
    const now = input.now ?? new Date()
    const at = now.toISOString()
    const segmentId = `seg:${input.sessionId}:${input.fromSeq}-${input.toSeq}`
    this.transaction(() => {
      this.statement(`INSERT INTO context_segment (
        segment_id, member_id, session_id, level, kind, label,
        from_seq, to_seq, frontier_seq, digest_json, digest_hash,
        status, valid_from, valid_to, created_at, updated_at
      ) VALUES (?, ?, ?, 'L2', 'summary', ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?)
      ON CONFLICT(segment_id) DO UPDATE SET
        label = excluded.label,
        frontier_seq = excluded.frontier_seq,
        digest_json = excluded.digest_json,
        digest_hash = excluded.digest_hash,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        updated_at = excluded.updated_at`).run(
        segmentId,
        input.memberId,
        input.sessionId,
        input.label,
        input.fromSeq,
        input.toSeq,
        input.frontierSeq,
        JSON.stringify(input.digest),
        input.digestHash,
        input.validFrom,
        input.validTo ?? null,
        at,
        at,
      )
      this.statement('DELETE FROM context_commitment WHERE segment_id = ?').run(segmentId)
      for (const commitment of commitments) {
        this.statement(`INSERT INTO context_commitment (
          commitment_id, member_id, session_id, segment_id, kind, text, quote,
          quote_hash, ref, status, valid_from, valid_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          commitmentId(segmentId, commitment.kind, commitment.ref, commitment.text),
          commitment.memberId,
          commitment.sessionId,
          segmentId,
          commitment.kind,
          commitment.text,
          commitment.quote,
          commitment.quoteHash,
          commitment.ref,
          commitment.status ?? 'current',
          commitment.validFrom,
          null,
          at,
        )
      }
      this.statement(`INSERT INTO context_epoch (
        member_id, session_id, frontier_seq, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(member_id, session_id) DO UPDATE SET
        frontier_seq = MAX(context_epoch.frontier_seq, excluded.frontier_seq),
        pending_json = NULL, pending_hash = NULL, pending_from_seq = NULL,
        pending_to_seq = NULL, pending_at = NULL, updated_at = excluded.updated_at`).run(
        input.memberId,
        input.sessionId,
        input.frontierSeq,
        at,
      )
    })
    const segment = this.getSegment(segmentId)
    if (segment === undefined) throw new Error(`context segment "${segmentId}" disappeared after commit`)
    return segment
  }

  getSegment(segmentId: string): ContextSegmentRecord | undefined {
    const row = this.statement('SELECT * FROM context_segment WHERE segment_id = ?').get(segmentId) as SegmentRow | undefined
    return row === undefined ? undefined : toStoredSegment(row)
  }

  /** Commit-point read cache: the segment whose window contains `seq`. */
  segmentForSeq(memberId: string, sessionId: string, seq: number): ContextSegmentRecord | undefined {
    const row = this.statement(`SELECT * FROM context_segment
      WHERE member_id = ? AND session_id = ? AND from_seq <= ? AND to_seq >= ? AND status = 'current'
      ORDER BY to_seq DESC LIMIT 1`).get(memberId, sessionId, seq, seq) as SegmentRow | undefined
    return row === undefined ? undefined : toStoredSegment(row)
  }

  listSegments(memberId: string, sessionId: string): ContextSegmentRecord[] {
    const rows = this.statement(`SELECT * FROM context_segment
      WHERE member_id = ? AND session_id = ? ORDER BY from_seq ASC`).all(memberId, sessionId) as unknown as SegmentRow[]
    return rows.map(toStoredSegment)
  }

  listCommitments(segmentId: string): ContextCommitmentRecord[] {
    const rows = this.statement('SELECT * FROM context_commitment WHERE segment_id = ? ORDER BY kind, created_at, commitment_id')
      .all(segmentId) as unknown as CommitmentRow[]
    return rows.map(toStoredCommitment)
  }

  /**
   * L3 generation rollups for the supplied Sessions. The summary is the node
   * label (a bounded, deterministic digest); `derived_from` edges resolve the
   * L2 segment refs the rollup was built from.
   */
  generationSummaries(memberId: string, sessionIds: readonly string[]): ContextGenerationRecord[] {
    const unique = [...new Set(sessionIds)]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.statement(`SELECT * FROM memory_node
      WHERE member_id = ? AND level = 'L3' AND kind = 'generation'
        AND status <> 'retired' AND session_id IN (${placeholders})
      ORDER BY valid_from, node_id`).all(memberId, ...unique) as unknown as NodeRow[]
    return rows.map(row => {
      const edges = this.statement(`SELECT dst_id FROM memory_edge
        WHERE member_id = ? AND src_id = ? AND kind = 'derived_from' AND valid_to IS NULL
        ORDER BY dst_id`).all(memberId, row.node_id) as unknown as { dst_id: string }[]
      const segments: string[] = []
      for (const edge of edges) {
        const node = this.getNode(edge.dst_id)
        if (node !== undefined && node.level === 'L2') segments.push(node.ref)
      }
      return {
        ref: row.ref,
        sessionId: row.session_id,
        summary: row.label,
        confidence: row.confidence,
        validFrom: row.valid_from,
        segments,
      }
    })
  }

  /** Units of one Session in ascending seq order, optionally bounded. */
  listUnits(memberId: string, sessionId: string, options: { fromSeq?: number; toSeq?: number } = {}): StoredContextUnit[] {
    const clauses = ['member_id = ?', 'session_id = ?']
    const values: (string | number)[] = [memberId, sessionId]
    if (options.fromSeq !== undefined) {
      clauses.push('seq >= ?')
      values.push(options.fromSeq)
    }
    if (options.toSeq !== undefined) {
      clauses.push('seq <= ?')
      values.push(options.toSeq)
    }
    const rows = this.statement(`SELECT * FROM unit WHERE ${clauses.join(' AND ')} ORDER BY seq ASC`)
      .all(...values) as unknown as UnitRow[]
    return rows.map(row => this.toStoredUnit(row))
  }

  /** Live edges whose two endpoints are in the supplied node set. */
  edgesAmong(memberId: string, nodeIds: readonly string[]): ContextEdgeRecord[] {
    const unique = [...new Set(nodeIds)]
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.statement(`SELECT * FROM memory_edge
      WHERE member_id = ? AND valid_to IS NULL
        AND src_id IN (${placeholders}) AND dst_id IN (${placeholders})
      ORDER BY kind, src_id, dst_id`).all(memberId, ...unique, ...unique) as unknown as EdgeRow[]
    return rows.map(toStoredEdge)
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

/** Map one `memory_node` row into the public read shape. */
function toStoredNode(row: NodeRow): ContextNodeRecord {
  return {
    nodeId: row.node_id,
    memberId: row.member_id,
    sessionId: row.session_id,
    level: row.level as ContextNodeLevel,
    kind: row.kind,
    label: row.label,
    ref: row.ref,
    status: row.status as ContextNodeStatus,
    confidence: row.confidence,
    validFrom: row.valid_from,
    ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Map one `memory_edge` row into the public read shape. */
function toStoredEdge(row: EdgeRow): ContextEdgeRecord {
  return {
    memberId: row.member_id,
    srcId: row.src_id,
    dstId: row.dst_id,
    kind: row.kind as ContextEdgeKind,
    weight: row.weight,
    validFrom: row.valid_from,
    ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
    createdAt: row.created_at,
  }
}

function parseDigest(json: string): ContextDigest {
  const parsed = JSON.parse(json) as Partial<ContextDigest>
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter((item): item is string => typeof item === 'string') : [],
    commitments: Array.isArray(parsed.commitments) ? parsed.commitments.filter((item): item is string => typeof item === 'string') : [],
    openLoops: Array.isArray(parsed.openLoops) ? parsed.openLoops.filter((item): item is string => typeof item === 'string') : [],
  }
}

function parsePending(json: string): { digest: ContextDigest; commitments: ContextPendingCommitment[] } {
  const parsed = JSON.parse(json) as { digest?: unknown; commitments?: unknown }
  const digest = parseDigest(JSON.stringify(parsed.digest ?? {}))
  const commitments = Array.isArray(parsed.commitments)
    ? parsed.commitments.filter((item): item is ContextPendingCommitment => {
        if (item === null || typeof item !== 'object') return false
        const candidate = item as Partial<ContextPendingCommitment>
        return (candidate.kind === 'decision' || candidate.kind === 'commitment')
          && typeof candidate.text === 'string'
          && typeof candidate.quote === 'string'
          && typeof candidate.quoteHash === 'string'
          && typeof candidate.ref === 'string'
      })
    : []
  return { digest, commitments }
}

function toStoredEpoch(row: EpochRow): ContextEpochRecord {
  const pending = row.pending_json === null || row.pending_hash === null
    || row.pending_from_seq === null || row.pending_to_seq === null || row.pending_at === null
    ? undefined
    : {
        ...parsePending(row.pending_json),
        hash: row.pending_hash,
        fromSeq: row.pending_from_seq,
        toSeq: row.pending_to_seq,
        preparedAt: row.pending_at,
      }
  return {
    memberId: row.member_id,
    sessionId: row.session_id,
    frontierSeq: row.frontier_seq,
    ...(pending === undefined ? {} : { pending }),
    updatedAt: row.updated_at,
  }
}

function toStoredSegment(row: SegmentRow): ContextSegmentRecord {
  return {
    segmentId: row.segment_id,
    memberId: row.member_id,
    sessionId: row.session_id,
    level: row.level as 'L2',
    kind: row.kind as 'summary',
    label: row.label,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    frontierSeq: row.frontier_seq,
    digest: parseDigest(row.digest_json),
    digestHash: row.digest_hash,
    status: row.status as ContextNodeStatus,
    validFrom: row.valid_from,
    ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toStoredCommitment(row: CommitmentRow): ContextCommitmentRecord {
  return {
    commitmentId: row.commitment_id,
    memberId: row.member_id,
    sessionId: row.session_id,
    segmentId: row.segment_id,
    kind: row.kind as 'decision' | 'commitment',
    text: row.text,
    quote: row.quote,
    quoteHash: row.quote_hash,
    ref: row.ref,
    status: row.status as ContextNodeStatus,
    validFrom: row.valid_from,
    ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
    createdAt: row.created_at,
  }
}

/** Deterministic id for one exact-quote commitment. */
export function commitmentId(segmentId: string, kind: string, ref: string, text: string): string {
  let hash = 0
  const input = `${segmentId}\u0000${kind}\u0000${ref}\u0000${text}`
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193)
  }
  return `cm:${(hash >>> 0).toString(36)}:${input.length}`
}
