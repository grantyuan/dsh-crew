import { describe, expect, it, vi } from 'vitest'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamThreadRef } from '@grantyuan/dsh-crew/types'
import { teamChannelAddress, teamThreadAddress } from '../src/client/team-address.ts'
import { openTeamTabFor } from '../src/client/team-tab-open.ts'

const workspace = 'w1' as WorkspaceId
const channelRef = 'channel:engineering' as AgentTeamChannelRef
const threadRef = 'thread:9' as AgentTeamThreadRef
const memberId = 'member:iris' as AgentTeamMemberId

function recorder(): { sidebarRight: ISidebarRight; openResource: ReturnType<typeof vi.fn>; openTab: ReturnType<typeof vi.fn> } {
  const openResource = vi.fn()
  const openTab = vi.fn()
  return { sidebarRight: { openResource, openTab } as unknown as ISidebarRight, openResource, openTab }
}

describe('openTeamTabFor', () => {
  it('lands a Channel face by its address', () => {
    const { sidebarRight, openResource } = recorder()
    openTeamTabFor({ kind: 'channel', workspaceId: workspace, channelRef }, sidebarRight)
    expect(openResource).toHaveBeenCalledWith(teamChannelAddress(workspace, channelRef))
  })

  it('lands a Thread face with its context params and the locate anchor when given', () => {
    const { sidebarRight, openResource } = recorder()
    openTeamTabFor({ kind: 'thread', workspaceId: workspace, threadRef, channelRef, taskNumber: 7 }, sidebarRight, 42)
    expect(openResource).toHaveBeenCalledWith(teamThreadAddress(workspace, threadRef), {
      params: { channelRef, taskNumber: 7, focusSequence: 42 },
    })
    openTeamTabFor({ kind: 'thread', workspaceId: workspace, threadRef }, sidebarRight)
    expect(openResource).toHaveBeenLastCalledWith(teamThreadAddress(workspace, threadRef), { params: {} })
  })

  it('opens list pages by kind and session history by its Member params', () => {
    const { sidebarRight, openTab } = recorder()
    openTeamTabFor({ kind: 'inbox' }, sidebarRight)
    openTeamTabFor({ kind: 'tasks' }, sidebarRight)
    openTeamTabFor({ kind: 'messages' }, sidebarRight)
    expect(openTab.mock.calls.map(call => call[0])).toEqual(['team-inbox', 'team-tasks', 'team-message-center'])
    openTeamTabFor({ kind: 'sessionHistory', memberId, workspaceId: workspace }, sidebarRight)
    expect(openTab).toHaveBeenLastCalledWith('team-session-history', { params: { memberId, workspaceId: workspace } })
  })

  it('lands nothing for the overview face', () => {
    const { sidebarRight, openResource, openTab } = recorder()
    openTeamTabFor({ kind: 'overview', workspaceId: workspace }, sidebarRight)
    expect(openResource).not.toHaveBeenCalled()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('swallows the no-session throw: the memory keeps the face for the replay', () => {
    const openResource = vi.fn(() => { throw new Error('sidebarRight: no session surface is mounted') })
    const openTab = vi.fn(() => { throw new Error('sidebarRight: no session surface is mounted') })
    const sidebarRight = { openResource, openTab } as unknown as ISidebarRight
    expect(() => openTeamTabFor({ kind: 'thread', workspaceId: workspace, threadRef }, sidebarRight)).not.toThrow()
    expect(() => openTeamTabFor({ kind: 'inbox' }, sidebarRight)).not.toThrow()
  })

  it('lands nothing when the thread face lacks the Workspace its address needs', () => {
    const { sidebarRight, openResource } = recorder()
    openTeamTabFor({ kind: 'thread', threadRef }, sidebarRight, 5)
    openTeamTabFor({ kind: 'channel', channelRef }, sidebarRight)
    expect(openResource).not.toHaveBeenCalled()
  })
})
