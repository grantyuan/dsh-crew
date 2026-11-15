/**
 * Transport clients for functional context roles.
 *
 * Two transports cover the pluggable config: a direct OpenAI-compatible
 * endpoint (the dedicated role or the configured assistant endpoint) and the
 * Harness LLM service for the Agent main model. Both return the same result
 * shapes so the runtime does not branch on transport. Embedding is only ever
 * an OpenAI-compatible `/embeddings` call or the built-in local model; the
 * host chat client refuses `embed()` outright.
 * @module @grantyuan/dsh-crew/context/role-client
 */

import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { ContextRoleRoute } from './role-models.ts'

/** Failure classes surfaced to metrics, health and the settings UI. */
export type ContextRoleFailureKind =
  | 'role-timeout'
  | 'role-auth'
  | 'role-rate-limit'
  | 'role-http'
  | 'role-invalid-response'
  | 'role-incompatible'

/** One sanitized role failure: no prompt, response body or credential. */
export class ContextRoleError extends Error {
  readonly kind: ContextRoleFailureKind
  readonly status?: number
  readonly host?: string

  constructor(kind: ContextRoleFailureKind, message: string, options: { status?: number | undefined; host?: string | undefined } = {}) {
    super(message)
    this.name = 'ContextRoleError'
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    if (options.host !== undefined) this.host = options.host
  }
}

export interface RoleChatRequest {
  readonly system: string
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
  readonly maxTokens: number
  readonly temperature?: number
  readonly signal: AbortSignal
}

export interface RoleChatResult {
  readonly text: string
  readonly provider: string
  readonly model: string
  readonly latencyMs: number
  readonly usage?: { readonly input: number; readonly output: number }
}

export interface RoleEmbeddingResult {
  readonly vectors: readonly Float32Array[]
  readonly dimension: number
  readonly modelId: string
  readonly latencyMs: number
}

export interface RoleClient {
  chat(route: ContextRoleRoute, request: RoleChatRequest): Promise<RoleChatResult>
  embed(route: ContextRoleRoute, texts: readonly string[], signal: AbortSignal): Promise<RoleEmbeddingResult>
}

/** The subset of the Harness LLM service this module needs. */
export interface HostLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

const ROLE_CHAT_MAX_TOKENS_CEILING = 8_000

/** Append an endpoint path without guessing a `/v1` prefix. */
export function roleEndpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Host name for sanitized errors; never includes credentials or query text. */
function hostOf(baseURL: string | undefined): string | undefined {
  if (baseURL === undefined || baseURL === '') return undefined
  try {
    return new URL(baseURL).host
  } catch {
    return undefined
  }
}

/** Link a caller signal with the role budget. */
function withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; didTimeout: () => boolean } {
  const timeout = AbortSignal.timeout(timeoutMs)
  return {
    signal: AbortSignal.any([signal, timeout]),
    didTimeout: () => timeout.aborted && !signal.aborted,
  }
}

function failureForStatus(status: number, host: string | undefined): ContextRoleError {
  if (status === 401 || status === 403) {
    return new ContextRoleError('role-auth', `role endpoint rejected the credential (HTTP ${status})`, { status, ...(host === undefined ? {} : { host }) })
  }
  if (status === 429) {
    return new ContextRoleError('role-rate-limit', `role endpoint is rate limited (HTTP ${status})`, { status, ...(host === undefined ? {} : { host }) })
  }
  return new ContextRoleError('role-http', `role endpoint returned HTTP ${status}`, { status, ...(host === undefined ? {} : { host }) })
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part !== null && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return ''
    })
    .join('')
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeVector(vector: readonly number[]): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  const length = Math.sqrt(norm)
  const output = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) {
    output[index] = length === 0 ? 0 : vector[index]! / length
  }
  return output
}

