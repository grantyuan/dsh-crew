import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextCoordinator,
  parseContextEnrichment,
  type ContextEnrichmentRuntime,
} from '../src/context/coordinator.ts'
import type { ContextRoleRoute } from '../src/context/role-models.ts'
import type { ContextRoleChatOptions, ContextRoleChatOutcome } from '../src/context/role-runtime.ts'
import { ContextStore } from '../src/context/store.ts'
import type { ContextUnitInput } from '../src/context/types.ts'

const cleanups: (() => void)[] = []

function openStore(): ContextStore {
  const store = new ContextStore({ path: ':memory:' })
  cleanups.push(() => store.close())
  return store
}

function unit(overrides: Partial<ContextUnitInput> = {}): ContextUnitInput {
  return {
    memberId: 'm1',
    sessionId: 's1',
    seq: 1,
    role: 'user',
    text: '决定采用方案 A：昨天下午和 @alice 讨论上下文压缩，必须完成。',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }
}

const route: ContextRoleRoute = {
  role: 'extraction',
  source: 'role',
  transport: 'openai-compatible',
  promptProfile: 'small',
  timeoutMs: 12_000,
  model: 'small-model',
  baseURL: 'https://small.test/v1',
}

const ok = (text: string): ContextRoleChatOutcome => ({ ok: true, text, route, latencyMs: 1 })
const failure = (kind: string, reason: string): ContextRoleChatOutcome => ({ ok: false, kind, reason, route, latencyMs: 1 })

interface ChatCall {
  readonly role: string
  readonly task: string
  readonly payload: unknown
  readonly options?: ContextRoleChatOptions
}

function makeRuntime(handler: (call: ChatCall) => Promise<ContextRoleChatOutcome>): { runtime: ContextEnrichmentRuntime; calls: ChatCall[] } {
  const calls: ChatCall[] = []
  const runtime: ContextEnrichmentRuntime = {
    async chat(role, task, payload, options) {
      const call: ChatCall = { role, task, payload, ...(options === undefined ? {} : { options }) }
      calls.push(call)
      return handler(call)
    },
  }
  return { runtime, calls }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('ContextCoordinator.record', () => {
  it('writes synchronously, queues enrichment, and never calls a model', () => {
    const store = openStore()
    const { runtime, calls } = makeRuntime(async () => ok('{}'))
    const coordinator = new ContextCoordinator({ store, runtime })

    const result = coordinator.record(unit())
    expect(result).toEqual({ unitId: 'cu:s1:1', inserted: true, changed: false, enrichQueued: true })
    expect(store.getUnit('cu:s1:1')?.kind).toBe('decision')
    expect(store.pendingOutboxCount('enrich')).toBe(1)
    expect(calls).toHaveLength(0)

    const duplicate = coordinator.record(unit())
    expect(duplicate).toEqual({ unitId: 'cu:s1:1', inserted: false, changed: false, enrichQueued: false })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })
})

describe('ContextCoordinator.drainEnrichment', () => {
  it('calls the extraction role in the background and fills only missing fields', async () => {
    const store = openStore()
    const { runtime, calls } = makeRuntime(async () => ok(JSON.stringify({
      subjects: ['@alice', '@bob'],
      topics: ['上下文压缩'],
      roles: ['agent'],
      time: { start: '2026-11-15T01:00:00.000Z', end: '2026-11-15T02:00:00.000Z' },
      confidence: 0.8,
    })))
    const coordinator = new ContextCoordinator({ store, runtime })
    coordinator.record(unit())

    const result = await coordinator.drainEnrichment()
    expect(result).toEqual({ claimed: 1, applied: 1, failed: 0, deferred: 0, dropped: 0 })
    expect(calls[0]).toMatchObject({ role: 'extraction', task: 'enrich' })
    expect(calls[0]?.options).toMatchObject({ priority: 'background', key: 'm1' })
    expect(store.pendingOutboxCount('enrich')).toBe(0)

    const facets = store.listFacets('cu:s1:1')
    const subjects = facets.filter(facet => facet.dimension === 'subject')
    expect(subjects.filter(facet => facet.value === 'member:alice')).toHaveLength(1)
    expect(subjects.find(facet => facet.value === 'member:alice')?.source).toBe('rule')
    expect(subjects.find(facet => facet.value === 'member:bob')?.source).toBe('model')
    expect(facets).toContainEqual(expect.objectContaining({ dimension: 'role', value: 'role:agent', source: 'model' }))
    expect(facets).toContainEqual(expect.objectContaining({ dimension: 'topic', value: 'topic:上下文压缩', source: 'model' }))
    const times = facets.filter(facet => facet.dimension === 'time')
    expect(times).toHaveLength(1)
    expect(times[0]?.source).toBe('rule')
  })

  it('drops a row after three failed attempts', async () => {
    const store = openStore()
    const { runtime } = makeRuntime(async () => {
      throw new Error('endpoint down')
    })
    const coordinator = new ContextCoordinator({ store, runtime, enrichmentBackoffMs: 0 })
    coordinator.record(unit())

    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, failed: 1, dropped: 0 })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, failed: 1, dropped: 0 })
    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, failed: 0, dropped: 1 })
    expect(store.pendingOutboxCount('enrich')).toBe(0)
  })

  it('treats an invalid enrichment reply as a failed attempt', async () => {
    const store = openStore()
    const { runtime } = makeRuntime(async () => ok('not json'))
    const coordinator = new ContextCoordinator({ store, runtime, enrichmentBackoffMs: 0 })
    coordinator.record(unit())

    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, failed: 1 })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })

  it('defers without consuming an attempt when the role is off', async () => {
    const store = openStore()
    const { runtime } = makeRuntime(async () => failure('role-off', 'no role, assistant, or main model'))
    const coordinator = new ContextCoordinator({ store, runtime })
    coordinator.record(unit())

    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, deferred: 1, failed: 0 })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
    const [pending] = store.claimEnrichment(10, Date.now() + 60_000)
    expect(pending?.attempts).toBe(0)
  })

  it('defers instead of dropping when no runtime is wired yet', async () => {
    const store = openStore()
    const coordinator = new ContextCoordinator({ store })
    coordinator.record(unit())

    expect(await coordinator.drainEnrichment()).toMatchObject({ claimed: 1, deferred: 1 })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })

  it('ignores a re-entrant drain while one is in flight', async () => {
    const store = openStore()
    let release!: (outcome: ContextRoleChatOutcome) => void
    const gate = new Promise<ContextRoleChatOutcome>((resolve) => {
      release = resolve
    })
    const { runtime } = makeRuntime(() => gate)
    const coordinator = new ContextCoordinator({ store, runtime })
    coordinator.record(unit())

    const first = coordinator.drainEnrichment()
    const second = await coordinator.drainEnrichment()
    expect(second).toEqual({ claimed: 0, applied: 0, failed: 0, deferred: 0, dropped: 0 })

    release(ok('{}'))
    expect(await first).toMatchObject({ claimed: 1, applied: 1 })
  })
})

describe('parseContextEnrichment', () => {
  it('accepts fenced JSON and bounds confidence', () => {
    const parsed = parseContextEnrichment('```json\n{"subjects":["@alice"],"confidence":5}\n```')
    expect(parsed).toMatchObject({ subjects: ['@alice'], confidence: 1 })
  })

  it('rejects prose without a JSON object', () => {
    expect(parseContextEnrichment('I could not find anything.')).toBeUndefined()
  })
})
