/**
 * Schedule-window recurrence arithmetic.
 *
 * Both time schedules (model routing and stop-run) share this module: a window
 * carries a wall-clock `HH:MM` span plus an optional recurrence, and the
 * window is only active on days its recurrence matches. A matching day
 * expands the span into one concrete interval `[start, end)`; a wrapping span
 * (`end` at or before `start`) ends on the following Team-zone day, so a
 * Friday-night workday window legitimately runs into Saturday morning.
 *
 * Everything is judged in the fixed Team coordination zone (UTC+8), the same
 * zone the minute arithmetic has always used. Instants are plain epoch
 * milliseconds, days are whole Team-zone day indexes, and no persistence
 * lives here: the ledger keeps the intent, this module only derives intervals.
 * @module @grantyuan/dsh-crew/schedule-recurrence
 */

import type { AgentTeamScheduleRecurrence, AgentTeamScheduleWeekday } from './types.ts'
import { TEAM_ZONE_OFFSET_MINUTES } from './time-format.ts'

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000

/** Minutes in one day — the wrap-around modulus of every Team-zone minute computation. */
export const MINUTES_PER_DAY = 24 * 60

/** The fixed Team-zone offset (UTC+8) in milliseconds. */
export const TEAM_ZONE_OFFSET_MS = TEAM_ZONE_OFFSET_MINUTES * 60_000

/** Days before/after the current day whose windows can still touch the moment. */
const CANDIDATE_DAY_SPAN = 2

/** Parse one `HH:MM` schedule bound into Team-zone day minutes (0..1439). */
export function parseScheduleMinute(text: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match === null) throw new Error(`invalid schedule time '${text}'`)
  return Number(match[1]) * 60 + Number(match[2])
}

/** One epoch instant rendered as its Team-zone calendar day. */
export interface TeamDateParts {
  readonly year: number
  /** 1..12. */
  readonly month: number
  /** 1..31. */
  readonly day: number
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  readonly weekday: AgentTeamScheduleWeekday
  /** Whole days since the Unix epoch in the Team zone — the `everyDays` alignment base. */
  readonly dayIndex: number
}

/** One epoch instant rendered as its Team-zone year/month/day/weekday. */
export function teamDateParts(epochMs: number): TeamDateParts {
  const shifted = new Date(epochMs + TEAM_ZONE_OFFSET_MS)
  const jsWeekday = shifted.getUTCDay()
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: (jsWeekday === 0 ? 7 : jsWeekday) as AgentTeamScheduleWeekday,
    dayIndex: Math.floor((epochMs + TEAM_ZONE_OFFSET_MS) / DAY_MS),
  }
}

/** The Team-zone calendar day of one day index. */
export function teamDatePartsOfDayIndex(dayIndex: number): TeamDateParts {
  return teamDateParts(dayIndex * DAY_MS - TEAM_ZONE_OFFSET_MS)
}

/** Days in one calendar month (month 1..12); February follows the leap-year rule. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whether `year-month-day` names a real calendar date. */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

/** Parse a `YYYY-MM-DD` Team-zone date into its day index, or undefined when it is not a real date. */
export function parseAnchorDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!isCalendarDate(year, month, day)) return undefined
  return Date.UTC(year, month - 1, day) / DAY_MS
}

/**
 * Whether one window's recurrence is active on the given Team-zone day.
 * Detail rules: `everyDays` is active on the anchor day and every
 * `intervalDays` days after it (never before); `monthly` and `yearly` are
 * inactive in months/years that lack their day (the 31st in a short month,
 * 02-29 in a common year) rather than shifting to a nearby day. An absent
 * recurrence is every day; an unreadable recurrence is never active.
 */
export function recurrenceMatchesDay(recurrence: AgentTeamScheduleRecurrence | undefined, day: TeamDateParts): boolean {
  if (recurrence === undefined) return true
  switch (recurrence.kind) {
    case 'daily':
      return true
    case 'workdays':
      return day.weekday <= 5
    case 'everyDays': {
      const anchor = parseAnchorDate(recurrence.anchorDate)
      if (anchor === undefined || !Number.isInteger(recurrence.intervalDays) || recurrence.intervalDays < 1) return false
      const elapsed = day.dayIndex - anchor
      return elapsed >= 0 && elapsed % recurrence.intervalDays === 0
    }
    case 'weekly':
      return recurrence.weekdays.includes(day.weekday)
    case 'monthly':
      return day.day === recurrence.dayOfMonth
    case 'yearly':
      return day.month === recurrence.month && day.day === recurrence.day
    default:
      return false
  }
}

