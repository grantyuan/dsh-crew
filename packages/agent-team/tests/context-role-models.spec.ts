import { describe, expect, it } from 'vitest'
import {
  BUILTIN_EMBEDDING_MODEL_ID,
  CONTEXT_ROLE_TIMEOUT_MS,
  contextRoleModelsFromSettings,
  contextRoleSettingKey,
  defaultContextRoleModels,
  emptyContextRoleEntry,
  isContextRoleConfigured,
  normalizeContextRoleEntry,
  resolveContextRoleRoute,
  validateContextRoleEntry,
  type ContextRoleEntry,
  type ContextRoleModels,
} from '../src/context/role-models.ts'

const entry = (overrides: Partial<ContextRoleEntry> = {}): ContextRoleEntry => ({
  ...emptyContextRoleEntry(),
  ...overrides,
})

const roles = (overrides: Partial<Record<keyof ContextRoleModels, ContextRoleEntry>>): ContextRoleModels => ({
  ...defaultContextRoleModels(),
  ...overrides,
})

const main = { provider: 'deepseek', model: 'deepseek-v4' }

describe('context role entries', () => {
  it('reads the four independent roles from flat Host settings', () => {
    expect(contextRoleSettingKey('decision', 'Model')).toBe('contextRoleDecisionModel')
    const models = contextRoleModelsFromSettings({
      contextRoleDecisionBaseURL: ' https://decision.test/v1/ ',
      contextRoleDecisionModel: 'judge',
      contextRoleDecisionApiKey: 'secret',
      contextRoleDecisionEnabled: true,
      contextRoleEmbeddingEnabled: true,
    })
    expect(models.decision).toEqual({ baseURL: 'https://decision.test/v1', model: 'judge', apiKey: 'secret', enabled: true })
    expect(models.embedding).toEqual({ ...emptyContextRoleEntry(), enabled: true })
    expect(models.assistant).toEqual(emptyContextRoleEntry())
    expect(models.extraction).toEqual(emptyContextRoleEntry())
  })

  it('normalizes whitespace and trailing slashes without inventing values', () => {
    expect(normalizeContextRoleEntry({ baseURL: ' https://example.test/v1/// ', model: ' m ', apiKey: ' k ', enabled: true }))
      .toEqual({ baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k', enabled: true })
    expect(normalizeContextRoleEntry(undefined)).toEqual(emptyContextRoleEntry())
  })

  it('requires an endpoint and a model together', () => {
    expect(validateContextRoleEntry(entry({ baseURL: 'https://example.test' }))).toEqual([
      'endpoint and model must be provided together',
    ])
    expect(validateContextRoleEntry(entry({ model: 'm' }))).toEqual([
      'model requires an endpoint',
    ])
  })

  it('accepts http(s) and rejects credentials, fragments and other schemes', () => {
    expect(validateContextRoleEntry(entry({ baseURL: 'https://example.test/v1', model: 'm' }))).toEqual([])
    expect(validateContextRoleEntry(entry({ baseURL: 'http://127.0.0.1:8080', model: 'm' }))).toEqual([])
    expect(validateContextRoleEntry(entry({ baseURL: 'file:///tmp/model', model: 'm' }))).toEqual([
      'endpoint must use http or https',
    ])
    expect(validateContextRoleEntry(entry({ baseURL: 'https://user:pass@example.test', model: 'm' }))).toEqual([
      'endpoint must not embed credentials',
    ])
    expect(validateContextRoleEntry(entry({ baseURL: 'https://example.test/#frag', model: 'm' }))).toEqual([
      'endpoint must not carry a fragment',
    ])
  })

  it('treats enabled plus endpoint plus model as configured, blank as not configured', () => {
    expect(isContextRoleConfigured(entry({ enabled: true, baseURL: 'https://x.test', model: 'm' }))).toBe(true)
    expect(isContextRoleConfigured(entry({ enabled: false, baseURL: 'https://x.test', model: 'm' }))).toBe(false)
    expect(isContextRoleConfigured(entry({ enabled: true }))).toBe(false)
    expect(defaultContextRoleModels().decision).toEqual(emptyContextRoleEntry())
  })
})

describe('generative role fallback chain', () => {
  it('uses the dedicated endpoint first with the small-model prompt profile', () => {
    const route = resolveContextRoleRoute({
      role: 'decision',
      roles: roles({ decision: entry({ enabled: true, baseURL: 'https://small.test/v1', model: 'judge' }) }),
      main,
    })
    expect(route).toMatchObject({
      source: 'role',
      transport: 'openai-compatible',
      promptProfile: 'small',
      baseURL: 'https://small.test/v1',
      model: 'judge',
      timeoutMs: CONTEXT_ROLE_TIMEOUT_MS.decision,
    })
  })

  it('falls back to the configured assistant endpoint with the general prompt profile', () => {
    const route = resolveContextRoleRoute({
      role: 'extraction',
      roles: roles({ assistant: entry({ enabled: true, baseURL: 'https://assistant.test/v1', model: 'general', apiKey: 'secret' }) }),
      main,
    })
    expect(route).toMatchObject({
      source: 'assistant',
      transport: 'openai-compatible',
      promptProfile: 'general',
      baseURL: 'https://assistant.test/v1',
      model: 'general',
      apiKey: 'secret',
      timeoutMs: CONTEXT_ROLE_TIMEOUT_MS.extraction,
    })
  })

  it('falls back to the Agent main model through the host LLM service', () => {
    const route = resolveContextRoleRoute({ role: 'assistant', roles: roles({}), main })
    expect(route).toMatchObject({
      source: 'main',
      transport: 'host-llm',
      promptProfile: 'general',
      provider: 'deepseek',
      model: 'deepseek-v4',
      timeoutMs: CONTEXT_ROLE_TIMEOUT_MS.assistant,
    })
  })

  it('turns the role off when no dedicated, assistant or main route exists', () => {
    const route = resolveContextRoleRoute({ role: 'decision', roles: roles({}) })
    expect(route).toMatchObject({ source: 'off', transport: 'lexical', model: '' })
  })

  it('makes the assistant role skip its own second hop', () => {
    const route = resolveContextRoleRoute({ role: 'assistant', roles: roles({}), main })
    expect(route.source).toBe('main')
  })

  it('does not stitch fields across roles', () => {
    const route = resolveContextRoleRoute({
      role: 'decision',
      roles: roles({ decision: entry({ enabled: true, baseURL: 'https://judge.test', model: '' }) }),
      main,
    })
    expect(route.source).toBe('main')
  })
})

describe('embedding role is not a chat fallback', () => {
  it('is lexical when explicitly disabled', () => {
    expect(resolveContextRoleRoute({
      role: 'embedding',
      roles: roles({ embedding: entry({ enabled: false, baseURL: 'https://embed.test', model: 'e' }) }),
      main,
    })).toMatchObject({ source: 'lexical', reason: 'embedding-disabled' })
  })

  it('uses the dedicated endpoint when configured', () => {
    expect(resolveContextRoleRoute({
      role: 'embedding',
      roles: roles({ embedding: entry({ enabled: true, baseURL: 'https://embed.test/v1', model: 'e' }) }),
      main,
    })).toMatchObject({
      source: 'role',
      transport: 'openai-compatible',
      promptProfile: 'embedding',
      model: 'e',
    })
  })

  it('uses the built-in local model when enabled but unconfigured', () => {
    expect(resolveContextRoleRoute({
      role: 'embedding',
      roles: roles({ embedding: entry({ enabled: true }) }),
      main,
      embedding: { localReady: true, assistantEmbeddings: 'unknown' },
    })).toMatchObject({
      source: 'local',
      transport: 'local-onnx',
      model: BUILTIN_EMBEDDING_MODEL_ID,
      promptProfile: 'embedding',
    })
  })

  it('uses an assistant endpoint only when it is known to support embeddings', () => {
    const configured = roles({ assistant: entry({ enabled: true, baseURL: 'https://assistant.test/v1', model: 'a' }) })
    expect(resolveContextRoleRoute({
      role: 'embedding',
      roles: { ...configured, embedding: entry({ enabled: true }) },
      main,
      embedding: { localReady: false, assistantEmbeddings: 'supported' },
    })).toMatchObject({ source: 'assistant', transport: 'openai-compatible' })
    expect(resolveContextRoleRoute({
      role: 'embedding',
      roles: { ...configured, embedding: entry({ enabled: true }) },
      main,
      embedding: { localReady: false, assistantEmbeddings: 'unsupported' },
    })).toMatchObject({ source: 'lexical', reason: 'assistant-endpoint-has-no-embeddings' })
  })

  it('never routes embedding to the main chat model', () => {
    const route = resolveContextRoleRoute({
      role: 'embedding',
      roles: roles({ embedding: entry({ enabled: true }) }),
      main,
      embedding: { localReady: false, assistantEmbeddings: 'unknown' },
    })
    expect(route.source).toBe('lexical')
    expect(route.transport).toBe('lexical')
  })
})
