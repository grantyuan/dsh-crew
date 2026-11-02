// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Landing drives the whole Team surface in jsdom; the shared suite ceiling applies.
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY as NAVIGATION_STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function storedNavigation(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(NAVIGATION_STORAGE_KEY) ?? '') as Record<string, unknown>
}

/** The bench tab host's surface for one open tab kind (the strip itself is the
 * shipped Sidebar's chrome, out of this bench's scope). */
function tabSurface(container: HTMLElement, kind: string): HTMLElement | null {
  return container.querySelector(`[data-team-tab="${kind}"]`)
}

/**
 * The Team pages land as tabs in the shipped right Sidebar: every entry point
 * writes the navigation snapshot (memory) and opens or reveals the tab its
 * face names. The bench's `sidebarRight` double records the opens and renders
 * each active tab's body through the real keyed `sidebar.right.pane.tab` seat,
 * so these read the same wiring production runs — never a Team-owned dock.
 */
describe('Team right-Sidebar landing', () => {
  it('lands a sidebar list card as its page tab beside the shipped conversation', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    // The Tasks page is opened by kind and its body renders in the right column.
    await waitFor(() => expect(b.openTab).toHaveBeenCalledWith('team-tasks'))
    await waitFor(() => expect(tabSurface(b.view.container, 'team-tasks')).not.toBeNull())
    // The center stays the shipped conversation beside the Sidebar — the Team
    // never took it over.
    expect(b.view.container.querySelector('[data-phase]')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('lands a Channel row by address, revealing on re-click, then a Thread row beside it', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    b.seedTasks([{ workspaceId: 'w1', row: { taskRef: 'task:1', threadRef: 'thread:1', channelRef: 'channel:engineering', taskNumber: 1, status: 'in_progress', resolution: 'open', subject: 'Ship the rollout', claimOwners: [], lastActivityAt: '2026-09-13T04:00:00.000Z' } }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    await waitFor(() => expect(b.openResource).toHaveBeenCalledWith(expect.stringContaining('dsh-resource://team/channel/')))
    // The same Channel re-clicked reveals the standing tab, it does not stack:
    // still one team-channel tab in the store.
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    expect(b.teamTabs().filter(tab => tab.kind === 'team-channel')).toHaveLength(1)
    // A Thread row on the Tasks page opens the list tab and the Thread tab by
    // its own address; the Channel tab underneath survives.
    fireEvent.click(b.view.getByRole('button', { name: '任务' }))
    fireEvent.click(await b.view.findByRole('button', { name: /Ship the rollout/ }))
    await waitFor(() => expect(b.openResource).toHaveBeenCalledWith(expect.stringContaining('dsh-resource://team/thread/'), expect.anything()))
    const kinds = b.teamTabs().map(tab => tab.kind)
    expect(kinds).toContain('team-channel')
    expect(kinds).toContain('team-thread')
    expect(kinds).toContain('team-tasks')
    await b.runtime.dispose()
  })

  it('re-lands the last Team page after leaving and re-entering Team mode', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    await waitFor(() => expect(tabSurface(b.view.container, 'team-tasks')).not.toBeNull())
    // Leave through the footer (对话) and come back. Leaving does not reclaim
    // the Sidebar's tabs (they are per-Session Sidebar state, not Team chrome),
    // so the Tasks tab stands; re-entering lands the remembered face again off
    // the persisted snapshot — a reveal, not a second stacked tab.
    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(storedNavigation().mode).toBe('conversation'))
    const opensBefore = b.openTab.mock.calls.length
    const tasksTabsBefore = b.teamTabs().filter(tab => tab.kind === 'team-tasks').length
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(b.openTab).toHaveBeenCalledTimes(opensBefore + 1))
    expect(b.openTab).toHaveBeenLastCalledWith('team-tasks')
    expect(b.teamTabs().filter(tab => tab.kind === 'team-tasks')).toHaveLength(tasksTabsBefore)
    await waitFor(() => expect(tabSurface(b.view.container, 'team-tasks')).not.toBeNull())
    await b.runtime.dispose()
  })

  it('reopens the last Member conversation on the next Team entry', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => expect(b.openSession).toHaveBeenCalledWith('session:member:builder'))
    // Leaving Team restores the Human's own session; re-entering reopens the
    // Member conversation — the last Team page the Human was reading.
    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(b.openSession).toHaveBeenLastCalledWith('ordinary-session'))
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(b.openSession).toHaveBeenLastCalledWith('session:member:builder'))
    await b.runtime.dispose()
  })

  it('swallows the no-session open error and keeps the navigation memory', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    b.failSidebarOpens(true)
    fireEvent.click(await b.view.findByRole('button', { name: '任务' }))
    // The command threw inside the Sidebar; the landing pass swallowed it and
    // the durable face still moved, so the next entry replays it.
    await waitFor(() => expect(storedNavigation().tasks).toBe(true))
    expect(b.view.queryByRole('alert')).toBeNull()
    b.failSidebarOpens(false)
    await b.runtime.dispose()
  })
})
