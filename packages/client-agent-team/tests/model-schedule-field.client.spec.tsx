// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamModelSelection, AgentTeamScheduleRecurrence } from '@grantyuan/dsh-crew/types'
import {
  ModelScheduleField,
  normalizeScheduleDraft,
  scheduleDraftInvalid,
  scheduleStoredDraft,
  type ModelScheduleDraft,
} from '../src/client/TeamMemberEditor.tsx'
import {
  normalizeRecurrenceDateText,
  normalizeRecurrenceDraft,
  recurrenceDraftInvalid,
  recurrenceStoredDraft,
  teamTodayText,
} from '../src/client/schedule-recurrence-field.tsx'
import { zh } from '../src/client/locales.ts'
import type { TeamModelCatalog } from '../src/client/slots.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof ModelScheduleField>[0]['t']

const CATALOG: TeamModelCatalog = {
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] },
    { id: 'qwen-official', name: 'Qwen', models: [{ id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' }] },
  ],
  failures: [],
}
const catalogOk = (): Promise<RemoteResult<TeamModelCatalog>> => Promise.resolve({ ok: true, value: CATALOG } as RemoteResult<TeamModelCatalog>)

const deepseek = { provider: 'deepseek-official', model: 'deepseek-flash' }
const qwen = { provider: 'qwen-official', model: 'qwen3.8-flash' }

describe('model schedule draft normalization', () => {
  it('round-trips a stored schedule and treats absent as an empty draft', () => {
    expect(scheduleStoredDraft(undefined)).toEqual({ enabled: false, windows: [] })
    const stored = { enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }
    expect(normalizeScheduleDraft(scheduleStoredDraft(stored))).toEqual(stored)
  })

  it('round-trips a stored recurrence-bearing schedule byte-identically, absent recurrence included', () => {
    // A stored schedule written before recurrences existed carries no recurrence
    // field; saving it untouched must not grow one (the JSON compare would else
    // flag a no-op edit as dirty), and every stored kind survives the draft
    // round trip without changing shape.
    const stored = { enabled: true, windows: [
      { start: '09:00', end: '18:00', selection: deepseek },
      { start: '10:00', end: '12:00', selection: qwen, recurrence: { kind: 'workdays' } as const },
      { start: '20:00', end: '22:00', selection: deepseek, recurrence: { kind: 'everyDays', intervalDays: 3, anchorDate: '2026-01-05' } as const },
      { start: '13:00', end: '14:00', selection: qwen, recurrence: { kind: 'weekly', weekdays: [6, 7] } as const },
      { start: '08:00', end: '09:00', selection: deepseek, recurrence: { kind: 'monthly', dayOfMonth: 31 } as const },
      { start: '00:00', end: '01:00', selection: qwen, recurrence: { kind: 'yearly', month: 2, day: 14 } as const },
    ] }
    expect(normalizeScheduleDraft(scheduleStoredDraft(stored))).toEqual(stored)
  })

  it('drops windows whose recurrence parameters are incomplete or invalid', () => {
    // The editor blocks submission while a parameter is missing, so the
    // normalization only ever guards a stale draft: an invalid recurrence makes
    // the whole window drop, exactly like an incomplete time bound does.
    const draft = scheduleStoredDraft({ enabled: true, windows: [
      { start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'weekly', weekdays: [] } },
      { start: '10:00', end: '12:00', selection: qwen, recurrence: { kind: 'everyDays', intervalDays: 400, anchorDate: '2026-01-05' } },
    ] })
    expect(normalizeScheduleDraft(draft)).toEqual({ enabled: true, windows: [] })
  })

  it('pads lenient time inputs to the stored HH:MM and drops blank and incomplete windows', () => {
    const draft: ModelScheduleDraft = {
      enabled: true,
      windows: [
        { start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } },
        { start: '', end: '', selection: undefined, recurrence: { kind: 'daily' } },
        { start: '18:00', end: '23:00', selection: undefined, recurrence: { kind: 'daily' } },
        { start: '9:00', end: '18:00', selection: qwen, recurrence: { kind: 'daily' } },
        { start: '9:5', end: '18:00', selection: qwen, recurrence: { kind: 'daily' } },
        { start: '24:00', end: '18:00', selection: qwen, recurrence: { kind: 'daily' } },
      ],
    }
    // `9:00` is what a Human naturally types; the ledger stores strict HH:MM,
    // so the editor pads it instead of refusing it. Malformed bounds (`9:5`,
    // `24:00`) still drop.
    expect(normalizeScheduleDraft(draft)).toEqual({ enabled: true, windows: [
      { start: '09:00', end: '18:00', selection: deepseek },
      { start: '09:00', end: '18:00', selection: qwen },
    ] })
  })

  it('flags incomplete windows, equal bounds, and an enabled schedule that demands nothing', () => {
    expect(scheduleDraftInvalid({ enabled: false, windows: [] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: true, windows: [] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '09:00', selection: deepseek, recurrence: { kind: 'daily' } }] })).toBe(true)
    // Equal bounds compare padded: `9:00` and `09:00` are the same instant.
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '9:00', end: '09:00', selection: deepseek, recurrence: { kind: 'daily' } }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '9:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '18:00', selection: undefined, recurrence: { kind: 'daily' } }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '', end: '', selection: undefined, recurrence: { kind: 'daily' } }] })).toBe(true)
  })

  it('flags a touched window whose recurrence parameters are missing or invalid', () => {
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'weekly', weekdays: [] } }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'everyDays', intervalDays: '', anchorDate: teamTodayText() } }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'weekly', weekdays: [3] } }] })).toBe(false)
  })
})

