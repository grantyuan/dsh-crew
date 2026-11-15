/**
 * Host-owned facade over the derived context index.
 *
 * The service is the only place that knows the database path and the failure
 * policy: an unreadable index is reported as `index-unavailable` rather than
 * surfacing a SQLite error into a turn or a tool result. Recall remains
 * synchronous and model-free so `agent/pre-step` never waits on a role.
 * @module @grantyuan/dsh-crew/context/service
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  commitPreparedEpoch,
  prepareEpoch,
  type CommitEpochOutcome,
  type ContextCompactor,
  type PrepareEpochOptions,
  type PrepareEpochOutcome,
} from './compaction.ts'
import { recallContext, type ContextRecallQuery, type ContextRecallResult } from './recall.ts'
import { renderRecallSnapshot, type ContextRecallSnapshot } from './recall-snapshot.ts'
import { readContextSource, type ContextReadRequest, type ContextReadResult } from './read.ts'
import { reviewContext } from './review.ts'
import { ContextStore } from './store.ts'
import type { ContextReviewRequest, ContextReviewResult } from './types.ts'

/** Per-Host derived context database. Rebuildable; safe to delete while stopped. */
export function contextDatabasePath(): string {
  return dshHomePath('agent-team', 'context', 'v1.sqlite')
}

export interface ContextServiceOptions {
  readonly path?: string
  readonly onError?: (error: unknown, stage: string) => void
  /** Skip FTS; only tests use this. */
  readonly disableFts?: boolean
}

export class ContextService {
  private store: ContextStore | undefined
  private readonly options: ContextServiceOptions

  constructor(options: ContextServiceOptions = {}) {
    this.options = options
    try {
      this.store = new ContextStore({
        path: options.path ?? contextDatabasePath(),
        ...(options.disableFts === true ? { disableFts: true } : {}),
      })
    } catch (error) {
      this.store = undefined
      this.options.onError?.(error, 'open')
    }
  }

  get available(): boolean {
    return this.store !== undefined
  }

  /** Expose the store for intake and background indexing; `undefined` when open failed. */
  contextStore(): ContextStore | undefined {
    return this.store
  }

  /** Synchronous recall used by both the tool and the pre-step snapshot. */
  recall(query: ContextRecallQuery): ContextRecallResult {
    if (this.store === undefined) return { items: [], degraded: [], reason: 'index-unavailable' }
    try {
      return recallContext(this.store, query)
    } catch (error) {
      this.options.onError?.(error, 'recall')
      return { items: [], degraded: [], reason: 'recall-failed' }
    }
  }

  /** Render the replace-in-place snapshot for the current recall result. */
  snapshot(query: ContextRecallQuery): ContextRecallSnapshot | undefined {
    return renderRecallSnapshot(this.recall(query))
  }

  /** Read original indexed text for one `cu:` / `seg:` ref; never mutates. */
  read(memberId: string, request: ContextReadRequest): ContextReadResult {
    if (this.store === undefined) return { ok: false, reason: 'index-unavailable' }
    try {
      return readContextSource(this.store, memberId, request)
    } catch (error) {
      this.options.onError?.(error, 'read')
      return { ok: false, reason: 'read-failed' }
    }
  }

  /** Read-only decision/commitment review; superseded history is included by default. */
  review(memberId: string, request: ContextReviewRequest): ContextReviewResult {
    if (this.store === undefined) {
      return {
        clusters: [], edges: [], narrative: 'Context index is unavailable.', includeSuperseded: request.includeSuperseded ?? true,
        degraded: ['index-unavailable'],
      }
    }
    const query = request.around ?? request.topic ?? ''
    const seeds = query.length === 0 ? [] : this.recall({ memberId, sessionId: request.around ?? '', query, mode: 'auto', limit: 8 }).items
    try {
      return reviewContext(this.store, memberId, request, seeds)
    } catch (error) {
      this.options.onError?.(error, 'review')
      return { clusters: [], edges: [], narrative: 'Context review failed.', includeSuperseded: request.includeSuperseded ?? true, degraded: ['review-failed'] }
    }
  }

  /** Pre-generate the next L2 digest and park it for the commit point. */
  async prepareCompaction(options: PrepareEpochOptions): Promise<PrepareEpochOutcome> {
    if (this.store === undefined) return { ok: false, reason: 'index-unavailable' }
    try {
      return await prepareEpoch(this.store, options)
    } catch (error) {
      this.options.onError?.(error, 'prepare-compaction')
      return { ok: false, reason: 'prepare-failed' }
    }
  }

  /** Commit the prepared digest without another model call. */
  async commitCompaction(options: {
    readonly memberId: string
    readonly sessionId: string
    readonly compactor: ContextCompactor
    readonly signal?: AbortSignal
    readonly now?: Date
  }): Promise<CommitEpochOutcome> {
    if (this.store === undefined) return { ok: false, reason: 'index-unavailable' }
    try {
      return await commitPreparedEpoch(this.store, options)
    } catch (error) {
      this.options.onError?.(error, 'commit-compaction')
      return { ok: false, reason: 'commit-failed' }
    }
  }

  /** Committed digest cache for one sequence, if that window was collapsed. */
  committedDigest(memberId: string, sessionId: string, seq: number) {
    return this.store?.segmentForSeq(memberId, sessionId, seq)?.digest
  }

  close(): void {
    this.store?.close()
    this.store = undefined
  }
}
