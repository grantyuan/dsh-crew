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

/** Compaction levels: L0 raw, L1 units, L2 topics, L3 generations, L4 Member index. */
export const CONTEXT_NODE_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const

export type ContextNodeLevel = (typeof CONTEXT_NODE_LEVELS)[number]

/** Belief lifecycle of a graph node; `current` is the only trusted-by-default state. */
export const CONTEXT_NODE_STATUSES = ['current', 'superseded', 'retired', 'unverified'] as const

export type ContextNodeStatus = (typeof CONTEXT_NODE_STATUSES)[number]

/** Edge kinds keep structure (`contains`), provenance (`evidence`) and belief change (`supersedes`) distinct. */
export const CONTEXT_EDGE_KINDS = [
  'contains',
  'derived_from',
  'about',
  'continues',
  'mentions',
  'evidence',
  'same_subject',
  'supersedes',
] as const

export type ContextEdgeKind = (typeof CONTEXT_EDGE_KINDS)[number]

/** One graph node. `ref` points at the immutable artifact it represents. */
export interface ContextNodeInput {
  readonly nodeId: string
  readonly memberId: string
  readonly sessionId: string
  readonly level: ContextNodeLevel
  readonly kind: string
  readonly label: string
  readonly ref: string
  readonly status?: ContextNodeStatus
  readonly confidence?: number
  /** When this belief became valid; defaults to write time. */
  readonly validFrom?: string
  /** When it stopped being valid; set together with `supersededBy`. */
  readonly validTo?: string
  readonly supersededBy?: string
  readonly now?: Date
}

export interface ContextNodeRecord {
  readonly nodeId: string
  readonly memberId: string
  readonly sessionId: string
  readonly level: ContextNodeLevel
  readonly kind: string
  readonly label: string
  readonly ref: string
  readonly status: ContextNodeStatus
  readonly confidence: number
  readonly validFrom: string
  readonly validTo?: string
  readonly supersededBy?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One directed edge; an undirected relation is stored once and traversed both ways. */
export interface ContextEdgeInput {
  readonly memberId: string
  readonly srcId: string
  readonly dstId: string
  readonly kind: ContextEdgeKind
  readonly weight?: number
  readonly validFrom?: string
  /** Retiring an edge keeps the fact that it once held. */
  readonly validTo?: string
  readonly now?: Date
}

export interface ContextEdgeRecord {
  readonly memberId: string
  readonly srcId: string
  readonly dstId: string
  readonly kind: ContextEdgeKind
  readonly weight: number
  readonly validFrom: string
  readonly validTo?: string
  readonly createdAt: string
}

/** One reached-but-not-seeded unit in a graph walk. */
export interface ContextGraphHit {
  readonly ref: string
  readonly depth: number
  readonly weight: number
}

/** Belief state of a unit, resolved from its L1 graph node. */
export interface ContextUnitStatus {
  readonly status: ContextNodeStatus
  /** Unit ref of the replacing node, resolved for recall output. */
  readonly supersededByRef?: string
  readonly validTo?: string
}

/** A committed L1 summary of one frontier window. */
export interface ContextDigest {
  readonly summary: string
  readonly decisions: readonly string[]
  readonly commitments: readonly string[]
  readonly openLoops: readonly string[]
}

export interface ContextSegmentInput {
  readonly memberId: string
  readonly sessionId: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly frontierSeq: number
  readonly digest: ContextDigest
  readonly digestHash: string
  readonly label: string
  readonly validFrom: string
  readonly validTo?: string
  readonly now?: Date
}

export interface ContextSegmentRecord extends ContextSegmentInput {
  readonly segmentId: string
  readonly level: 'L2'
  readonly kind: 'summary'
  readonly status: ContextNodeStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ContextPendingCommitment {
  readonly kind: 'decision' | 'commitment'
  readonly text: string
  readonly quote: string
  readonly quoteHash: string
  readonly ref: string
}

export interface ContextEpochPending {
  readonly digest: ContextDigest
  readonly commitments: readonly ContextPendingCommitment[]
  readonly hash: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly preparedAt: string
}

export interface ContextEpochRecord {
  readonly memberId: string
  readonly sessionId: string
  readonly frontierSeq: number
  readonly pending?: ContextEpochPending
  readonly updatedAt: string
}

export interface ContextCommitmentInput {
  readonly memberId: string
  readonly sessionId: string
  readonly segmentId: string
  readonly kind: 'decision' | 'commitment'
  readonly text: string
  readonly quote: string
  readonly quoteHash: string
  readonly ref: string
  readonly status?: ContextNodeStatus
  readonly validFrom: string
  readonly now?: Date
}

export interface ContextCommitmentRecord extends Omit<ContextCommitmentInput, 'now'> {
  readonly commitmentId: string
  readonly status: ContextNodeStatus
  readonly validTo?: string
  readonly createdAt: string
}

/** One reachable edge rendered for review. */
export interface ContextReviewEdge {
  readonly from: string
  readonly to: string
  readonly kind: ContextEdgeKind
  readonly validFrom: string
  readonly validTo?: string
}

export interface ContextReviewDecision {
  readonly ref: string
  readonly text: string
  readonly status: 'active' | 'superseded' | 'expired' | 'unverified'
  readonly validFrom: string
  readonly validTo?: string
  readonly supersededBy?: string
}

export interface ContextReviewCluster {
  readonly topic: string
  readonly decisions: readonly ContextReviewDecision[]
  readonly openQuestions: readonly string[]
  readonly segments: readonly string[]
  readonly generations: readonly string[]
}

export interface ContextReviewRequest {
  readonly topic?: string
  readonly around?: string
  readonly includeSuperseded?: boolean
  readonly depth?: 1 | 2
}

export interface ContextReviewResult {
  readonly clusters: readonly ContextReviewCluster[]
  readonly edges: readonly ContextReviewEdge[]
  readonly narrative: string
  readonly includeSuperseded: boolean
  readonly degraded: readonly string[]
}

/** Planning verdict for one compaction epoch. */
export interface ContextCompactionPlan {
  readonly fromSeq: number
  readonly toSeq: number
  readonly unitCount: number
  readonly windowTokens: number
  readonly retainedTokens: number
  readonly expectedRemainingRequests: number
  readonly savingsTokens: number
}

export type ContextCompactionPlanOutcome =
  | { readonly ok: true; readonly plan: ContextCompactionPlan }
  | { readonly ok: false; readonly reason: string }
