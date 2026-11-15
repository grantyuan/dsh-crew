/**
 * Synchronous unit intake plus the asynchronous enrichment drain.
 *
 * `record` is the only path a Session event needs: it runs the zero-model
 * rules, writes the unit transactionally, and leaves an outbox row when the
 * unit deserves a model pass. `drainEnrichment` is always optional work — a
 * missing, disabled or failing role never blocks or fails the write.
 * @module @grantyuan/dsh-crew/context/coordinator
 */

import type { AgentTeamModelSelection } from '../types.ts'
import { facetsFromEnrichment } from './facets.ts'
import { normalizeTerm } from './keywords.ts'
import type { ContextModelRole } from './role-models.ts'
import type { ContextRoleTask } from './prompts/role-prompts.ts'
import type { ContextRoleChatOptions, ContextRoleChatOutcome } from './role-runtime.ts'
import type { ContextStore } from './store.ts'
import type {
  ContextKeyword,
  ContextUnitEnrichment,
  ContextUnitInput,
  ContextUnitWriteResult,
} from './types.ts'
import { buildContextUnit, shouldEnrichUnit } from './units.ts'

/** The narrow runtime surface the coordinator needs. */
export interface ContextEnrichmentRuntime {
  chat(
    role: Exclude<ContextModelRole, 'embedding'>,
    task: ContextRoleTask,
    payload: unknown,
    options?: ContextRoleChatOptions,
  ): Promise<ContextRoleChatOutcome>
}

export interface ContextCoordinatorOptions {
  readonly store: ContextStore
  readonly runtime?: ContextEnrichmentRuntime
  readonly main?: (memberId: string) => AgentTeamModelSelection | undefined
  /**
   * Async extraction is opt-in with the generative roles. While it is off, no
   * outbox row is written, so a default configuration never spends a main-model
   * call on background facets.
   */
  readonly enrichmentEnabled?: () => boolean
  readonly now?: () => Date
  readonly onError?: (error: unknown) => void
  /** Delay before a failed enrichment row is retried; defaults to 30 s. */
  readonly enrichmentBackoffMs?: number
}

export interface DrainEnrichmentOptions {
  readonly limit?: number
  readonly signal?: AbortSignal
}

export interface ContextEnrichmentDrainResult {
  readonly claimed: number
  readonly applied: number
  readonly failed: number
  readonly deferred: number
  readonly dropped: number
}

interface OutboxPayload {
  readonly ref?: string
  readonly text?: string
  readonly keywords?: readonly string[]
  readonly facets?: readonly { readonly dimension?: string; readonly value?: string; readonly raw?: string }[]
}

const EMPTY_DRAIN: ContextEnrichmentDrainResult = { claimed: 0, applied: 0, failed: 0, deferred: 0, dropped: 0 }

function readStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || strings.includes(trimmed)) continue
    strings.push(trimmed.slice(0, 200))
    if (strings.length >= limit) break
  }
  return strings
}

function parseTime(value: unknown): { startMs: number; endMs: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { start?: unknown; end?: unknown }
  const start = typeof record.start === 'string' ? Date.parse(record.start) : Number.NaN
  const end = typeof record.end === 'string' ? Date.parse(record.end) : Number.NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { startMs: start, endMs: end }
  if (Number.isFinite(start)) return { startMs: start, endMs: start + 3_600_000 }
  if (Number.isFinite(end)) return { startMs: end - 3_600_000, endMs: end }
  return undefined
}

/**
 * Parse the `enrich` role's JSON reply. Anything unrecognizable is `undefined`
 * so the caller can count a failed attempt instead of writing junk facets.
 */
