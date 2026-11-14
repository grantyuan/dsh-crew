import { describe, expect, it } from 'vitest'
import {
  assertScheduleRecurrence,
  describeRecurrence,
  recurrenceMatchesDay,
  teamDateParts,
  windowCoversAt,
  windowOccurrencesAround,
  windowOccurrencesOn,
} from '../src/schedule-recurrence.ts'
import {
  ModelScheduleMonitor,
  modelScheduleSwitchNoticeText,
  resolveScheduleRoute,
  resolveScheduleRouteAt,
  upcomingRouteChanges,
} from '../src/model-schedule.ts'
import {
  StopScheduleMonitor,
  crossedStopBoundaries,
  stopScheduleBoundaryNoticeText,
  stopScheduleResumeNoticeText,
  stopScheduleWrapUpNoticeText,
  upcomingStopBoundaries,
} from '../src/stop-schedule.ts'
import type { TeamDateParts } from '../src/schedule-recurrence.ts'
import type { AgentTeamAgentMember, AgentTeamMemberModelSchedule, AgentTeamModelSelection, AgentTeamScheduleRecurrence } from '../src/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

// Team zone is UTC+8. Calendar facts used below (proleptic Gregorian, no DST
// in a fixed offset): 2026-11-09 is a Monday, 2026-11-13 a Friday, 2026-11-14
// a Saturday, 2026-11-15 a Sunday; 2026 is not a leap year, 2024 and 2028 are.
const AT = (teamIso: string): number => Date.parse(`${teamIso}:00+08:00`)

/**
 * An independent weekday oracle: the ISO weekday derived from the standard
 * library's own calendar, so the module's date arithmetic is checked against
 * something that does not share its implementation.
 */
function partsOf(year: number, month: number, day: number): TeamDateParts {
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1
  return { year, month, day, weekday: weekday as TeamDateParts['weekday'] }
}

const daily = (): AgentTeamScheduleRecurrence => ({ kind: 'daily' })
const workdays = (): AgentTeamScheduleRecurrence => ({ kind: 'workdays' })
const everyDays = (intervalDays: number, anchorDate: string): AgentTeamScheduleRecurrence => ({ kind: 'everyDays', intervalDays, anchorDate })
const weekly = (...weekdays: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7)[]): AgentTeamScheduleRecurrence => ({ kind: 'weekly', weekdays })
const monthly = (dayOfMonth: number): AgentTeamScheduleRecurrence => ({ kind: 'monthly', dayOfMonth })
const yearly = (month: number, day: number): AgentTeamScheduleRecurrence => ({ kind: 'yearly', month, day })

const windowOf = (start: string, end: string, recurrence?: AgentTeamScheduleRecurrence) => ({ start, end, ...(recurrence === undefined ? {} : { recurrence }) })

describe('teamDateParts (the Team-zone calendar day)', () => {
  it('reads the UTC+8 calendar day and ISO weekday, not the machine zone', () => {
    expect(teamDateParts(Date.parse('2026-11-03T10:00:00Z'))).toEqual({ year: 2026, month: 11, day: 3, weekday: 2 }) // Tuesday
    expect(teamDateParts(Date.parse('2026-11-09T02:00:00Z'))).toEqual({ year: 2026, month: 11, day: 9, weekday: 1 }) // Monday
    expect(teamDateParts(Date.parse('2026-11-14T09:00:00Z'))).toEqual({ year: 2026, month: 11, day: 14, weekday: 6 }) // Saturday
    expect(teamDateParts(Date.parse('2026-11-15T10:00:00Z'))).toEqual({ year: 2026, month: 11, day: 15, weekday: 7 }) // Sunday
  })

  it('rolls the Team day over at 16:00 UTC, where the fixed offset ends it', () => {
    expect(teamDateParts(Date.parse('2026-11-03T15:59:00Z'))).toMatchObject({ month: 11, day: 3, weekday: 2 })
    expect(teamDateParts(Date.parse('2026-11-03T16:00:00Z'))).toMatchObject({ month: 11, day: 4, weekday: 3 })
  })
})

