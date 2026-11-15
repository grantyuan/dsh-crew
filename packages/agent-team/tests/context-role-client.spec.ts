import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import {
  ContextRoleError,
  HostModelRoleClient,
  OpenAiCompatibleRoleClient,
  roleEndpoint,
  type HostLlm,
} from '../src/context/role-client.ts'
import type { ContextRoleRoute } from '../src/context/role-models.ts'

const route = (overrides: Partial<ContextRoleRoute> = {}): ContextRoleRoute => ({
  role: 'decision',
  source: 'role',
  transport: 'openai-compatible',
  promptProfile: 'small',
  timeoutMs: 1_000,
  model: 'judge',
  baseURL: 'https://roles.test/v1',
  ...overrides,
})

const request = (signal = new AbortController().signal) => ({
  system: 'system',
  messages: [{ role: 'user' as const, content: 'payload' }],
  maxTokens: 100,
  signal,
})

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

describe('OpenAI-compatible role client', () => {
  it('joins endpoints without guessing /v1', () => {
    expect(roleEndpoint('https://roles.test/v1/', '/chat/completions')).toBe('https://roles.test/v1/chat/completions')
    expect(roleEndpoint('https://roles.test', 'embeddings')).toBe('https://roles.test/embeddings')
  })

  it('reads string and block-array content and reports usage', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const client = new OpenAiCompatibleRoleClient(async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
    })
    const result = await client.chat(route(), request())
    expect(result).toMatchObject({ text: 'hello', model: 'judge', usage: { input: 3, output: 2 } })
    expect(calls[0]?.url).toBe('https://roles.test/v1/chat/completions')
    const body = JSON.parse(String(calls[0]?.init?.body)) as { stream: boolean; messages: unknown[] }
    expect(body.stream).toBe(false)
    expect(body.messages).toHaveLength(2)
  })

  it('classifies auth, rate-limit and invalid responses without leaking the key', async () => {
    const auth = new OpenAiCompatibleRoleClient(async () => jsonResponse({ error: 'nope' }, 401))
    await expect(auth.chat(route({ apiKey: 'secret' }), request())).rejects.toMatchObject({
      kind: 'role-auth',
      message: expect.not.stringContaining('secret'),
    })
    const limited = new OpenAiCompatibleRoleClient(async () => jsonResponse({}, 429))
    await expect(limited.chat(route(), request())).rejects.toMatchObject({ kind: 'role-rate-limit' })
    const broken = new OpenAiCompatibleRoleClient(async () => new Response('not-json', { status: 200 }))
    await expect(broken.chat(route(), request())).rejects.toMatchObject({ kind: 'role-invalid-response' })
  })

  it('times out a hanging endpoint', async () => {
    const client = new OpenAiCompatibleRoleClient(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    await expect(client.chat(route({ timeoutMs: 5 }), request())).rejects.toMatchObject({ kind: 'role-timeout' })
  })

  it('normalizes embedding vectors and rejects inconsistent dimensions', async () => {
    const client = new OpenAiCompatibleRoleClient(async () => jsonResponse({
      data: [{ embedding: [3, 4] }, { embedding: [0, 2] }],
    }))
    const result = await client.embed(route({ role: 'embedding', promptProfile: 'embedding' }), ['a', 'b'], new AbortController().signal)
    expect(result.dimension).toBe(2)
    expect(result.vectors[0]![0]).toBeCloseTo(0.6, 5)
    expect(result.vectors[0]![1]).toBeCloseTo(0.8, 5)
    expect(Array.from(result.vectors[1]!)).toEqual([0, 1])

    const bad = new OpenAiCompatibleRoleClient(async () => jsonResponse({
      data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3] }],
    }))
    await expect(bad.embed(route({ role: 'embedding' }), ['a', 'b'], new AbortController().signal))
      .rejects.toMatchObject({ kind: 'role-invalid-response' })
  })
})

describe('host model role client', () => {
  const llm = (chunks: readonly StreamChunk[]): HostLlm => ({
    async *stream() {
      yield* chunks
    },
  })

  it('assembles text from the Harness stream', async () => {
    const client = new HostModelRoleClient(llm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'main ' },
      { type: 'text-delta', index: 0, text: 'answer' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const result = await client.chat(route({ source: 'main', transport: 'host-llm', promptProfile: 'general', provider: 'p', model: 'm' }), request())
    expect(result.text).toBe('main answer')
    expect(result.model).toBe('m')
  })

  it('never serves embeddings', async () => {
    const client = new HostModelRoleClient(llm([]))
    await expect(client.embed()).rejects.toBeInstanceOf(ContextRoleError)
    await expect(client.embed()).rejects.toMatchObject({ kind: 'role-incompatible' })
  })
})
