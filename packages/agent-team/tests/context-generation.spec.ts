import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_GENERATION,
  buildGenerationSummary,
  generationNodeId,
  rollupGeneration,
} from '../src/context/generation.ts'
import { ContextPipeline } from '../src/context/pipeline.ts'
import { ContextService } from '../src/context/service.ts'
import { ContextStore } from '../src/context/store.ts'
import { buildContextUnit } from '../src/context/units.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function openStore(): ContextStore {
  const store = new ContextStore({ path: ':memory:', disableFts: true })
  cleanups.push(() => store.close())
  return store
}

function makeUnit(seq: number, text: string) {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq,
    role: 'user',
    text,
    recordedAt: `2026-11-15T06:${String(seq).padStart(2, '0')}:00.000Z`,
    timezone: 'Asia/Shanghai',
  }, { now: NOW })
}

describe('context generation rollup', () => {
  it('rolls committed segment digests up into one L3 generation node', () => {
    const store = openStore()
    store.writeUnit(makeUnit(1, '决定：采用 alpha 方案。'))
    store.writeUnit(makeUnit(2, '决定：改用 beta 方案。'))
    store.commitSegment({
      memberId: 'm1',
      sessionId: 's1',
      fromSeq: 1,
      toSeq: 2,
      frontierSeq: 2,
      digest: {
        summary: 'Window one settled on alpha.',
        decisions: ['采用 alpha 方案。'],
        commitments: ['下周复测'],
        openLoops: ['确认阈值？'],
      },
      digestHash: 'h1',
      label: 'window 1',
      validFrom: '2026-11-15T06:00:00.000Z',
    })

    const generation = rollupGeneration(store, 'm1', 's1', { now: NOW() })
    expect(generation).toMatchObject({
      ref: 'gen:s1',
      sessionId: 's1',
      confidence: 0.8,
      segments: ['seg:s1:1-2'],
    })
    // Decisions travel verbatim; the rollup never re-summarizes them.
    expect(generation!.summary).toContain('采用 alpha 方案。')
    expect(store.getNode(generationNodeId('s1'))).toMatchObject({
      level: 'L3',
      kind: 'generation',
      ref: 'gen:s1',
    })
    expect(store.generationSummaries('m1', ['s1'])).toMatchObject([{
      ref: 'gen:s1',
      summary: generation!.summary,
      segments: ['seg:s1:1-2'],
    }])
  })

  it('falls back to L1 units when a short generation has no segments', () => {
    const store = openStore()
    store.writeUnit(makeUnit(1, '决定：保留 beta 兼容层。'))

    const generation = rollupGeneration(store, 'm1', 's1', { now: NOW() })
    expect(generation).toMatchObject({ ref: 'gen:s1', confidence: 0.6, segments: [] })
    expect(generation!.summary).toContain('保留 beta 兼容层。')
  })

  it('keeps the generation summary inside its character bound', () => {
    const units = Array.from({ length: 30 }, (_, index) => makeUnit(index + 1, `决定：${index} ${'x'.repeat(200)}`))
    const built = buildGenerationSummary({ sessionId: 's1', segments: [], units })
    expect(built!.summary.length).toBeLessThanOrEqual(CONTEXT_GENERATION.maxSummaryChars)
    expect(built!.summary.length).toBeGreaterThan(2_000)
  })

  it('rolls the previous generation up when the Member moves to a new Session', () => {
    const service = new ContextService({ path: ':memory:', disableFts: true })
    cleanups.push(() => service.close())
    const pipeline = new ContextPipeline({ service, now: NOW })
    pipeline.recordSessionEvent('m1', 's1', {
      type: 'user/message',
      seq: 1,
      time: Date.parse('2026-11-15T06:00:00.000Z'),
      data: { role: 'user', content: [{ type: 'text', text: '决定：采用 alpha 方案。' }], source: { kind: 'user' } },
    })
    expect(service.contextStore()!.listUnits('m1', 's1')).toHaveLength(1)

    pipeline.recordSessionEvent('m1', 's2', {
      type: 'user/message',
      seq: 1,
      time: Date.parse('2026-11-15T07:00:00.000Z'),
      data: { role: 'user', content: [{ type: 'text', text: '新的一代。' }], source: { kind: 'user' } },
    })
    const generations = service.contextStore()!.generationSummaries('m1', ['s1'])
    expect(generations).toHaveLength(1)
    expect(generations[0]).toMatchObject({ ref: 'gen:s1' })
    expect(generations[0]!.summary).toContain('采用 alpha 方案。')
  })
})