describe('recurrenceMatchesDay (the six kinds)', () => {
  it('treats an absent recurrence and daily as every day', () => {
    expect(recurrenceMatchesDay(undefined, partsOf(2026, 11, 14))).toBe(true)
    expect(recurrenceMatchesDay(daily(), partsOf(2026, 11, 14))).toBe(true)
    expect(recurrenceMatchesDay(daily(), partsOf(2026, 11, 15))).toBe(true)
  })

  it('matches workdays Monday through Friday only', () => {
    expect(recurrenceMatchesDay(workdays(), partsOf(2026, 11, 9))).toBe(true) // Monday
    expect(recurrenceMatchesDay(workdays(), partsOf(2026, 11, 13))).toBe(true) // Friday
    expect(recurrenceMatchesDay(workdays(), partsOf(2026, 11, 14))).toBe(false) // Saturday
    expect(recurrenceMatchesDay(workdays(), partsOf(2026, 11, 15))).toBe(false) // Sunday
  })

  it('matches every N days from the anchor day on, never before it', () => {
    const kind = everyDays(3, '2026-11-10')
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 10))).toBe(true) // the anchor day itself
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 13))).toBe(true)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 16))).toBe(true)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 11))).toBe(false)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 12))).toBe(false)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 9))).toBe(false) // one day before the anchor
    // A serial difference that is a negative multiple of N still never matches.
    expect(recurrenceMatchesDay(kind, partsOf(2026, 11, 7))).toBe(false)
  })

  it('keeps the every-N-day series aligned across month and year boundaries', () => {
    const kind = everyDays(5, '2026-01-30')
    expect(recurrenceMatchesDay(kind, partsOf(2026, 1, 30))).toBe(true)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 2, 4))).toBe(true)
    expect(recurrenceMatchesDay(kind, partsOf(2026, 3, 6))).toBe(true) // 35 days on, across a short month
    expect(recurrenceMatchesDay(kind, partsOf(2026, 12, 31))).toBe(true) // 335 days on, across the year
    expect(recurrenceMatchesDay(kind, partsOf(2027, 1, 5))).toBe(true) // 341 = 5 * 68
    expect(recurrenceMatchesDay(kind, partsOf(2027, 1, 4))).toBe(false)
  })

  it('matches only the selected weekdays of a weekly recurrence', () => {
    const weekend = weekly(6, 7)
    expect(recurrenceMatchesDay(weekend, partsOf(2026, 11, 14))).toBe(true) // Saturday
    expect(recurrenceMatchesDay(weekend, partsOf(2026, 11, 15))).toBe(true) // Sunday
    expect(recurrenceMatchesDay(weekend, partsOf(2026, 11, 13))).toBe(false) // Friday
    const mondayOnly = weekly(1)
    expect(recurrenceMatchesDay(mondayOnly, partsOf(2026, 11, 9))).toBe(true)
    expect(recurrenceMatchesDay(mondayOnly, partsOf(2026, 11, 10))).toBe(false)
  })

  it('matches monthly day-of-month and leaves short months silent', () => {
    expect(recurrenceMatchesDay(monthly(15), partsOf(2026, 11, 15))).toBe(true)
    expect(recurrenceMatchesDay(monthly(15), partsOf(2026, 11, 14))).toBe(false)
    // The 31st simply never occurs in a 30-day month: no window, no error.
    expect(recurrenceMatchesDay(monthly(31), partsOf(2026, 1, 31))).toBe(true)
    expect(recurrenceMatchesDay(monthly(31), partsOf(2026, 4, 30))).toBe(false)
    expect(recurrenceMatchesDay(monthly(29), partsOf(2026, 2, 28))).toBe(false) // 2026 has no Feb 29
    expect(recurrenceMatchesDay(monthly(29), partsOf(2028, 2, 29))).toBe(true)
  })

  it('matches yearly month and day, with 02-29 alive only in leap years', () => {
    expect(recurrenceMatchesDay(yearly(3, 15), partsOf(2026, 3, 15))).toBe(true)
    expect(recurrenceMatchesDay(yearly(3, 15), partsOf(2026, 3, 14))).toBe(false)
    expect(recurrenceMatchesDay(yearly(3, 15), partsOf(2026, 4, 15))).toBe(false)
    expect(recurrenceMatchesDay(yearly(2, 29), partsOf(2028, 2, 29))).toBe(true) // leap year: the window exists
    expect(recurrenceMatchesDay(yearly(2, 29), partsOf(2026, 2, 28))).toBe(false) // otherwise the month never grows the day
    expect(recurrenceMatchesDay(yearly(12, 31), partsOf(2026, 12, 31))).toBe(true)
  })
})