export function parseContextEnrichment(text: string): ContextUnitEnrichment | undefined {
  const stripped = text.replace(/```(?:json)?/giu, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as { subjects?: unknown; topics?: unknown; roles?: unknown; time?: unknown; confidence?: unknown }
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0.5
  const time = parseTime(record.time)
  return {
    subjects: readStringArray(record.subjects, 8),
    topics: readStringArray(record.topics, 8),
    roles: readStringArray(record.roles, 6),
    confidence,
    ...(time === undefined ? {} : { time }),
  }
}

function parseOutboxPayload(payload: string): OutboxPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as OutboxPayload
  } catch {
    return undefined
  }
}

/** Model topics double as lexical keywords; rule terms already present win. */
function topicKeywords(topics: readonly string[]): ContextKeyword[] {
  const keywords: ContextKeyword[] = []
  for (const topic of topics) {
    const term = normalizeTerm(topic)
    if (term === '' || keywords.some(keyword => keyword.term === term)) continue
    keywords.push({ term, kind: 'term', weight: 0.5, source: 'model' })
  }
  return keywords
}

export class ContextCoordinator {
  private readonly store: ContextStore
  private readonly options: ContextCoordinatorOptions
  private draining = false

  constructor(options: ContextCoordinatorOptions) {
    this.store = options.store
    this.options = options
  }

  private failRow(id: number, message: string): { dropped: boolean; attempts: number } {
    return this.store.failOutbox(
      id,
      message,
      this.options.enrichmentBackoffMs === undefined ? {} : { backoffMs: this.options.enrichmentBackoffMs },
    )
  }

  /** Write one Session event into the L1 index. Never calls a model. */
  record(input: ContextUnitInput): ContextUnitWriteResult {
    const unit = buildContextUnit(input, this.options.now === undefined ? {} : { now: this.options.now })
    const enqueueEnrichment = this.options.enrichmentEnabled?.() !== false && shouldEnrichUnit(unit)
    return this.store.writeUnit(unit, { enqueueEnrichment })
  }

  /**
   * Run due enrichment rows once. Re-entrant calls are ignored so a periodic
   * trigger and an explicit retry cannot process the same row twice.
   */
  async drainEnrichment(options: DrainEnrichmentOptions = {}): Promise<ContextEnrichmentDrainResult> {
    if (this.draining || this.options.enrichmentEnabled?.() === false) return EMPTY_DRAIN
    this.draining = true
    try {
      const limit = Math.max(1, Math.min(32, options.limit ?? 8))
      const rows = this.store.claimEnrichment(limit)
      if (rows.length === 0) return EMPTY_DRAIN
      const runtime = this.options.runtime
      if (runtime === undefined) {
        for (const row of rows) this.store.deferOutbox(row.id)
        return { ...EMPTY_DRAIN, claimed: rows.length, deferred: rows.length }
      }

      let applied = 0
      let failed = 0
      let deferred = 0
      let dropped = 0

      for (const row of rows) {
        if (options.signal?.aborted === true) break
        const payload = parseOutboxPayload(row.payload)
        if (payload?.text === undefined) {
          const outcome = this.failRow(row.id, 'outbox payload has no text')
          if (outcome.dropped) dropped += 1
          else failed += 1
          continue
        }

        const main = this.options.main?.(row.memberId)
        let outcome: ContextRoleChatOutcome
        try {
          outcome = await runtime.chat('extraction', 'enrich', {
            ref: row.unitId,
            text: payload.text,
            keywords: payload.keywords ?? [],
            facets: payload.facets ?? [],
          }, {
            priority: 'background',
            key: row.memberId,
            ...(main === undefined ? {} : { main }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          })
        } catch (error) {
          this.options.onError?.(error)
          const result = this.failRow(row.id, error instanceof Error ? error.message : 'enrichment call failed')
          if (result.dropped) dropped += 1
          else failed += 1
          continue
        }

        if (!outcome.ok) {
          if (outcome.kind === 'role-off' || outcome.kind === 'queue-full') {
            this.store.deferOutbox(row.id)
            deferred += 1
          } else {
            const result = this.failRow(row.id, outcome.reason)
            if (result.dropped) dropped += 1
            else failed += 1
          }
          continue
        }

        const enrichment = parseContextEnrichment(outcome.text)
        if (enrichment === undefined) {
          const result = this.failRow(row.id, 'enrichment response was not valid JSON')
          if (result.dropped) dropped += 1
          else failed += 1
          continue
        }

        this.store.applyEnrichment(row.unitId, {
          keywords: topicKeywords(enrichment.topics),
          facets: facetsFromEnrichment(enrichment),
        })
        this.store.completeOutbox(row.id)
        applied += 1
      }

      return { claimed: rows.length, applied, failed, deferred, dropped }
    } finally {
      this.draining = false
    }
  }
}
