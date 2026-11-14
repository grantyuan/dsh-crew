/**
 * The one recurrence authority for Member schedule windows: calendar-day
 * matching for the six recurrence kinds, expansion of a matched day's window
 * into its concrete Team-zone interval, the candidate-day spread the two
 * schedule monitors expand, and the commit shape rule the ledger enforces.
 * Both the model schedule (`src/model-schedule.ts`) and the stop schedule
 * (`src/stop-schedule.ts`) consume this module and must not re-derive any of
 * its arithmetic.
 *
 * Every date is interpreted in the fixed Team coordination zone (UTC+8) —
 * the same zone the `HH:MM` window bounds live in — so there is no
 * daylight-saving component anywhere: a Team-zone calendar day is exactly
 * 24 hours, and the day/serial conversions below are pure proleptic-Gregorian
 * integer arithmetic (no `Date` object, whose UTC year mapping would bend for
 * years 0–99).
 *
 * A window expands only on days its recurrence matches; the interval is
 * anchored to the window's start day, so a cross-midnight window that begins
 * on a matched day runs to the NEXT day's `end` (workdays 22:00–08:00 covers
 * Saturday morning from Friday night). An `everyDays` recurrence counts day
 * serials from its anchor date: the anchor day itself is effective, then
 * every `intervalDays`-th day, never anything before the anchor.
 * @module @grantyuan/dsh-crew/schedule-recurrence
 */

import type { AgentTeamScheduleRecurrence } from './types.ts'
import { TEAM_ZONE_OFFSET_MINUTES } from './time-format.ts'

/** Minutes in one day — the wrap-around modulus of every Team-zone minute computation. */
export const MINUTES_PER_DAY = 24 * 60
export const TEAM_ZONE_OFFSET_MS = TEAM_ZONE_OFFSET_MINUTES * 60_000
export const MS_PER_MINUTE = 60_000

/** Parse one `HH:MM` schedule bound into Team-zone day minutes (0..1439). */
export function parseScheduleMinute(text: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match === null) throw new Error(`invalid model schedule time '${text}'`)
  return Number(match[1]) * 60 + Number(match[2])
}

/** One Team-zone calendar day with its ISO weekday (1 = Monday … 7 = Sunday). */
export interface TeamDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7
}

/** The window shape both schedule families share: minute bounds plus the optional recurrence. */
export interface ScheduleWindowBounds {
  readonly start: string
  readonly end: string
  readonly recurrence?: AgentTeamScheduleRecurrence
}

/** One matched day's window resolved to concrete epoch instants (half-open). */
export interface ScheduleWindowOccurrence {
  /** The epoch instant the window's `start` minute lands on (inclusive). */
  readonly startMs: number
  /** The epoch instant the window's `end` minute lands on (exclusive; the next day for a wrap window). */
  readonly endMs: number
}

/** One epoch instant rendered as its Team-zone minute of the day (0..1439). */
export function teamMinuteOfDay(epochMs: number): number {
  return Math.floor(((epochMs + TEAM_ZONE_OFFSET_MS) % (MINUTES_PER_DAY * MS_PER_MINUTE)) / MS_PER_MINUTE)
}

/** One epoch instant rendered as its absolute Team-zone minute (monotonic latch key). */
export function teamAbsoluteMinute(epochMs: number): number {
  return Math.floor((epochMs + TEAM_ZONE_OFFSET_MS) / MS_PER_MINUTE)
}

/** The Team-zone day serial of one epoch instant (whole days since 1970-01-01). */
export function teamDayNumber(epochMs: number): number {
  return Math.floor((epochMs + TEAM_ZONE_OFFSET_MS) / (MINUTES_PER_DAY * MS_PER_MINUTE))
}

/** One epoch instant rendered as its Team-zone calendar day and ISO weekday. */
export function teamDateParts(epochMs: number): TeamDateParts {
  return datePartsOfDayNumber(teamDayNumber(epochMs))
}

/** The epoch instant one Team-zone day serial at one day minute sits on. */
function teamMinuteInstant(dayNumber: number, minuteOfDay: number): number {
  return dayNumber * MINUTES_PER_DAY * MS_PER_MINUTE - TEAM_ZONE_OFFSET_MS + minuteOfDay * MS_PER_MINUTE
}

// Proleptic-Gregorian day/serial conversion (Howard Hinnant's algorithms,
// truncating integer division) — exact for every four-digit year, which is
// what keeps `everyDays` anchors and leap rules honest without a Date object.