/** Direct OpenAI-compatible transport. */
export class OpenAiCompatibleRoleClient implements RoleClient {
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl
  }

  private headers(route: ContextRoleRoute): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(route.apiKey === undefined || route.apiKey === '' ? {} : { authorization: `Bearer ${route.apiKey}` }),
    }
  }

  async chat(route: ContextRoleRoute, request: RoleChatRequest): Promise<RoleChatResult> {
    if (route.baseURL === undefined || route.baseURL === '') {
      throw new ContextRoleError('role-incompatible', 'role endpoint is not configured')
    }
    const started = Date.now()
    const timeout = withTimeout(request.signal, route.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(roleEndpoint(route.baseURL, 'chat/completions'), {
        method: 'POST',
        headers: this.headers(route),
        body: JSON.stringify({
          model: route.model,
          messages: [
            { role: 'system', content: request.system },
            ...request.messages,
          ],
          max_tokens: Math.min(request.maxTokens, ROLE_CHAT_MAX_TOKENS_CEILING),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          stream: false,
        }),
        signal: timeout.signal,
      })
    } catch (error) {
      throw this.transportError(error, route, timeout.didTimeout())
    }
    if (!response.ok) throw failureForStatus(response.status, hostOf(route.baseURL))
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ContextRoleError('role-invalid-response', 'role endpoint returned non-JSON', { host: hostOf(route.baseURL) })
    }
    const choices = asRecord(body)?.choices
    const first = Array.isArray(choices) ? choices[0] : undefined
    const message = asRecord(first)?.message
    const text = textFromMessageContent(asRecord(message)?.content)
    if (text === '') {
      throw new ContextRoleError('role-invalid-response', 'role endpoint returned no text content', { host: hostOf(route.baseURL) })
    }
    const usage = asRecord(body)?.usage
    const input = finiteNumber(asRecord(usage)?.prompt_tokens)
    const output = finiteNumber(asRecord(usage)?.completion_tokens)
    return {
      text,
      provider: 'openai-compatible',
      model: route.model,
      latencyMs: Date.now() - started,
      ...(input === undefined || output === undefined ? {} : { usage: { input, output } }),
    }
  }

  async embed(route: ContextRoleRoute, texts: readonly string[], signal: AbortSignal): Promise<RoleEmbeddingResult> {
    if (route.baseURL === undefined || route.baseURL === '') {
      throw new ContextRoleError('role-incompatible', 'embedding endpoint is not configured')
    }
    const started = Date.now()
    const timeout = withTimeout(signal, route.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(roleEndpoint(route.baseURL, 'embeddings'), {
        method: 'POST',
        headers: this.headers(route),
        body: JSON.stringify({ model: route.model, input: [...texts] }),
        signal: timeout.signal,
      })
    } catch (error) {
      throw this.transportError(error, route, timeout.didTimeout())
    }
    if (!response.ok) throw failureForStatus(response.status, hostOf(route.baseURL))
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ContextRoleError('role-invalid-response', 'embedding endpoint returned non-JSON', { host: hostOf(route.baseURL) })
    }
    const data = asRecord(body)?.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new ContextRoleError('role-invalid-response', 'embedding endpoint returned a different number of vectors', { host: hostOf(route.baseURL) })
    }
    const vectors: Float32Array[] = []
    let dimension = 0
    for (const item of data) {
      const embedding = asRecord(item)?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new ContextRoleError('role-invalid-response', 'embedding endpoint returned an invalid vector', { host: hostOf(route.baseURL) })
      }
      if (dimension === 0) dimension = embedding.length
      if (embedding.length !== dimension) {
        throw new ContextRoleError('role-invalid-response', 'embedding endpoint returned inconsistent dimensions', { host: hostOf(route.baseURL) })
      }
      vectors.push(normalizeVector(embedding as number[]))
    }
    return { vectors, dimension, modelId: route.model, latencyMs: Date.now() - started }
  }

  private transportError(error: unknown, route: ContextRoleRoute, timedOut: boolean): ContextRoleError {
    if (timedOut) {
      return new ContextRoleError('role-timeout', `role endpoint did not answer within ${route.timeoutMs}ms`, { host: hostOf(route.baseURL) })
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new ContextRoleError('role-timeout', 'role call was cancelled', { host: hostOf(route.baseURL) })
    }
    return new ContextRoleError('role-http', 'role endpoint is unreachable', { host: hostOf(route.baseURL) })
  }
}

/** Harness LLM transport for the Agent main model. */
export class HostModelRoleClient implements RoleClient {
  private readonly llm: HostLlm

  constructor(llm: HostLlm) {
    this.llm = llm
  }

  async chat(route: ContextRoleRoute, request: RoleChatRequest): Promise<RoleChatResult> {
    const provider = route.provider
    if (provider === undefined || route.model === '') {
      throw new ContextRoleError('role-incompatible', 'main model route is not available')
    }
    const started = Date.now()
    const timeout = withTimeout(request.signal, route.timeoutMs)
    const assembler = new BlockAssembler()
    const messages = request.messages.map(message => message.role === 'assistant'
      ? createAssistantMessage({
        content: [{ type: 'text', text: message.content }],
        source: { provider, model: route.model },
      })
      : createUserMessage({
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'user' },
      }))
    try {
      for await (const chunk of this.llm.stream({
        provider,
        model: route.model,
        messages,
        system: request.system,
        maxTokens: Math.min(request.maxTokens, ROLE_CHAT_MAX_TOKENS_CEILING),
        signal: timeout.signal,
      })) assembler.push(chunk)
    } catch (error) {
      if (timeout.didTimeout()) {
        throw new ContextRoleError('role-timeout', `main model did not answer within ${route.timeoutMs}ms`)
      }
      throw error instanceof ContextRoleError
        ? error
        : new ContextRoleError('role-http', 'main model call failed')
    }
    if (timeout.didTimeout()) {
      throw new ContextRoleError('role-timeout', `main model did not answer within ${route.timeoutMs}ms`)
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new ContextRoleError('role-http', 'main model call failed')
    }
    if (finish.kind === 'max-tokens') {
      throw new ContextRoleError('role-invalid-response', 'main model reply was truncated at the token cap')
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    if (text === '') {
      throw new ContextRoleError('role-invalid-response', 'main model returned no text content')
    }
    return { text, provider, model: route.model, latencyMs: Date.now() - started }
  }

  async embed(): Promise<RoleEmbeddingResult> {
    throw new ContextRoleError('role-incompatible', 'the main chat model cannot serve embeddings')
  }
}

/** Pick the transport for one resolved route. */
export function roleClientFor(
  route: ContextRoleRoute,
  dependencies: { readonly llm: HostLlm; readonly fetchImpl?: typeof fetch },
): RoleClient {
  if (route.transport === 'host-llm') return new HostModelRoleClient(dependencies.llm)
  if (route.transport === 'openai-compatible') return new OpenAiCompatibleRoleClient(dependencies.fetchImpl ?? fetch)
  throw new ContextRoleError('role-incompatible', `route ${route.transport} is not a chat transport`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
