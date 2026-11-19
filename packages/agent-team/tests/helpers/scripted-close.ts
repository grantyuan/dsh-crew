import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * The scripted closing round of the team_set_status protocol: the turn's
 * completion signal is a terminal `team_set_status` call (idle/waiting/free),
 * not trailing text. Legacy scripts queued a single text round per turn; the
 * scripted adapters upgrade those to the declaration round plus the original
 * text (held as the pending follow-up round) so each scripted close stays a
 * healthy completed stop.
 */
export function statusCloseChunks(status: 'idle' | 'waiting' | 'free' = 'idle'): StreamChunk[] {
  const id = ToolCallId(`status-close-${Math.random().toString(36).slice(2, 8)}`)
  const argumentsJson = JSON.stringify({ status })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'team_set_status', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'team_set_status', arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Whether one scripted response is a plain text-only turn-ending close — the
 * legacy shape that needs the terminal declaration round served ahead of it.
 * Responses that already carry a tool call pass through untouched.
 */
export function isPlainStopClose(response: StreamChunk[]): boolean {
  const finish = response.at(-1)
  if (finish?.type !== 'finish' || finish.reason.kind !== 'stop') return false
  return !response.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
}

/**
 * Base-class state for scripted adapters that upgrade plain closes. Call
 * {@link takePendingClose} first in `stream`; when it returns a response,
 * serve it unchanged — it is the closing text round of the previous call's
 * declaration.
 */
export class CloseUpgradeState {
  private pendingClose: StreamChunk[] | undefined
  /** Declaration rounds served by {@link holdClosingText} — one extra model request per upgraded close. */
  closeRounds = 0

  takePendingClose(): StreamChunk[] | undefined {
    const pending = this.pendingClose
    this.pendingClose = undefined
    return pending
  }

  /** Serve the declaration round now and hold `response` for the next call. */
  holdClosingText(response: StreamChunk[]): StreamChunk[] {
    this.pendingClose = response
    this.closeRounds += 1
    return statusCloseChunks()
  }
}
