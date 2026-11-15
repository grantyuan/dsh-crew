import { createHash } from 'node:crypto'
import type { ContextStore, StoredContextUnit } from './store.ts'
import type {
  ContextCompactionPlan,
  ContextCompactionPlanOutcome,
  ContextDigest,
  ContextEpochPending,
  ContextPendingCommitment,
  ContextSegmentInput,
  ContextSegmentRecord,
} from './types.ts'

/** Thresholds from the maintained spec; do not relax these without a decision record. */
export const CONTEXT_COMPACTION = {
  minWindowTokens: 8_000,
  minTurns: 10,
  expectedRequestsFloor: 5,
  expectedRequestsCeiling: 60,
  costRatio: 2,
  tailFloorTokens: 1_500,
  youngAnalysisItems: 5,
  maxDigestInputTokens: 6_000,
  maxSummaryTokens: 1_200,
} as const

/** Deterministic token estimate; only used for local budgeting, never billed. */
export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Decide whether the units behind the frontier are worth collapsing. The
 * analysis window and the tail floor are removed before measuring, so a
 * borderline window is rejected rather than partially compressed.
 */
export function planContextCompaction(
  units: readonly StoredContextUnit[],
  options: { frontierSeq?: number; expectedRemainingRequests?: number; summaryTokens?: number } = {},
): ContextCompactionPlanOutcome {
  const sorted = [...units].sort((left, right) => left.seq - right.seq)
  const frontier = options.frontierSeq ?? 0
  if (sorted.length === 0) return { ok: false, reason: 'no-units' }

  let end = sorted.length - CONTEXT_COMPACTION.youngAnalysisItems - 1
  end = legalCutIndex(sorted, end)
  if (end < 0) return { ok: false, reason: 'analysis-window' }

  const candidate = sorted.slice(0, end + 1).filter(unit => unit.seq > frontier)
  if (candidate.length < CONTEXT_COMPACTION.minTurns) return { ok: false, reason: 'too-few-turns' }

  const lastCandidateIndex = sorted.findIndex(unit => unit.seq === candidate[candidate.length - 1]?.seq)
  end = legalCutIndex(sorted, lastCandidateIndex)
  let windowUnits = sorted.slice(0, end + 1).filter(unit => unit.seq > frontier)

  const summaryTokens = Math.min(
    options.summaryTokens ?? CONTEXT_COMPACTION.maxSummaryTokens,
    CONTEXT_COMPACTION.maxSummaryTokens,
  )

  // Retain at least the tail floor. If the whole Session is shorter than that,
  // there is nothing safe to collapse yet.
  let retained = retainedTokens(sorted, end + 1)
  while (retained < CONTEXT_COMPACTION.tailFloorTokens && end > 0) {
    end = legalCutIndex(sorted, end - 1)
    windowUnits = sorted.slice(0, end + 1).filter(unit => unit.seq > frontier)
    retained = retainedTokens(sorted, end + 1)
  }
  if (retained < CONTEXT_COMPACTION.tailFloorTokens) return { ok: false, reason: 'tail-floor' }
  if (windowUnits.length < CONTEXT_COMPACTION.minTurns) return { ok: false, reason: 'too-few-turns' }

  const windowTokens = windowUnits.reduce((sum, unit) => sum + estimateContextTokens(unit.text), 0)
  if (windowTokens < CONTEXT_COMPACTION.minWindowTokens) return { ok: false, reason: 'below-minimum-window' }

  const expectedRemainingRequests = clamp(
    Math.round(options.expectedRemainingRequests ?? 20),
    CONTEXT_COMPACTION.expectedRequestsFloor,
    CONTEXT_COMPACTION.expectedRequestsCeiling,
  )
  const savingsTokens = windowTokens - summaryTokens
  const nextCost = retained + summaryTokens
  if (savingsTokens * expectedRemainingRequests <= CONTEXT_COMPACTION.costRatio * nextCost) {
    return { ok: false, reason: 'not-cost-effective' }
  }

  const plan: ContextCompactionPlan = {
    fromSeq: windowUnits[0]!.seq,
    toSeq: windowUnits[windowUnits.length - 1]!.seq,
    unitCount: windowUnits.length,
    windowTokens,
    retainedTokens: retained,
    expectedRemainingRequests,
    savingsTokens,
  }
  return { ok: true, plan }
}

