import { describe, expect, it } from 'vitest'
import {
  describeRecurrence,
  recurrenceMatchesDay,
  scheduleCandidateDays,
  teamDateParts,
  windowCoversInstant,
  windowOccurrenceOn,
  windowOccurrencesAround,
} from '../src/schedule-recurrence.ts'
import type { AgentTeamModelScheduleWindow } from '../src/types.ts'

// 2026-11-03 is a Tuesday; 2026-11-07 a Saturday, 2026-11-08 a Sunday.
const day = (isoDate: string) => teamDateParts(Date.parse(`${isoDate}T00:00:00+08:00`))
const win = (start: string, end: string, recurrence?: AgentTeamModelScheduleWindow['recurrence']) => ({
  start,
  end,
  ...(recurrence === undefined ? {} : { recurrence }),
})

describe('schedule recurrence day matching', () => {
  it('treats an absent recurrence as every day and skips weekends for workdays', () => {
    expect(recurrenceMatchesDay(undefined, day('2026-11-07'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'daily' }, day('2026-11-07'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'workdays' }, day('2026-11-03'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'workdays' }, day('2026-11-07'))).toBe(false)
    expect(recurrenceMatchesDay({ kind: 'workdays' }, day('2026-11-08'))).toBe(false)
  })

  it('aligns everyDays to its anchor: the anchor day and every interval after it, never before', () => {
    const everyThree = { kind: 'everyDays', intervalDays: 3, anchorDate: '2026-11-03' } as const
    expect(recurrenceMatchesDay(everyThree, day('2026-11-03'))).toBe(true)
    expect(recurrenceMatchesDay(everyThree, day('2026-11-04'))).toBe(false)
    expect(recurrenceMatchesDay(everyThree, day('2026-11-06'))).toBe(true)
    expect(recurrenceMatchesDay(everyThree, day('2026-11-02'))).toBe(false)
    // A bad anchor is never active rather than throwing on a live pass.
    expect(recurrenceMatchesDay({ kind: 'everyDays', intervalDays: 2, anchorDate: '2026-02-30' }, day('2026-11-03'))).toBe(false)
  })

  it('matches weekly days, monthly days, and yearly dates without shifting', () => {
    expect(recurrenceMatchesDay({ kind: 'weekly', weekdays: [1, 3] }, day('2026-11-04'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'weekly', weekdays: [1, 3] }, day('2026-11-03'))).toBe(false)
    expect(recurrenceMatchesDay({ kind: 'monthly', dayOfMonth: 31 }, day('2026-11-30'))).toBe(false)
    expect(recurrenceMatchesDay({ kind: 'monthly', dayOfMonth: 30 }, day('2026-11-30'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'yearly', month: 2, day: 29 }, day('2028-02-29'))).toBe(true)
    expect(recurrenceMatchesDay({ kind: 'yearly', month: 2, day: 29 }, day('2027-02-28'))).toBe(false)
  })

  it('reads the Team-zone weekday with Monday as 1', () => {
    expect(day('2026-11-02').weekday).toBe(1)
    expect(day('2026-11-03').weekday).toBe(2)
    expect(day('2026-11-08').weekday).toBe(7)
  })
})

describe('schedule window occurrence expansion', () => {
  it('expands a matching day into a half-open interval on that day', () => {
    const occurrence = windowOccurrenceOn(win('09:00', '18:00'), day('2026-11-03'))
    expect(occurrence?.startMs).toBe(Date.parse('2026-11-03T09:00:00+08:00'))
    expect(occurrence?.endMs).toBe(Date.parse('2026-11-03T18:00:00+08:00'))
  })

  it('ends a wrapping window on the following Team-zone day', () => {
    const occurrence = windowOccurrenceOn(win('22:00', '06:00'), day('2026-11-03'))
    expect(occurrence?.startMs).toBe(Date.parse('2026-11-03T22:00:00+08:00'))
    expect(occurrence?.endMs).toBe(Date.parse('2026-11-04T06:00:00+08:00'))
  })

  it('produces no occurrence on a non-matching day or for equal bounds', () => {
    expect(windowOccurrenceOn(win('09:00', '18:00', { kind: 'workdays' }), day('2026-11-07'))).toBeUndefined()
    expect(windowOccurrenceOn(win('09:00', '09:00'), day('2026-11-03'))).toBeUndefined()
  })

  it('opens no window on a short month 31st or a common-year 02-29', () => {
    const monthly = win('09:00', '18:00', { kind: 'monthly', dayOfMonth: 31 })
    expect(windowOccurrencesAround(monthly, Date.parse('2026-11-30T12:00:00+08:00'))).toHaveLength(0)
    expect(windowOccurrencesAround(monthly, Date.parse('2026-12-31T12:00:00+08:00'))).toHaveLength(1)

    const leap = win('09:00', '18:00', { kind: 'yearly', month: 2, day: 29 })
    expect(windowOccurrencesAround(leap, Date.parse('2027-02-28T12:00:00+08:00'))).toHaveLength(0)
    expect(windowOccurrencesAround(leap, Date.parse('2028-02-29T12:00:00+08:00'))).toHaveLength(1)
  })

  it('applies recurrence to the window start day, so a wrapping window needs a matching Friday', () => {
    const fridayNight = win('22:00', '06:00', { kind: 'workdays' })
    // Saturday 03:00 Team: the occurrence started on Friday, so it still covers.
    expect(windowCoversInstant(fridayNight, Date.parse('2026-11-07T03:00:00+08:00'))).toBe(true)
    // Sunday 03:00 Team: Saturday is not a workday — no occurrence at all.
    expect(windowCoversInstant(fridayNight, Date.parse('2026-11-08T03:00:00+08:00'))).toBe(false)
  })

  it('covers the candidate days from two days back through tomorrow', () => {
    const days = scheduleCandidateDays(Date.parse('2026-11-03T12:00:00+08:00'))
    expect(days.map(parts => parts.day)).toEqual([1, 2, 3, 4])
  })
})

describe('schedule recurrence notices', () => {
  it('describes each pattern for notices', () => {
    expect(describeRecurrence(undefined)).toBe('every day')
    expect(describeRecurrence({ kind: 'daily' })).toBe('every day')
    expect(describeRecurrence({ kind: 'workdays' })).toBe('on workdays')
    expect(describeRecurrence({ kind: 'everyDays', intervalDays: 3, anchorDate: '2026-11-03' })).toBe('every 3 days from 2026-11-03')
    expect(describeRecurrence({ kind: 'everyDays', intervalDays: 1, anchorDate: '2026-11-03' })).toBe('every 1 day from 2026-11-03')
    expect(describeRecurrence({ kind: 'weekly', weekdays: [1, 3] })).toBe('on Mon, Wed')
    expect(describeRecurrence({ kind: 'monthly', dayOfMonth: 15 })).toBe('on day 15 of every month')
    expect(describeRecurrence({ kind: 'yearly', month: 2, day: 29 })).toBe('every year on 02-29')
  })
})