describe('windowOccurrencesOn (one matched day, expanded to an interval)', () => {
  it('expands a plain window to [start, end) of the Team-zone day', () => {
    const occurrences = windowOccurrencesOn(windowOf('09:00', '18:00', daily()), partsOf(2026, 11, 14))
    expect(occurrences).toEqual([{ startMs: AT('2026-11-14T09:00'), endMs: AT('2026-11-14T18:00') }])
  })

  it('anchors a cross-midnight window to its start day: the end lands on the next day', () => {
    const occurrences = windowOccurrencesOn(windowOf('22:00', '08:00', workdays()), partsOf(2026, 11, 13)) // Friday
    expect(occurrences).toEqual([{ startMs: AT('2026-11-13T22:00'), endMs: AT('2026-11-14T08:00') }])
  })

  it('produces nothing on a day the recurrence does not match', () => {
    expect(windowOccurrencesOn(windowOf('22:00', '08:00', workdays()), partsOf(2026, 11, 14))).toEqual([]) // Saturday
  })

  it('treats an absent recurrence as daily and a degenerate window as never covering', () => {
    expect(windowOccurrencesOn(windowOf('09:00', '18:00'), partsOf(2026, 11, 14))).toEqual([{ startMs: AT('2026-11-14T09:00'), endMs: AT('2026-11-14T18:00') }])
    expect(windowOccurrencesOn(windowOf('09:00', '09:00'), partsOf(2026, 11, 14))).toEqual([])
  })
})

describe('windowOccurrencesAround (the candidate-day spread a monitor expands)', () => {
  it('expands a daily window on each of the four candidate days around the instant', () => {
    // Saturday 2026-11-14 morning: candidates are Thu 12, Fri 13, Sat 14, Sun 15.
    const occurrences = windowOccurrencesAround(windowOf('09:00', '18:00'), AT('2026-11-14T02:00'))
    expect(occurrences.map(occurrence => occurrence.startMs)).toEqual([
      AT('2026-11-12T09:00'), AT('2026-11-13T09:00'), AT('2026-11-14T09:00'), AT('2026-11-15T09:00'),
    ])
  })

  it('keeps the wrap window a workday anchored: Thursday and Friday both reach the morning, Saturday never starts', () => {
    const occurrences = windowOccurrencesAround(windowOf('22:00', '08:00', workdays()), AT('2026-11-14T02:00'))
    expect(occurrences).toEqual([
      { startMs: AT('2026-11-12T22:00'), endMs: AT('2026-11-13T08:00') },
      { startMs: AT('2026-11-13T22:00'), endMs: AT('2026-11-14T08:00') },
    ])
  })
})

describe('windowCoversAt (the per-window instant test)', () => {
  it('sees a yesterday-started wrap window through this morning and nothing past it', () => {
    const window = windowOf('22:00', '08:00', workdays())
    expect(windowCoversAt(window, AT('2026-11-14T02:00'))).toBe(true) // Friday's window, Saturday morning
    expect(windowCoversAt(window, AT('2026-11-14T08:00'))).toBe(false) // end is exclusive
    expect(windowCoversAt(window, AT('2026-11-15T02:00'))).toBe(false) // Saturday start day never matched
    expect(windowCoversAt(window, AT('2026-11-13T21:59'))).toBe(false)
  })
})

describe('describeRecurrence (the notice phrase)', () => {
  it('gives plain daily windows no phrase, so legacy notices stay byte-identical', () => {
    expect(describeRecurrence(undefined)).toBe('')
    expect(describeRecurrence(daily())).toBe('')
  })

  it('phrases the parameterized kinds', () => {
    expect(describeRecurrence(workdays())).toBe('on workdays')
    expect(describeRecurrence(everyDays(3, '2026-11-10'))).toBe('every 3 days')
    expect(describeRecurrence(everyDays(1, '2026-11-10'))).toBe('every day')
    expect(describeRecurrence(weekly(6, 7))).toBe('on Sat and Sun')
    expect(describeRecurrence(weekly(1, 3, 5))).toBe('on Mon, Wed and Fri')
    expect(describeRecurrence(monthly(15))).toBe('on day 15 of each month')
    expect(describeRecurrence(yearly(2, 29))).toBe('each year on 02-29')
  })
})

