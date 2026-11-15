/**
 * Live-session intake and background scheduling for the derived context index.
 *
 * The turn path only ever writes the unit row: no model is awaited on a
 * Session event, and the pre-step commit reads an already prepared digest.
 * Embeddings and the next L2 epoch are scheduled on the idle boundary, so a
 * slow or disabled role degrades recall instead of stalling a turn.
 * @module @grantyuan/dsh-crew/context/pipeline
 */

import type { AgentTeamModelSelection } from '../types.ts'
import {
  commitPreparedEpoch,
  digestHash,
  parseDigestReply,
  prepareEpoch,
  type CommitEpochOutcome,
  type PrepareEpochOutcome,
} from './compaction.ts'
import { ContextCoordinator, type ContextEnrichmentRuntime } from './coordinator.ts'
import { rollupGeneration as rollupGenerationInStore } from './generation.ts'
import { contextUnitFromEvent, type SessionEventLike } from './intake.ts'
import type { ContextRoleEmbeddingOutcome } from './role-runtime.ts'
import type { ContextService } from './service.ts'
import type { ContextDigest, ContextUnitInput } from './types.ts'

/** The runtime surface background indexing needs; both calls are best-effort. */
export interface ContextPipelineRuntime extends ContextEnrichmentRuntime {
  embed(
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal; readonly key?: string },
  ): Promise<ContextRoleEmbeddingOutcome>
}

export interface ContextPipelineOptions {
  readonly service: ContextService
  readonly runtime?: ContextPipelineRuntime
  readonly main?: (memberId: string) => AgentTeamModelSelection | undefined
  /** Feature gate: no index writes, embeddings, or enrichment while every context role is off. */
  readonly canIndex?: () => boolean
  /** Async extraction runs only when a generative context role is on. */
  readonly canEnrich?: () => boolean
  readonly canSummarize?: () => boolean
  readonly canEmbed?: () => boolean
  readonly now?: () => Date
  readonly onError?: (error: unknown, stage: string) => void
  /** Failed-embedding cooldown; defaults to 30 s (5 min when the role is off). */
  readonly embeddingBackoffMs?: number
}

export interface ContextEmbeddingDrainResult {
  readonly claimed: number
  readonly embedded: number
  readonly failed: number
}

interface QueryVector {
  readonly text: string
  readonly values: Float32Array
}

const EMPTY_EMBEDDING_DRAIN: ContextEmbeddingDrainResult = { claimed: 0, embedded: 0, failed: 0 }

/**
 * Deterministic commitments: the digest's own decision/commitment lines are the
 * quotes, and validation drops any that the window does not contain verbatim.
 */
function commitmentsFromDigest(digest: ContextDigest): readonly { kind: string; text: string; quote: string }[] {
  const raw: { kind: string; text: string; quote: string }[] = []
  for (const text of digest.decisions) raw.push({ kind: 'decision', text, quote: text })
  for (const text of digest.commitments) raw.push({ kind: 'commitment', text, quote: text })
  return raw
}

export class ContextPipeline {
  private readonly service: ContextService
  private readonly coordinator: ContextCoordinator
  private readonly options: ContextPipelineOptions
  private readonly preparedSummaries = new Map<string, string>()
  private readonly queryVectors = new Map<string, QueryVector>()
  private readonly queryInFlight = new Set<string>()
  /** Last Session seen per Member; a change means the previous generation closed. */
  private readonly sessionByMember = new Map<string, string>()
  private embedding = false
  private preparing = false
  private embeddingBackoffUntil = 0

