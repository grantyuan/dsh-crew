// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        { start: '22:00', end: '06:00' },
        { start: '', end: '' },
        { start: '12:00', end: '' },
        // `9:00` is what a Human naturally types; the stored form is strict
        // HH:MM, so the editor pads it instead of refusing it.
        { start: '9:00', end: '18:00' },
      ],
    }
    expect(normalizeStopScheduleDraft(draft)).toEqual({ enabled: true, windows: [{ start: '22:00', end: '06:00' }, { start: '09:00', end: '18:00' }] })
  })

  it('flags incomplete windows, equal bounds, and an enabled schedule that stops nothing', () => {
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [] })).toBe(false)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '22:00', end: '06:00' }] })).toBe(false)
    // Equal bounds compare padded: `9:00` and `09:00` are the same instant.
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '9:00', end: '09:00' }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '09:00' }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '' }] })).toBe(true)
    expect(stopScheduleDraftInvalid({ enabled: true, windows: [{ start: '', end: '' }] })).toBe(true)
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
    renderField({ enabled: true, windows: [{ start: '22:00', end: '06:00' }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '添加停止区间' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [{ start: '22:00', end: '06:00' }, { start: '', end: '' }],
    })
  })

  it('removes the touched window through its labelled action', () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '22:00', end: '06:00' }, { start: '12:00', end: '14:00' }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '移除停止区间 #2' }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, windows: [{ start: '22:00', end: '06:00' }] })
  })

  it('surfaces the rule alert while the draft is invalid and hides it once complete', () => {
    // The lenient `9:00` input pads to a valid bound now; a malformed minute
    // is what still trips the rule.
    const { rerender } = renderField({ enabled: true, windows: [{ start: '9:5', end: '18:00' }] })
    expect(screen.getByRole('alert').textContent).toContain('每个停止区间需要 HH:MM')
    rerender(
      <StopScheduleField draft={{ enabled: true, windows: [{ start: '22:00', end: '06:00' }] }} onChange={vi.fn()} disabled={false} t={t} />,
    )
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
})