describe('assertScheduleRecurrence (the commit shape rule)', () => {
  it('accepts the six kinds with valid parameters', () => {
    expect(() => assertScheduleRecurrence(daily())).not.toThrow()
    expect(() => assertScheduleRecurrence(workdays())).not.toThrow()
    expect(() => assertScheduleRecurrence(everyDays(1, '2026-11-10'))).not.toThrow()
    expect(() => assertScheduleRecurrence(everyDays(366, '2024-02-29'))).not.toThrow()
    expect(() => assertScheduleRecurrence(weekly(1, 4, 7))).not.toThrow()
    expect(() => assertScheduleRecurrence(monthly(31))).not.toThrow()
    expect(() => assertScheduleRecurrence(yearly(2, 29))).not.toThrow()
  })

  it('rejects an unknown kind', () => {
    expect(() => assertScheduleRecurrence({ kind: 'weekdays' } as never)).toThrow(/kind/)
  })

  it('rejects an everyDays interval outside 1..366 or a non-integer one', () => {
    expect(() => assertScheduleRecurrence(everyDays(0, '2026-11-10'))).toThrow(/intervalDays/)
    expect(() => assertScheduleRecurrence(everyDays(367, '2026-11-10'))).toThrow(/intervalDays/)
    expect(() => assertScheduleRecurrence(everyDays(2.5, '2026-11-10'))).toThrow(/intervalDays/)
  })

  it('rejects an everyDays anchor that is not a real calendar date', () => {
    expect(() => assertScheduleRecurrence(everyDays(3, '2026-02-30'))).toThrow(/anchorDate/)
    expect(() => assertScheduleRecurrence(everyDays(3, '2026-13-01'))).toThrow(/anchorDate/)
    expect(() => assertScheduleRecurrence(everyDays(3, '20261110'))).toThrow(/anchorDate/)
    expect(() => assertScheduleRecurrence(everyDays(3, '2026-11-10T00:00'))).toThrow(/anchorDate/)
  })

  it('rejects weekly weekday lists that are empty, out of range, or repeated', () => {
    const raw = (value: unknown): AgentTeamScheduleRecurrence => value as AgentTeamScheduleRecurrence
    expect(() => assertScheduleRecurrence(weekly())).toThrow(/weekday/)
    expect(() => assertScheduleRecurrence(raw({ kind: 'weekly', weekdays: [0, 1] }))).toThrow(/weekday/)
    expect(() => assertScheduleRecurrence(raw({ kind: 'weekly', weekdays: [1, 8] }))).toThrow(/weekday/)
    expect(() => assertScheduleRecurrence(raw({ kind: 'weekly', weekdays: [3, 3] }))).toThrow(/weekday/)
  })

  it('rejects a monthly day outside 1..31', () => {
    expect(() => assertScheduleRecurrence(monthly(0))).toThrow(/dayOfMonth/)
    expect(() => assertScheduleRecurrence(monthly(32))).toThrow(/dayOfMonth/)
    expect(() => assertScheduleRecurrence(monthly(1.5))).toThrow(/dayOfMonth/)
  })

  it('rejects a yearly date outside its month or 02-30, accepting 02-29', () => {
    expect(() => assertScheduleRecurrence(yearly(0, 15))).toThrow(/yearly/)
    expect(() => assertScheduleRecurrence(yearly(13, 15))).toThrow(/yearly/)
    expect(() => assertScheduleRecurrence(yearly(2, 30))).toThrow(/yearly/)
    expect(() => assertScheduleRecurrence(yearly(4, 31))).toThrow(/yearly/)
    expect(() => assertScheduleRecurrence(yearly(2, 29))).not.toThrow() // pattern rule: February caps at 29
  })
})

const deepseek = (): AgentTeamModelSelection => ({ provider: 'deepseek', model: 'deepseek-flash' })
const qwen = (): AgentTeamModelSelection => ({ provider: 'qwen', model: 'qwen3.8-flash' })

const modelWindow = (start: string, end: string, selection: AgentTeamModelSelection, recurrence?: AgentTeamScheduleRecurrence) =>
  ({ start, end, selection, ...(recurrence === undefined ? {} : { recurrence }) })
const scheduleOf = (enabled: boolean, ...windows: AgentTeamMemberModelSchedule['windows']): AgentTeamMemberModelSchedule =>
  ({ enabled, windows })

function member(overrides: { readonly memberId: string } & Partial<Omit<AgentTeamAgentMember, 'memberId'>>): AgentTeamAgentMember {
  return {
    sessionId: SessionId(`session:${overrides.memberId}`),
    workspaceId: WorkspaceId('workspace:alpha'),
    handle: 'worker',
    description: '',
    presetId: 'team-member',
    privateMemoryPath: '/tmp/x',
    state: 'enabled',
    ...overrides,
    memberId: overrides.memberId as never,
  } as AgentTeamAgentMember
}

