/**
 * Runtime that resolves, schedules and calls functional context roles.
 *
 * The runtime owns the fallback walk. A role's dedicated endpoint is tried
 * first; on a transport failure (not only when unconfigured) the next
 * candidate — the configured assistant endpoint, then the Agent main model —
 * is tried with its own prompt profile. All attempts share the role's total
 * deadline, so falling back can never extend the accepted latency budget.
 * Embedding is handled separately: dedicated → built-in local → assistant
 * endpoint known to support `/embeddings` → lexical; the chat model is never
 * an embedding fallback.
 * @module @grantyuan/dsh-crew/context/role-runtime
 */

import type { AgentTeamModelSelection } from '../types.ts'
import { ContextMetrics } from './metrics.ts'
import { buildContextRolePrompt, type ContextRoleTask } from './prompts/role-prompts.ts'
import {
  ContextRoleError,
  roleClientFor,
  type HostLlm,
  type RoleChatResult,
  type RoleEmbeddingResult,
} from './role-client.ts'
import { ContextRoleHealth } from './role-health.ts'
import {
  CONTEXT_ROLE_TIMEOUT_MS,
  resolveContextRoleCandidates,
  resolveContextRoleRoute,
  type ContextModelRole,
  type ContextRoleModels,
  type ContextRoleRoute,
} from './role-models.ts'
import { ContextRoleScheduler, ContextRoleQueueError, type ContextRolePriority } from './role-scheduler.ts'

export interface LocalEmbeddingProvider {
  available(): boolean
  embed(texts: readonly string[], signal: AbortSignal): Promise<RoleEmbeddingResult>
}

export interface ContextRoleRuntimeDependencies {
  readonly readRoles: () => ContextRoleModels
  readonly llm: HostLlm
  readonly fetchImpl?: typeof fetch
  readonly localEmbedding?: LocalEmbeddingProvider
  readonly assistantEmbeddings?: 'unknown' | 'supported' | 'unsupported'
  readonly metrics?: ContextMetrics
  readonly health?: ContextRoleHealth
  readonly scheduler?: ContextRoleScheduler
}

export interface ContextRoleChatOptions {
  readonly main?: AgentTeamModelSelection
  readonly signal?: AbortSignal
  readonly priority?: ContextRolePriority
  /** Stable per-Member scheduler key; defaults to the role name. */
  readonly key?: string
}

export type ContextRoleChatOutcome =
  | {
    readonly ok: true
    readonly text: string
    readonly route: ContextRoleRoute
    readonly latencyMs: number
    readonly usage?: RoleChatResult['usage']
  }
  | {
    readonly ok: false
    readonly kind: string
    readonly reason: string
    readonly route?: ContextRoleRoute
    readonly latencyMs: number
  }

export type ContextRoleEmbeddingOutcome =
  | {
    readonly ok: true
    readonly vectors: readonly Float32Array[]
    readonly dimension: number
    readonly modelId: string
    readonly source: ContextRoleRoute['source']
    readonly latencyMs: number
  }
  | {
    readonly ok: false
    readonly kind: string
    readonly reason: string
    readonly source: ContextRoleRoute['source']
    readonly latencyMs: number
  }

export interface ContextRoleRuntimeStatus {
  readonly roles: readonly {
    readonly role: ContextModelRole
    readonly route: ContextRoleRoute
    readonly circuit: ReturnType<ContextRoleHealth['snapshot']>['state']
    readonly lastError?: ReturnType<ContextRoleHealth['snapshot']>['lastError']
    readonly p50?: number
    readonly p95?: number
    readonly queueDepth: number
  }[]
  readonly embedding: ContextRoleRoute
}

const ROLE_ORDER: readonly ContextModelRole[] = ['assistant', 'embedding', 'decision', 'extraction']

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

export class ContextRoleRuntime {
  private readonly dependencies: ContextRoleRuntimeDependencies
  private readonly metrics: ContextMetrics
  private readonly health: ContextRoleHealth
  private readonly scheduler: ContextRoleScheduler

  constructor(dependencies: ContextRoleRuntimeDependencies) {
    this.dependencies = dependencies
    this.metrics = dependencies.metrics ?? new ContextMetrics()
    this.health = dependencies.health ?? new ContextRoleHealth()
    this.scheduler = dependencies.scheduler ?? new ContextRoleScheduler()
  }

