// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamClientMemberStatus, AgentTeamMemberPromptView, AgentTeamMemberResult, AgentTeamUpdateMemberRequest } from '@grantyuan/dsh-crew/types'
import { AgentEditorDialog } from '../src/client/TeamMemberEditor.tsx'
import { zh } from '../src/client/locales.ts'
import type { TeamModelCatalog } from '../src/client/slots.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as never

const CATALOG: TeamModelCatalog = {
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ] },
    { id: 'qwen-official', name: 'Qwen', models: [{ id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' }] },
  ],
  failures: [],
}
const catalogOk = (): Promise<RemoteResult<TeamModelCatalog>> => Promise.resolve({ ok: true, value: CATALOG } as RemoteResult<TeamModelCatalog>)

const loadPromptView = vi.fn(async (): Promise<RemoteResult<AgentTeamMemberPromptView>> => {
  throw new Error('not used')
})

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
  const curateMemberPrompt = vi.fn(async () => ({ ok: true as const, value: { proposal: {}, modelUsed: { provider: 'test', model: 'test' } } })) as never
  const view = render(
    <AgentEditorDialog
      status={status}
      updateMember={updateMember}
      loadPromptView={loadPromptView}
      curateMemberPrompt={curateMemberPrompt}
      loadModels={catalogOk}
      onCommitted={vi.fn()}
      onClose={vi.fn()}
      t={t}
    />,
  )
  return { updateMember, view }
}

describe('backup model edit repro', () => {
  it('modifies a stored backup route and enables save', async () => {
    const { updateMember } = renderEditor(statusWith({
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // Modify the stored backup row: open its picker and choose another model.
    fireEvent.click(await screen.findByRole('button', { name: '备用 #1' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'Qwen3.8 Flash' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member:builder',
      modelFallbacks: [{ provider: 'qwen-official', model: 'qwen3.8-flash' }],
    })))
  })

  it('changes a stored backup route effort and enables save', async () => {
    const { updateMember } = renderEditor(statusWith({
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' }],
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    // The fallback row is the field whose label names the candidate; the
    // primary picker's own effort row renders above it.
    const fallbackRow = screen.getByText('备用 #1').closest('div') as HTMLElement
    fireEvent.click(await within(fallbackRow).findByRole('button', { name: /推理强度/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'low' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low' }],
    })))
  })

  it('modifies a backup route while the primary follows the Host default', async () => {
    const { updateMember } = renderEditor(statusWith({
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: '备用 #1' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'Qwen3.8 Flash' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      modelFallbacks: [{ provider: 'qwen-official', model: 'qwen3.8-flash' }],
    })))
  })

  it('adds a second backup route to a stored list and enables save', async () => {
    const { updateMember } = renderEditor(statusWith({
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: '添加备用路由' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'Qwen3.8 Flash' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      modelFallbacks: [
        { provider: 'deepseek-official', model: 'deepseek-reasoner' },
        { provider: 'qwen-official', model: 'qwen3.8-flash' },
      ],
    })))
  })

  it('removes a stored backup route and enables save', async () => {
    const { updateMember } = renderEditor(statusWith({
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      modelFallbacks: [
        { provider: 'deepseek-official', model: 'deepseek-reasoner' },
        { provider: 'qwen-official', model: 'qwen3.8-flash' },
      ],
    }))
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click((await screen.findAllByRole('button', { name: '移除该备用' }))[0]!)
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith(expect.objectContaining({
      modelFallbacks: [{ provider: 'qwen-official', model: 'qwen3.8-flash' }],
    })))
  })

  it('never offers the primary or another backup route as a candidate', async () => {
    renderEditor(statusWith({
      model: { provider: 'deepseek-official', model: 'deepseek-chat' },
      modelFallbacks: [{ provider: 'deepseek-official', model: 'deepseek-reasoner' }],
    }))
    // The add picker lists neither the primary (DeepSeek Chat) nor the stored
    // row (DeepSeek Reasoner) — a pick the Host would refuse used to be
    // silently ignored, leaving the save button gray with no feedback.
    fireEvent.click(await screen.findByRole('button', { name: '添加备用路由' }))
    const menu = within(document.body).getByRole('menu')
    await waitFor(() => expect(menu.textContent).toContain('Qwen3.8 Flash'))
    expect(within(menu).queryByRole('menuitem', { name: 'DeepSeek Chat' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'DeepSeek Reasoner' })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Qwen3.8 Flash' }))
    // A stored row keeps its own value selectable but not the others.
    fireEvent.click(await screen.findByRole('button', { name: '备用 #1' }))
    const rowMenu = within(document.body).getByRole('menu')
    expect(within(rowMenu).getByRole('menuitem', { name: 'DeepSeek Reasoner' })).toBeTruthy()
    expect(within(rowMenu).queryByRole('menuitem', { name: 'DeepSeek Chat' })).toBeNull()
    expect(within(rowMenu).queryByRole('menuitem', { name: 'Qwen3.8 Flash' })).toBeNull()
  })
})
