// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberPromptView, AgentTeamMemberResult, AgentTeamUpdateMemberRequest } from '@grantyuan/dsh-crew/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  AgentEditorDialog,
  StopScheduleField,
  normalizeStopScheduleDraft,
  stopScheduleDraftInvalid,
  stopScheduleStoredDraft,
  type StopScheduleDraft,
} from '../src/client/TeamMemberEditor.tsx'
import {
  normalizeRecurrenceDraft,
  recurrenceDraftInvalid,
  recurrenceStoredDraft,
  teamTodayText,
} from '../src/client/schedule-recurrence-field.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as never

const loadPromptView = vi.fn(async (): Promise<RemoteResult<AgentTeamMemberPromptView>> => {
  throw new Error('not used')
})

describe('stop schedule draft normalization', () => {
  it('round-trips a stored schedule and treats absent as an empty draft', () => {
    expect(stopScheduleStoredDraft(undefined)).toEqual({ enabled: false, windows: [] })
    const stored = { enabled: true, windows: [{ start: '22:00', end: '06:00' }] }
    expect(normalizeStopScheduleDraft(stopScheduleStoredDraft(stored))).toEqual(stored)
  })

  it('pads lenient time inputs to the stored HH:MM and drops blank and incomplete windows', () => {
    const draft: StopScheduleDraft = {
      enabled: true,
      windows: [
        { start: '22:00', end: '06:00', recurrence: { kind: 'daily' } },
        { start: '', end: '', recurrence: { kind: 'daily' } },
        { start: '12:00', end: '', recurrence: { kind: 'daily' } },
        // `9:00` is what a Human naturally types; the stored form is strict
        // HH:MM, so the editor pads it instead of refusing it.
        { start: '9:00', end: '18:00', recurrence: { kind: 'daily' } },
      ],
    }
    expect(normalizeStopScheduleDraft(draft)).toEqual({ enabled: true, windows: [{ start: '22:00', end: '06:00' }, { start: '09:00', end: '18:00' }] })
  })

  it('flags incomplete windows, equal bounds, and an enabled schedule that stops nothing', () => {
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [] })).toBe(false)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] })).toBe(false)
    // Equal bounds compare padded: `9:00` and `09:00` are the same instant.
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '9:00', end: '09:00', recurrence: { kind: 'daily' } }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '09:00', recurrence: { kind: 'daily' } }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '', recurrence: { kind: 'daily' } }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '', end: '', recurrence: { kind: 'daily' } }] })).toBe(true)
  })

  it('flags a touched window whose recurrence parameters are missing or invalid', () => {
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'weekly', weekdays: [] } }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'everyDays', intervalDays: '', anchorDate: teamTodayText() } }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'workdays' } }] })).toBe(false)
  })
})

describe('recurrence draft helpers shared by both schedule fields', () => {
  it('reads a stored stop window without a recurrence field as daily and re-saves it absent', () => {
    // The stored shape stays byte-identical: absent recurrence in, absent out —
    // the dialog's JSON compare must never flag a no-op stop-schedule edit.
    const stored = { enabled: true, windows: [{ start: '22:00', end: '06:00' }] }
    expect(normalizeStopScheduleDraft(stopScheduleStoredDraft(stored))).toEqual(stored)
    expect(recurrenceStoredDraft(undefined)).toEqual({ kind: 'daily' })
    expect(normalizeRecurrenceDraft({ kind: 'daily' })).toBeUndefined()
  })

  it('round-trips a stored weekly stop window through the draft', () => {
    const stored = { enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'weekly', weekdays: [1, 5] } as const }] }
    expect(normalizeStopScheduleDraft(stopScheduleStoredDraft(stored))).toEqual(stored)
    expect(recurrenceDraftInvalid({ kind: 'weekly', weekdays: [1, 5] })).toBe(false)
  })
})

function renderField(draft: StopScheduleDraft, onChange = vi.fn()) {
  return render(
    <StopScheduleField draft={draft} onChange={onChange} disabled={false} t={t} />,
  )
}