/** One window expanded to the concrete interval its start day activates. */
export interface ScheduleWindowOccurrence {
  readonly startMs: number
  /** Exclusive end; later than `startMs` because the equal-bounds window is degenerate. */
  readonly endMs: number
  /** The Team-zone day the window starts on. */
  readonly dayIndex: number
}

/**
 * Expand one window on one Team-zone day: the interval `[start, end)` when the
 * day matches its recurrence, otherwise nothing. A wrapping span ends on the
 * next day, so its interval crosses midnight.
 */
export function windowOccurrenceOn(
  window: { readonly start: string; readonly end: string; readonly recurrence?: AgentTeamScheduleRecurrence },
  day: TeamDateParts,
): ScheduleWindowOccurrence | undefined {
  if (!recurrenceMatchesDay(window.recurrence, day)) return undefined
  const startMinute = parseScheduleMinute(window.start)
  const endMinute = parseScheduleMinute(window.end)
  if (startMinute === endMinute) return undefined
  const dayStartMs = day.dayIndex * DAY_MS - TEAM_ZONE_OFFSET_MS
  const endMinuteOfInterval = endMinute <= startMinute ? endMinute + MINUTES_PER_DAY : endMinute
  return {
    startMs: dayStartMs + startMinute * 60_000,
    endMs: dayStartMs + endMinuteOfInterval * 60_000,
    dayIndex: day.dayIndex,
  }
}

/**
 * Candidate start days around an instant: two days back through the next day.
 * Yesterday and the day before cover wrapping windows that started then and
 * are still running (or ended minutes ago); tomorrow covers a late-night
 * start whose end sits just past a forward horizon.
 */
export function scheduleCandidateDays(nowMs: number): readonly TeamDateParts[] {
  const today = teamDateParts(nowMs)
  const days: TeamDateParts[] = []
  for (let offset = -CANDIDATE_DAY_SPAN; offset <= 1; offset += 1) {
    days.push(offset === 0 ? today : teamDatePartsOfDayIndex(today.dayIndex + offset))
  }
  return days
}

/** Every occurrence of one window among the candidate days around an instant. */
export function windowOccurrencesAround(
  window: { readonly start: string; readonly end: string; readonly recurrence?: AgentTeamScheduleRecurrence },
  nowMs: number,
): readonly ScheduleWindowOccurrence[] {
  const occurrences: ScheduleWindowOccurrence[] = []
  for (const day of scheduleCandidateDays(nowMs)) {
    const occurrence = windowOccurrenceOn(window, day)
    if (occurrence !== undefined) occurrences.push(occurrence)
  }
  return occurrences
}

/** Whether one window's expanded interval covers the given instant. */
export function windowCoversInstant(
  window: { readonly start: string; readonly end: string; readonly recurrence?: AgentTeamScheduleRecurrence },
  nowMs: number,
): boolean {
  return windowOccurrencesAround(window, nowMs).some(occurrence => occurrence.startMs <= nowMs && nowMs < occurrence.endMs)
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Deep-freeze one recurrence value (the weekly day list included); absent stays absent. */
export function freezeScheduleRecurrence(recurrence: AgentTeamScheduleRecurrence): AgentTeamScheduleRecurrence
export function freezeScheduleRecurrence(recurrence: AgentTeamScheduleRecurrence | undefined): AgentTeamScheduleRecurrence | undefined
export function freezeScheduleRecurrence(recurrence: AgentTeamScheduleRecurrence | undefined): AgentTeamScheduleRecurrence | undefined {
  if (recurrence === undefined) return undefined
  if (recurrence.kind === 'weekly') return Object.freeze({ kind: 'weekly', weekdays: Object.freeze([...recurrence.weekdays]) })
  return Object.freeze({ ...recurrence })
}

/**
 * Human-readable recurrence phrase for notices ("on workdays", "every 3
 * days"). Absent and `daily` both read as "every day", matching the stored
 * absent-means-daily rule.
 */
export function describeRecurrence(recurrence: AgentTeamScheduleRecurrence | undefined): string {
  if (recurrence === undefined) return 'every day'
  switch (recurrence.kind) {
    case 'daily':
      return 'every day'
    case 'workdays':
      return 'on workdays'
    case 'everyDays':
      return `every ${recurrence.intervalDays} ${recurrence.intervalDays === 1 ? 'day' : 'days'} from ${recurrence.anchorDate}`
    case 'weekly':
      return `on ${recurrence.weekdays.map(day => WEEKDAY_NAMES[day - 1]).join(', ')}`
    case 'monthly':
      return `on day ${recurrence.dayOfMonth} of every month`
    case 'yearly':
      return `every year on ${String(recurrence.month).padStart(2, '0')}-${String(recurrence.day).padStart(2, '0')}`
    default:
      return 'every day'
  }
}
