import { describe, expect, it } from 'vitest'
import {
  ModelScheduleMonitor,
  modelScheduleSwitchNoticeText,
  parseScheduleMinute,
  resolveScheduleRoute,
  sameScheduleRoute,
  scheduleRouteKey,
  scheduleWindowCovers,
  teamMinuteOfDay,
  upcomingRouteChanges,
  MODEL_SCHEDULE_NOTICE_AHEAD_MS,
  type ModelScheduleBoundary,
} from '../src/model-schedule.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamMemberModelSchedule, AgentTeamModelSelection } from '../src/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const alpha = WorkspaceId('workspace:alpha')
const deepseek = (): AgentTeamModelSelection => ({ provider: 'deepseek', model: 'deepseek-flash' })
const qwen = (): AgentTeamModelSelection => ({ provider: 'qwen', model: 'qwen3.8-flash' })

// Team zone is UTC+8: 2026-11-03T10:00:00Z is 18:00 Team time, minute 1080.
const AT_18_00_TEAM = Date.UTC(2026, 10, 3, 10, 0, 0)

const window = (start: string, end: string, selection: AgentTeamModelSelection) => ({ start, end, selection })
const scheduleOf = (enabled: boolean, ...windows: readonly ReturnType<typeof window>[]): AgentTeamMemberModelSchedule => ({ enabled, windows })

function member(overrides: { readonly memberId: string } & Partial<Omit<AgentTeamAgentMember, 'memberId'>>): AgentTeamAgentMember {
  return {
    sessionId: SessionId(`session:${overrides.memberId}`),
    workspaceId: alpha,
    handle: 'worker',
    description: '',
    presetId: 'team-member',
    privateMemoryPath: '/tmp/x',
    state: 'enabled',
    ...overrides,
    memberId: overrides.memberId as never,
  } as AgentTeamAgentMember
}

describe('model schedule time arithmetic (Team zone UTC+8)', () => {
  it('parses HH:MM bounds and rejects anything else', () => {
    expect(parseScheduleMinute('09:30')).toBe(570)
    expect(parseScheduleMinute('00:00')).toBe(0)
    expect(parseScheduleMinute('23:59')).toBe(1439)
    expect(() => parseScheduleMinute('24:00')).toThrow()
    expect(() => parseScheduleMinute('9:00')).toThrow()
    expect(() => parseScheduleMinute('09:60')).toThrow()
  })

  it('reads the day minute through the Team zone, not the machine zone', () => {
    expect(teamMinuteOfDay(AT_18_00_TEAM)).toBe(18 * 60)
  })

  it('covers a half-open window: start inclusive, end exclusive', () => {
    const w = window('09:00', '18:00', deepseek())
    expect(scheduleWindowCovers(w, 9 * 60)).toBe(true)
    expect(scheduleWindowCovers(w, 18 * 60 - 1)).toBe(true)
    expect(scheduleWindowCovers(w, 18 * 60)).toBe(false)
    expect(scheduleWindowCovers(w, 8 * 60)).toBe(false)
  })

  it('wraps a window whose end is at or before its start past midnight', () => {
    const w = window('22:00', '06:00', deepseek())
    expect(scheduleWindowCovers(w, 23 * 60)).toBe(true)
    expect(scheduleWindowCovers(w, 3 * 60)).toBe(true)
    expect(scheduleWindowCovers(w, 6 * 60)).toBe(false)
    expect(scheduleWindowCovers(w, 12 * 60)).toBe(false)
  })

  it('resolves the FIRST covering window and never an override when disabled', () => {
    const schedule = scheduleOf(true, window('09:00', '12:00', deepseek()), window('09:30', '18:00', qwen()))
    expect(resolveScheduleRoute(schedule, 10 * 60)).toEqual(deepseek())
    expect(resolveScheduleRoute(schedule, 13 * 60)).toEqual(qwen())
    expect(resolveScheduleRoute(schedule, 8 * 60)).toBeUndefined()
    expect(resolveScheduleRoute(scheduleOf(false, window('00:00', '23:59', deepseek())), 12 * 60)).toBeUndefined()
  })
})

