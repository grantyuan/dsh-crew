import { afterEach, describe, expect, it } from 'vitest'
import { reviewContext } from '../src/context/review.ts'
import { ContextStore } from '../src/context/store.ts'
import type { ContextUnitInput } from '../src/context/types.ts'
import { buildContextUnit } from '../src/context/units.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function openStore(): ContextStore {
  const store = new ContextStore({ path: ':memory:' })
  cleanups.push(() => store.close())
  return store
}

function makeUnit(overrides: Partial<ContextUnitInput> = {}) {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq: 1,
    role: 'user',
    text: '决定：采用 alpha 方案。',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }, { now: NOW })
}

describe('context review', () => {
  it('groups decisions and keeps the supersession history by default', () => {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1, text: '决定：采用 alpha 方案。@alice 跟进？', recordedAt: '2026-11-15T06:00:00.000Z' }))
    store.writeUnit(makeUnit({ seq: 2, text: '决定：改用 beta 方案。', recordedAt: '2026-11-15T07:00:00.000Z' }))
    store.supersedeUnit('cu:s1:2', 'cu:s1:1', new Date('2026-11-15T08:00:00.000Z'))

    const result = reviewContext(store, 'm1', { topic: '方案' }, [{ ref: 'cu:s1:2' }])
    expect(result.includeSuperseded).toBe(true)
    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0]!.decisions).toHaveLength(2)
    expect(result.clusters[0]!.decisions[0]).toMatchObject({ ref: 'cu:s1:1', status: 'superseded', supersededBy: 'cu:s1:2' })
    expect(result.clusters[0]!.decisions[1]).toMatchObject({ ref: 'cu:s1:2', status: 'active' })
    expect(result.clusters[0]!.openQuestions[0]).toContain('alice')
    expect(result.edges.some(edge => edge.kind === 'supersedes')).toBe(true)
    expect(result.narrative).toContain('2 decision(s)')
  })

  it('can hide superseded decisions and their stale text', () => {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1, text: '决定：采用 alpha 方案。', recordedAt: '2026-11-15T06:00:00.000Z' }))
    store.writeUnit(makeUnit({ seq: 2, text: '决定：改用 beta 方案。', recordedAt: '2026-11-15T07:00:00.000Z' }))
    store.supersedeUnit('cu:s1:2', 'cu:s1:1')

    const result = reviewContext(store, 'm1', { topic: '方案', includeSuperseded: false }, [{ ref: 'cu:s1:2' }])
    expect(result.clusters[0]!.decisions).toHaveLength(1)
    expect(result.clusters[0]!.decisions[0]).toMatchObject({ ref: 'cu:s1:2', status: 'active' })
  })

  it('reports that a query is needed when neither topic nor around is given', () => {
    const store = openStore()
    const result = reviewContext(store, 'm1', {}, [])
    expect(result.degraded).toContain('review-needs-topic-or-around')
    expect(result.clusters).toEqual([])
  })
})
