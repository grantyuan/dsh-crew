import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_COMPACTION,
  commitPreparedEpoch,
  committedDigestForSeq,
  compactionInput,
  digestHash,
  parseDigestReply,
  planContextCompaction,
  prepareEpoch,
  validateCommitments,
} from '../src/context/compaction.ts'
import { ContextStore } from '../src/context/store.ts'
import type { ContextDigest } from '../src/context/types.ts'
import { buildContextUnit } from '../src/context/units.ts'
import type { ContextUnitInput } from '../src/context/types.ts'

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
    text: 'decision: keep the recall fold deterministic',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }, { now: NOW })
}

/** One unit at the token target (4 chars == 1 estimated token). */
function denseUnit(seq: number, tokens = 8_000, role: ContextUnitInput['role'] = 'user') {
  return makeUnit({
    seq,
    role,
    text: `step ${seq} ${'x'.repeat(tokens * 4)}`,
    recordedAt: `2026-11-15T06:${String(seq % 60).padStart(2, '0')}:00.000Z`,
  })
}

function seeded(count: number): ContextStore {
  const store = openStore()
  for (let seq = 1; seq <= count; seq += 1) store.writeUnit(denseUnit(seq))
  return store
}

const DIGEST: ContextDigest = {
  summary: 'We kept the recall fold deterministic.',
  decisions: ['Keep the recall fold deterministic'],
  commitments: ['Alice will review the patch'],
  openLoops: ['Confirm the embedding size'],
}

