// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamModelSelection } from '@grantyuan/dsh-crew/types'
import {
  ModelScheduleField,
  defaultScheduleRecurrenceDraft,
  normalizeScheduleDraft,
  scheduleDraftInvalid,
  scheduleStoredDraft,
  type ModelScheduleDraft,
  type ModelScheduleWindowDraft,
} from '../src/client/TeamMemberEditor.tsx'
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
const daily = defaultScheduleRecurrenceDraft(Date.UTC(2026, 10, 3, 12, 0, 0))
const win = (
  start: string,
  end: string,
  selection: ModelScheduleWindowDraft['selection'],
  recurrence = defaultScheduleRecurrenceDraft(),
): ModelScheduleWindowDraft => ({ start, end, selection, recurrence })

describe('model schedule draft normalization', () => {
  it('round-trips a stored schedule, treats absent as an empty draft, and shows a missing recurrence as daily', () => {
    expect(scheduleStoredDraft(undefined)).toEqual({ enabled: false, windows: [] })
    const stored = { enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }
    expect(scheduleStoredDraft(stored).windows[0]?.recurrence.kind).toBe('daily')
    // Daily normalizes back to the absent field, so an untouched schedule is
    // byte-identical after a save (no spurious dirty state).
    expect(normalizeScheduleDraft(scheduleStoredDraft(stored))).toEqual(stored)
  })

  it('round-trips a stored recurrence for every pattern', () => {
    const stored = {
      enabled: true,
      windows: [
        { start: '09:00', end: '18:00', selection: deepseek, recurrence: { kind: 'workdays' } },
        { start: '09:00', end: '18:00', selection: qwen, recurrence: { kind: 'everyDays', intervalDays: 3, anchorDate: '2026-11-03' } },
        { start: '10:00', end: '12:00', selection: qwen, recurrence: { kind: 'weekly', weekdays: [1, 3] } },
        { start: '10:00', end: '12:00', selection: qwen, recurrence: { kind: 'monthly', dayOfMonth: 15 } },
        { start: '10:00', end: '12:00', selection: qwen, recurrence: { kind: 'yearly', month: 2, day: 29 } },
      ],
    } as const
    expect(normalizeScheduleDraft(scheduleStoredDraft(stored))).toEqual(stored)
  })

  it('drops a window with an impossible recurrence and flags it as invalid', () => {
    const impossible = { ...daily, kind: 'yearly' as const, month: '2', day: '30' }
    const draft: ModelScheduleDraft = { enabled: true, windows: [win('09:00', '18:00', deepseek, impossible)] }
    expect(normalizeScheduleDraft(draft)).toEqual({ enabled: true, windows: [] })
    expect(scheduleDraftInvalid(draft)).toBe(true)
    const leap = { ...daily, kind: 'yearly' as const, month: '2', day: '29' }
    expect(scheduleDraftInvalid({ enabled: true, windows: [win('09:00', '18:00', deepseek, leap)] })).toBe(false)
  })

  it('pads lenient time inputs to the stored HH:MM and drops blank and incomplete windows', () => {
    const draft: ModelScheduleDraft = {
      enabled: true,
      windows: [
        win('09:00', '18:00', deepseek),
        win('', '', undefined),
        win('18:00', '23:00', undefined),
        win('9:00', '18:00', qwen),
        win('9:5', '18:00', qwen),
        win('24:00', '18:00', qwen),
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
    expect(scheduleDraftInvalid({ enabled: true, windows: [win('09:00', '18:00', deepseek)] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: false, windows: [win('09:00', '09:00', deepseek)] })).toBe(true)
    // Equal bounds compare padded: `9:00` and `09:00` are the same instant.
    expect(scheduleDraftInvalid({ enabled: false, windows: [win('9:00', '09:00', deepseek)] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: false, windows: [win('9:00', '18:00', deepseek)] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: false, windows: [win('09:00', '18:00', undefined)] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [win('', '', undefined)] })).toBe(true)
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
    renderField({ enabled: true, windows: [win('09:00', '18:00', deepseek)] }, vi.fn(), { provider: 'qwen-official', model: 'qwen3.8-flash' })
    expect(screen.getByText('当前按日程运行:qwen-official/qwen3.8-flash')).toBeTruthy()
  })

  it('adds a row with labelled start/end inputs and appends it on change', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [win('09:00', '18:00', deepseek)] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '添加时间窗' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [win('09:00', '18:00', deepseek), win('', '', undefined)],
    })
  })

  it('removes the touched window through its labelled action', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [win('09:00', '18:00', deepseek), win('18:00', '23:00', qwen)] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '移除时间窗 #2' }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, windows: [win('09:00', '18:00', deepseek)] })
  })

  it('surfaces the rule alert while the draft is invalid and hides it once complete', () => {
    // The lenient `9:00` input pads to a valid bound now, so the invalid
    // draft here is the missing model — the rule the picker cannot satisfy
    // on its own.
    const { rerender } = renderField({ enabled: true, windows: [win('9:00', '18:00', undefined)] })
    expect(screen.getByRole('alert').textContent).toContain('每个时间窗需要 HH:MM')
    rerender(
      <ModelScheduleField draft={{ enabled: true, windows: [win('09:00', '18:00', deepseek)] }} onChange={vi.fn()} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads the untouched window picker as the missing choice, never as a follow-default option', () => {
    // The ledger refuses a follow-default window, so the idle trigger must not
    // borrow the primary picker's legitimate "跟随全局默认" — it names the
    // pick the row still owes, and only a chosen model satisfies the rule.
    renderField({ enabled: true, windows: [win('09:00', '18:00', undefined)] })
    const trigger = screen.getByRole('button', { name: '时间窗 #1' })
    expect(trigger.textContent).toContain('选择模型…')
    expect(trigger.textContent).not.toContain('跟随全局默认')
  })

  it('shows a stored window without a recurrence as daily and switches pattern through the menu', () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [win('09:00', '18:00', deepseek)] }, onChange)
    const trigger = screen.getByRole('button', { name: '时间窗 #1 周期' })
    expect(trigger.textContent).toContain('每天')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('每周'))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [expect.objectContaining({ recurrence: expect.objectContaining({ kind: 'weekly', weekdays: [1] }) })],
    })
  })

  it('toggles weekday chips and surfaces an impossible yearly date', () => {
    const weekly = { ...daily, kind: 'weekly' as const, weekdays: [1] as const }
    const onChange = vi.fn()
    const { rerender } = render(<ModelScheduleField draft={{ enabled: true, windows: [win('09:00', '18:00', deepseek, weekly)] }} onChange={onChange} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />)
    expect(screen.getByRole('group', { name: '时间窗 #1 周期 星期' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '周一' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '周三' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [expect.objectContaining({ recurrence: expect.objectContaining({ weekdays: [1, 3] }) })],
    })
    const impossible = { ...daily, kind: 'yearly' as const, month: '2', day: '30' }
    rerender(<ModelScheduleField draft={{ enabled: true, windows: [win('09:00', '18:00', deepseek, impossible)] }} onChange={vi.fn()} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />)
    expect(screen.getByText('周期参数不完整或无效')).toBeTruthy()
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
