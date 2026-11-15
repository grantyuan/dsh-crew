import { afterEach, describe, expect, it } from 'vitest'
import { ContextPipeline, type ContextPipelineRuntime } from '../src/context/pipeline.ts'
import { contextUnitFromEvent } from '../src/context/intake.ts'
import { ContextService } from '../src/context/service.ts'
import { buildContextUnit } from '../src/context/units.ts'
import type { ContextDigest } from '../src/context/types.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const DIGEST: ContextDigest = {
  summary: 'We kept the recall fold deterministic.',
  decisions: ['step 1'],
  commitments: ['step 2'],
  openLoops: ['Confirm the embedding size'],
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function service(): ContextService {
  const created = new ContextService({ path: ':memory:', disableFts: true })
  cleanups.push(() => created.close())
  return created
}

function denseUnit(seq: number, tokens = 8_000): ReturnType<typeof buildContextUnit> {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq,
    role: 'user',
    text: `step ${seq} ${'x'.repeat(tokens * 4)}`,
    recordedAt: `2026-11-15T06:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    timezone: 'Asia/Shanghai',
  }, { now: NOW })
}

function seed(target: ContextService, count: number): void {
  const store = target.contextStore()!
  for (let seq = 1; seq <= count; seq += 1) store.writeUnit(denseUnit(seq))
}

interface StubCalls {
  readonly chats: unknown[]
  readonly embeds: readonly string[][]
}

function stubRuntime(options: {
  readonly digest?: ContextDigest
  readonly chatFails?: boolean
  readonly vectors?: readonly Float32Array[]
} = {}): { runtime: ContextPipelineRuntime; calls: StubCalls } {
  const chats: unknown[] = []
  const embeds: string[][] = []
  const runtime = {
    async chat(_role: string, _task: string, payload: unknown) {
      chats.push(payload)
      if (options.chatFails === true) return { ok: false, kind: 'unavailable', reason: 'down', latencyMs: 1 }
      return {
        ok: true,
        text: JSON.stringify(options.digest ?? DIGEST),
        route: { role: 'assistant', source: 'assistant', transport: 'http', promptProfile: 'default', timeoutMs: 1, model: 'assistant-model' },
        latencyMs: 1,
      }
    },
    async embed(texts: readonly string[]) {
      embeds.push([...texts])
      return {
        ok: true,
        vectors: options.vectors ?? texts.map(() => new Float32Array([1, 0])),
        dimension: 2,
        modelId: 'test-embedding',
        source: 'embedding',
        latencyMs: 1,
      }
    },
  } as unknown as ContextPipelineRuntime
  return { runtime, calls: { chats, embeds } }
}

describe('context session intake', () => {
  it('indexes real user, assistant, and tool text only', () => {
    const user = contextUnitFromEvent('m1', 's1', {
      type: 'user/message',
      seq: 3,
      time: Date.parse('2026-11-15T06:00:00.000Z'),
      data: { role: 'user', content: [{ type: 'text', text: 'keep it deterministic' }], source: { kind: 'user' } },
    })
    expect(user).toMatchObject({ memberId: 'm1', sessionId: 's1', seq: 3, role: 'user', text: 'keep it deterministic', eventType: 'user/message' })
    const assistant = contextUnitFromEvent('m1', 's1', {
      type: 'assistant/message',
      seq: 4,
      time: Date.parse('2026-11-15T06:00:01.000Z'),
      data: { message: { content: [{ type: 'text', text: 'I kept it.' }], source: { kind: 'model' } } },
    })
    expect(assistant).toMatchObject({ role: 'assistant', text: 'I kept it.' })
    const tool = contextUnitFromEvent('m1', 's1', {
      type: 'tool/result',
      seq: 5,
      time: Date.parse('2026-11-15T06:00:02.000Z'),
      data: { message: { content: [{ type: 'text', text: 'exit 0' }], source: { kind: 'tool' } } },
    })
    expect(tool).toMatchObject({ role: 'tool', text: 'exit 0' })
  })

  it('ignores plugin-injected user messages and empty prose', () => {
    expect(contextUnitFromEvent('m1', 's1', {
      type: 'user/message',
      seq: 6,
      time: Date.now(),
      data: { role: 'user', content: [{ type: 'text', text: '<recall-snapshot>' }], source: { kind: 'agent-team' } },
    })).toBeUndefined()
    expect(contextUnitFromEvent('m1', 's1', {
      type: 'assistant/message',
      seq: 7,
      time: Date.now(),
      data: { message: { content: [{ type: 'tool-call', id: 'c1' }], source: { kind: 'model' } } },
    })).toBeUndefined()
    expect(contextUnitFromEvent('m1', 's1', { type: 'turn/end', seq: 8, time: Date.now(), data: {} })).toBeUndefined()
  })
})

describe('context pipeline background work', () => {
  it('backfills one embedding batch and drains the queue', async () => {
    const target = service()
    seed(target, 1)
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW })
    const result = await pipeline.drainEmbeddings('m1')
    expect(result).toEqual({ claimed: 1, embedded: 1, failed: 0 })
    expect(calls.embeds).toHaveLength(1)
    const unit = target.contextStore()!.listUnits('m1', 's1')[0]!
    expect(target.contextStore()!.getVector(unit.unitId)?.model).toBe('test-embedding')
    expect(target.contextStore()!.pendingVectorUnits(8, 'm1')).toHaveLength(0)
  })

  it('keeps the queue when the embedding role is off', async () => {
    const target = service()
    seed(target, 1)
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW, canEmbed: () => false })
    expect(await pipeline.drainEmbeddings('m1')).toEqual({ claimed: 0, embedded: 0, failed: 0 })
    expect(calls.embeds).toHaveLength(0)
    expect(target.contextStore()!.pendingVectorUnits(8, 'm1')).toHaveLength(1)
  })

  it('writes nothing while every context role is off', async () => {
    const target = service()
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW, canIndex: () => false })
    pipeline.recordSessionEvent('m1', 's1', {
      type: 'user/message',
      seq: 1,
      time: Date.parse('2026-11-15T06:00:00.000Z'),
      data: { role: 'user', content: [{ type: 'text', text: 'what did we decide?' }], source: { kind: 'user' } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(target.contextStore()!.listUnits('m1', 's1')).toHaveLength(0)
    expect(calls.embeds).toHaveLength(0)
    expect(target.contextStore()!.pendingOutboxCount('enrich')).toBe(0)
  })

  it('does not enqueue extraction while the generative roles are off', async () => {
    const target = service()
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW, canEnrich: () => false })
    pipeline.recordSessionEvent('m1', 's1', {
      type: 'assistant/message',
      seq: 1,
      time: Date.parse('2026-11-15T06:00:00.000Z'),
      data: { message: { content: [{ type: 'text', text: 'I kept it.' }], source: { kind: 'model' } } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(target.contextStore()!.listUnits('m1', 's1')).toHaveLength(1)
    expect(target.contextStore()!.pendingOutboxCount('enrich')).toBe(0)
    await pipeline.drainEnrichment()
    expect(calls.chats).toHaveLength(0)
  })

  it('only reuses a query vector for the exact text it embedded', async () => {
    const target = service()
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW })
    await pipeline.primeQueryVector('m1', 'embedding size')
    expect(pipeline.queryVector('m1', 'embedding size')).toEqual(new Float32Array([1, 0]))
    expect(pipeline.queryVector('m1', 'other text')).toBeUndefined()
    await pipeline.primeQueryVector('m1', 'embedding size')
    expect(calls.embeds).toHaveLength(1)
  })

  it('prepares once, commits without a second model call, and caches the summary', async () => {
    const target = service()
    seed(target, 16)
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW, canSummarize: () => true })
    const prepared = await pipeline.prepare('m1', 's1')
    expect(prepared.ok).toBe(true)
    expect(calls.chats).toHaveLength(1)
    expect(pipeline.hasPending('m1', 's1')).toBe(true)
    expect(pipeline.pendingIsFresh('m1', 's1')).toBe(true)

    const committed = await pipeline.commit('m1', 's1')
    expect(committed.ok).toBe(true)
    expect(calls.chats).toHaveLength(1)
    expect(pipeline.hasPending('m1', 's1')).toBe(false)
    expect(pipeline.takePreparedSummary('m1')).toBe(DIGEST.summary)
    expect(pipeline.takePreparedSummary('m1')).toBeUndefined()

    const store = target.contextStore()!
    const segments = store.listSegments('m1', 's1')
    expect(segments).toHaveLength(1)
    expect(store.listCommitments(segments[0]!.segmentId)).toHaveLength(2)
  })

  it('does nothing on idle preparation when the assistant role is off', async () => {
    const target = service()
    seed(target, 16)
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW, canSummarize: () => false })
    expect(await pipeline.prepare('m1', 's1')).toEqual({ ok: false, reason: 'assistant-role-off' })
    expect(calls.chats).toHaveLength(0)
    expect(pipeline.hasPending('m1', 's1')).toBe(false)
  })

  it('records a live user event and primes its query vector', async () => {
    const target = service()
    const { runtime, calls } = stubRuntime()
    const pipeline = new ContextPipeline({ service: target, runtime, now: NOW })
    pipeline.recordSessionEvent('m1', 's1', {
      type: 'user/message',
      seq: 1,
      time: Date.parse('2026-11-15T06:00:00.000Z'),
      data: { role: 'user', content: [{ type: 'text', text: 'what did we decide?' }], source: { kind: 'user' } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(target.contextStore()!.listUnits('m1', 's1')).toHaveLength(1)
    expect(calls.embeds.some(batch => batch[0] === 'what did we decide?')).toBe(true)
    expect(pipeline.queryVector('m1', 'what did we decide?')).toEqual(new Float32Array([1, 0]))
  })
})