describe('recurrence draft normalization', () => {
  it('round-trips every stored recurrence kind and reads an absent recurrence as daily', () => {
    expect(recurrenceStoredDraft(undefined)).toEqual({ kind: 'daily' })
    const stored: readonly AgentTeamScheduleRecurrence[] = [
      { kind: 'workdays' },
      { kind: 'everyDays', intervalDays: 3, anchorDate: '2026-01-05' },
      { kind: 'weekly', weekdays: [6, 7] },
      { kind: 'monthly', dayOfMonth: 31 },
      { kind: 'yearly', month: 2, day: 14 },
    ]
    for (const recurrence of stored) expect(normalizeRecurrenceDraft(recurrenceStoredDraft(recurrence))).toEqual(recurrence)
    // An explicit stored `daily` re-saves as the equivalent absent field: both
    // mean every day on the Host, and absent is the shape this editor writes.
    expect(recurrenceStoredDraft({ kind: 'daily' })).toEqual({ kind: 'daily' })
    expect(normalizeRecurrenceDraft(recurrenceStoredDraft({ kind: 'daily' }))).toBeUndefined()
  })

  it('emits no recurrence field for a daily window, so a stored absent field never grows one', () => {
    // Absent and `daily` mean the same every-day effect on the Host; the
    // editor sends absent so an untouched stored schedule stays byte-identical
    // under the dialog's JSON compare.
    expect(normalizeRecurrenceDraft({ kind: 'daily' })).toBeUndefined()
    expect(normalizeRecurrenceDraft({ kind: 'workdays' })).toEqual({ kind: 'workdays' })
  })

  it('sorts and dedupes weekly weekdays into the shape the Host commit gate accepts', () => {
    expect(normalizeRecurrenceDraft({ kind: 'weekly', weekdays: [5, 1, 5, 7] })).toEqual({ kind: 'weekly', weekdays: [1, 5, 7] })
  })

  it('pads lenient anchor dates to the stored YYYY-MM-DD shape', () => {
    // `2026-1-5` is what a Human naturally types; the Host anchor rule measures
    // strict YYYY-MM-DD, so the editor pads the lenient shape first.
    expect(normalizeRecurrenceDateText('2026-1-5')).toBe('2026-01-05')
    expect(normalizeRecurrenceDateText(' 2026-01-05 ')).toBe('2026-01-05')
    expect(normalizeRecurrenceDateText('2026-01')).toBe('2026-01')
    expect(normalizeRecurrenceDateText('')).toBe('')
  })

  it('blocks the missing and out-of-range parameters of every kind', () => {
    const today = teamTodayText()
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(recurrenceDraftInvalid({ kind: 'daily' })).toBe(false)
    expect(recurrenceDraftInvalid({ kind: 'workdays' })).toBe(false)
    // everyDays: an integer interval 1..366 plus a real anchor calendar date.
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '', anchorDate: today })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '0', anchorDate: today })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '367', anchorDate: today })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '2.5', anchorDate: today })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '3', anchorDate: '' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '3', anchorDate: '2026-1-5' })).toBe(false)
    // weekly: at least one weekday.
    expect(recurrenceDraftInvalid({ kind: 'weekly', weekdays: [] })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'weekly', weekdays: [1] })).toBe(false)
    // monthly: day 1..31 — 31 in a short month stays legal intent (silence, not an error).
    expect(recurrenceDraftInvalid({ kind: 'monthly', dayOfMonth: '' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'monthly', dayOfMonth: '0' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'monthly', dayOfMonth: '32' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'monthly', dayOfMonth: '31' })).toBe(false)
    // yearly: a real month/day pattern; February caps at 29, so 02-30 cannot
    // commit while 02-29 (leap-only silence) can.
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '', day: '1' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '13', day: '1' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '2', day: '' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '2', day: '30' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '2', day: '29' })).toBe(false)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '4', day: '31' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'yearly', month: '4', day: '30' })).toBe(false)
    // everyDays anchor: a concrete date must exist in its own year.
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '3', anchorDate: '2026-02-29' })).toBe(true)
    expect(recurrenceDraftInvalid({ kind: 'everyDays', intervalDays: '3', anchorDate: '2024-02-29' })).toBe(false)
  })
})