function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year
  const era = Math.trunc((shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400)
  const yearOfEra = shiftedYear - era * 400
  const dayOfYear = Math.trunc((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

function civilFromDays(dayNumber: number): { readonly year: number; readonly month: number; readonly day: number } {
  const shifted = dayNumber + 719468
  const era = Math.trunc((shifted >= 0 ? shifted : shifted - 146096) / 146097)
  const dayOfEra = shifted - era * 146097
  const yearOfEra = Math.trunc((dayOfEra - Math.trunc(dayOfEra / 1460) + Math.trunc(dayOfEra / 36524) - Math.trunc(dayOfEra / 146096)) / 365)
  const year = yearOfEra + era * 400
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.trunc(yearOfEra / 4) - Math.trunc(yearOfEra / 100))
  const monthPrefix = Math.trunc((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.trunc((153 * monthPrefix + 2) / 5) + 1
  const month = monthPrefix + (monthPrefix < 10 ? 3 : -9)
  return { year: year + (month <= 2 ? 1 : 0), month, day }
}

function datePartsOfDayNumber(dayNumber: number): TeamDateParts {
  const { year, month, day } = civilFromDays(dayNumber)
  // 1970-01-01 (serial 0) was a Thursday, ISO weekday 4.
  const weekday = (((dayNumber + 3) % 7 + 7) % 7 + 1) as TeamDateParts['weekday']
  return { year, month, day, weekday }
}

function dayNumberOf(day: TeamDateParts): number {
  return daysFromCivil(day.year, day.month, day.day)
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** Days in one month, February capped at 29 — the yearly-pattern rule. */
function monthLengthCapped(month: number): number {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number
}

/** Days in one month of one concrete year — the anchorDate rule. */
function monthLengthOfYear(year: number, month: number): number {
  return month === 2 && !isLeapYear(year) ? 28 : monthLengthCapped(month)
}

/**
 * Whether `text` is a real calendar date in `YYYY-MM-DD` shape — the
 * `everyDays` anchor rule (2026-02-29 is not a date; 2024-02-29 is).
 */
export function isValidCalendarDateText(text: string): boolean {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(text)
  if (match === null) return false
  const year = Number(text.slice(0, 4))
  const month = Number(text.slice(5, 7))
  const day = Number(text.slice(8, 10))
  if (month < 1 || month > 12) return false
  return Number.isInteger(day) && day >= 1 && day <= monthLengthOfYear(year, month)
}

/** Whether a yearly month/day pattern names a day some year can carry (February allows 29). */
export function isValidYearlyDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= monthLengthCapped(month)
}

function parseCalendarDateText(text: string): number | undefined {
  if (!isValidCalendarDateText(text)) return undefined
  return daysFromCivil(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)))
}

/**
 * Whether the window is effective on the given Team-zone day. An absent
 * recurrence matches every day, which is exactly the pre-recurrence behavior.
 */
export function recurrenceMatchesDay(recurrence: AgentTeamScheduleRecurrence | undefined, day: TeamDateParts): boolean {
  if (recurrence === undefined) return true
  switch (recurrence.kind) {
    case 'daily':
      return true
    case 'workdays':
      return day.weekday >= 1 && day.weekday <= 5
    case 'everyDays': {
      const anchor = parseCalendarDateText(recurrence.anchorDate)
      if (anchor === undefined) return false
      const daysSinceAnchor = dayNumberOf(day) - anchor
      return daysSinceAnchor >= 0 && daysSinceAnchor % recurrence.intervalDays === 0
    }
    case 'weekly':
      return recurrence.weekdays.includes(day.weekday)
    case 'monthly':
      return day.day === recurrence.dayOfMonth
    case 'yearly':
      return day.month === recurrence.month && day.day === recurrence.day
  }
  // Runtime data outside the declared kind union (never produced by the
  // commit rule or the replay schema) matches nothing.
  return false
}

/**
 * Expand the window on one Team-zone day into its concrete half-open
 * interval — empty when the day does not match the window's recurrence, and
 * empty for the degenerate `start === end` window (rejected at commit, never
 * covering by the bounds rule).
 */
export function windowOccurrencesOn(window: ScheduleWindowBounds, day: TeamDateParts): readonly ScheduleWindowOccurrence[] {
  if (!recurrenceMatchesDay(window.recurrence, day)) return []
  const startMinute = parseScheduleMinute(window.start)
  const endMinute = parseScheduleMinute(window.end)
  if (startMinute === endMinute) return []
  const dayNumber = dayNumberOf(day)
  return [{
    startMs: teamMinuteInstant(dayNumber, startMinute),
    // A wrap window (end ≤ start) anchors to its start day and ends on the next day.
    endMs: teamMinuteInstant(endMinute > startMinute ? dayNumber : dayNumber + 1, endMinute),
  }]
}

/**
 * The candidate START days one monitor pass expands its windows on, as day
 * offsets from the pass instant's Team-zone day: two days back still reach a
 * wrap window whose end fell late the night before (inside the stop
 * schedule's resume freshness), and one day ahead reaches the post-midnight
 * start or end of a late-evening window inside a notice horizon. Four days
 * times the six-window cap times two edges bounds one pass's date work.
 */
const OCCURRENCE_CANDIDATE_DAY_OFFSETS = [-2, -1, 0, 1] as const

/** Every occurrence of the window that a pass at `epochMs` can still see: start days N-2 … N+1. */
export function windowOccurrencesAround(window: ScheduleWindowBounds, epochMs: number): readonly ScheduleWindowOccurrence[] {
  const today = teamDayNumber(epochMs)
  const occurrences: ScheduleWindowOccurrence[] = []
  for (const offset of OCCURRENCE_CANDIDATE_DAY_OFFSETS) {
    occurrences.push(...windowOccurrencesOn(window, datePartsOfDayNumber(today + offset)))
  }
  return occurrences
}

/** Whether the window itself covers the instant — any candidate-day occurrence contains it. */
export function windowCoversAt(window: ScheduleWindowBounds, epochMs: number): boolean {
  return windowOccurrencesAround(window, epochMs).some(occurrence => epochMs >= occurrence.startMs && epochMs < occurrence.endMs)
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/**
 * The recurrence phrase the notice texts carry, e.g. `on workdays` or
 * `every 3 days`. A plain daily window phrases as nothing, so notices for
 * pre-recurrence schedules render byte-identically to before.
 */
export function describeRecurrence(recurrence: AgentTeamScheduleRecurrence | undefined): string {
  if (recurrence === undefined) return ''
  switch (recurrence.kind) {
    case 'daily':
      return ''
    case 'workdays':
      return 'on workdays'
    case 'everyDays':
      return recurrence.intervalDays === 1 ? 'every day' : `every ${recurrence.intervalDays} days`
    case 'weekly': {
      const days = [...recurrence.weekdays].sort((a, b) => a - b).map(weekday => WEEKDAY_NAMES[weekday - 1])
      return `on ${days.slice(0, -1).join(', ')}${days.length > 1 ? ' and ' : ''}${days.at(-1)}`
    }
    case 'monthly':
      return `on day ${recurrence.dayOfMonth} of each month`
    case 'yearly': {
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `each year on ${pad(recurrence.month)}-${pad(recurrence.day)}`
    }
  }
  // Runtime data outside the declared kind union (never produced by the
  // commit rule or the replay schema) phrases as nothing.
  return ''
}

/**
 * The recurrence shape rule both schedule commit paths enforce. Pure shape:
 * parameters must be integers in their declared ranges and dates must be
 * real calendar shapes (the yearly February cap allows 29; a concrete anchor
 * date must exist in its own year). What a shape MEANS on a non-leap-year
 * February 29th — silence, no window — is intent, never an error. The family
 * prefixes the rejection (`member model schedule recurrence …`) so a Human
 * editing both schedules in one request can tell the two apart, like the
 * window bounds errors do.
 */
export function assertScheduleRecurrence(recurrence: AgentTeamScheduleRecurrence | undefined, family: 'model schedule' | 'stop schedule'): void {
  if (recurrence === undefined) return
  const label = `member ${family} recurrence`
  switch (recurrence.kind) {
    case 'daily':
    case 'workdays':
      return
    case 'everyDays':
      if (!Number.isInteger(recurrence.intervalDays) || recurrence.intervalDays < 1 || recurrence.intervalDays > 366) {
        throw new Error(`${label} intervalDays must be an integer from 1 to 366, an interval spanning at most one leap year`)
      }
      if (!isValidCalendarDateText(recurrence.anchorDate)) {
        throw new Error(`${label} anchorDate must be a YYYY-MM-DD calendar date`)
      }
      return
    case 'weekly':
      if (recurrence.weekdays.length === 0) throw new Error(`${label} weekdays must list at least one weekday`)
      if (recurrence.weekdays.some(weekday => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
        throw new Error(`${label} weekdays must be ISO weekdays 1 (Monday) through 7 (Sunday)`)
      }
      if (new Set(recurrence.weekdays).size !== recurrence.weekdays.length) {
        throw new Error(`${label} weekdays must not repeat a weekday`)
      }
      return
    case 'monthly':
      if (!Number.isInteger(recurrence.dayOfMonth) || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
        throw new Error(`${label} dayOfMonth must be an integer from 1 to 31`)
      }
      return
    case 'yearly':
      if (!Number.isInteger(recurrence.month) || recurrence.month < 1 || recurrence.month > 12) {
        throw new Error(`${label} yearly month must be an integer from 1 to 12`)
      }
      if (!isValidYearlyDay(recurrence.month, recurrence.day)) {
        throw new Error(`${label} yearly day must exist in the month (February allows 29)`)
      }
      return
  }
  throw new Error(`${label} kind must be one of daily, workdays, everyDays, weekly, monthly, yearly`)
}
