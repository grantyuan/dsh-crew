/**
 * Functional model roles for context management.
 *
 * The four roles are pluggable Host settings, not Team ledger facts: each
 * role carries its own OpenAI-compatible endpoint, model name, optional API
 * key and enable switch. Every field is optional; an unconfigured generative
 * role is simply off. Routes resolve per role as dedicated endpoint →
 * configured `assistant` endpoint → the running Agent main model, and the
 * caller uses the matching prompt profile (small vs general). Embedding is
 * the one exception: it never falls back to a chat model, and an unconfigured
 * enabled embedding role uses the built-in local granite model before lexical
 * retrieval.
 * @module @grantyuan/dsh-crew/context/role-models
 */

import type { AgentTeamModelSelection } from '../types.ts'

/** The four context-management roles. */
export const CONTEXT_MODEL_ROLES = ['assistant', 'embedding', 'decision', 'extraction'] as const

export type ContextModelRole = (typeof CONTEXT_MODEL_ROLES)[number]

/** One role's configurable route. Empty strings mean "not configured". */
export interface ContextRoleEntry {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly enabled: boolean
}

/** All role routes, keyed by role. */
export type ContextRoleModels = Readonly<Record<ContextModelRole, ContextRoleEntry>>

/** Where the effective route came from. */
export type ContextRoleRouteSource = 'role' | 'assistant' | 'main' | 'local' | 'lexical' | 'off'

/** How the route is called. */
export type ContextRoleTransport = 'openai-compatible' | 'host-llm' | 'local-onnx' | 'lexical'

/** Which prompt family the caller must use. */
export type ContextRolePromptProfile = 'small' | 'general' | 'embedding'

/** One resolved route. `model` is empty only when `source` is `off`/`lexical`. */
export interface ContextRoleRoute {
  readonly role: ContextModelRole
  readonly source: ContextRoleRouteSource
  readonly transport: ContextRoleTransport
  readonly promptProfile: ContextRolePromptProfile
  readonly timeoutMs: number
  readonly model: string
  readonly baseURL?: string
  readonly apiKey?: string
  readonly provider?: string
  readonly reason?: string
}

/** Role-specific budgets. These are acceptance thresholds, never relaxed by fallback. */
export const CONTEXT_ROLE_TIMEOUT_MS: Readonly<Record<ContextModelRole, number>> = {
  assistant: 25_000,
  embedding: 5_000,
  decision: 12_000,
  extraction: 12_000,
}

/** Built-in local embedding model used when the embedding role has no endpoint. */
export const BUILTIN_EMBEDDING_MODEL_ID = 'granite-embedding-97m-multilingual-r2'
export const BUILTIN_EMBEDDING_DIMENSION = 384

/** Empty role entry: all fields blank, disabled. */
export function emptyContextRoleEntry(): ContextRoleEntry {
  return { baseURL: '', model: '', apiKey: '', enabled: false }
}

/** Fresh default role set. Embedding's built-in default is applied by the resolver, not here. */
export function defaultContextRoleModels(): ContextRoleModels {
  return {
    assistant: emptyContextRoleEntry(),
    embedding: emptyContextRoleEntry(),
    decision: emptyContextRoleEntry(),
    extraction: emptyContextRoleEntry(),
  }
}

