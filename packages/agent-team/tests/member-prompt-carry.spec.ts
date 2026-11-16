import { describe, expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { carriedSystemPromptFromEvents, carriedSystemPromptFromSeed } from '../src/member-prompt-carry.ts'

let seqCounter = 0

function surfaceEvent(type: 'system/message' | 'user/message', text: string, op: SessionEvent['surfaceOp'] = 'append'): SessionEvent {
  seqCounter += 1
  const seq = seqCounter as SessionSeq
  const message = type === 'system/message' ? createSystemMessage(text) : createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  return { type, seq, time: 0, data: { message }, surfaceOp: op } as SessionEvent
}

function replaceEvent(text: string, startSeq: SessionSeq, endSeq: SessionSeq): SessionEvent {
  seqCounter += 1
  const seq = seqCounter as SessionSeq
  return {
    type: 'system/message',
    seq,
    time: 0,
    data: { message: createSystemMessage(text) },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [startSeq, endSeq],
  } as unknown as SessionEvent
}

describe('carried system prompt capture', () => {
  it('reads the head system text of a plain log and stops at the first user message', () => {
    const events = [
      surfaceEvent('system/message', 'The prompt.'),
      surfaceEvent('user/message', 'hello'),
      surfaceEvent('system/message', 'An in-history update, not the head.'),
    ]
    expect(carriedSystemPromptFromEvents(events)).toBe('The prompt.')
    expect(carriedSystemPromptFromSeed(events)).toBe('The prompt.')
  })

  it('follows a node-zero replacement to its current text', () => {
    const head = surfaceEvent('system/message', 'The stale prompt.')
    const events = [
      head,
      surfaceEvent('user/message', 'hello'),
      replaceEvent('The rebuilt prompt.', head.seq, head.seq),
    ]
    expect(carriedSystemPromptFromEvents(events)).toBe('The rebuilt prompt.')
  })

  it('joins every head system node before the first user message', () => {
    const events = [
      surfaceEvent('system/message', 'First node.'),
      surfaceEvent('system/message', 'Second node.'),
      surfaceEvent('user/message', 'hello'),
    ]
    expect(carriedSystemPromptFromEvents(events)).toBe('First node.\n\nSecond node.')
  })

  it('returns undefined when the head is not a system prompt', () => {
    expect(carriedSystemPromptFromEvents([surfaceEvent('user/message', 'hello')])).toBeUndefined()
    expect(carriedSystemPromptFromEvents([])).toBeUndefined()
    expect(carriedSystemPromptFromSeed([])).toBeUndefined()
  })

  it('fails closed when a replace cites surface nodes the log prefix does not hold', () => {
    const events = [
      surfaceEvent('system/message', 'The prompt.'),
      surfaceEvent('user/message', 'hello'),
      replaceEvent('A compaction over inherited nodes.', 0 as SessionSeq, 1 as SessionSeq),
    ]
    expect(carriedSystemPromptFromEvents(events)).toBeUndefined()
  })
})
