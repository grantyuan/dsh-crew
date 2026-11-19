import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  classifyAssistantResponse,
  classifyStoppedTurnTail,
  isResponseFault,
  RESPONSE_GUARD_MAX_CONSECUTIVE,
  RESPONSE_GUARD_NOTICE_SUMMARY,
  ResponseGuardCoordinator,
  TEAM_SET_STATUS_TOOL_NAME,
} from '../src/response-guard.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

const statusCall = (status: string, name = TEAM_SET_STATUS_TOOL_NAME): ContentBlock =>
  ({ type: 'tool-call', id: 'call-1', name, arguments: JSON.stringify({ status }) } as ContentBlock)

describe('classifyAssistantResponse', () => {
  it('sees a tool call regardless of text', () => {
    const shape = classifyAssistantResponse([
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'call-1' as never, name: 'team_message', arguments: '{}' },
    ] satisfies ContentBlock[])
    expect(shape.hasToolCall).toBe(true)
    expect(shape.hasText).toBe(false)
    expect(shape.announcesTerminalStatus).toBe(false)
  })

  it('detects a terminal team_set_status call alongside text', () => {
    const shape = classifyAssistantResponse([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'work is done.\n' },
      statusCall('idle'),
    ])
    expect(shape.hasText).toBe(true)
    expect(shape.hasToolCall).toBe(true)
    expect(shape.announcesTerminalStatus).toBe(true)
  })

  it('busy is not a terminal declaration', () => {
    const shape = classifyAssistantResponse([statusCall('busy')])
    expect(shape.hasToolCall).toBe(true)
    expect(shape.announcesTerminalStatus).toBe(false)
  })

  it('other tools declaring statuses do not announce completion', () => {
    const shape = classifyAssistantResponse([statusCall('idle', 'team_message')])
    expect(shape.announcesTerminalStatus).toBe(false)
  })

  it('malformed arguments never announce completion', () => {
    const shape = classifyAssistantResponse([
      { type: 'tool-call', id: 'call-1', name: TEAM_SET_STATUS_TOOL_NAME, arguments: 'not json' } as ContentBlock,
    ])
    expect(shape.announcesTerminalStatus).toBe(false)
  })

  it('treats whitespace-only text as no text', () => {
    const shape = classifyAssistantResponse([{ type: 'text', text: '  \n' }])
    expect(shape.hasText).toBe(false)
    expect(shape.announcesTerminalStatus).toBe(false)
  })
})

describe('isResponseFault', () => {
  it('passes a response that keeps working through tool calls', () => {
    expect(isResponseFault({ hasToolCall: true, hasText: false, announcesTerminalStatus: false }, false)).toBe(false)
  })

  it('passes a text-only round that follows a terminal declaration in the turn', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: true, announcesTerminalStatus: false }, true)).toBe(false)
  })

  it('faults on a thinking-only response', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: false, announcesTerminalStatus: false }, false)).toBe(true)
  })

  it('faults on trailing text without a declaration or tool call', () => {
    expect(isResponseFault({ hasToolCall: false, hasText: true, announcesTerminalStatus: false }, false)).toBe(true)
  })
})

