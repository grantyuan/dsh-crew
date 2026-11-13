import { describe, expect, it } from 'vitest'
import {
  StopScheduleMonitor,
  stopScheduleBoundaryNoticeText,
  stopScheduleResumeNoticeText,
  stopScheduleWrapUpNoticeText,
  crossedStopBoundaries,
  upcomingStopBoundaries,
  STOP_SCHEDULE_NOTICE_AHEAD_MS,
  type StopScheduleBoundary,
} from '../src/stop-schedule.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamMemberStopSchedule } from '../src/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const alpha = WorkspaceId('workspace:alpha')

// Team zone is UTC+8: 2026-11-03T10:00:00Z is 18:00 Team time, minute 1080.
const AT_18_00_TEAM = Date.UTC(2026, 10, 3, 10, 0, 0)

const window = (start: string, end: string) => ({ start, end })
const scheduleOf = (enabled: boolean, ...windows: readonly ReturnType<typeof window>[]): AgentTeamMemberStopSchedule => ({ enabled, windows })

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

describe('upcomingStopBoundaries (the wrap-up heads-up picture)', () => {
  it('finds a window start inside the thirty-minute horizon', () => {
    const schedule = scheduleOf(true, window('22:00', '06:00'))
    const now = AT_18_00_TEAM + 4 * 60 * 60_000 // 22:04 Team: the 22:00 edge is today, already running
    const nextDay = now + 22 * 60 * 60_000 // 20:04 Team next day: 22:00 is 116 minutes ahead — outside
    expect(upcomingStopBoundaries(schedule, now)).toHaveLength(0)
    const soon = AT_18_00_TEAM + 3 * 60 * 60_000 + 30 * 60_000 // 21:30 Team: 22:00 is 30 minutes ahead
    const boundaries = upcomingStopBoundaries(schedule, soon)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]?.kind).toBe('stop')
    expect(boundaries[0]?.window).toEqual(window('22:00', '06:00'))
    expect(upcomingStopBoundaries(schedule, nextDay)).toHaveLength(0)
  })

  it('ignores the start minute already running and a disabled schedule', () => {
    expect(upcomingStopBoundaries(scheduleOf(true, window('22:00', '06:00')), AT_18_00_TEAM + 4 * 60 * 60_000)).toHaveLength(0)
    expect(upcomingStopBoundaries(scheduleOf(false, window('22:00', '06:00')), AT_18_00_TEAM + 3 * 60 * 60_000 + 30 * 60_000)).toHaveLength(0)
  })

  it('deduplicates overlapping windows that start together, and never offers a resume heads-up', () => {
    const schedule = scheduleOf(true, window('18:00', '20:00'), window('18:00', '23:00'), window('23:00', '06:00'))
    const boundaries = upcomingStopBoundaries(schedule, AT_18_00_TEAM - 10 * 60_000)
    expect(boundaries).toHaveLength(1)
    expect(boundaries.every(boundary => boundary.kind === 'stop')).toBe(true)
  })
})

