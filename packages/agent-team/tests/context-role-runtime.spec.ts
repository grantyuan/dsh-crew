import { describe, expect, it } from 'vitest'
import type { HostLlm, RoleEmbeddingResult } from '../src/context/role-client.ts'
import {
  defaultContextRoleModels,
  normalizeContextRoleEntry,
  type ContextRoleEntry,
  type ContextRoleModels,
} from '../src/context/role-models.ts'
import { ContextRoleRuntime, type LocalEmbeddingProvider } from '../src/context/role-runtime.ts'

const llm: HostLlm = {
  stream() {
    throw new Error('the host chat model must not be called for embeddings')
  },
}

const entry = (overrides: Partial<ContextRoleEntry> = {}): ContextRoleEntry => normalizeContextRoleEntry({
  baseURL: 'https://role.test/v1',
  model: 'role-model',
  enabled: true,
  ...overrides,
})

const roles = (overrides: Partial<ContextRoleModels> = {}): ContextRoleModels => ({
  ...defaultContextRoleModels(),
  embedding: normalizeContextRoleEntry({ enabled: true }),
  ...overrides,
})

const localProvider = (result: RoleEmbeddingResult): LocalEmbeddingProvider => ({
  available: () => true,
  embed: async () => result,
})

const localResult: RoleEmbeddingResult = {
  vectors: [new Float32Array([1, 0])],
  dimension: 2,
  modelId: 'granite-embedding-97m-multilingual-r2',
  latencyMs: 3,
}

const embeddingsBody = (count: number): string => JSON.stringify({
  data: Array.from({ length: count }, () => ({ embedding: [1, 0] })),
})

const jsonResponse = (body: string, status = 200): Response => new Response(body, {
  status,
  headers: { 'content-type': 'application/json' },
})

describe('ContextRoleRuntime.embed fallback chain', () => {
  it('falls back to the built-in local model when the dedicated endpoint fails', async () => {
    const runtime = new ContextRoleRuntime({
      readRoles: () => roles({ embedding: entry() }),
      llm,
      fetchImpl: async () => jsonResponse('{"error":"down"}', 500),
      localEmbedding: localProvider(localResult),
    })
    const outcome = await runtime.embed(['hello'])
    expect(outcome).toMatchObject({ ok: true, source: 'local', modelId: 'granite-embedding-97m-multilingual-r2' })
  })

  it('falls back to the assistant endpoint after the local model is unavailable', async () => {
    const requested: string[] = []
    const runtime = new ContextRoleRuntime({
      readRoles: () => roles({ assistant: entry({ model: 'assistant-model' }) }),
      llm,
      fetchImpl: async (url) => {
        requested.push(String(url))
        return jsonResponse(embeddingsBody(1))
      },
    })
    const outcome = await runtime.embed(['hello'])
    expect(outcome).toMatchObject({ ok: true, source: 'assistant', modelId: 'assistant-model' })
    expect(requested).toEqual(['https://role.test/v1/embeddings'])
  })

  it('degrades to lexical when the assistant endpoint has no /embeddings route', async () => {
    let calls = 0
    const runtime = new ContextRoleRuntime({
      readRoles: () => roles({ assistant: entry() }),
      llm,
      fetchImpl: async () => {
        calls += 1
        return jsonResponse('{"error":"not found"}', 404)
      },
    })
    const first = await runtime.embed(['hello'])
    expect(first).toMatchObject({ ok: false, source: 'assistant' })
    const second = await runtime.embed(['hello'])
    expect(second).toMatchObject({ ok: false, kind: 'lexical', source: 'lexical' })
    expect(calls).toBe(1)
  })

  it('degrades to lexical without calling the main chat model', async () => {
    const runtime = new ContextRoleRuntime({ readRoles: () => roles(), llm })
    const outcome = await runtime.embed(['hello'])
    expect(outcome).toMatchObject({ ok: false, kind: 'lexical', source: 'lexical' })
  })

  it('never embeds when the embedding role is disabled', async () => {
    const runtime = new ContextRoleRuntime({
      readRoles: () => roles({ embedding: entry({ enabled: false }) }),
      llm,
      localEmbedding: localProvider(localResult),
    })
    const outcome = await runtime.embed(['hello'])
    expect(outcome).toMatchObject({ ok: false, kind: 'lexical', reason: 'embedding role is disabled' })
  })
})
