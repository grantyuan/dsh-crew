/**
 * Unit identity and preparation.
 *
 * A context unit is one message-producing Session event. Its identity is
 * `cu:<sessionId>:<seq>`, which is stable across rebuilds and independent of
 * the Session log's own position on another Member. Preparation runs the
 * zero-model rules so callers only deal with one ready-to-write record.
 * @module @grantyuan/dsh-crew/context/units
 */

import { createHash } from 'node:crypto'
import { charLength } from './keywords.ts'
import { extractContextRules, normalizeUnitText } from './extract-rules.ts'
import type { ContextUnitInput, ContextUnitRecord } from './types.ts'

/** Stable unit identity: Session plus its append-only event index. */
export function contextUnitId(sessionId: string, seq: number): string {
  return `cu:${sessionId}:${seq}`
}

/** SHA-256 of the normalized text; the idempotency key for rewrites. */
export function contextUnitHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface BuildContextUnitOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

/** Build the complete, write-ready unit record from one Session event. */
export function buildContextUnit(input: ContextUnitInput, options: BuildContextUnitOptions = {}): ContextUnitRecord {
  const text = normalizeUnitText(input.text)
  const extraction = extractContextRules({
    text,
    role: input.role,
    recordedAt: input.recordedAt,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
  })
  return {
    unitId: contextUnitId(input.sessionId, input.seq),
    memberId: input.memberId,
    sessionId: input.sessionId,
    seq: input.seq,
    role: input.role,
    kind: extraction.kind,
    importance: extraction.importance,
    text,
    textHash: contextUnitHash(text),
    chars: charLength(text),
    recordedAt: input.recordedAt,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    keywords: extraction.keywords,
    facets: extraction.facets,
  }
}

/**
 * Whether the asynchronous `extraction` role should look at this unit.
 * The design's trigger is `importance >= 2` or an entity cue; a rule subject
 * facet is the cheapest deterministic form of the latter.
 */
export function shouldEnrichUnit(unit: ContextUnitRecord): boolean {
  if (unit.importance >= 2) return true
  return unit.facets.some(facet => facet.dimension === 'subject' || facet.dimension === 'space')
}