describe('resolveScheduleRouteAt (coverage by expanded occurrences)', () => {
  it('covers only the days the recurrence matches, list order deciding overlaps', () => {
    const schedule = scheduleOf(true,
      modelWindow('09:00', '18:00', deepseek(), workdays()),
      modelWindow('09:00', '18:00', qwen(), weekly(6, 7)),
    )
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-16T10:00'))).toEqual(deepseek()) // Monday: workdays window
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T10:00'))).toEqual(qwen()) // Saturday: weekend window
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T07:00'))).toBeUndefined() // outside the bounds both days
  })

  it('lets the FIRST covering window win against any later window, whatever its recurrence', () => {
    const schedule = scheduleOf(true,
      modelWindow('09:00', '12:00', deepseek(), weekly(1, 2, 3, 4, 5, 6, 7)),
      modelWindow('09:00', '18:00', qwen()),
    )
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T10:00'))).toEqual(deepseek())
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T13:00'))).toEqual(qwen())
  })

  it('sees a near-24-hour wrap window through the day after its start day, two candidate days back', () => {
    // everyDays(2) from Thursday: occurrences [Thu 23:59, Fri 23:58) and [Sat 23:59, Sun 23:58).
    const schedule = scheduleOf(true, modelWindow('23:59', '23:58', deepseek(), everyDays(2, '2026-11-12')))
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-13T12:00'))).toEqual(deepseek()) // Friday noon: Thursday's window still runs
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T12:00'))).toBeUndefined() // Friday's window: gap day, nothing runs
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-13T23:58'))).toBeUndefined() // end exclusive, and Saturday starts nothing until 23:59
  })

  it('anchors a cross-midnight workday window to its start day through the next morning', () => {
    const schedule = scheduleOf(true, modelWindow('22:00', '08:00', deepseek(), workdays()))
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T02:00'))).toEqual(deepseek()) // Friday night's window, Saturday morning
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T07:59'))).toEqual(deepseek())
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T08:00'))).toBeUndefined() // end exclusive
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-14T22:30'))).toBeUndefined() // Saturday is not a start day
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-15T02:00'))).toBeUndefined() // nothing carries into Sunday
    expect(resolveScheduleRouteAt(schedule, AT('2026-11-16T02:00'))).toBeUndefined() // nor into Monday before its own window
  })

  it('answers nothing for a disabled schedule and everything for plain daily windows', () => {
    expect(resolveScheduleRouteAt(scheduleOf(false, modelWindow('09:00', '18:00', deepseek())), AT('2026-11-16T10:00'))).toBeUndefined()
    const dailySchedule = scheduleOf(true, modelWindow('09:00', '18:00', deepseek()))
    expect(resolveScheduleRouteAt(dailySchedule, AT('2026-11-14T10:00'))).toEqual(deepseek())
    expect(resolveScheduleRouteAt(dailySchedule, AT('2026-11-14T18:00'))).toBeUndefined()
  })

  it('agrees minute for minute with the legacy daily resolver on every daily shape', () => {
    const shapes = [
      scheduleOf(true, modelWindow('09:00', '18:00', deepseek())),
      scheduleOf(true, modelWindow('22:00', '06:00', deepseek())),
      scheduleOf(true, modelWindow('09:00', '12:00', deepseek()), modelWindow('09:30', '18:00', qwen())),
      scheduleOf(true, modelWindow('23:50', '00:10', deepseek())),
      scheduleOf(true, modelWindow('18:00', '09:00', deepseek()), modelWindow('00:00', '23:59', qwen())),
    ]
    const dayStart = AT('2026-11-03T00:00')
    for (const schedule of shapes) {
      for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 1) {
        const epochMs = dayStart + minuteOfDay * 60_000
        expect(resolveScheduleRouteAt(schedule, epochMs)).toEqual(resolveScheduleRoute(schedule, minuteOfDay))
      }
    }
  })
})

