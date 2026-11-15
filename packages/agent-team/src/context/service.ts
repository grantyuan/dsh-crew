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
import { recallContext, type ContextRecallQuery, type ContextRecallResult } from './recall.ts'
import { renderRecallSnapshot, type ContextRecallSnapshot } from './recall-snapshot.ts'
import { ContextStore } from './store.ts'

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

  close(): void {
    this.store?.close()
    this.store = undefined
  }
}
