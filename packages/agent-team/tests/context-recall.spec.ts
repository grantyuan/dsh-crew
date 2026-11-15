import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXT_RECALL_DEGRADED, recallContext, type ContextRecallQuery } from '../src/context/recall.ts'
import { ContextService } from '../src/context/service.ts'
import { ContextStore } from '../src/context/store.ts'
import type { ContextUnitInput } from '../src/context/types.ts'
import { buildContextUnit } from '../src/context/units.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function openStore(disableFts = false): ContextStore {
  const store = new ContextStore({ path: ':memory:', ...(disableFts ? { disableFts: true } : {}) })
  cleanups.push(() => store.close())
  return store
}

function unit(overrides: Partial<ContextUnitInput> = {}): ReturnType<typeof buildContextUnit> {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq: 1,
    role: 'user',
    text: 'placeholder',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }, { now: NOW })
}

function seeded(disableFts = false): ContextStore {
  const store = openStore(disableFts)
  store.writeUnit(unit({ seq: 1, text: 'Fixed error TS2339 at packages/agent-team/src/index.ts for @alice', recordedAt: '2026-11-15T06:00:00.000Z' }))
  store.writeUnit(unit({ seq: 2, text: 'Unrelated note about lunch and the weather', recordedAt: '2026-11-15T07:00:00.000Z' }))
  store.writeUnit(unit({ seq: 3, sessionId: 's2', text: 'Pinned granite-embedding-97m as the default embedding model', recordedAt: '2026-11-15T08:00:00.000Z' }))
  return store
}

function query(overrides: Partial<ContextRecallQuery> = {}): ContextRecallQuery {
  return { memberId: 'm1', sessionId: 's1', query: 'TS2339', now: NOW().getTime(), ...overrides }
}

describe('five-route recall', () => {
  it('fuses exact and lexical hits so a unit strong on both ranks first', () => {
    const result = recallContext(seeded(), query())

    expect(result.items[0]?.ref).toBe('cu:s1:1')
    expect(result.items[0]?.sources).toEqual(['exact', 'lexical'])
    expect(result.items[0]?.snippet).toContain('TS2339')
    expect(result.items[0]?.status).toBe('active')
  })

  it('keeps other Sessions of the same Member eligible', () => {
    const result = recallContext(seeded(), query({ query: 'granite-embedding-97m' }))
    expect(result.items.map(item => item.ref)).toContain('cu:s2:3')
  })

  it('scopes every route to the requesting Member', () => {
    const result = recallContext(seeded(), query({ memberId: 'm2' }))
    expect(result.items).toEqual([])
  })

  it('restricts routes when a mode is explicit', () => {
    const exactOnly = recallContext(seeded(), query({ mode: 'lexical' }))
    expect(exactOnly.items.length).toBeGreaterThan(0)
    expect(exactOnly.items.every(item => item.sources.includes('lexical'))).toBe(true)

    const noTerms = recallContext(seeded(), query({ mode: 'exact', query: 'please remember this' }))
    expect(noTerms.items).toEqual([])
    expect(noTerms.degraded).toEqual([CONTEXT_RECALL_DEGRADED.exactNoTerms])
  })

  it('ranks a precomputed query vector without waiting for a model', () => {
    const store = seeded()
    store.upsertVector('cu:s1:1', 'granite-97m', Float32Array.from([1, 0]))
    store.upsertVector('cu:s1:2', 'granite-97m', Float32Array.from([0, 1]))
    const result = recallContext(store, query({ query: '', mode: 'vector', queryVector: Float32Array.from([1, 0]) }))
    expect(result.items.map(item => item.ref)).toEqual(['cu:s1:1'])
    expect(result.items[0]?.sources).toEqual(['vector'])
  })

  it('names every route it could not run instead of failing', () => {
    const result = recallContext(seeded(), query())
    expect(result.degraded).toContain(CONTEXT_RECALL_DEGRADED.graph)

    const noVector = recallContext(seeded(), query({ mode: 'vector' }))
    expect(noVector.items).toEqual([])
    expect(noVector.degraded).toEqual([CONTEXT_RECALL_DEGRADED.vectorPending])
  })

  it('falls back to LIKE and says so when FTS is unavailable', () => {
    const result = recallContext(seeded(true), query())
    expect(result.items[0]?.ref).toBe('cu:s1:1')
    expect(result.degraded).toContain(CONTEXT_RECALL_DEGRADED.lexicalLike)
  })

  it('clamps the requested limit', () => {
    const store = openStore()
    for (let seq = 1; seq <= 30; seq += 1) {
      store.writeUnit(unit({ seq, text: `shared token alpha ${seq}`, recordedAt: `2026-11-15T06:${String(seq).padStart(2, '0')}:00.000Z` }))
    }
    expect(recallContext(store, query({ query: 'alpha', limit: 100 })).items).toHaveLength(8)
    expect(recallContext(store, query({ query: 'alpha', limit: 0 })).items).toHaveLength(1)
  })

  it('keeps warm recall inside the 40 ms p95 budget at 1000 units', () => {
    // D13's hard threshold for the 1000-turn tier: recall is model-free, so the
    // pre-step path stays inside budget regardless of which role model (if any)
    // is configured. This guards the query plan, not a benchmark.
    const store = openStore()
    for (let seq = 1; seq <= 1000; seq += 1) {
      store.writeUnit(unit({
        seq,
        text: `decision ${seq}: pin packages/agent-team/src/index.ts TS23${seq % 10} and re-check token ${seq % 17}`,
        recordedAt: new Date(NOW().getTime() + seq * 60_000).toISOString(),
      }))
    }
    for (let warm = 0; warm < 3; warm += 1) recallContext(store, query({ query: 'TS233 packages/agent-team/src/index.ts' }))
    const samples: number[] = []
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now()
      recallContext(store, query({ query: `TS233 token ${run}` }))
      samples.push(performance.now() - started)
    }
    samples.sort((left, right) => left - right)
    expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(40)
  })
})

describe('ContextService failure boundary', () => {
  it('reports an unavailable index instead of throwing', () => {
    const service = new ContextService({ path: '/tmp' })
    cleanups.push(() => service.close())
    expect(service.available).toBe(false)
    expect(service.recall(query())).toEqual({ items: [], degraded: [], reason: 'index-unavailable' })
    expect(service.snapshot(query())).toBeUndefined()
  })

  it('renders a snapshot once the index has content and clears it after close', () => {
    const service = new ContextService({ path: ':memory:' })
    cleanups.push(() => service.close())
    service.contextStore()?.writeUnit(unit({ text: 'Fixed error TS2339 at packages/agent-team/src/index.ts' }))

    const snapshot = service.snapshot(query())
    expect(snapshot?.itemCount).toBe(1)
    expect(snapshot?.text).toContain('cu:s1:1')

    service.close()
    expect(service.available).toBe(false)
    expect(service.snapshot(query())).toBeUndefined()
  })
})