/** Never cut between an assistant tool call and the tool result that follows it. */
function legalCutIndex(units: readonly StoredContextUnit[], index: number): number {
  let cut = index
  while (cut >= 0 && units[cut + 1]?.role === 'tool') cut -= 1
  return cut
}

function retainedTokens(units: readonly StoredContextUnit[], start: number): number {
  return units.slice(Math.max(0, start)).reduce((sum, unit) => sum + estimateContextTokens(unit.text), 0)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Render the bounded digest input; decisions are kept before bulk dialogue. */
export function compactionInput(
  units: readonly StoredContextUnit[],
  maxTokens: number = CONTEXT_COMPACTION.maxDigestInputTokens,
): string {
  const budget = maxTokens * 4
  let used = 0
  const lines: string[] = []
  const decisions = units.filter(unit => unit.kind === 'decision')
  const rest = units.filter(unit => unit.kind !== 'decision')
  for (const unit of [...decisions, ...rest]) {
    const limit = unit.kind === 'decision' ? 1_200 : unit.role === 'tool' ? 400 : 900
    const body = unit.text.length <= limit ? unit.text : `${unit.text.slice(0, limit)}…`
    const line = `[${unit.seq} ${unit.role}/${unit.kind}] ${body}`
    if (used + line.length > budget) continue
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

/** Extract the first balanced JSON object from a model reply. */
export function parseDigestReply(text: string): ContextDigest {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('digest reply has no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const summary = requireString(parsed.summary, 'summary')
  const decisions = requireStringArray(parsed.decisions, 'decisions')
  const commitments = requireStringArray(parsed.commitments, 'commitments')
  const openLoops = requireStringArray(parsed.openLoops, 'openLoops')
  const cappedSummary = summary.length > CONTEXT_COMPACTION.maxSummaryTokens * 4
    ? `${summary.slice(0, CONTEXT_COMPACTION.maxSummaryTokens * 4 - 1)}…`
    : summary
  return {
    summary: cappedSummary,
    decisions: decisions.map(item => item.slice(0, 400)),
    commitments: commitments.map(item => item.slice(0, 400)),
    openLoops: openLoops.map(item => item.slice(0, 400)),
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`digest field "${field}" must be a string`)
  return value
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`digest field "${field}" must be a string array`)
  }
  return value
}

/** Keep only commitments whose quote is a verbatim substring of a source unit. */
export function validateCommitments(
  units: readonly StoredContextUnit[],
  items: readonly { kind?: unknown; text?: unknown; quote?: unknown }[],
): ContextPendingCommitment[] {
  const accepted: ContextPendingCommitment[] = []
  for (const item of items) {
    if (typeof item.text !== 'string' || typeof item.quote !== 'string' || item.quote.length === 0) continue
    const kind = item.kind === 'decision' ? 'decision' : 'commitment'
    const source = units.find(unit => unit.text.includes(item.quote as string))
    if (source === undefined) continue
    accepted.push({
      kind,
      text: item.text,
      quote: item.quote,
      quoteHash: createHash('sha256').update(item.quote).digest('hex'),
      ref: source.unitId,
    })
  }
  return accepted
}

export function digestHash(digest: ContextDigest): string {
  return createHash('sha256').update(JSON.stringify(digest)).digest('hex')
}

export interface PrepareEpochOptions {
  readonly memberId: string
  readonly sessionId: string
  readonly frontierSeq?: number
  readonly expectedRemainingRequests?: number
  readonly signal?: AbortSignal
  readonly now?: Date
  readonly summarize: (input: { text: string; units: readonly StoredContextUnit[] }) => Promise<ContextDigest>
  readonly extractCommitments?: (
    input: { text: string; units: readonly StoredContextUnit[] },
  ) => Promise<readonly { kind?: unknown; text?: unknown; quote?: unknown }[]>
}

export type PrepareEpochOutcome =
  | { readonly ok: true; readonly pending: ContextEpochPending; readonly reused: boolean; readonly plan: ContextCompactionPlan }
  | { readonly ok: false; readonly reason: string }

/**
 * Pre-generate the digest for the next epoch and park it in the store. This is
 * the expensive step; it is intentionally separate from the commit point.
 */
export async function prepareEpoch(store: ContextStore, options: PrepareEpochOptions): Promise<PrepareEpochOutcome> {
  const epoch = store.getEpoch(options.memberId, options.sessionId)
  const units = store.listUnits(options.memberId, options.sessionId)
  const planned = planContextCompaction(units, {
    frontierSeq: options.frontierSeq ?? epoch.frontierSeq,
    ...(options.expectedRemainingRequests === undefined ? {} : { expectedRemainingRequests: options.expectedRemainingRequests }),
  })
  if (!planned.ok) return planned

  if (epoch.pending !== undefined
    && epoch.pending.fromSeq === planned.plan.fromSeq
    && epoch.pending.toSeq === planned.plan.toSeq
    && digestHash(epoch.pending.digest) === epoch.pending.hash) {
    return { ok: true, pending: epoch.pending, reused: true, plan: planned.plan }
  }

  const window = units.filter(unit => unit.seq >= planned.plan.fromSeq && unit.seq <= planned.plan.toSeq)
  const text = compactionInput(window)
  const digest = await options.summarize({ text, units: window })
  const rawCommitments = options.extractCommitments === undefined
    ? []
    : await options.extractCommitments({ text, units: window })
  const commitments = validateCommitments(window, rawCommitments)
  const hash = digestHash(digest)
  const at = options.now ?? new Date()
  const saved = store.savePendingEpoch({
    memberId: options.memberId,
    sessionId: options.sessionId,
    digest,
    commitments,
    hash,
    fromSeq: planned.plan.fromSeq,
    toSeq: planned.plan.toSeq,
    now: at,
  })
  if (saved.pending === undefined) throw new Error('pending epoch disappeared after save')
  return { ok: true, pending: saved.pending, reused: false, plan: planned.plan }
}

export interface ContextCompactor {
  compactPrepared(input: {
    readonly fromSeq: number
    readonly toSeq: number
    readonly summary: string
    readonly signal?: AbortSignal
  }): Promise<void>
}

export type CommitEpochOutcome =
  | { readonly ok: true; readonly segment: ContextSegmentRecord }
  | { readonly ok: false; readonly reason: string }

/**
 * Commit point: no model call. The digest prepared earlier is written to the
 * compaction engine, then the L2 segment and its commitments become durable.
 */
export async function commitPreparedEpoch(
  store: ContextStore,
  options: {
    readonly memberId: string
    readonly sessionId: string
    readonly compactor: ContextCompactor
    readonly signal?: AbortSignal
    readonly now?: Date
  },
): Promise<CommitEpochOutcome> {
  const epoch = store.getEpoch(options.memberId, options.sessionId)
  const pending = epoch.pending
  if (pending === undefined) return { ok: false, reason: 'no-pending' }
  if (digestHash(pending.digest) !== pending.hash) {
    store.clearPendingEpoch(options.memberId, options.sessionId)
    return { ok: false, reason: 'stale-pending' }
  }
  if (epoch.frontierSeq >= pending.fromSeq) {
    store.clearPendingEpoch(options.memberId, options.sessionId)
    return { ok: false, reason: 'stale-pending' }
  }

  await options.compactor.compactPrepared({
    fromSeq: pending.fromSeq,
    toSeq: pending.toSeq,
    summary: pending.digest.summary,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const input: ContextSegmentInput = {
    memberId: options.memberId,
    sessionId: options.sessionId,
    fromSeq: pending.fromSeq,
    toSeq: pending.toSeq,
    frontierSeq: pending.toSeq,
    digest: pending.digest,
    digestHash: pending.hash,
    label: `summary ${pending.fromSeq}-${pending.toSeq}`,
    validFrom: pending.preparedAt,
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  const commitments = pending.commitments.map(commitment => ({
    ...commitment,
    memberId: options.memberId,
    sessionId: options.sessionId,
    segmentId: `seg:${options.sessionId}:${pending.fromSeq}-${pending.toSeq}`,
    validFrom: pending.preparedAt,
  }))
  const segment = store.commitSegment(input, commitments)
  return { ok: true, segment }
}

/** Read cache for a committed window; the digest is reused without a model call. */
export function committedDigestForSeq(
  store: ContextStore,
  memberId: string,
  sessionId: string,
  seq: number,
): ContextDigest | undefined {
  return store.segmentForSeq(memberId, sessionId, seq)?.digest
}
