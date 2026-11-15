import { afterEach, describe, expect, it } from 'vitest'
import { ContextStore } from '../src/context/store.ts'
import type { ContextUnitInput } from '../src/context/types.ts'
import { buildContextUnit, contextNodeId } from '../src/context/units.ts'

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

function makeUnit(overrides: Partial<ContextUnitInput> = {}): ReturnType<typeof buildContextUnit> {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq: 1,
    role: 'user',
    text: '决定：保留 recall fold 的确定性',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }, { now: NOW })
}

describe('context graph storage', () => {
  it('creates one current L1 node per unit with validity and confidence', () => {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1 }))

    expect(store.getNode(contextNodeId('cu:s1:1'))).toMatchObject({
      memberId: 'm1',
      sessionId: 's1',
      level: 'L1',
      kind: 'decision',
      ref: 'cu:s1:1',
      status: 'current',
      confidence: 1,
      validFrom: '2026-11-15T06:00:00.000Z',
    })
    expect(store.listNodes('m1', { level: 'L1' }).map(node => node.ref)).toEqual(['cu:s1:1'])
    expect(store.listNodes('m1', { ref: 'cu:s1:1' })).toHaveLength(1)
    expect(store.listNodes('m1', { ref: 'cu:s1:2' })).toEqual([])
  })

  it('links consecutive units and units that share a subject', () => {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1, text: 'decision: @alice keeps the recall fold', recordedAt: '2026-11-15T06:00:00.000Z' }))
    store.writeUnit(makeUnit({ seq: 2, text: 'decision: @alice reviews the recall fold', recordedAt: '2026-11-15T07:00:00.000Z' }))
    store.writeUnit(makeUnit({ seq: 1, sessionId: 's2', text: 'decision: @alice continues in another Session', recordedAt: '2026-11-15T08:00:00.000Z' }))

    const fromSecond = store.graphNeighbors('m1', [contextNodeId('cu:s1:2')], 1, 10).map(hit => hit.ref)
    expect(fromSecond).toContain('cu:s1:1')
    expect(fromSecond).toContain('cu:s2:1')

    const crossSession = store.graphNeighbors('m1', [contextNodeId('cu:s2:1')], 1, 10).map(hit => hit.ref)
    expect(crossSession).toContain('cu:s1:1')
    expect(crossSession).toContain('cu:s1:2')
  })

  it('walks two to three hops and clamps depth', () => {
    const store = openStore()
    for (let seq = 1; seq <= 5; seq += 1) {
      store.writeUnit(makeUnit({ seq, text: `step ${seq}`, recordedAt: `2026-11-15T06:0${seq}:00.000Z` }))
    }

    const reached = store.graphNeighbors('m1', [contextNodeId('cu:s1:5')], 9, 10)
    expect(reached.map(hit => [hit.ref, hit.depth])).toEqual([
      ['cu:s1:4', 1],
      ['cu:s1:3', 2],
      ['cu:s1:2', 3],
    ])
  })

  it('ignores edges that were retired', () => {
    const store = openStore()
    store.upsertNode({ nodeId: 'mn:a', memberId: 'm1', sessionId: 's1', level: 'L1', kind: 'decision', label: 'a', ref: 'cu:s1:a' })
    store.upsertNode({ nodeId: 'mn:b', memberId: 'm1', sessionId: 's1', level: 'L1', kind: 'decision', label: 'b', ref: 'cu:s1:b' })
    store.upsertEdge({ memberId: 'm1', srcId: 'mn:a', dstId: 'mn:b', kind: 'mentions', validFrom: '2026-11-15T06:00:00.000Z', validTo: '2026-11-15T09:00:00.000Z' })

    expect(store.graphNeighbors('m1', ['mn:a'], 2, 10)).toEqual([])
  })
})

describe('context graph supersession', () => {
  function seeded(): ContextStore {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1, text: 'decision: use alpha for the recall fold', recordedAt: '2026-11-15T06:00:00.000Z' }))
    store.writeUnit(makeUnit({ seq: 2, text: 'decision: use beta for the recall fold', recordedAt: '2026-11-15T07:00:00.000Z' }))
    return store
  }

  it('marks the old node superseded and resolves the replacing ref', () => {
    const store = seeded()
    store.supersedeUnit('cu:s1:2', 'cu:s1:1', new Date('2026-11-15T08:00:00.000Z'))

    expect(store.getNode(contextNodeId('cu:s1:1'))).toMatchObject({
      status: 'superseded',
      supersededBy: contextNodeId('cu:s1:2'),
      validTo: '2026-11-15T08:00:00.000Z',
    })
    expect(store.getNode(contextNodeId('cu:s1:2'))?.status).toBe('current')

    const statuses = store.unitStatuses('m1', ['cu:s1:1', 'cu:s1:2'])
    expect(statuses.get('cu:s1:1')).toEqual({
      status: 'superseded',
      supersededByRef: 'cu:s1:2',
      validTo: '2026-11-15T08:00:00.000Z',
    })
    expect(statuses.get('cu:s1:2')).toEqual({ status: 'current' })
  })

  it('keeps the supersedes relation walkable and never revives the old node', () => {
    const store = seeded()
    store.supersedeUnit('cu:s1:2', 'cu:s1:1')

    expect(store.graphNeighbors('m1', [contextNodeId('cu:s1:1')], 1, 10).map(hit => hit.ref)).toContain('cu:s1:2')

    store.upsertNode({
      nodeId: contextNodeId('cu:s1:1'),
      memberId: 'm1',
      sessionId: 's1',
      level: 'L1',
      kind: 'decision',
      label: 'rewritten',
      ref: 'cu:s1:1',
      status: 'current',
    })
    expect(store.getNode(contextNodeId('cu:s1:1'))?.status).toBe('superseded')
  })

  it('rejects supersession across Members or onto a missing unit', () => {
    const store = seeded()
    store.writeUnit(makeUnit({ memberId: 'm2', sessionId: 's3', seq: 1, text: 'other member unit' }))

    expect(() => store.supersedeUnit('cu:s3:1', 'cu:s1:1')).toThrow(/Member boundaries/)
    expect(() => store.supersedeUnit('cu:s1:2', 'cu:s1:99')).toThrow(/both units to exist/)
  })
})