describe('upcomingRouteChanges with recurrences', () => {
  it('finds no boundary on a day the window does not match', () => {
    const schedule = scheduleOf(true, modelWindow('09:00', '18:00', deepseek(), workdays()))
    // Saturday 17:52 Team: a daily window would head for its 18:00 end eight
    // minutes out; a workdays window has no Saturday, so nothing comes.
    expect(upcomingRouteChanges(schedule, AT('2026-11-14T17:52'))).toEqual([])
    // Saturday 08:52: a daily window would head for its 09:00 start; none comes on Saturday.
    expect(upcomingRouteChanges(schedule, AT('2026-11-14T08:52'))).toEqual([])
  })

  it('still finds the ordinary workday boundaries', () => {
    const schedule = scheduleOf(true, modelWindow('09:00', '18:00', deepseek(), workdays()))
    const changes = upcomingRouteChanges(schedule, AT('2026-11-16T17:52')) // Monday
    expect(changes).toHaveLength(1)
    expect(changes[0]?.atMs).toBe(AT('2026-11-16T18:00'))
    expect(changes[0]?.incoming).toBeUndefined()
    expect(changes[0]?.recurrenceText).toBe('on workdays')
  })

  it('ends a yesterday-matched cross-midnight window this morning (the resume-shaped route change)', () => {
    const schedule = scheduleOf(true, modelWindow('22:00', '06:00', deepseek(), workdays()))
    const changes = upcomingRouteChanges(schedule, AT('2026-11-14T05:55')) // Saturday: Friday's window runs to 06:00
    expect(changes).toHaveLength(1)
    expect(changes[0]?.atMs).toBe(AT('2026-11-14T06:00'))
    expect(changes[0]?.incoming).toBeUndefined()
    expect(changes[0]?.recurrenceText).toBe('on workdays')
    // Sunday morning: Saturday started nothing, so nothing ends.
    expect(upcomingRouteChanges(schedule, AT('2026-11-15T05:55'))).toEqual([])
  })

  it('carries a late-evening window past midnight into the morning end boundary', () => {
    const schedule = scheduleOf(true, modelWindow('23:45', '00:15', deepseek(), workdays()))
    // Saturday 00:06: Friday's 23:45 window is still running and ends at 00:15.
    const changes = upcomingRouteChanges(schedule, AT('2026-11-14T00:06'))
    expect(changes).toHaveLength(1)
    expect(changes[0]?.atMs).toBe(AT('2026-11-14T00:15'))
    expect(changes[0]?.incoming).toBeUndefined()
  })

  it('announces a start that lands just after midnight on the next matched day', () => {
    const schedule = scheduleOf(true, modelWindow('00:05', '00:15', deepseek(), weekly(6)))
    const changes = upcomingRouteChanges(schedule, AT('2026-11-13T23:58')) // Friday 23:58: Saturday's 00:05 start is inside the horizon
    expect(changes).toHaveLength(1)
    expect(changes[0]?.atMs).toBe(AT('2026-11-14T00:05'))
    expect(changes[0]?.incoming).toEqual(deepseek())
    expect(changes[0]?.recurrenceText).toBe('on Sat')
  })
})

describe('ModelScheduleMonitor passes with recurrences', () => {
  it('keeps the Member pinned on a non-matching day and switches back from the schedule route', async () => {
    let applied: AgentTeamModelSelection | undefined = deepseek() // left over from Friday's window
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:workdays',
      modelSchedule: scheduleOf(true, modelWindow('09:00', '18:00', deepseek(), workdays())),
      ...(applied === undefined ? {} : { scheduledModel: applied }),
    })]
    const switches: Array<{ readonly memberId: string; readonly desired: AgentTeamModelSelection | undefined }> = []
    const reminders: unknown[] = []
    const monitor = new ModelScheduleMonitor({
      members,
      applySwitch: async (_member, desired) => {
        switches.push({ memberId: 'member:workdays', desired })
        applied = desired
        return true
      },
      remind: async (_member, boundary) => { reminders.push(boundary) },
      log: () => {},
    })
    // Saturday noon: the workdays window does not exist, the pinned route stands again.
    await monitor.runPass(AT('2026-11-14T12:00'))
    expect(switches).toEqual([{ memberId: 'member:workdays', desired: undefined }])
    expect(reminders).toEqual([])
    // Converged: the next pass drives nothing.
    await monitor.runPass(AT('2026-11-14T12:00') + 30_000)
    expect(switches).toHaveLength(1)
    // Monday 17:52: the window is live again — the route switches back onto the
    // window's selection, and the 18:00 end earns the ordinary heads-up.
    await monitor.runPass(AT('2026-11-16T17:52'))
    expect(switches).toHaveLength(2)
    expect(switches[1]).toEqual({ memberId: 'member:workdays', desired: deepseek() })
    expect(reminders).toHaveLength(1)
  })
})

describe('model schedule notice text with a recurrence phrase', () => {
  it('names the recurrence on the schedule subject', () => {
    const text = modelScheduleSwitchNoticeText({
      memberHandle: 'worker',
      whenText: '2026-11-16T18:00:00+08:00',
      incoming: undefined,
      recurrenceText: 'on workdays',
    })
    expect(text).toContain('your Team model schedule on workdays switches your model route')
    expect(text).toContain('back onto its pinned route')
  })

  it('stays byte-identical for plain daily windows', () => {
    const legacy = modelScheduleSwitchNoticeText({ memberHandle: 'worker', whenText: '2026-11-16T18:00:00+08:00', incoming: qwen() })
    const daily = modelScheduleSwitchNoticeText({ memberHandle: 'worker', whenText: '2026-11-16T18:00:00+08:00', incoming: qwen(), recurrenceText: '' })
    expect(daily).toBe(legacy)
    expect(daily).toContain('your Team model schedule switches your model route onto qwen/qwen3.8-flash')
    expect(daily).not.toContain('undefined')
  })
})