describe('upcomingRouteChanges', () => {
  const dayNight = scheduleOf(true,
    window('09:00', '18:00', deepseek()),
    window('18:00', '23:00', qwen()),
  )

  it('finds a route-changing boundary inside the ten-minute horizon and names the incoming route', () => {
    const now = AT_18_00_TEAM - 8 * 60_000
    const changes = upcomingRouteChanges(dayNight, now)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.atMs).toBe(AT_18_00_TEAM)
    expect(changes[0]?.incoming).toEqual(qwen())
  })

  it('ignores boundaries beyond the horizon and the minute already running', () => {
    expect(upcomingRouteChanges(dayNight, AT_18_00_TEAM - 11 * 60_000)).toHaveLength(0)
    // 18:00:01 Team: the boundary minute is the current one — delta 0, no heads-up.
    expect(upcomingRouteChanges(dayNight, AT_18_00_TEAM + 1_000)).toHaveLength(0)
  })

  it('earns nothing where adjacent windows demand the same route', () => {
    const sameTwice = scheduleOf(true, window('09:00', '12:00', deepseek()), window('12:00', '18:00', deepseek()))
    expect(upcomingRouteChanges(sameTwice, Date.UTC(2026, 10, 3, 3, 52, 0))).toHaveLength(0)
  })

  it('reports the fall-back-to-pinned change when the last covering window ends', () => {
    const now = Date.UTC(2026, 10, 3, 14, 52, 0) // 22:52 Team; 23:00 ends the schedule's coverage
    const changes = upcomingRouteChanges(dayNight, now)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.incoming).toBeUndefined()
  })

  it('deduplicates two windows that change at the same minute', () => {
    const shared = scheduleOf(true,
      window('09:00', '18:00', deepseek()),
      window('18:00', '23:00', qwen()),
      window('18:00', '20:00', qwen()),
    )
    expect(upcomingRouteChanges(shared, AT_18_00_TEAM - 5 * 60_000).filter(change => change.atMs === AT_18_00_TEAM)).toHaveLength(1)
  })
})

/**
 * A monitor with scripted Host hooks and a Member list the test can move:
 * a landing switch updates the Member's durable applied route exactly like
 * the Host's ledger commit does, so the pass-after-pass idempotence is the
 * real desired-vs-applied comparison, not a stub artifact.
 */
function monitorHarness(members: () => readonly AgentTeamAgentMember[]) {
  const switches: Array<{ readonly memberId: AgentTeamMemberId; readonly desired: AgentTeamModelSelection | undefined }> = []
  const reminders: Array<{ readonly memberId: AgentTeamMemberId; readonly boundary: ModelScheduleBoundary }> = []
  const logs: string[] = []
  const state = { switchResult: true, remindError: undefined as Error | undefined }
  const monitor = new ModelScheduleMonitor({
    members,
    applySwitch: async (member, desired) => {
      switches.push({ memberId: member.memberId, desired })
      return state.switchResult
    },
    remind: async (member, boundary) => {
      if (state.remindError !== undefined) throw state.remindError
      reminders.push({ memberId: member.memberId, boundary })
    },
    log: message => { logs.push(message) },
  })
  return { monitor, switches, reminders, logs, state }
}

