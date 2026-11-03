// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamModelSelection } from '@grantyuan/dsh-crew/types'
import {
  ModelScheduleField,
  normalizeScheduleDraft,
  scheduleDraftInvalid,
  scheduleStoredDraft,
  type ModelScheduleDraft,
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

describe('model schedule draft normalization', () => {
  it('round-trips a stored schedule and treats absent as an empty draft', () => {
    expect(scheduleStoredDraft(undefined)).toEqual({ enabled: false, windows: [] })
    const stored = { enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }
    expect(normalizeScheduleDraft(scheduleStoredDraft(stored))).toEqual(stored)
  })

  it('drops blank and incomplete windows from the submitted schedule', () => {
    const draft: ModelScheduleDraft = {
      enabled: true,
      windows: [
        { start: '09:00', end: '18:00', selection: deepseek },
        { start: '', end: '', selection: undefined },
        { start: '18:00', end: '23:00', selection: undefined },
        { start: '9:00', end: '18:00', selection: qwen },
      ],
    }
    expect(normalizeScheduleDraft(draft)).toEqual({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] })
  })

  it('flags incomplete windows, equal bounds, and an enabled schedule that demands nothing', () => {
    expect(scheduleDraftInvalid({ enabled: false, windows: [] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: true, windows: [] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] })).toBe(false)
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '09:00', selection: deepseek }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: false, windows: [{ start: '09:00', end: '18:00', selection: undefined }] })).toBe(true)
    expect(scheduleDraftInvalid({ enabled: true, windows: [{ start: '', end: '', selection: undefined }] })).toBe(true)
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
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }, vi.fn(), { provider: 'qwen-official', model: 'qwen3.8-flash' })
    expect(screen.getByText('当前按日程运行:qwen-official/qwen3.8-flash')).toBeTruthy()
  })

  it('adds a row with labelled start/end inputs and appends it on change', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '添加时间窗' }))
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      windows: [{ start: '09:00', end: '18:00', selection: deepseek }, { start: '', end: '', selection: undefined }],
    })
  })

  it('removes the touched window through its labelled action', async () => {
    const onChange = vi.fn()
    renderField({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }, { start: '18:00', end: '23:00', selection: qwen }] }, onChange)
    fireEvent.click(screen.getByRole('button', { name: '移除时间窗 #2' }))
    expect(onChange).toHaveBeenCalledWith({ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] })
  })

  it('surfaces the rule alert while the draft is invalid and hides it once complete', () => {
    const { rerender } = renderField({ enabled: true, windows: [{ start: '9:00', end: '18:00', selection: deepseek }] })
    expect(screen.getByRole('alert').textContent).toContain('每个时间窗需要 HH:MM')
    rerender(
      <ModelScheduleField draft={{ enabled: true, windows: [{ start: '09:00', end: '18:00', selection: deepseek }] }} onChange={vi.fn()} applied={undefined} loadModels={catalogOk} disabled={false} t={t} />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