describe('crossedStopBoundaries (the already-crossed picture)', () => {
  it('includes the stop edge only while the window covers the current minute', () => {
    const schedule = scheduleOf(true, window('17:00', '18:00'))
    const inside = crossedStopBoundaries(schedule, AT_18_00_TEAM - 30 * 60_000) // 17:30 Team
    expect(inside).toHaveLength(1)
    expect(inside[0]?.kind).toBe('stop')
    expect(inside[0]?.absoluteMinute).toBe(teamAbsoluteMinuteOf(AT_18_00_TEAM - 60 * 60_000))
    // The exact start minute covers (start inclusive): the crossing is now.
    const atStart = crossedStopBoundaries(schedule, Date.UTC(2026, 10, 3, 9, 0, 0))
    expect(atStart.some(boundary => boundary.kind === 'stop')).toBe(true)
    // After the end the stop edge drops out; the end minute itself is the
    // resume crossing (end exclusive, so the window no longer covers).
    const atEnd = crossedStopBoundaries(schedule, AT_18_00_TEAM)
    expect(atEnd.some(boundary => boundary.kind === 'stop')).toBe(false)
    expect(atEnd.map(boundary => boundary.kind)).toEqual(['resume'])
  })

  it('includes the resume edge once the window no longer covers', () => {
    const schedule = scheduleOf(true, window('09:00', '18:00'))
    const boundaries = crossedStopBoundaries(schedule, AT_18_00_TEAM)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]?.kind).toBe('resume')
    expect(boundaries[0]?.window).toEqual(window('09:00', '18:00'))
    // Inside the window the resume edge has not crossed.
    expect(crossedStopBoundaries(schedule, AT_18_00_TEAM - 60 * 60_000).some(boundary => boundary.kind === 'resume')).toBe(false)
  })

  it('wraps past midnight and deduplicates windows that cross together', () => {
    const wrap = scheduleOf(true, window('22:00', '06:00'))
    // 03:00 Team is inside the wrap window: the stop edge crossed five hours ago.
    const inside = crossedStopBoundaries(wrap, Date.UTC(2026, 10, 3, 19, 0, 0))
    expect(inside.filter(boundary => boundary.kind === 'stop')).toHaveLength(1)
    // The previous day's end is history, not an event: it never re-qualifies
    // mid-window, so a freshly enabled or restarted Host does not greet the
    // running window with a stale "you may start again".
    expect(inside.filter(boundary => boundary.kind === 'resume')).toHaveLength(0)
    // 06:00 Team is the end: resume fires within its freshness bound, the stop edge does not.
    const atEnd = crossedStopBoundaries(wrap, Date.UTC(2026, 10, 3, 22, 0, 0))
    expect(atEnd).toHaveLength(1)
    expect(atEnd[0]?.kind).toBe('resume')
    // An end crossed more than an hour ago no longer earns the notice.
    const lateResume = crossedStopBoundaries(wrap, Date.UTC(2026, 10, 3, 23, 30, 0))
    expect(lateResume).toHaveLength(0)
    const shared = scheduleOf(true, window('09:00', '18:00'), window('09:30', '18:00'))
    expect(crossedStopBoundaries(shared, AT_18_00_TEAM)).toHaveLength(1)
    expect(crossedStopBoundaries(scheduleOf(false, window('09:00', '18:00')), AT_18_00_TEAM)).toHaveLength(0)
  })
})

function teamAbsoluteMinuteOf(atMs: number): number {
  return Math.floor((atMs + 8 * 60 * 60_000) / 60_000)
}

/**
 * A monitor with scripted Host hooks and a Member list the test can move.
 * The isRunning/isMidTurn answers are the Host's live-session facts; the
 * pass consumes them per boundary exactly as the delivery rules require.
 */
function monitorHarness(members: () => readonly AgentTeamAgentMember[]) {
  const notices: Array<{ readonly memberId: AgentTeamMemberId; readonly body: string }> = []
  const logs: string[] = []
  const flags = {
    running: true,
    midTurn: true,
    notifyError: undefined as Error | undefined,
  }
  const monitor = new StopScheduleMonitor({
    members,
    isRunning: () => flags.running,
    isMidTurn: () => flags.midTurn,
    notify: async (memberId, body) => {
      if (flags.notifyError !== undefined) throw flags.notifyError
      notices.push({ memberId: memberId.memberId, body })
    },
    log: message => { logs.push(message) },
  })
  return { monitor, notices, logs, flags }
}