function renderField(draft: ModelScheduleDraft, onChange = vi.fn(), applied = undefined as AgentTeamModelSelection | undefined) {
  return render(
    <ModelScheduleField draft={draft} onChange={onChange} applied={applied} loadModels={catalogOk} disabled={false} t={t} />,
  )
}

describe('ModelScheduleField surface', () => {
  it('renders the title, the hint, the enable switch, and the add action for an untouched Member', () => {
    renderField({ enabled: false, windows: [] })
    expect(screen.getByText('按时间切换模型')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '启用时间日程' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加时间窗' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the schedule-applied route when the Host currently overrides the pin', () => {
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }, vi.fn(), { provider: 'qwen-official', model: 'qwen3.8-flash' })
    expect(screen.getByText('当前按日程运行:qwen-official/qwen3.8-flash')).toBeTruthy()
  })

  it('adds a row with labelled start/end inputs and appends it on change', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '添加时间窗' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [
        { start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } },
        // A fresh row reads as 每天 (absent on the wire), so the drawn row commits
        // exactly like a pre-recurrence one until the Human picks another kind.
        { start: '', end: '', selection: undefined, recurrence: { kind: 'daily' } },
      ],
    })
  })

  it('removes the touched window through its labelled action', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }, { start: '18:00', end: '23:00', selection: qwen, recurrence: { kind: 'daily' } }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '移除时间窗 #2' }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] })
  })

  it('surfaces the rule alert while the draft is invalid and hides it once complete', () => {
    // The lenient `9:00` input pads to a valid bound now, so the invalid
    // draft here is the missing model — the rule the picker cannot satisfy
    // on its own.
    const { rerender } = renderField({ enabled: true, windows: [{ start: '9:00', end: '18:00', selection: undefined, recurrence: { kind: 'daily' } }] })
    expect(screen.getByRole('alert').textContent).toContain('每个时间窗需要 HH:MM')
    rerender(
      <ModelScheduleField draft={{ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }} onChange={vi.fn()} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads the untouched window picker as the missing choice, never as a follow-default option', () => {
    // The ledger refuses a follow-default window, so the idle trigger must not
    // borrow the primary picker's legitimate "跟随全局默认" — it names the
    // pick the row still owes, and only a chosen model satisfies the rule.
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: undefined, recurrence: { kind: 'daily' } }] })
    const trigger = screen.getByRole('button', { name: '时间窗 #1' })
    expect(trigger.textContent).toContain('选择模型…')
    expect(trigger.textContent).not.toContain('跟随全局默认')
  })
})

