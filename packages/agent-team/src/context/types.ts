/**
 * Durable L1 context index types.
 *
 * These describe the derived, rebuildable context index: one row per
 * message-producing Session event, its deterministic keywords, and its facet
 * filters. They never carry authority over the Team ledger or the Session log;
 * deleting the database only loses recall acceleration, not history.
 * @module @grantyuan/dsh-crew/context/types
 */

/** The four message-producing roles a context unit can come from. */
export const CONTEXT_UNIT_ROLES = ['user', 'assistant', 'tool', 'notice'] as const

export type ContextUnitRole = (typeof CONTEXT_UNIT_ROLES)[number]

/** L1 unit kinds, aligned with the design's `ContextUnit.kind`. */
export const CONTEXT_UNIT_KINDS = ['decision', 'process', 'auxiliary', 'memory', 'fact', 'unclassified'] as const

export type ContextUnitKind = (typeof CONTEXT_UNIT_KINDS)[number]

/** Importance is intentionally ordinal: 0 noise, 3 must keep verbatim. */
export type ContextImportance = 0 | 1 | 2 | 3

/** Keyword kinds share one table; exact keeps original casing and punctuation. */
export type ContextTermKind = 'exact' | 'term' | 'phrase'

/** `deterministic` is the rule extractor; `inherited` is a parent aggregate. */
export type ContextTermSource = 'model' | 'deterministic' | 'inherited'

/** One keyword attached to a unit. */
export interface ContextKeyword {
  readonly term: string
  readonly kind: ContextTermKind
  readonly weight: number
  readonly source: ContextTermSource
}

/** Facet dimensions: what constrains a unit, not what it says. */
export const CONTEXT_FACET_DIMENSIONS = ['time', 'space', 'topic', 'role', 'subject'] as const

export type ContextFacetDimension = (typeof CONTEXT_FACET_DIMENSIONS)[number]

/** Rule facets are authoritative; the model may only fill missing dimensions. */
export type ContextFacetSource = 'rule' | 'model' | 'inherited'

/** Time granularity values from the design's relative-time table. */
export type ContextTimeGranularity =
  | 'instant'
  | 'minute'
  | 'hour'
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'night'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year'

/** One facet row. Time values carry absolute epoch milliseconds for range scans. */
export interface ContextFacet {
  readonly dimension: ContextFacetDimension
  readonly value: string
  readonly raw?: string
  readonly startMs?: number
  readonly endMs?: number
  readonly granularity?: ContextTimeGranularity
  readonly tz?: string
  readonly confidence: number
  readonly source: ContextFacetSource
}

/** A message-producing event promoted to a context unit. */
export interface ContextUnitInput {
  readonly memberId: string
  readonly sessionId: string
  readonly seq: number
  readonly role: ContextUnitRole
  readonly text: string
  /** The Session event's recorded time; relative time resolves against this. */
  readonly recordedAt: string
  readonly timezone?: string
  readonly eventType?: string
  readonly toolName?: string
}

/** A fully prepared unit: identity, text, rules output, and derived filters. */
export interface ContextUnitRecord {
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
  readonly keywords: readonly ContextKeyword[]
  readonly facets: readonly ContextFacet[]
}

/** Zero-model extraction output for one unit. */
export interface ContextUnitExtraction {
  readonly kind: ContextUnitKind
  readonly importance: ContextImportance
  readonly keywords: readonly ContextKeyword[]
  readonly facets: readonly ContextFacet[]
}

/** Model-provided enrichment; only missing fields are written. */
export interface ContextUnitEnrichment {
  readonly subjects: readonly string[]
  readonly topics: readonly string[]
  readonly roles: readonly string[]
  readonly confidence: number
  readonly time?: { readonly startMs: number; readonly endMs: number }
}

/** Result of one idempotent unit write. */
export interface ContextUnitWriteResult {
  readonly unitId: string
  readonly inserted: boolean
  readonly changed: boolean
  readonly enrichQueued: boolean
}

/** A pending background enrichment row. */
export interface ContextOutboxRow {
  readonly id: number
  readonly memberId: string
  readonly sessionId: string
  readonly unitId: string
  readonly kind: string
  readonly payload: string
  readonly attempts: number
}