  constructor(options: ContextPipelineOptions) {
    this.options = options
    this.service = options.service
    const store = options.service.contextStore()
    this.coordinator = new ContextCoordinator({
      store: store!,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.main === undefined ? {} : { main: options.main }),
      ...(options.canEnrich === undefined ? {} : { enrichmentEnabled: options.canEnrich }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onError === undefined ? {} : { onError: error => options.onError?.(error, 'enrichment') }),
    })
  }

  get available(): boolean {
    return this.service.contextStore() !== undefined
  }

  private fail(error: unknown, stage: string): void {
    this.options.onError?.(error, stage)
  }

  /** Index one live Session event. Synchronous and model-free on the turn path. */
  recordSessionEvent(memberId: string, sessionId: string, event: SessionEventLike): void {
    if (!this.available || this.options.canIndex?.() === false) return
    const previous = this.sessionByMember.get(memberId)
    if (previous !== sessionId) {
      this.sessionByMember.set(memberId, sessionId)
      if (previous !== undefined) this.rollupGeneration(memberId, previous)
    }
    const input: ContextUnitInput | undefined = contextUnitFromEvent(
      memberId,
      sessionId,
      event,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
    if (input === undefined) return
    try {
      this.coordinator.record(input)
    } catch (error) {
      this.fail(error, 'intake')
      return
    }
    if (input.role === 'user') void this.primeQueryVector(memberId, input.text)
    void this.drainEmbeddings(memberId)
    void this.drainEnrichment()
  }

  /** Fire-and-forget enrichment drain; the coordinator ignores re-entrant calls. */
  async drainEnrichment(): Promise<void> {
    if (!this.available || this.options.canIndex?.() === false) return
    try {
      await this.coordinator.drainEnrichment()
    } catch (error) {
      this.fail(error, 'enrichment')
    }
  }

  /**
   * Refresh one generation's L3 rollup. Deterministic and model-free, so it can
   * run on the idle boundary or when a generation closes without touching the
   * surface or the provider cache.
   */
  rollupGeneration(memberId: string, sessionId: string): void {
    const store = this.service.contextStore()
    if (store === undefined) return
    try {
      rollupGenerationInStore(store, memberId, sessionId, this.options.now === undefined ? {} : { now: this.options.now() })
    } catch (error) {
      this.fail(error, 'generation-rollup')
    }
  }

  /**
   * Embed due units for one Member. A disabled or failing role parks the queue
   * and retries later; the write never waits on this.
   */
  async drainEmbeddings(memberId: string): Promise<ContextEmbeddingDrainResult> {
    const store = this.service.contextStore()
    const runtime = this.options.runtime
    if (store === undefined || runtime === undefined || this.embedding) return EMPTY_EMBEDDING_DRAIN
    if (this.options.canEmbed?.() === false) return EMPTY_EMBEDDING_DRAIN
    const now = (this.options.now?.() ?? new Date()).getTime()
    if (now < this.embeddingBackoffUntil) return EMPTY_EMBEDDING_DRAIN
    this.embedding = true
    try {
      const units = store.pendingVectorUnits(8, memberId)
      if (units.length === 0) return EMPTY_EMBEDDING_DRAIN
      const outcome = await runtime.embed(units.map(unit => unit.text), { key: memberId })
      if (!outcome.ok) {
        const off = outcome.kind === 'lexical' || outcome.kind === 'role-off'
        this.embeddingBackoffUntil = now + (off ? 300_000 : this.options.embeddingBackoffMs ?? 30_000)
        return { claimed: units.length, embedded: 0, failed: units.length }
      }
      if (outcome.vectors.length !== units.length) {
        this.embeddingBackoffUntil = now + (this.options.embeddingBackoffMs ?? 30_000)
        return { claimed: units.length, embedded: 0, failed: units.length }
      }
      const at = this.options.now?.() ?? new Date()
      units.forEach((unit, index) => store.upsertVector(unit.unitId, outcome.modelId, outcome.vectors[index]!, at))
      return { claimed: units.length, embedded: units.length, failed: 0 }
    } catch (error) {
      this.embeddingBackoffUntil = now + (this.options.embeddingBackoffMs ?? 30_000)
      this.fail(error, 'embedding')
      return { claimed: 0, embedded: 0, failed: 1 }
    } finally {
      this.embedding = false
    }
  }

  /** Embed one user query for the next pre-step; duplicate texts share a call. */
  async primeQueryVector(memberId: string, text: string): Promise<void> {
    const runtime = this.options.runtime
    if (runtime === undefined || this.options.canEmbed?.() === false) return
    const key = `${memberId}\u0000${text}`
    if (this.queryInFlight.has(key) || this.queryVectors.get(memberId)?.text === text) return
    this.queryInFlight.add(key)
    try {
      const outcome = await runtime.embed([text], { key: memberId })
      if (outcome.ok && outcome.vectors[0] !== undefined) {
        this.queryVectors.set(memberId, { text, values: outcome.vectors[0] })
      }
    } catch (error) {
      this.fail(error, 'query-embedding')
    } finally {
      this.queryInFlight.delete(key)
    }
  }

  /** The query vector only applies when the caller's text is the one embedded. */
  queryVector(memberId: string, text: string): Float32Array | undefined {
    const cached = this.queryVectors.get(memberId)
    return cached !== undefined && cached.text === text ? cached.values : undefined
  }

  /**
   * Generate the next L2 digest. Idle-only: the model call is background work,
   * never awaited by a turn. An unchanged pending digest is reused for free.
   */
  async prepare(memberId: string, sessionId: string, signal?: AbortSignal): Promise<PrepareEpochOutcome> {
    if (this.options.canSummarize?.() === false) return { ok: false, reason: 'assistant-role-off' }
    const runtime = this.options.runtime
    if (runtime === undefined) return { ok: false, reason: 'no-runtime' }
    if (this.preparing) return { ok: false, reason: 'busy' }
    this.preparing = true
    try {
      let digest: ContextDigest | undefined
      const main = this.options.main?.(memberId)
      const outcome = await this.service.prepareCompaction({
        memberId,
        sessionId,
        ...(signal === undefined ? {} : { signal }),
        ...(this.options.now === undefined ? {} : { now: this.options.now() }),
        summarize: async ({ text }) => {
          const reply = await runtime.chat('assistant', 'summarize', { text }, {
            priority: 'background',
            key: memberId,
            ...(main === undefined ? {} : { main }),
            ...(signal === undefined ? {} : { signal }),
          })
          if (!reply.ok) throw new Error(reply.reason)
          digest = parseDigestReply(reply.text)
          return digest
        },
        extractCommitments: async () => digest === undefined ? [] : commitmentsFromDigest(digest),
      })
      return outcome
    } catch (error) {
      this.fail(error, 'prepare-compaction')
      return { ok: false, reason: 'prepare-failed' }
    } finally {
      this.preparing = false
    }
  }

  /**
   * Commit point: reads the pending digest and parks its summary for the next
   * compaction engine. No model call, so a pre-step may await it.
   */
  async commit(memberId: string, sessionId: string): Promise<CommitEpochOutcome> {
    const before = this.service.contextStore()?.getEpoch(memberId, sessionId).pending
    const outcome = await this.service.commitCompaction({
      memberId,
      sessionId,
      compactor: {
        compactPrepared: async ({ summary }) => {
          this.preparedSummaries.set(memberId, summary)
        },
      },
    })
    if (!outcome.ok && before !== undefined) this.preparedSummaries.delete(memberId)
    return outcome
  }

  /** Consume the committed summary exactly once; the engine installs it at construction. */
  takePreparedSummary(memberId: string): string | undefined {
    const summary = this.preparedSummaries.get(memberId)
    this.preparedSummaries.delete(memberId)
    return summary
  }

  /** Whether a digest is parked for the next commit, without loading its body. */
  hasPending(memberId: string, sessionId: string): boolean {
    return this.service.contextStore()?.getEpoch(memberId, sessionId).pending !== undefined
  }

  /** Guard used by tests and diagnostics: the parked digest verifies against its hash. */
  pendingIsFresh(memberId: string, sessionId: string): boolean {
    const pending = this.service.contextStore()?.getEpoch(memberId, sessionId).pending
    return pending !== undefined && digestHash(pending.digest) === pending.hash
  }
}
