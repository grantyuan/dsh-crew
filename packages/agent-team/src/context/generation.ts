/**
 * L3 generation rollups.
 *
 * A generation is one Session. Its summary is built deterministically from the
 * committed L2 digests (or, for a short generation without segments, from the
 * L1 units) and written only into the derived graph. It never rewrites the
 * surface or the Session log, so producing or refreshing it costs no provider
 * cache and needs no compaction cost gate.
 * @module @grantyuan/dsh-crew/context/generation
 */

import type { ContextStore, StoredContextUnit } from './store.ts'
import type { ContextGenerationRecord, ContextSegmentRecord } from './types.ts'

/** L3 bounds; the 600-token cap is expressed as characters for local budgeting. */
export const CONTEXT_GENERATION = {
  maxSummaryChars: 2_400,
  segmentLabelChars: 120,
  unitExcerptChars: 200,
  segmentConfidence: 0.8,
  unitConfidence: 0.6,
} as const

/** Stable generation identity, independent of graph node ids. */
export function generationRef(sessionId: string): string {
  return `gen:${sessionId}`
}

/** Deterministic L3 graph node id for one Session generation. */
export function generationNodeId(sessionId: string): string {
  return `mn:${generationRef(sessionId)}`
}

/** Deterministic L2 graph node id for one committed segment. */
export function segmentNodeId(segmentId: string): string {
  return `mn:${segmentId}`
}

export interface BuildGenerationSummaryInput {
  readonly sessionId: string
  readonly segments: readonly ContextSegmentRecord[]
  readonly units: readonly StoredContextUnit[]
}

export interface GenerationSummary {
  readonly summary: string
  readonly confidence: number
  readonly validFrom: string
}

/**
 * Build a bounded generation summary. Decisions are appended verbatim and
 * never re-summarized; the window prose only fills the remaining budget.
 */
export function buildGenerationSummary(input: BuildGenerationSummaryInput): GenerationSummary | undefined {
  const segments = [...input.segments].sort((left, right) => left.fromSeq - right.fromSeq)
  const units = [...input.units].sort((left, right) => left.seq - right.seq)
  if (segments.length === 0 && units.length === 0) return undefined

  const old = segments[0]?.validFrom ?? units[0]?.recordedAt ?? new Date(0).toISOString()
  const confidence = segments.length > 0 ? CONTEXT_GENERATION.segmentConfidence : CONTEXT_GENERATION.unitConfidence
  const decisions: string[] = []
  const commitments: string[] = []
  const openLoops: string[] = []
  const prose: string[] = []
  const seenDecision = new Set<string>()

  if (segments.length > 0) {
    for (const segment of segments) {
      for (const decision of segment.digest.decisions) {
        if (decision.trim() === '' || seenDecision.has(decision)) continue
        seenDecision.add(decision)
        decisions.push(decision)
      }
      for (const commitment of segment.digest.commitments) commitments.push(commitment)
      for (const loop of segment.digest.openLoops) openLoops.push(loop)
      if (segment.digest.summary.trim() !== '') prose.push(segment.digest.summary)
    }
  } else {
    for (const unit of units) {
      if (unit.kind === 'decision') {
        if (seenDecision.has(unit.text)) continue
        seenDecision.add(unit.text)
        decisions.push(unit.text)
      } else if (unit.importance >= 2 && unit.text.trim() !== '') {
        prose.push(excerpt(unit.text, CONTEXT_GENERATION.unitExcerptChars))
      }
    }
  }

  const header = segments.length > 0
    ? `Generation ${input.sessionId}: ${segments.length} window(s), seq ${segments[0]!.fromSeq}-${segments[segments.length - 1]!.toSeq}.`
    : `Generation ${input.sessionId}: ${units.length} unit(s), seq ${units[0]!.seq}-${units[units.length - 1]!.seq}.`
  const lines = [header]
  appendSection(lines, 'Decisions', decisions)
  appendSection(lines, 'Commitments', commitments)
  appendSection(lines, 'Open', openLoops)
  appendSection(lines, segments.length > 0 ? 'Windows' : 'Context', prose)
  return { summary: lines.join('\n'), confidence, validFrom: old }
}

/**
 * Build or refresh the L2 nodes, the L3 generation node, and the
 * `derived_from` edges that roll the segments up into the generation.
 * Idempotent; returns `undefined` when the generation has no indexed content.
 */
export function rollupGeneration(
  store: ContextStore,
  memberId: string,
  sessionId: string,
  options: { readonly now?: Date } = {},
): ContextGenerationRecord | undefined {
  const segments = store.listSegments(memberId, sessionId)
  const units = store.listUnits(memberId, sessionId)
  const built = buildGenerationSummary({ sessionId, segments, units })
  if (built === undefined) return undefined

  const now = options.now ?? new Date()
  const segmentRefs: string[] = []
  for (const segment of segments) {
    store.upsertNode({
      nodeId: segmentNodeId(segment.segmentId),
      memberId,
      sessionId,
      level: 'L2',
      kind: 'summary',
      label: excerpt(segment.digest.summary, CONTEXT_GENERATION.segmentLabelChars),
      ref: segment.segmentId,
      status: segment.status,
      confidence: CONTEXT_GENERATION.segmentConfidence,
      validFrom: segment.validFrom,
      ...(segment.validTo === undefined ? {} : { validTo: segment.validTo }),
      now,
    })
    segmentRefs.push(segment.segmentId)
  }

  const ref = generationRef(sessionId)
  store.upsertNode({
    nodeId: generationNodeId(sessionId),
    memberId,
    sessionId,
    level: 'L3',
    kind: 'generation',
    label: built.summary,
    ref,
    confidence: built.confidence,
    validFrom: built.validFrom,
    now,
  })
  for (const segmentId of segmentRefs) {
    store.upsertEdge({
      memberId,
      srcId: generationNodeId(sessionId),
      dstId: segmentNodeId(segmentId),
      kind: 'derived_from',
      weight: 1,
      validFrom: built.validFrom,
      now,
    })
  }
  return {
    ref,
    sessionId,
    summary: built.summary,
    confidence: built.confidence,
    validFrom: built.validFrom,
    segments: segmentRefs,
  }
}

/** Read existing generation rollups without creating or refreshing them. */
export function readGenerationSummaries(
  store: ContextStore,
  memberId: string,
  sessionIds: readonly string[],
): ContextGenerationRecord[] {
  return store.generationSummaries(memberId, sessionIds)
}

function appendSection(lines: string[], title: string, values: readonly string[]): void {
  if (values.length === 0) return
  const section = [title]
  let used = lines.join('\n').length + 1 + title.length
  for (const value of values) {
    const line = `- ${value}`
    if (used + line.length + 1 > CONTEXT_GENERATION.maxSummaryChars) break
    section.push(line)
    used += line.length + 1
  }
  if (section.length > 1) lines.push(...section)
}

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
