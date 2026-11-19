// ScheduleRecurrenceField: the one per-window recurrence editor both schedule
// fields share (the Human's only recurrence surface — the model tools cannot
// write one). The draft helpers and the kind parameter validation live here
// too, so `ModelScheduleField` and `StopScheduleField` never grow their own.

import { useState } from 'react'
import type { AgentTeamScheduleRecurrence } from '@grantyuan/dsh-crew/types'
import { IconChevronDownOutlineRegular, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import createCss from './create.module.css'
import type { TeamKey } from './locales.ts'
import type { TeamSidebarProps } from './slots.ts'

/** ISO weekday a weekly recurrence lists (1 = Monday … 7 = Sunday). */
export type RecurrenceWeekday = Extract<AgentTeamScheduleRecurrence, { kind: 'weekly' }>['weekdays'][number]

const RECURRENCE_KINDS = ['daily', 'workdays', 'everyDays', 'weekly', 'monthly', 'yearly'] as const

export type RecurrenceKind = typeof RECURRENCE_KINDS[number]

/**
 * One window recurrence under edit: the picked kind plus the lenient text the
 * Human typed into that kind's parameter inputs (numbers and dates stay text
 * until the normalize step, like the `9:00` time bounds do). `daily` is the
 * untouched default every row opens with — on the wire it sends no field at
 * all, because absent means every day on the Host and a stored schedule must
 * not grow a field it did not carry.
 */
export type RecurrenceDraft =
  | { readonly kind: 'daily' }
  | { readonly kind: 'workdays' }
  | { readonly kind: 'everyDays'; readonly intervalDays: string; readonly anchorDate: string }
  | { readonly kind: 'weekly'; readonly weekdays: readonly RecurrenceWeekday[] }
  | { readonly kind: 'monthly'; readonly dayOfMonth: string }
  | { readonly kind: 'yearly'; readonly month: string; readonly day: string }

const KIND_LABEL_KEYS: Record<RecurrenceKind, TeamKey> = {
  daily: 'recurrenceDaily',
  workdays: 'recurrenceWorkdays',
  everyDays: 'recurrenceEveryDays',
  weekly: 'recurrenceWeekly',
  monthly: 'recurrenceMonthly',
  yearly: 'recurrenceYearly',
}

const WEEKDAYS: readonly RecurrenceWeekday[] = [1, 2, 3, 4, 5, 6, 7]

/** The month lengths the yearly-day rule caps February at (29 = leap-year intent). */
const MONTH_LENGTHS_CAPPED = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** The stored recurrence (or absent = every day) as an editable draft. */
export function recurrenceStoredDraft(stored: AgentTeamScheduleRecurrence | undefined): RecurrenceDraft {
  if (stored === undefined) return { kind: 'daily' }
  switch (stored.kind) {
    case 'daily':
      return { kind: 'daily' }
    case 'workdays':
      return { kind: 'workdays' }
    case 'everyDays':
      return { kind: 'everyDays', intervalDays: String(stored.intervalDays), anchorDate: stored.anchorDate }
    case 'weekly':
      return { kind: 'weekly', weekdays: [...new Set(stored.weekdays)].sort((a, b) => a - b) }
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: String(stored.dayOfMonth) }
    case 'yearly':
      return { kind: 'yearly', month: String(stored.month), day: String(stored.day) }
    // A future union kind must fail this client build here, not render garbage.
    default:
      return stored satisfies never
  }
}

/** The fresh draft one kind starts from; everyDays anchors on today so its first interval begins immediately. */
export function recurrenceKindDraft(kind: RecurrenceKind): RecurrenceDraft {
  switch (kind) {
    case 'daily':
    case 'workdays':
      return { kind }
    case 'everyDays':
      return { kind, intervalDays: '', anchorDate: teamTodayText() }
    case 'weekly':
      return { kind, weekdays: [] }
    case 'monthly':
      return { kind, dayOfMonth: '' }
    case 'yearly':
      return { kind, month: '', day: '' }
  }
}