const stopWindow = (start: string, end: string, recurrence?: AgentTeamScheduleRecurrence) => ({ start, end, ...(recurrence === undefined ? {} : { recurrence }) })
const stopScheduleOf = (enabled: boolean, ...windows: readonly ReturnType<typeof stopWindow>[]) => ({ enabled, windows })

describe('upcomingStopBoundaries with recurrences', () => {
  it('offers the wrap-up heads-up only on a day the window starts', () => {
    const schedule = stopScheduleOf(true, stopWindow('22:00', '06:00', workdays()))
    const friday = upcomingStopBoundaries(schedule, AT('2026-11-13T21:30'))
    expect(friday).toHaveLength(1)
    expect(friday[0]).toMatchObject({ kind: 'stop', atMs: AT('2026-11-13T22:00') })
    // Saturday 21:30: a daily window would head for its 22:00 start; a workdays window has no Saturday.
    expect(upcomingStopBoundaries(schedule, AT('2026-11-14T21:30'))).toEqual([])
  })

  it('offers the wrap-up heads-up for a start that lands just after midnight on the next matched day', () => {
    const schedule = stopScheduleOf(true, stopWindow('00:05', '00:15', weekly(6)))
    // Friday 23:40 Team: Saturday's 00:05 start is twenty-five minutes ahead.
    const boundaries = upcomingStopBoundaries(schedule, AT('2026-11-13T23:40'))
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ kind: 'stop', atMs: AT('2026-11-14T00:05') })
  })

  it('anchors an everyDays stop window to its first day', () => {
    const schedule = stopScheduleOf(true, stopWindow('22:00', '06:00', everyDays(3, '2026-11-13')))
    expect(upcomingStopBoundaries(schedule, AT('2026-11-13T21:30'))).toHaveLength(1) // the anchor day itself
    expect(upcomingStopBoundaries(schedule, AT('2026-11-12T21:30'))).toEqual([]) // before the anchor
    expect(upcomingStopBoundaries(schedule, AT('2026-11-14T21:30'))).toEqual([]) // one day after: not a multiple of 3
    expect(upcomingStopBoundaries(schedule, AT('2026-11-16T21:30'))).toHaveLength(1) // three days on
  })
})

describe('crossedStopBoundaries with recurrences', () => {
  it('resumes a yesterday-matched cross-midnight window this morning, inside the freshness bound', () => {
    const schedule = stopScheduleOf(true, stopWindow('22:00', '06:00', workdays()))
    // Saturday 06:30: Friday's window ended forty minutes ago.
    const boundaries = crossedStopBoundaries(schedule, AT('2026-11-14T06:30'))
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ kind: 'resume', atMs: AT('2026-11-14T06:00') })
    // Ninety minutes past the end it is history, not an event.
    expect(crossedStopBoundaries(schedule, AT('2026-11-14T07:30'))).toEqual([])
    // Sunday 06:30: Saturday started nothing, so nothing ended.
    expect(crossedStopBoundaries(schedule, AT('2026-11-15T06:30'))).toEqual([])
  })

  it('resumes a same-day window that ended late the previous evening', () => {
    const schedule = stopScheduleOf(true, stopWindow('22:00', '23:50', workdays()))
    const boundaries = crossedStopBoundaries(schedule, AT('2026-11-14T00:30')) // Saturday: Friday's window ended 40 minutes ago
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ kind: 'resume', atMs: AT('2026-11-13T23:50') })
  })

  it('keeps the stop expectation standing while a Friday-started window still covers Saturday', () => {
    const schedule = stopScheduleOf(true, stopWindow('22:00', '06:00', workdays()))
    const boundaries = crossedStopBoundaries(schedule, AT('2026-11-14T03:00')) // Saturday 03:00, inside Friday's wrap window
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ kind: 'stop', atMs: AT('2026-11-13T22:00') })
    // Sunday 03:00: no occurrence covers it, and none just crossed.
    expect(crossedStopBoundaries(schedule, AT('2026-11-15T03:00'))).toEqual([])
  })

  it('resumes a near-24-hour wrap window whose end fell late last night, two candidate days back', () => {
    // everyDays(2) from Thursday: Thursday's occurrence ends Friday 23:58; the
    // next one starts Saturday 23:59 — so Saturday 00:30 is covered by nothing.
    const schedule = stopScheduleOf(true, stopWindow('23:59', '23:58', everyDays(2, '2026-11-12')))
    const boundaries = crossedStopBoundaries(schedule, AT('2026-11-14T00:30'))
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({ kind: 'resume', atMs: AT('2026-11-13T23:58') })
  })

  it('never resumes a window that covers the moment through its next day', () => {
    // The 23:59-long window covers 00:30 through today's own occurrence, so
    // yesterday's end — although inside the freshness bound — earns nothing.
    const schedule = stopScheduleOf(true, stopWindow('00:00', '23:59'))
    expect(crossedStopBoundaries(schedule, AT('2026-11-14T00:30'))).toHaveLength(1)
    expect(crossedStopBoundaries(schedule, AT('2026-11-14T00:30'))[0]?.kind).toBe('stop')
  })
})