  /** Run one generative role task with fallback across candidates. */
  async chat(
    role: Exclude<ContextModelRole, 'embedding'>,
    task: ContextRoleTask,
    payload: unknown,
    options: ContextRoleChatOptions = {},
  ): Promise<ContextRoleChatOutcome> {
    const started = Date.now()
    const roles = this.dependencies.readRoles()
    const candidates = resolveContextRoleCandidates({ role, roles, ...(options.main === undefined ? {} : { main: options.main }) })
    const first = candidates[0]!
    if (first.source === 'off') {
      this.metrics.inc('context_role_calls_total', { role, source: 'off', outcome: 'skipped' })
      return { ok: false, kind: 'role-off', reason: first.reason ?? 'no-role-assistant-or-main-model', route: first, latencyMs: 0 }
    }
    const deadline = Date.now() + first.timeoutMs
    let lastFailure: { route: ContextRoleRoute; error: ContextRoleError } | undefined

    for (const candidate of candidates) {
      if (options.signal?.aborted === true) break
      const remaining = remainingMs(deadline)
      if (remaining <= 1_000 && lastFailure !== undefined) break
      const health = this.health.check(candidate)
      if (!health.allowed) {
        this.metrics.inc('context_role_calls_total', { role, source: candidate.source, outcome: 'circuit-open' })
        this.metrics.inc('context_role_dropped_total', { role, reason: health.state })
        lastFailure = {
          route: candidate,
          error: new ContextRoleError('role-timeout', `circuit is ${health.state}`),
        }
        continue
      }
      const prompt = buildContextRolePrompt({
        role,
        task,
        profile: candidate.promptProfile === 'general' ? 'general' : 'small',
        payload,
      })
      const attemptRoute: ContextRoleRoute = { ...candidate, timeoutMs: Math.max(1_000, Math.min(candidate.timeoutMs, remaining)) }
      const controller = new AbortController()
      const total = AbortSignal.timeout(remaining)
      const signal = AbortSignal.any([controller.signal, total, ...(options.signal === undefined ? [] : [options.signal])])
      try {
        const result = await this.scheduler.run({
          key: `${options.key ?? role}:${role}`,
          priority: options.priority ?? 'background',
          signal,
          task: async (scheduledSignal) => {
            const client = roleClientFor(attemptRoute, {
              llm: this.dependencies.llm,
              ...(this.dependencies.fetchImpl === undefined ? {} : { fetchImpl: this.dependencies.fetchImpl }),
            })
            return client.chat(attemptRoute, {
              system: prompt.system,
              messages: prompt.messages,
              maxTokens: prompt.maxTokens,
              temperature: prompt.temperature,
              signal: scheduledSignal,
            })
          },
        })
        this.health.success(candidate)
        this.metrics.inc('context_role_calls_total', { role, source: candidate.source, outcome: 'ok' })
        this.metrics.observe('context_role_latency_ms', { role, source: candidate.source }, result.latencyMs)
        return {
          ok: true,
          text: result.text,
          route: candidate,
          latencyMs: result.latencyMs,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        }
      } catch (error) {
        const failure = error instanceof ContextRoleError ? error : new ContextRoleError('role-http', error instanceof Error ? error.message : 'role call failed')
        this.health.failure(candidate, failure)
        this.metrics.inc('context_role_fail_total', { role, source: candidate.source, kind: failure.kind })
        lastFailure = { route: candidate, error: failure }
        if (error instanceof ContextRoleQueueError) {
          return { ok: false, kind: 'queue-full', reason: error.message, route: candidate, latencyMs: Date.now() - started }
        }
      }
    }

    const last = lastFailure
    return {
      ok: false,
      kind: last?.error.kind ?? 'aborted',
      reason: last?.error.message ?? 'context role call was cancelled',
      ...(last === undefined ? {} : { route: last.route }),
      latencyMs: Date.now() - started,
    }
  }

