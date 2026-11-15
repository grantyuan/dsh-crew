/**
 * Bounded scheduler for functional context roles.
 *
 * Background enrichment must never starve an interactive recall or summary.
 * Each (Member, role) key admits one in-flight call, the process admits three,
 * and the queue is capped so a broken endpoint cannot grow an unbounded
 * backlog. Interactive jobs are admitted before background jobs.
 * @module @grantyuan/dsh-crew/context/role-scheduler
 */

export type ContextRolePriority = 'interactive' | 'background'

export class ContextRoleQueueError extends Error {
  readonly kind = 'queue-full'

  constructor(message: string) {
    super(message)
    this.name = 'ContextRoleQueueError'
  }
}

interface QueuedJob {
  readonly key: string
  readonly priority: ContextRolePriority
  readonly task: (signal: AbortSignal) => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly externalSignal?: AbortSignal
  readonly onAbort?: () => void
}

export interface ScheduleRoleTaskOptions<T> {
  readonly key: string
  readonly priority?: ContextRolePriority
  readonly signal?: AbortSignal
  readonly task: (signal: AbortSignal) => Promise<T>
}

const GLOBAL_CONCURRENCY = 3
const QUEUE_LIMIT = 8

export class ContextRoleScheduler {
  private readonly inFlightByKey = new Map<string, number>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly queue: QueuedJob[] = []
  private globalInFlight = 0
  private disposed = false

  run<T>(options: ScheduleRoleTaskOptions<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('context role scheduler is disposed'))
    if (options.signal?.aborted === true) return Promise.reject(new Error('context role call was cancelled'))
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        key: options.key,
        priority: options.priority ?? 'background',
        task: options.task,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(options.signal === undefined ? {} : { externalSignal: options.signal }),
      }
      if (this.queue.length === 0 && this.canStart(job.key)) {
        this.start(job)
        return
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        reject(new ContextRoleQueueError(`context role queue is full for '${job.key}'`))
        return
      }
      if (options.signal !== undefined) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(job)
          if (index !== -1) this.queue.splice(index, 1)
          reject(new Error('context role call was cancelled'))
        }
        ;(job as { onAbort?: () => void }).onAbort = onAbort
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.queue.push(job)
      this.queue.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority))
      this.drain()
    })
  }

  /** Queued jobs, exposed for the runtime's status view. */
  get depth(): number {
    return this.queue.length
  }

  /** Cancel queued work and abort in-flight calls. */
  dispose(): void {
    this.disposed = true
    for (const job of this.queue.splice(0)) {
      if (job.onAbort !== undefined) job.externalSignal?.removeEventListener('abort', job.onAbort)
      job.reject(new Error('context role scheduler is disposed'))
    }
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  private canStart(key: string): boolean {
    return this.globalInFlight < GLOBAL_CONCURRENCY && (this.inFlightByKey.get(key) ?? 0) < 1
  }

  private start(job: QueuedJob): void {
    if (job.onAbort !== undefined) job.externalSignal?.removeEventListener('abort', job.onAbort)
    this.globalInFlight += 1
    this.inFlightByKey.set(job.key, (this.inFlightByKey.get(job.key) ?? 0) + 1)
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const external = job.externalSignal
    const onExternalAbort = (): void => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }
    void job.task(controller.signal).then(
      (value) => job.resolve(value),
      (error) => job.reject(error),
    ).finally(() => {
      external?.removeEventListener('abort', onExternalAbort)
      this.activeControllers.delete(controller)
      this.globalInFlight -= 1
      const remaining = (this.inFlightByKey.get(job.key) ?? 1) - 1
      if (remaining <= 0) this.inFlightByKey.delete(job.key)
      else this.inFlightByKey.set(job.key, remaining)
      this.drain()
    })
  }

  private drain(): void {
    if (this.disposed) return
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index]!
      if (this.canStart(job.key)) {
        this.queue.splice(index, 1)
        this.start(job)
        continue
      }
      index += 1
    }
  }

}

function priorityRank(priority: ContextRolePriority): number {
  return priority === 'interactive' ? 0 : 1
}