describe('ResponseGuardCoordinator', () => {
  const memberId = 'member:builder' as AgentTeamMemberId
  const closing = { hasToolCall: true, hasText: true, announcesTerminalStatus: true }
  const trailing = { hasToolCall: false, hasText: true, announcesTerminalStatus: false }
  const silent = { hasToolCall: false, hasText: false, announcesTerminalStatus: false }
  const working = { hasToolCall: true, hasText: false, announcesTerminalStatus: false }

  function harness(overrides: Partial<ConstructorParameters<typeof ResponseGuardCoordinator>[0]> = {}) {
    const nudges: Array<{ memberId: AgentTeamMemberId; diagnostic: string }> = []
    const standDowns: Array<{ memberId: AgentTeamMemberId; faults: number }> = []
    const coordinator = new ResponseGuardCoordinator({
      nudge: (id, diagnostic) => { nudges.push({ memberId: id, diagnostic }) },
      onStandDown: (id, faults) => { standDowns.push({ memberId: id, faults }) },
      ...overrides,
    })
    return { coordinator, nudges, standDowns }
  }

  it('nudges each of the first consecutive faulty responses', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, silent, false)
    expect(nudges).toHaveLength(2)
    expect(nudges[1]?.diagnostic).toContain('no visible text')
  })

  it('resets the episode on any healthy response, including tool calls', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, working, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(2)
  })

  it('stands down once after the faulty-response budget is spent', () => {
    const { coordinator, nudges, standDowns } = harness()
    for (let i = 0; i < RESPONSE_GUARD_MAX_CONSECUTIVE + 2; i += 1) coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(RESPONSE_GUARD_MAX_CONSECUTIVE)
    expect(standDowns).toEqual([{ memberId, faults: RESPONSE_GUARD_MAX_CONSECUTIVE + 1 }])
  })

  it('a fresh episode can open after a healthy response following a stand-down', () => {
    const { coordinator, nudges, standDowns } = harness()
    for (let i = 0; i < RESPONSE_GUARD_MAX_CONSECUTIVE + 1; i += 1) coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, working, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(standDowns).toHaveLength(1)
    expect(nudges).toHaveLength(RESPONSE_GUARD_MAX_CONSECUTIVE + 1)
  })

  it('a terminal declaration keeps the closing text round clean', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, closing, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(0)
  })

  it('ignores interrupted messages without touching the episode', () => {
    const { coordinator, nudges } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, trailing, true)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges).toHaveLength(2)
  })

  it('stops nudging when the nudge target is gone', () => {
    const coordinator = new ResponseGuardCoordinator({
      nudge: () => { throw new Error('member disposed') },
    })
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator['consecutiveFaults'].has(memberId)).toBe(false)
  })

  it('labels the notice as a pure reminder for the context projection', () => {
    expect(RESPONSE_GUARD_NOTICE_SUMMARY).toContain('continue')
  })

  it('dispose clears every episode', () => {
    const { coordinator } = harness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    coordinator.dispose()
    expect(coordinator['consecutiveFaults'].size).toBe(0)
  })
})

describe('ResponseGuardCoordinator stop lane', () => {
  const memberId = 'member:builder' as AgentTeamMemberId
  const closing = { hasToolCall: true, hasText: true, announcesTerminalStatus: true }
  const trailing = { hasToolCall: false, hasText: true, announcesTerminalStatus: false }
  const working = { hasToolCall: true, hasText: false, announcesTerminalStatus: false }

  function stopHarness(overrides: Partial<ConstructorParameters<typeof ResponseGuardCoordinator>[0]> = {}) {
    const nudges: Array<{ memberId: AgentTeamMemberId; diagnostic: string }> = []
    let clock = 1_000
    const coordinator = new ResponseGuardCoordinator({
      nudge: (id, diagnostic) => { nudges.push({ memberId: id, diagnostic }) },
      now: () => clock,
      ...overrides,
    })
    return { coordinator, nudges, tick: (ms: number) => { clock += ms } }
  }

  it('reminds a completed stop whose last round trailed off', () => {
    const { coordinator, nudges } = stopHarness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))).toHaveLength(1)
  })

  it('reports a turn closed by a terminal declaration without nudging', () => {
    const { coordinator, nudges } = stopHarness()
    coordinator.onAssistantMessage(memberId, closing, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('completed')
    expect(nudges).toHaveLength(0)
  })

  it('a busy declaration alone does not close a stop', () => {
    const { coordinator, nudges } = stopHarness()
    coordinator.onAssistantMessage(memberId, { hasToolCall: true, hasText: false, announcesTerminalStatus: false }, false)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))).toHaveLength(1)
  })

  it('leaves a loop-owned tool-call stop and a non-completed stop alone', () => {
    const { coordinator, nudges } = stopHarness()
    coordinator.onAssistantMessage(memberId, working, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('other')
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'interrupted')).toBe('other')
    expect(coordinator.onTurnStop(memberId, 'error')).toBe('other')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))).toHaveLength(0)
  })

  it('reminds the stop even after the in-loop budget stood down, and re-arms it', () => {
    const { coordinator, nudges } = stopHarness()
    for (let i = 0; i < RESPONSE_GUARD_MAX_CONSECUTIVE + 1; i += 1) coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    const stopNudges = nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))
    expect(stopNudges).toHaveLength(1)
    // The episode re-armed with the stop reminder: a fresh in-loop nudge is budgeted again.
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(nudges.filter(nudge => !nudge.diagnostic.includes('the turn stopped'))).toHaveLength(RESPONSE_GUARD_MAX_CONSECUTIVE + 1)
  })

  it('spaces stop reminders by the cooldown instead of hot-looping', () => {
    const { coordinator, nudges, tick } = stopHarness()
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    tick(1000)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))).toHaveLength(1)
    coordinator['lastStopReminder'].delete(memberId)
    tick(1000)
    coordinator.onAssistantMessage(memberId, trailing, false)
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('the turn stopped'))).toHaveLength(2)
  })

  it('a stop with no observed round reads as unfinished work', () => {
    const { coordinator, nudges } = stopHarness()
    expect(coordinator.onTurnStop(memberId, 'completed')).toBe('faulty')
    expect(nudges).toHaveLength(1)
  })

  it('onStoppedAtBoot reminds faulty tails and trusts completed tails', () => {
    const { coordinator, nudges } = stopHarness()
    expect(coordinator.onStoppedAtBoot(memberId, 'completed')).toBe('completed')
    expect(nudges).toHaveLength(0)
    expect(coordinator.onStoppedAtBoot(memberId, 'faulty')).toBe('faulty')
    expect(nudges.filter(nudge => nudge.diagnostic.includes('stopped with unfinished work'))).toHaveLength(1)
  })

  it('a throwing stop reminder reports the failure without wedging the lane', () => {
    const failures: unknown[] = []
    const coordinator = new ResponseGuardCoordinator({
      nudge: () => { throw new Error('member disposed') },
      onNudgeFailed: (_id, error) => { failures.push(error) },
    })
    coordinator.onTurnStop(memberId, 'completed')
    expect(failures).toHaveLength(1)
  })
})