describe('context compaction planning', () => {
  it('keeps the analysis window and tail floor untouched', () => {
    const store = seeded(16)
    const outcome = planContextCompaction(store.listUnits('m1', 's1'), { expectedRemainingRequests: 20 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fromSeq).toBe(1)
    expect(outcome.plan.toSeq).toBe(11)
    expect(outcome.plan.unitCount).toBe(11)
    expect(outcome.plan.windowTokens).toBeGreaterThanOrEqual(CONTEXT_COMPACTION.minWindowTokens)
    expect(outcome.plan.retainedTokens).toBeGreaterThanOrEqual(CONTEXT_COMPACTION.tailFloorTokens)
  })

  it('rejects a short Session instead of compressing it', () => {
    const store = seeded(9)
    expect(planContextCompaction(store.listUnits('m1', 's1'))).toEqual({ ok: false, reason: 'too-few-turns' })
  })

  it('never cuts between a tool call and its result', () => {
    const store = seeded(16)
    const units = store.listUnits('m1', 's1')
    units[11] = { ...units[11]!, role: 'tool' }
    const outcome = planContextCompaction(units, { expectedRemainingRequests: 20 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.toSeq).toBeLessThanOrEqual(units[10]!.seq)
  })

  it('honours the committed frontier', () => {
    const store = seeded(21)
    const outcome = planContextCompaction(store.listUnits('m1', 's1'), {
      frontierSeq: 5,
      expectedRemainingRequests: 20,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.fromSeq).toBe(6)
  })

  it('rejects a Session that cannot fill the tail floor', () => {
    const store = openStore()
    for (let seq = 1; seq <= 16; seq += 1) store.writeUnit(denseUnit(seq, 80))
    expect(planContextCompaction(store.listUnits('m1', 's1'), { expectedRemainingRequests: 20 }))
      .toEqual({ ok: false, reason: 'tail-floor' })
  })
})

describe('context digest preparation', () => {
  it('caps digest input and keeps decisions first', () => {
    const store = openStore()
    store.writeUnit(makeUnit({ seq: 1, text: `决定：${'d'.repeat(2_000)}` }))
    for (let seq = 2; seq <= 12; seq += 1) store.writeUnit(denseUnit(seq))
    const text = compactionInput(store.listUnits('m1', 's1'), 1_000)
    expect(text.split('\n')[0]).toContain('decision')
    expect(text.length).toBeLessThanOrEqual(4_000)
  })

  it('parses fenced JSON and caps the summary', () => {
    const digest = parseDigestReply('```json\n'
      + JSON.stringify({ ...DIGEST, summary: 's'.repeat(CONTEXT_COMPACTION.maxSummaryTokens * 4 + 50) })
      + '\n```')
    expect(digest.decisions).toEqual(DIGEST.decisions)
    expect(digest.summary.length).toBeLessThanOrEqual(CONTEXT_COMPACTION.maxSummaryTokens * 4)
  })

  it('drops commitments whose quote is not verbatim', () => {
    const units = [
      storeUnit(1, 'Alice will review the patch tomorrow.'),
      storeUnit(2, 'The embedding size stays 768.'),
    ]
    const accepted = validateCommitments(units, [
      { kind: 'commitment', text: 'Alice reviews the patch', quote: 'Alice will review the patch' },
      { kind: 'decision', text: 'Embedding size', quote: 'embedding size is 1024' },
    ])
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ ref: 'cu:s1:1', quote: 'Alice will review the patch' })
    expect(accepted[0]!.quoteHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('context compaction commit point', () => {
  it('reuses the pending digest and commits without another model call', async () => {
    const store = seeded(16)
    const summarize = vi.fn(async () => DIGEST)
    const first = await prepareEpoch(store, { memberId: 'm1', sessionId: 's1', summarize })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.reused).toBe(false)

    const second = await prepareEpoch(store, { memberId: 'm1', sessionId: 's1', summarize })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.reused).toBe(true)
    expect(summarize).toHaveBeenCalledTimes(1)

    const compactPrepared = vi.fn(async () => {})
    const commit = await commitPreparedEpoch(store, { memberId: 'm1', sessionId: 's1', compactor: { compactPrepared } })
    expect(commit.ok).toBe(true)
    if (!commit.ok) return
    expect(compactPrepared).toHaveBeenCalledWith(expect.objectContaining({
      fromSeq: first.plan.fromSeq,
      toSeq: first.plan.toSeq,
      summary: DIGEST.summary,
    }))
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(store.getEpoch('m1', 's1')).toMatchObject({ frontierSeq: first.plan.toSeq })
    expect(store.getEpoch('m1', 's1').pending).toBeUndefined()
    expect(committedDigestForSeq(store, 'm1', 's1', first.plan.fromSeq)).toEqual(DIGEST)
    expect(store.listSegments('m1', 's1')).toHaveLength(1)
  })

  it('records only verbatim commitments and exposes them with the segment', async () => {
    const store = seeded(16)
    const prepared = await prepareEpoch(store, {
      memberId: 'm1',
      sessionId: 's1',
      summarize: async () => DIGEST,
      extractCommitments: async () => [
        { kind: 'commitment', text: 'Alice reviews the patch', quote: 'step 3' },
        { kind: 'commitment', text: 'Not present', quote: 'this text does not exist' },
      ],
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.pending.commitments).toHaveLength(1)

    const commit = await commitPreparedEpoch(store, {
      memberId: 'm1',
      sessionId: 's1',
      compactor: { compactPrepared: async () => {} },
    })
    expect(commit.ok).toBe(true)
    if (!commit.ok) return
    const commitments = store.listCommitments(commit.segment.segmentId)
    expect(commitments).toHaveLength(1)
    expect(commitments[0]).toMatchObject({ quote: 'step 3', ref: 'cu:s1:3' })
  })

  it('discards a pending digest whose hash no longer matches', async () => {
    const store = seeded(16)
    store.savePendingEpoch({
      memberId: 'm1',
      sessionId: 's1',
      digest: DIGEST,
      commitments: [],
      hash: 'not-the-digest',
      fromSeq: 1,
      toSeq: 11,
    })
    const commit = await commitPreparedEpoch(store, {
      memberId: 'm1',
      sessionId: 's1',
      compactor: { compactPrepared: async () => {} },
    })
    expect(commit).toEqual({ ok: false, reason: 'stale-pending' })
    expect(store.getEpoch('m1', 's1').pending).toBeUndefined()
  })

  it('is a no-op when nothing was prepared', async () => {
    const store = seeded(16)
    expect(await commitPreparedEpoch(store, {
      memberId: 'm1',
      sessionId: 's1',
      compactor: { compactPrepared: async () => {} },
    })).toEqual({ ok: false, reason: 'no-pending' })
  })
})

function storeUnit(seq: number, text: string) {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq,
    role: 'user',
    text,
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
  }, { now: NOW })
}