/** Trim text and drop trailing slashes from an endpoint. */
function normalizeBaseURL(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

/** Normalize one role entry: trim strings, normalize the endpoint, keep blank as blank. */
export function normalizeContextRoleEntry(entry: {
  readonly baseURL?: string | undefined
  readonly model?: string | undefined
  readonly apiKey?: string | undefined
  readonly enabled?: boolean | undefined
} | undefined): ContextRoleEntry {
  return {
    baseURL: normalizeBaseURL(entry?.baseURL),
    model: (entry?.model ?? '').trim(),
    apiKey: (entry?.apiKey ?? '').trim(),
    enabled: entry?.enabled === true,
  }
}

/** Whether the entry names a usable dedicated endpoint. */
export function isContextRoleConfigured(entry: ContextRoleEntry): boolean {
  return entry.enabled && entry.baseURL !== '' && entry.model !== ''
}

/**
 * Validate one role's URL pair. Returns human-readable errors; an empty list
 * means the entry may be persisted. Endpoint and model must be either both
 * blank or both present so a half-filled card can never look enabled.
 */
export function validateContextRoleEntry(entry: ContextRoleEntry): string[] {
  const errors: string[] = []
  const hasURL = entry.baseURL !== ''
  const hasModel = entry.model !== ''
  if (hasURL !== hasModel) {
    errors.push(hasURL
      ? 'endpoint and model must be provided together'
      : 'model requires an endpoint')
  }
  if (hasURL) {
    let url: URL
    try {
      url = new URL(entry.baseURL)
    } catch {
      return [...errors, 'endpoint must be an absolute http(s) URL']
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('endpoint must use http or https')
    }
    if (url.username !== '' || url.password !== '') {
      errors.push('endpoint must not embed credentials')
    }
    if (url.hash !== '') {
      errors.push('endpoint must not carry a fragment')
    }
  }
  return errors
}

/**
 * Flat Host settings fields, one group per role. These are the Host row's own
 * volatile Config; `apiKey` stays Host-local and is never returned to the Client.
 */
export interface ContextRoleSettings {
  readonly contextRoleAssistantBaseURL?: string | undefined
  readonly contextRoleAssistantModel?: string | undefined
  readonly contextRoleAssistantApiKey?: string | undefined
  readonly contextRoleAssistantEnabled?: boolean | undefined
  readonly contextRoleEmbeddingBaseURL?: string | undefined
  readonly contextRoleEmbeddingModel?: string | undefined
  readonly contextRoleEmbeddingApiKey?: string | undefined
  readonly contextRoleEmbeddingEnabled?: boolean | undefined
  readonly contextRoleDecisionBaseURL?: string | undefined
  readonly contextRoleDecisionModel?: string | undefined
  readonly contextRoleDecisionApiKey?: string | undefined
  readonly contextRoleDecisionEnabled?: boolean | undefined
  readonly contextRoleExtractionBaseURL?: string | undefined
  readonly contextRoleExtractionModel?: string | undefined
  readonly contextRoleExtractionApiKey?: string | undefined
  readonly contextRoleExtractionEnabled?: boolean | undefined
}

/** Settings field name for one role property, e.g. `contextRoleDecisionModel`. */
export function contextRoleSettingKey(role: ContextModelRole, field: 'BaseURL' | 'Model' | 'ApiKey' | 'Enabled'): string {
  return `contextRole${role.charAt(0).toUpperCase()}${role.slice(1)}${field}`
}

/** Read the four role entries out of the flat Host settings. */
export function contextRoleModelsFromSettings(settings: ContextRoleSettings): ContextRoleModels {
  const read = (role: ContextModelRole): ContextRoleEntry => {
    const field = <T>(name: 'BaseURL' | 'Model' | 'ApiKey' | 'Enabled'): T | undefined =>
      settings[contextRoleSettingKey(role, name) as keyof ContextRoleSettings] as T | undefined
    return normalizeContextRoleEntry({
      baseURL: field<string>('BaseURL'),
      model: field<string>('Model'),
      apiKey: field<string>('ApiKey'),
      enabled: field<boolean>('Enabled'),
    })
  }
  return {
    assistant: read('assistant'),
    embedding: read('embedding'),
    decision: read('decision'),
    extraction: read('extraction'),
  }
}

/** Inputs to route resolution. */
export interface ResolveContextRoleRouteInput {
  readonly role: ContextModelRole
  readonly roles: ContextRoleModels
  readonly main?: AgentTeamModelSelection
  readonly embedding?: {
    readonly localReady: boolean
    readonly assistantEmbeddings: 'unknown' | 'supported' | 'unsupported'
  }
}

function entryRoute(
  role: ContextModelRole,
  source: 'role' | 'assistant',
  entry: ContextRoleEntry,
  promptProfile: ContextRolePromptProfile,
): ContextRoleRoute {
  return {
    role,
    source,
    transport: 'openai-compatible',
    promptProfile,
    timeoutMs: CONTEXT_ROLE_TIMEOUT_MS[role],
    baseURL: entry.baseURL,
    model: entry.model,
    ...(entry.apiKey === '' ? {} : { apiKey: entry.apiKey }),
  }
}

function mainRoute(role: ContextModelRole, main: AgentTeamModelSelection): ContextRoleRoute {
  return {
    role,
    source: 'main',
    transport: 'host-llm',
    promptProfile: 'general',
    timeoutMs: CONTEXT_ROLE_TIMEOUT_MS[role],
    model: main.model,
    provider: main.provider,
  }
}

function offRoute(role: ContextModelRole, reason: string): ContextRoleRoute {
  return {
    role,
    source: 'off',
    transport: 'lexical',
    promptProfile: 'small',
    timeoutMs: CONTEXT_ROLE_TIMEOUT_MS[role],
    model: '',
    reason,
  }
}

function lexicalRoute(role: ContextModelRole, reason: string): ContextRoleRoute {
  return {
    role,
    source: 'lexical',
    transport: 'lexical',
    promptProfile: 'embedding',
    timeoutMs: CONTEXT_ROLE_TIMEOUT_MS[role],
    model: '',
    reason,
  }
}

/**
 * Resolve one role's effective route.
 *
 * Generative roles: dedicated → configured assistant → Agent main model → off.
 * The assistant role itself skips the assistant hop. The prompt profile is
 * part of the resolved route so fallback callers cannot accidentally reuse
 * the dedicated small-model prompt.
 *
 * Embedding: dedicated → built-in local granite → assistant endpoint only if
 * it is known to speak `/embeddings` → lexical. The main model is never an
 * embedding route.
 */
export function resolveContextRoleRoute(input: ResolveContextRoleRouteInput): ContextRoleRoute {
  if (input.role !== 'embedding') return resolveContextRoleCandidates(input)[0]!
  return resolveEmbeddingRoute(input)
}

/**
 * Ordered generative candidates for one role: dedicated → assistant → main.
 * The runtime walks this list on failure, not only on missing config, while
 * sharing the role's total deadline.
 */
export function resolveContextRoleCandidates(input: ResolveContextRoleRouteInput): ContextRoleRoute[] {
  if (input.role === 'embedding') return [resolveEmbeddingRoute(input)]
  const candidates: ContextRoleRoute[] = []
  const own = input.roles[input.role]
  if (isContextRoleConfigured(own)) candidates.push(entryRoute(input.role, 'role', own, 'small'))
  const assistant = input.roles.assistant
  if (input.role !== 'assistant' && isContextRoleConfigured(assistant)) {
    candidates.push(entryRoute(input.role, 'assistant', assistant, 'general'))
  }
  if (input.main !== undefined) candidates.push(mainRoute(input.role, input.main))
  return candidates.length === 0 ? [offRoute(input.role, 'no-role-assistant-or-main-model')] : candidates
}

function resolveEmbeddingRoute(input: ResolveContextRoleRouteInput): ContextRoleRoute {
  const own = input.roles.embedding

  if (input.role === 'embedding') {
    if (!own.enabled) return lexicalRoute('embedding', 'embedding-disabled')
    if (isContextRoleConfigured(own)) return entryRoute('embedding', 'role', own, 'embedding')
    if (input.embedding?.localReady === true) {
      return {
        role: 'embedding',
        source: 'local',
        transport: 'local-onnx',
        promptProfile: 'embedding',
        timeoutMs: CONTEXT_ROLE_TIMEOUT_MS.embedding,
        model: BUILTIN_EMBEDDING_MODEL_ID,
      }
    }
    const assistant = input.roles.assistant
    if (isContextRoleConfigured(assistant) && input.embedding?.assistantEmbeddings === 'supported') {
      return entryRoute('embedding', 'assistant', assistant, 'embedding')
    }
    return lexicalRoute(
      'embedding',
      input.embedding?.assistantEmbeddings === 'unsupported'
        ? 'assistant-endpoint-has-no-embeddings'
        : 'local-embedding-unavailable',
    )
  }

  if (isContextRoleConfigured(own)) {
    return entryRoute(input.role, 'role', own, 'small')
  }

  const assistant = input.roles.assistant
  if (input.role !== 'assistant' && isContextRoleConfigured(assistant)) {
    return entryRoute(input.role, 'assistant', assistant, 'general')
  }

  if (input.main !== undefined) return mainRoute(input.role, input.main)

  return offRoute(input.role, 'no-role-assistant-or-main-model')
}