  /** Embed texts with the embedding-specific chain; never uses the chat model. */
  async embed(texts: readonly string[], options: { readonly signal?: AbortSignal; readonly key?: string } = {}): Promise<ContextRoleEmbeddingOutcome> {
    const started = Date.now()
    const roles = this.dependencies.readRoles()
    const route = resolveContextRoleRoute({
      role: 'embedding',
      roles,
      embedding: {
        localReady: this.dependencies.localEmbedding?.available() === true,
        assistantEmbeddings: this.dependencies.assistantEmbeddings ?? 'unknown',
      },
    })
    const signal = options.signal ?? new AbortController().signal

    if (route.source === 'local') {
      const local = this.dependencies.localEmbedding
      if (local === undefined || !local.available()) {
        return { ok: false, kind: 'local-unavailable', reason: 'local embedding runtime is unavailable', source: route.source, latencyMs: Date.now() - started }
      }
      try {
        const result = await this.scheduler.run({
          key: `${options.key ?? 'embedding'}:embedding`,
          priority: 'background',
          signal,
          task: scheduledSignal => local.embed(texts, scheduledSignal),
        })
        this.metrics.inc('context_role_calls_total', { role: 'embedding', source: 'local', outcome: 'ok' })
        this.metrics.observe('context_role_latency_ms', { role: 'embedding', source: 'local' }, result.latencyMs)
        return { ok: true, vectors: result.vectors, dimension: result.dimension, modelId: result.modelId, source: 'local', latencyMs: result.latencyMs }
      } catch (error) {
        this.metrics.inc('context_role_fail_total', { role: 'embedding', source: 'local', kind: 'local-error' })
        return { ok: false, kind: 'local-error', reason: error instanceof Error ? error.message : 'local embedding failed', source: 'local', latencyMs: Date.now() - started }
      }
    }

    if (route.source === 'lexical') {
      return { ok: false, kind: 'lexical', reason: route.reason ?? 'embedding is not configured', source: 'lexical', latencyMs: 0 }
    }

    // Dedicated endpoint, with the assistant endpoint as a compatibility hop
    // only when it is known to expose /embeddings.
    const candidates: ContextRoleRoute[] = [route]
    const assistant = roles.assistant
    if (route.source === 'role' && this.dependencies.assistantEmbeddings === 'supported' && assistant.enabled && assistant.baseURL !== '' && assistant.model !== '') {
      candidates.push({ ...route, source: 'assistant', baseURL: assistant.baseURL, model: assistant.model, ...(assistant.apiKey === '' ? {} : { apiKey: assistant.apiKey }) })
    }
    let last: ContextRoleError | undefined
    for (const candidate of candidates) {
      if (options.signal?.aborted === true) break
      const health = this.health.check(candidate)
      if (!health.allowed) {
        last = new ContextRoleError('role-timeout', `circuit is ${health.state}`)
        continue
      }
      try {
        const result = await this.scheduler.run({
          key: `${options.key ?? 'embedding'}:embedding`,
          priority: 'background',
          signal,
          task: async (scheduledSignal) => {
            const client = roleClientFor(candidate, {
              llm: this.dependencies.llm,
              ...(this.dependencies.fetchImpl === undefined ? {} : { fetchImpl: this.dependencies.fetchImpl }),
            })
            return client.embed(candidate, texts, scheduledSignal)
          },
        })
        this.health.success(candidate)
        this.metrics.inc('context_role_calls_total', { role: 'embedding', source: candidate.source, outcome: 'ok' })
        this.metrics.observe('context_role_latency_ms', { role: 'embedding', source: candidate.source }, result.latencyMs)
        return { ok: true, vectors: result.vectors, dimension: result.dimension, modelId: result.modelId, source: candidate.source, latencyMs: result.latencyMs }
      } catch (error) {
        last = error instanceof ContextRoleError ? error : new ContextRoleError('role-http', 'embedding call failed')
        this.health.failure(candidate, last)
        this.metrics.inc('context_role_fail_total', { role: 'embedding', source: candidate.source, kind: last.kind })
      }
    }
    return {
      ok: false,
      kind: last?.kind ?? 'lexical',
      reason: last?.message ?? 'embedding is unavailable',
      source: route.source,
      latencyMs: Date.now() - started,
    }
  }

  status(options: { readonly main?: AgentTeamModelSelection } = {}): ContextRoleRuntimeStatus {
    const roles = this.dependencies.readRoles()
    const routeFor = (role: ContextModelRole): ContextRoleRoute => resolveContextRoleRoute({
      role,
      roles,
      ...(options.main === undefined ? {} : { main: options.main }),
      embedding: {
        localReady: this.dependencies.localEmbedding?.available() === true,
        assistantEmbeddings: this.dependencies.assistantEmbeddings ?? 'unknown',
      },
    })
    return {
      roles: ROLE_ORDER.map((role) => {
        const route = routeFor(role)
        const health = this.health.snapshot(role)
        const latency = this.metrics.latency(role, route.source)
        return {
          role,
          route,
          circuit: health.state,
          ...(health.lastError === undefined ? {} : { lastError: health.lastError }),
          ...(latency.p50 === undefined ? {} : { p50: latency.p50 }),
          ...(latency.p95 === undefined ? {} : { p95: latency.p95 }),
          queueDepth: this.scheduler.depth,
        }
      }),
      embedding: routeFor('embedding'),
    }
  }

  /** Role budget, exposed for the settings UI without duplicating constants. */
  timeoutMs(role: ContextModelRole): number {
    return CONTEXT_ROLE_TIMEOUT_MS[role]
  }

  dispose(): void {
    this.scheduler.dispose()
  }
}
