/**
 * Turn one live Session event into a context unit input.
 *
 * Intake is deliberately narrow: only real conversation contributes. Messages
 * this plugin or another producer injects (identity, recall snapshots, notices)
 * are not history the Member produced or read as a user turn, so indexing them
 * would make recall cite its own scaffolding.
 * @module @grantyuan/dsh-crew/context/intake
 */

import type { ContextUnitInput, ContextUnitRole } from './types.ts'

/** Structural view of the Session event an intake seam receives. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function readSourceKind(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined
  return typeof source.kind === 'string' ? source.kind : undefined
}

/**
 * The direct message envelope differs by event type: `user/message` carries
 * the message fields at `data`, while assistant and tool events nest the
 * message under `data.message`.
 */
function readMessage(event: SessionEventLike): { content: unknown; source: unknown } | undefined {
  if (!isRecord(event.data)) return undefined
  const nested = event.data.message
  return isRecord(nested)
    ? { content: nested.content, source: nested.source }
    : { content: event.data.content, source: event.data.source }
}

/**
 * Map one event to a unit input, or `undefined` when it is not conversational
 * history. Tool results are indexed without a name because the result event
 * carries only the call id; the name belongs to `tool/call`.
 */
export function contextUnitFromEvent(
  memberId: string,
  sessionId: string,
  event: SessionEventLike,
  timezone?: string,
): ContextUnitInput | undefined {
  const role: ContextUnitRole | undefined = event.type === 'user/message'
    ? 'user'
    : event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : undefined
  if (role === undefined) return undefined
  const message = readMessage(event)
  if (message === undefined) return undefined
  if (role === 'user' && readSourceKind(message.source) !== 'user') return undefined
  const text = readText(message.content)
  if (text === '') return undefined
  return {
    memberId,
    sessionId,
    seq: event.seq,
    role,
    text,
    recordedAt: new Date(event.time).toISOString(),
    eventType: event.type,
    ...(timezone === undefined ? {} : { timezone }),
  }
}