describe('ModelScheduleMonitor passes', () => {
  it('drives a switch when the desired route differs from the applied one', async () => {
    let applied: AgentTeamModelSelection | undefined = deepseek()
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:sched',
      modelSchedule: scheduleOf(true, window('09:00', '18:00', deepseek())),
      ...(applied === undefined ? {} : { scheduledModel: applied }),
    })]
    const hooks = monitorHarness(members)
    await hooks.monitor.runPass(AT_18_00_TEAM) // 18:00: coverage moved to nothing
    expect(hooks.switches).toHaveLength(1)
    expect(hooks.switches[0]).toEqual({ memberId: 'member:sched' as never, desired: undefined })
    applied = hooks.switches[0]?.desired
    hooks.switches.length = 0
    await hooks.monitor.runPass(AT_18_00_TEAM + 30_000)
    expect(hooks.switches).toHaveLength(0) // durable convergence: nothing to drive
  })

  it('keeps retrying a switch that could not land, and stops once it has', async () => {
    let applied: AgentTeamModelSelection | undefined
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:busy',
      modelSchedule: scheduleOf(true, window('17:00', '22:00', qwen())),
      ...(applied === undefined ? {} : { scheduledModel: applied }),
    })]
    const hooks = monitorHarness(members)
    hooks.state.switchResult = false // mid-turn: the Host defers
    await hooks.monitor.runPass(AT_18_00_TEAM)
    expect(hooks.switches).toHaveLength(1)
    await hooks.monitor.runPass(AT_18_00_TEAM + 30_000)
    expect(hooks.switches).toHaveLength(2) // pending re-drives the SAME desired route
    expect(hooks.switches[1]?.desired).toEqual(qwen())
    hooks.state.switchResult = true
    await hooks.monitor.runPass(AT_18_00_TEAM + 60_000)
    expect(hooks.switches).toHaveLength(3)
    applied = hooks.switches[2]?.desired // the Host landed the durable route
    hooks.switches.length = 0
    await hooks.monitor.runPass(AT_18_00_TEAM + 90_000)
    expect(hooks.switches).toHaveLength(0)
  })

  it('delivers one heads-up per boundary and never re-delivers a landed one', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:sched',
      modelSchedule: scheduleOf(true, window('09:00', '18:00', deepseek()), window('18:00', '23:00', qwen())),
      scheduledModel: deepseek(),
    })]
    const hooks = monitorHarness(members)
    const soon = AT_18_00_TEAM - 8 * 60_000
    await hooks.monitor.runPass(soon)
    expect(hooks.reminders).toHaveLength(1)
    expect(hooks.reminders[0]?.boundary.incoming).toEqual(qwen())
    await hooks.monitor.runPass(soon + 30_000)
    expect(hooks.reminders).toHaveLength(1) // latched per boundary
  })

  it('retries a failed reminder on the next pass instead of losing the heads-up', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:sched',
      modelSchedule: scheduleOf(true, window('09:00', '18:00', deepseek()), window('18:00', '23:00', qwen())),
      scheduledModel: deepseek(),
    })]
    const hooks = monitorHarness(members)
    hooks.state.remindError = new Error('gateway down')
    const soon = AT_18_00_TEAM - 8 * 60_000
    await hooks.monitor.runPass(soon)
    expect(hooks.reminders).toHaveLength(0)
    expect(hooks.logs.some(line => line.includes('gateway down'))).toBe(true)
    hooks.state.remindError = undefined
    await hooks.monitor.runPass(soon + 30_000)
    expect(hooks.reminders).toHaveLength(1)
  })

  it('skips suspended, archived, and external Members, and drives nothing for Members without a schedule', async () => {
    const current = [
      member({ memberId: 'member:susp', state: 'suspended', modelSchedule: scheduleOf(true, window('09:00', '23:00', deepseek())), scheduledModel: deepseek() }),
      member({ memberId: 'member:arch', state: 'archived', modelSchedule: scheduleOf(true, window('09:00', '23:00', deepseek())), scheduledModel: deepseek() }),
      member({ memberId: 'member:ext', external: true, modelSchedule: scheduleOf(true, window('09:00', '23:00', deepseek())), scheduledModel: deepseek() }),
      member({ memberId: 'member:plain' }),
    ]
    const hooks = monitorHarness(() => current)
    await hooks.monitor.runPass(Date.UTC(2026, 10, 3, 1, 0, 0)) // 09:00 Team
    expect(hooks.switches).toHaveLength(0)
    expect(hooks.reminders).toHaveLength(0)
  })

  it('treats a disabled schedule as a demand to fall back to the pinned route', async () => {
    let applied: AgentTeamModelSelection | undefined = deepseek()
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:off',
      modelSchedule: scheduleOf(false, window('09:00', '23:00', deepseek())),
      ...(applied === undefined ? {} : { scheduledModel: applied }),
    })]
    const hooks = monitorHarness(members)
    await hooks.monitor.runPass(Date.UTC(2026, 10, 3, 1, 0, 0))
    expect(hooks.switches).toEqual([{ memberId: 'member:off' as never, desired: undefined }])
    applied = undefined
  })
})

describe('model schedule route identity', () => {
  it('compares routes structurally with absent-meaning-pin semantics', () => {
    expect(sameScheduleRoute(undefined, undefined)).toBe(true)
    expect(sameScheduleRoute(deepseek(), undefined)).toBe(false)
    expect(sameScheduleRoute(undefined, deepseek())).toBe(false)
    expect(sameScheduleRoute(deepseek(), { provider: 'deepseek', model: 'deepseek-flash' })).toBe(true)
    expect(scheduleRouteKey(undefined)).toBe(scheduleRouteKey(undefined))
    expect(scheduleRouteKey(qwen())).not.toBe(scheduleRouteKey(deepseek()))
  })

  it('writes a heads-up that names the member, the incoming route, and the reset', () => {
    const text = modelScheduleSwitchNoticeText({ memberHandle: 'worker', whenText: '2026-11-03T18:00:00+08:00', incoming: qwen() })
    expect(text).toContain('@worker')
    expect(text).toContain('qwen/qwen3.8-flash')
    expect(text).toContain('2026-11-03T18:00:00+08:00')
    expect(text).toContain('context reset')
    const fallback = modelScheduleSwitchNoticeText({ memberHandle: 'worker', whenText: '2026-11-03T23:00:00+08:00', incoming: undefined })
    expect(fallback).toContain('pinned route')
  })

  it('keeps the notice horizon at ten minutes before the switch', () => {
    expect(MODEL_SCHEDULE_NOTICE_AHEAD_MS).toBe(10 * 60 * 1000)
  })
})