/** Lenient `2026-1-5` pads to the stored `YYYY-MM-DD`, like the time bounds pad `9:00`. */
export function normalizeRecurrenceDateText(text: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim())
  return match === null ? text.trim() : `${match[1]!}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function monthLengthOfYear(year: number, month: number): number {
  if (month !== 2) return MONTH_LENGTHS_CAPPED[month - 1]!
  return isLeapYear(year) ? 29 : 28
}

/**
 * Whether `text` names a real calendar date — the anchor rule the Host commit
 * gate enforces. `packages/agent-team/src/schedule-recurrence.ts` is the
 * authority this mirrors; the mirror exists because the web bundle cannot
 * inline Host source. `2026-02-29` is not a date; `2024-02-29` is.
 */
export function isValidRecurrenceDateText(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const year = Number(match[1]!)
  const month = Number(match[2]!)
  const day = Number(match[3]!)
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= monthLengthOfYear(year, month)
}

/** The Team-zone (UTC+8) calendar day the editor runs on — the everyDays anchor default. */
export function teamTodayText(now: number = Date.now()): string {
  const shifted = new Date(now + 8 * 60 * 60_000)
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

/**
 * True while the draft's parameters are missing or outside the shape the Host
 * commit gate accepts: an integer interval 1..366 plus a real anchor date, at
 * least one weekday, a day 1..31, a real yearly month/day with February
 * capped at 29 — so 02-30 cannot commit while 02-29 stays as leap-year
 * intent. `daily` and `workdays` carry no parameters and are always complete.
 */
export function recurrenceDraftInvalid(draft: RecurrenceDraft): boolean {
  switch (draft.kind) {
    case 'daily':
    case 'workdays':
      return false
    case 'everyDays': {
      const interval = Number(draft.intervalDays.trim())
      if (!Number.isInteger(interval) || interval < 1 || interval > 366) return true
      return !isValidRecurrenceDateText(normalizeRecurrenceDateText(draft.anchorDate))
    }
    case 'weekly':
      return draft.weekdays.length === 0
    case 'monthly': {
      const day = Number(draft.dayOfMonth.trim())
      return !Number.isInteger(day) || day < 1 || day > 31
    }
    case 'yearly': {
      const month = Number(draft.month.trim())
      if (!Number.isInteger(month) || month < 1 || month > 12) return true
      const day = Number(draft.day.trim())
      return !Number.isInteger(day) || day < 1 || day > MONTH_LENGTHS_CAPPED[month - 1]!
    }
  }
}

/**
 * The committed recurrence shape: `daily` sends no field at all (absent means
 * every day on the Host, so an untouched stored schedule stays byte-identical
 * under the dialog's JSON compare), weekdays ride sorted and deduplicated,
 * and the lenient anchor text pads to strict `YYYY-MM-DD`. Callers only reach
 * it with complete drafts — the editor blocks incomplete ones and drops their
 * rows — so the numbers here are already the integers the Host measures.
 */
export function normalizeRecurrenceDraft(draft: RecurrenceDraft): AgentTeamScheduleRecurrence | undefined {
  switch (draft.kind) {
    case 'daily':
      return undefined
    case 'workdays':
      return { kind: 'workdays' }
    case 'everyDays':
      return { kind: 'everyDays', intervalDays: Number(draft.intervalDays.trim()), anchorDate: normalizeRecurrenceDateText(draft.anchorDate) }
    case 'weekly':
      return { kind: 'weekly', weekdays: [...new Set(draft.weekdays)].sort((a, b) => a - b) }
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: Number(draft.dayOfMonth.trim()) }
    case 'yearly':
      return { kind: 'yearly', month: Number(draft.month.trim()), day: Number(draft.day.trim()) }
  }
}

/** True while any window of one schedule family carries incomplete or invalid recurrence parameters. */
export function anyRecurrenceInvalid(windows: readonly { readonly recurrence: RecurrenceDraft }[]): boolean {
  return windows.some(w => recurrenceDraftInvalid(w.recurrence))
}

/**
 * The per-window recurrence editor both schedule fields share: the kind
 * dropdown (每天 / 工作日 / 每几天 / 每周 / 每月 / 每年) plus the parameters that
 * kind demands — interval and anchor date for 每几天 (the anchor defaults to
 * the Team-zone today when the kind is picked), seven weekday chips for 每周,
 * the day of month for 每月, month and day for 每年, nothing for 每天 and
 * 工作日. Every control's accessible name prefixes the row's window label, so
 * the six windows a schedule may carry never collide in the accessibility
 * tree.
 */
export function RecurrenceField({ draft, onChange, windowLabel, disabled, t }: {
  readonly draft: RecurrenceDraft
  readonly onChange: (next: RecurrenceDraft) => void
  /** The row's window label ("时间窗 #1") — every control's accessible name prefixes it. */
  readonly windowLabel: string
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [open, setKindOpen] = useState(false)
  const items: MenuEntry[] = RECURRENCE_KINDS.map(kind => ({ id: kind, label: t(KIND_LABEL_KEYS[kind]) }))
  // Both shipped dictionaries carry exactly seven names, one per ISO weekday;
  // the chip shows the compact one and the accessible name the full one.
  const chips = t('recurrenceWeekdayChips').split(',')
  const names = t('recurrenceWeekdayNames').split(',')
  return <div className={createCss.scheduleRecurrence} role="group" aria-label={`${windowLabel} ${t('recurrenceLabel')}`}>
    <Menu
      open={open}
      portal
      className={createCss.menuCap!}
      items={items}
      selectedId={draft.kind}
      onSelect={key => {
        setKindOpen(false)
        if ((RECURRENCE_KINDS as readonly string[]).includes(key)) onChange(recurrenceKindDraft(key as RecurrenceKind))
      }}
      onClose={() => { setKindOpen(false) }}
      anchor={
        <button
          type="button"
          className={`${createCss.selectTrigger!} ${createCss.recurrenceTrigger!}`}
          aria-label={`${windowLabel} ${t('recurrenceLabel')}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setKindOpen(value => !value) }}
        >
          <span className={createCss.selectValue}>{t(KIND_LABEL_KEYS[draft.kind])}</span>
          <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
        </button>
      }
    />
    {draft.kind === 'everyDays' && <>
      <label className={createCss.scheduleTime}>
        <span>{t('recurrenceEveryDaysInterval')}</span>
        <Input
          className={createCss.scheduleInput!}
          value={draft.intervalDays}
          placeholder="1"
          inputMode="numeric"
          maxLength={3}
          aria-label={`${windowLabel} ${t('recurrenceEveryDaysInterval')}`}
          onChange={event => onChange({ ...draft, intervalDays: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label className={createCss.scheduleTime}>
        <span>{t('recurrenceEveryDaysAnchor')}</span>
        <Input
          className={createCss.scheduleInput!}
          value={draft.anchorDate}
          placeholder="2026-01-01"
          inputMode="numeric"
          maxLength={10}
          aria-label={`${windowLabel} ${t('recurrenceEveryDaysAnchor')}`}
          onChange={event => onChange({ ...draft, anchorDate: event.target.value })}
          disabled={disabled}
        />
      </label>
    </>}
    {draft.kind === 'weekly' && <div className={createCss.recurrenceWeekdays} role="group" aria-label={`${windowLabel} ${t('recurrenceWeekdaysLabel')}`}>
      {WEEKDAYS.map((weekday, index) => {
        const pressed = draft.weekdays.includes(weekday)
        return <button
          key={weekday}
          type="button"
          className={`${createCss.recurrenceChip!} ${pressed ? createCss.recurrenceChipOn! : ''}`.trim()}
          aria-pressed={pressed}
          aria-label={`${windowLabel} ${names[index] ?? String(weekday)}`}
          disabled={disabled}
          onClick={() => {
            const next = pressed
              ? draft.weekdays.filter(entry => entry !== weekday)
              : [...draft.weekdays, weekday]
            onChange({ ...draft, weekdays: next })
          }}
        >{chips[index] ?? String(weekday)}</button>
      })}
    </div>}
    {draft.kind === 'monthly' && <label className={createCss.scheduleTime}>
      <span>{t('recurrenceMonthlyDay')}</span>
      <Input
        className={createCss.scheduleInput!}
        value={draft.dayOfMonth}
        placeholder="1"
        inputMode="numeric"
        maxLength={2}
        aria-label={`${windowLabel} ${t('recurrenceMonthlyDay')}`}
        onChange={event => onChange({ ...draft, dayOfMonth: event.target.value })}
        disabled={disabled}
      />
    </label>}
    {draft.kind === 'yearly' && <>
      <label className={createCss.scheduleTime}>
        <span>{t('recurrenceYearlyMonth')}</span>
        <Input
          className={createCss.scheduleInput!}
          value={draft.month}
          placeholder="1"
          inputMode="numeric"
          maxLength={2}
          aria-label={`${windowLabel} ${t('recurrenceYearlyMonth')}`}
          onChange={event => onChange({ ...draft, month: event.target.value })}
          disabled={disabled}
        />
      </label>
      <label className={createCss.scheduleTime}>
        <span>{t('recurrenceYearlyDay')}</span>
        <Input
          className={createCss.scheduleInput!}
          value={draft.day}
          placeholder="1"
          inputMode="numeric"
          maxLength={2}
          aria-label={`${windowLabel} ${t('recurrenceYearlyDay')}`}
          onChange={event => onChange({ ...draft, day: event.target.value })}
          disabled={disabled}
        />
      </label>
    </>}
  </div>
}