describe('StopScheduleField surface', () => {
  it('renders the title, the hint, the enable switch, and the add action for an untouched Member', () => {
    renderField({ enabled: false, windows: [] })
    expect(screen.getByText('停止运行时间区间')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '启用停止日程' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加停止区间' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('adds a labelled window row and appends it on change', () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '添加停止区间' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [
        { start: '22:00', end: '06:00', recurrence: { kind: 'daily' } },
        // A fresh row reads as 每天 (absent on the wire) until the Human picks another kind.
        { start: '', end: '', recurrence: { kind: 'daily' } },
      ],
    })
  })

  it('removes the touched window through its labelled action', () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }, { start: '12:00', end: '14:00', recurrence: { kind: 'daily' } }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '移除停止区间 #2' }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] })
  })

  it('surfaces the rule alert while the draft is invalid and hides it once complete', () => {
    // The lenient `9:00` input pads to a valid bound now; a malformed minute
    // is what still trips the rule.
    const { rerender } = renderField({ enabled: true, windows: [{ start: '9:5', end: '18:00', recurrence: { kind: 'daily' } }] })
    expect(screen.getByRole('alert').textContent).toContain('每个停止区间需要 HH:MM')
    rerender(
      <StopScheduleField draft={{ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] }} onChange={vi.fn()} disabled={false} t={t} />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

/** Controlled field harness: the dialog owns the draft state, so interactions re-render through the parent. */
function ControlledStopScheduleField({ initial }: { readonly initial: StopScheduleDraft }) {
  const [draft, setDraft] = useState(initial)
  return <StopScheduleField draft={draft} onChange={setDraft} disabled={false} t={t} />
}

describe('StopScheduleField recurrence control', () => {
  it('reads a stored stop window without a recurrence field as 每天', () => {
    renderField({ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] })
    expect(screen.getByRole('button', { name: '停止区间 #1 周期' }).textContent).toContain('每天')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('picks 每周 from the dropdown, toggles chips, and clears the recurrence alert once one is pressed', async () => {
    render(<ControlledStopScheduleField initial={{ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'weekly', weekdays: [] } }] }} />)
    expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('周期参数'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周一' }))
    expect(screen.getByRole('button', { name: '停止区间 #1 周一' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('switches kinds through the shared dropdown and defaults the everyDays anchor to today', async () => {
    render(<ControlledStopScheduleField initial={{ enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'daily' } }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周期' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '每几天' }))
    expect((screen.getByLabelText('停止区间 #1 起始日') as HTMLInputElement).value).toBe(teamTodayText())
    expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('周期参数'))).toBe(true)
    fireEvent.change(screen.getByLabelText('停止区间 #1 间隔天数'), { target: { value: '2' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AgentEditorDialog stop schedule commit', () => {
  function statusWith(overrides: Record<string, unknown>): AgentTeamClientMemberStatus {
    return {
      member: {
        memberId: 'member:builder', workspaceId: 'w1', handle: 'builder', description: 'builder description',
        presetId: 'team-member', state: 'enabled', sessionId: 'session:builder',
        ...overrides,
      },
      workspaceIds: ['w1'],
      availability: 'active',
      presence: 'available',
    } as unknown as AgentTeamClientMemberStatus
  }

  function renderEditor(status: AgentTeamClientMemberStatus) {
    // The dialog only reads the result's ok/error here; the typed Remote shapes
    // ride the real Host, so the mock answers the narrow shape through casts.
    const updateMember = vi.fn(async () => ({ ok: true as const, value: { receipt: {}, status } })) as unknown as
      (request: AgentTeamUpdateMemberRequest) => Promise<RemoteResult<AgentTeamMemberResult>>
    const curateMemberPrompt = loadPromptView as never
    const view = render(
      <AgentEditorDialog
        status={status}
        updateMember={updateMember}
      loadPromptView={loadPromptView}
      curateMemberPrompt={curateMemberPrompt}
      loadModels={(): Promise<RemoteResult<never>> => Promise.resolve({ ok: true, value: { groups: [], failures: [] } } as RemoteResult<never>)}
      onCommitted={vi.fn()}
      onClose={vi.fn()}
      t={t}
    />,
  )
  return { updateMember, view }
}

  it('commits a drawn stop schedule and echoes a stored one absent-clears', async () => {
    const { updateMember } = renderEditor(statusWith({
      stopSchedule: { enabled: false, windows: [{ start: '22:00', end: '06:00' }] },
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // Enable the stored schedule: the echo carries the whole stored intent.
    fireEvent.click(screen.getByRole('checkbox', { name: '启用停止日程' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      stopSchedule: { enabled: true, windows: [{ start: '22:00', end: '06:00' }] },
    })))
  })

  it('gates the save on an invalid window and sends a fresh schedule once complete', async () => {
    const { updateMember } = renderEditor(statusWith({}))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '启用停止日程' }))
    expect((screen.getByRole('alert')).textContent).toContain('至少需要一个完整区间')
    expect(save.disabled).toBe(true)
    // The window row exists only once drawn; the alert clears when it completes.
    fireEvent.click(screen.getByRole('button', { name: '添加停止区间' }))
    fireEvent.change(screen.getByLabelText('停止区间 #1 开始'), { target: { value: '22:00' } })
    fireEvent.change(screen.getByLabelText('停止区间 #1 结束'), { target: { value: '06:00' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      stopSchedule: { enabled: true, windows: [{ start: '22:00', end: '06:00' }] },
    })))
  })

  it('echoes a stored weekly recurrence, gates the save on cleared chips, and commits the sorted weekday set', async () => {
    const { updateMember } = renderEditor(statusWith({
      stopSchedule: { enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'weekly', weekdays: [1, 5] } }] },
    }))
    // The stored recurrence reads back: the trigger names 每周 and the stored
    // chips render pressed, and an untouched dialog stays clean.
    expect(screen.getByRole('button', { name: '停止区间 #1 周期' }).textContent).toContain('每周')
    expect(screen.getByRole('button', { name: '停止区间 #1 周一' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '停止区间 #1 周五' }).getAttribute('aria-pressed')).toBe('true')
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // Clearing every chip makes the recurrence incomplete: the save gates.
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周五' }))
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周一' }))
    expect(screen.getAllByRole('alert').some(alert => alert.textContent.includes('周期参数'))).toBe(true)
    expect(save.disabled).toBe(true)
    // Repicking two different weekdays changes the stored set; the commit
    // rides the sorted unique shape the Host gate accepts.
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周三' }))
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周一' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      stopSchedule: { enabled: true, windows: [{ start: '22:00', end: '06:00', recurrence: { kind: 'weekly', weekdays: [1, 3] } }] },
    })))
  })

  it('commits a freshly drawn everyDays window with its interval and today anchor', async () => {
    const { updateMember } = renderEditor(statusWith({}))
    fireEvent.click(screen.getByRole('checkbox', { name: '启用停止日程' }))
    fireEvent.click(screen.getByRole('button', { name: '添加停止区间' }))
    fireEvent.change(screen.getByLabelText('停止区间 #1 开始'), { target: { value: '9:00' } })
    fireEvent.change(screen.getByLabelText('停止区间 #1 结束'), { target: { value: '18:00' } })
    fireEvent.click(screen.getByRole('button', { name: '停止区间 #1 周期' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '每几天' }))
    // The anchor prefilled with today; only the interval is missing, so the
    // save gates on the recurrence rule alone.
    expect((screen.getByLabelText('停止区间 #1 起始日') as HTMLInputElement).value).toBe(teamTodayText())
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('停止区间 #1 间隔天数'), { target: { value: '2' } })
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      stopSchedule: { enabled: true, windows: [{ start: '09:00', end: '18:00', recurrence: { kind: 'everyDays', intervalDays: 2, anchorDate: teamTodayText() } }] },
    })))
  })
})