describe('classifyStoppedTurnTail', () => {
  const turnStart = (seq: number): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'turn/start', seq, time: 10_000 + seq, data: { turn: 1 } })
  const turnEnd = (seq: number, kind: string, cause?: string): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'turn/end', seq, time: 10_000 + seq, data: { turn: 1, reason: { kind, ...(cause === undefined ? {} : { reason: { kind: cause } }) } } })
  const assistant = (seq: number, text: string): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'assistant/message', seq, time: 10_000 + seq, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
  const assistantTool = (seq: number): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'assistant/message', seq, time: 10_000 + seq, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }] } } })
  const assistantClose = (seq: number, status: string, name = TEAM_SET_STATUS_TOOL_NAME): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'assistant/message', seq, time: 10_000 + seq, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: `call-${seq}`, name, arguments: JSON.stringify({ status }) }] } } })
  const assistantTextAfter = (seq: number): { type: string; seq: number; time: number; data: unknown } =>
    ({ type: 'assistant/message', seq, time: 10_000 + seq, data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'all delivered' }] } } })

  it('a completed terminal-declaration close arms', () => {
    expect(classifyStoppedTurnTail([turnStart(0), assistantClose(1, 'idle'), assistantTextAfter(2), turnEnd(3, 'completed')]).outcome).toBe('completed')
  })

  it('a completed trailed close reads faulty', () => {
    expect(classifyStoppedTurnTail([turnStart(0), assistant(1, 'let me check the build:'), turnEnd(2, 'completed')]).outcome).toBe('faulty')
  })

  it('a busy declaration is not a completion signal', () => {
    expect(classifyStoppedTurnTail([turnStart(0), assistantClose(1, 'busy'), assistantTextAfter(2), turnEnd(3, 'completed')]).outcome).toBe('faulty')
  })

  it('a completed tool-call close is loop-owned silence', () => {
    expect(classifyStoppedTurnTail([turnStart(0), assistantTool(1), turnEnd(2, 'completed')]).outcome).toBe('none')
  })

  it('crash orphans and shutdown disposes read faulty; Human aborts and errors stay silent', () => {
    expect(classifyStoppedTurnTail([turnStart(0), assistant(1, 'mid work'), turnEnd(2, 'interrupted')]).outcome).toBe('faulty')
    expect(classifyStoppedTurnTail([turnStart(0), assistant(1, 'mid work'), turnEnd(2, 'aborted', 'disposed')]).outcome).toBe('faulty')
    expect(classifyStoppedTurnTail([turnStart(0), assistant(1, 'mid work')]).outcome).toBe('faulty')
    expect(classifyStoppedTurnTail([turnStart(0), turnEnd(1, 'error')]).outcome).toBe('none')
    expect(classifyStoppedTurnTail([turnStart(0), assistant(1, 'mid work'), turnEnd(2, 'aborted', 'user')]).outcome).toBe('none')
  })

  it('an empty log says nothing, and a restarted turn after the end still reads unfinished', () => {
    expect(classifyStoppedTurnTail([]).outcome).toBe('none')
    expect(classifyStoppedTurnTail([assistantClose(1, 'idle'), turnEnd(2, 'completed'), turnStart(3)]).outcome).toBe('faulty')
  })

  it('carries the stop instant for the caller\'s recency window', () => {
    const tail = classifyStoppedTurnTail([turnStart(0), assistant(1, 'mid work'), turnEnd(2, 'completed')])
    expect(tail.at).toBe(10_002)
  })
})