describe('StopScheduleMonitor passes with recurrences', () => {
  it('delivers wrap-up, stop, and resume only around matched days, latched per boundary minute', async () => {
    const members = (): readonly AgentTeamAgentMember[] => [member({
      memberId: 'member:workdays-stop',
      stopSchedule: stopScheduleOf(true, stopWindow('22:00', '06:00', workdays())),
    })]
    const notices: Array<{ readonly memberId: string; readonly body: string }> = []
    const monitor = new StopScheduleMonitor({
      members,
      isRunning: () => true,
      isMidTurn: () => true,
      notify: async (_memberId, body) => { notices.push({ memberId: 'member:workdays-stop', body }) },
      formatWhen: atMs => new Date(atMs).toISOString(),
      log: () => {},
    })
    const kindOf = (body: string): string => body.includes('Stop-run notice') ? 'wrap-up' : body.includes('stop running now') ? 'stop' : body.includes('Stop window ended') ? 'resume' : 'other'
    // Friday 21:30: the wrap-up heads-up for the 22:00 start.
    await monitor.runPass(AT('2026-11-13T21:30'))
    expect(notices.map(notice => kindOf(notice.body))).toEqual(['wrap-up'])
    expect(notices[0]?.body).toContain('on workdays')
    // Saturday 03:00: still inside Friday's wrap window — the boundary-stop notice.
    await monitor.runPass(AT('2026-11-14T03:00'))
    expect(notices.map(notice => kindOf(notice.body))).toEqual(['wrap-up', 'stop'])
    // Saturday 06:30: the window ended forty minutes ago — the resume notice.
    await monitor.runPass(AT('2026-11-14T06:30'))
    expect(notices.map(notice => kindOf(notice.body))).toEqual(['wrap-up', 'stop', 'resume'])
    expect(notices[2]?.body).toContain('on workdays')
    // Latched: the same boundaries earn nothing again.
    await monitor.runPass(AT('2026-11-14T03:00') + 30_000)
    expect(notices).toHaveLength(3)
    // Saturday 21:30: no Saturday window, no wrap-up heads-up.
    await monitor.runPass(AT('2026-11-14T21:30'))
    expect(notices).toHaveLength(3)
  })
})

describe('stop schedule notice texts with a recurrence phrase', () => {
  it('qualifies the window with its recurrence', () => {
    const wrapUp = stopScheduleWrapUpNoticeText({ memberHandle: 'worker', whenText: '2026-11-13T22:00:00+08:00', window: stopWindow('22:00', '06:00', workdays()) })
    expect(wrapUp).toContain('(22:00–06:00 Team time, on workdays)')
    expect(wrapUp).toContain('in 30 minutes you must stop running')
    const boundary = stopScheduleBoundaryNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00', weekly(6)) })
    expect(boundary).toContain('(22:00–06:00 Team time, on Sat)')
    const resume = stopScheduleResumeNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00', everyDays(3, '2026-11-13')) })
    expect(resume).toContain('(22:00–06:00 Team time, every 3 days)')
  })

  it('stays byte-identical for plain daily windows', () => {
    const legacy = stopScheduleWrapUpNoticeText({ memberHandle: 'worker', whenText: '2026-11-13T22:00:00+08:00', window: stopWindow('22:00', '06:00') })
    const dailyText = stopScheduleWrapUpNoticeText({ memberHandle: 'worker', whenText: '2026-11-13T22:00:00+08:00', window: stopWindow('22:00', '06:00', daily()) })
    expect(dailyText).toBe(legacy)
    expect(dailyText).toContain('(22:00–06:00 Team time) starts at')
    expect(stopScheduleBoundaryNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00', daily()) }))
      .toBe(stopScheduleBoundaryNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00') }))
    expect(stopScheduleResumeNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00', daily()) }))
      .toBe(stopScheduleResumeNoticeText({ memberHandle: 'worker', window: stopWindow('22:00', '06:00') }))
  })
})