/** Controlled field harness: the dialog owns the draft state, so interactions re-render through the parent. */
function ControlledModelScheduleField({ initial }: { readonly initial: ModelScheduleDraft }) {
  const [draft, setDraft] = useState(initial)
  return <ModelScheduleField draft={draft} onChange={setDraft} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />
}

describe('ModelScheduleField recurrence control', () => {
  it('reads a stored window without a recurrence field as 每天', () => {
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] })
    expect(screen.getByRole('button', { name: '时间窗 #1 周期' }).textContent).toContain('每天')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('picks 每周 from the dropdown and toggles the weekday chips', async () => {
    render(<ControlledModelScheduleField initial={{ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '时间窗 #1 周期' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '每周' }))
    // Seven chips, one per ISO weekday; none pressed on a fresh weekly pick.
    for (const name of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
      expect(screen.getByRole('button', { name: `时间窗 #1 ${name}` }).getAttribute('aria-pressed')).toBe('false')
    }
    fireEvent.click(screen.getByRole('button', { name: '时间窗 #1 周六' }))
    fireEvent.click(screen.getByRole('button', { name: '时间窗 #1 周日' }))
    expect(screen.getByRole('button', { name: '时间窗 #1 周六' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('defaults the everyDays anchor to the Team-zone today when the kind is picked', async () => {
    render(<ControlledModelScheduleField initial={{ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '时间窗 #1 周期' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '每几天' }))
    expect((screen.getByLabelText('时间窗 #1 起始日') as HTMLInputElement).value).toBe(teamTodayText())
    // The interval stays empty until the Human fills it, and the recurrence
    // alert names the parameter rule while it is missing.
    expect((screen.getByLabelText('时间窗 #1 间隔天数') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('周期参数'))).toBe(true)
    fireEvent.change(screen.getByLabelText('时间窗 #1 间隔天数'), { target: { value: '3' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('blocks an invalid yearly calendar day (2 月 30 日) and accepts 2 月 29 日', async () => {
    render(<ControlledModelScheduleField initial={{ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'daily' } }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '时间窗 #1 周期' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '每年' }))
    fireEvent.change(screen.getByLabelText('时间窗 #1 每年月'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('时间窗 #1 每年日'), { target: { value: '30' } })
    expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('周期参数'))).toBe(true)
    fireEvent.change(screen.getByLabelText('时间窗 #1 每年日'), { target: { value: '29' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('parseCapabilityScore', () => {
  it('maps the empty text to a clear, keeps the stored rating on the same number, and rejects out-of-range input', async () => {
    const { parseCapabilityScore } = await import('../src/client/TeamMemberEditor.tsx')
    expect(parseCapabilityScore('', 8)).toBe(null)
    expect(parseCapabilityScore('', undefined)).toBe(null)
    expect(parseCapabilityScore('8', 8)).toBe(undefined)
    expect(parseCapabilityScore(' 9 ', undefined)).toBe(9)
    expect(parseCapabilityScore('0', undefined)).toBe(Number.NaN)
    expect(parseCapabilityScore('11', undefined)).toBe(Number.NaN)
    expect(parseCapabilityScore('3.5', undefined)).toBe(Number.NaN)
    expect(parseCapabilityScore('abc', undefined)).toBe(Number.NaN)
  })
})