describe('StopScheduleMonitor passes', () => {
  // One pass may legitimately deliver several kinds at once (a window-end
  // resume can still sit inside the latch window while the next start earns
  // its heads-up); every assertion names its kind through the body marker.
  const wrapUps = (notices: readonly { readonly body: string }[]): readonly string[] => notices.map(notice => notice.body).filter(body => body.includes('Stop-run notice'))
  const boundaryStops = (notices: readonly { readonly body: string }[]): readonly string[] => notices.map(notice => notice.body).filter(body => body.includes('stop running now'))
  const resumes = (notices: readonly { readonly body: string }[]): readonly string[] => notices.map(notice => notice.body).filter(body => body.includes('Stop window ended'))

  it('delivers the wrap-up heads-up to a running Member once per boundary', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:stop',
      stopSchedule: scheduleOf(true, window('22:00', '06:00')),
    })]
    const hooks = monitorHarness(members)
    const soon = AT_18_00_TEAM + 3 * 60 * 60_000 + 30 * 60_000 // 21:30 Team; 22:00 in 30 minutes
    await hooks.monitor.runPass(soon)
    const wrapUps0 = wrapUps(hooks.notices)
    expect(wrapUps0).toHaveLength(1)
    expect(wrapUps0[0]).toContain('@worker')
    expect(wrapUps0[0]).toContain('22:00')
    await hooks.monitor.runPass(soon + 30_000)
    expect(wrapUps(hooks.notices)).toHaveLength(1) // latched per boundary
  })

  it('never delivers the wrap-up heads-up to a Member without a live Session', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:stopped',
      stopSchedule: scheduleOf(true, window('22:00', '06:00')),
    })]
    const hooks = monitorHarness(members)
    hooks.flags.running = false
    await hooks.monitor.runPass(AT_18_00_TEAM + 3 * 60 * 60_000 + 30 * 60_000)
    expect(wrapUps(hooks.notices)).toHaveLength(0)
    // The Member starts running while the boundary is still ahead: the
    // not-yet-crossed heads-up still belongs to it.
    hooks.flags.running = true
    await hooks.monitor.runPass(AT_18_00_TEAM + 3 * 60 * 60_000 + 31 * 60_000)
    expect(wrapUps(hooks.notices)).toHaveLength(1)
  })

  it('tells a still-working Member to stop once the window has started, and nobody once it has stopped', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:busy',
      stopSchedule: scheduleOf(true, window('17:00', '18:00')),
    })]
    const hooks = monitorHarness(members)
    const inside = AT_18_00_TEAM - 30 * 60_000 // 17:30 Team
    await hooks.monitor.runPass(inside)
    const stops0 = boundaryStops(hooks.notices)
    expect(stops0).toHaveLength(1)
    expect(stops0[0]).toContain('17:00')
    await hooks.monitor.runPass(inside + 30_000)
    expect(boundaryStops(hooks.notices)).toHaveLength(1) // latched per boundary
    // An idle Member inside the window earns no boundary notice.
    const idle = monitorHarness(members)
    idle.flags.midTurn = false
    await idle.monitor.runPass(inside)
    expect(boundaryStops(idle.notices)).toHaveLength(0)
  })

  it('delivers the resume notice after the window ends, running or not', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:resume',
      stopSchedule: scheduleOf(true, window('09:00', '18:00')),
    })]
    const hooks = monitorHarness(members)
    hooks.flags.running = false
    hooks.flags.midTurn = false
    await hooks.monitor.runPass(AT_18_00_TEAM)
    const resumes0 = resumes(hooks.notices)
    expect(resumes0).toHaveLength(1)
    expect(resumes0[0]).toContain('ask the Manager')
    await hooks.monitor.runPass(AT_18_00_TEAM + 30_000)
    expect(resumes(hooks.notices)).toHaveLength(1) // latched per boundary
  })

  it('retries a failed notice on the next pass instead of losing the boundary', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:retry',
      stopSchedule: scheduleOf(true, window('09:00', '18:00')),
    })]
    const hooks = monitorHarness(members)
    hooks.flags.notifyError = new Error('gateway down')
    await hooks.monitor.runPass(AT_18_00_TEAM)
    expect(hooks.notices).toHaveLength(0)
    expect(hooks.logs.some(line => line.includes('gateway down'))).toBe(true)
    hooks.flags.notifyError = undefined
    await hooks.monitor.runPass(AT_18_00_TEAM + 30_000)
    expect(resumes(hooks.notices)).toHaveLength(1)
  })

  it('skips suspended, archived, external, and schedule-less Members', async () => {
    const current = [
      member({ memberId: 'member:susp', state: 'suspended', stopSchedule: scheduleOf(true, window('09:00', '18:00')) }),
      member({ memberId: 'member:arch', state: 'archived', stopSchedule: scheduleOf(true, window('09:00', '18:00')) }),
      member({ memberId: 'member:ext', external: true, stopSchedule: scheduleOf(true, window('09:00', '18:00')) }),
      member({ memberId: 'member:plain' }),
    ]
    const hooks = monitorHarness(() => current)
    await hooks.monitor.runPass(AT_18_00_TEAM)
    expect(hooks.notices).toHaveLength(0)
  })
})

describe('stop schedule notice texts', () => {
  it('carries the wrap-up contract: stop time, handover, Manager report, stated interval', () => {
    const text = stopScheduleWrapUpNoticeText({ memberHandle: 'worker', whenText: '2026-11-03T22:00:00+08:00', window: window('22:00', '06:00') })
    expect(text).toContain('@worker')
    expect(text).toContain('in 30 minutes you must stop running')
    expect(text).toContain('handover document')
    expect(text).toContain('Manager')
    expect(text).toContain('from 22:00 to 06:00')
  })

  it('names the boundary and the resume instruction', () => {
    const boundary = stopScheduleBoundaryNoticeText({ memberHandle: 'worker', window: window('22:00', '06:00') })
    expect(boundary).toContain('stop running now')
    expect(boundary).toContain('do not start new work')
    const resume = stopScheduleResumeNoticeText({ memberHandle: 'worker', window: window('22:00', '06:00') })
    expect(resume).toContain('you may start again')
    expect(resume).toContain('ask the Manager')
  })

  it('keeps the notice horizon at thirty minutes before the window', () => {
    expect(STOP_SCHEDULE_NOTICE_AHEAD_MS).toBe(30 * 60 * 1000)
  })
})

// A boundary type import guard: the shape stays part of the module contract.
export type { StopScheduleBoundary }
