import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamThreadRef } from '@grantyuan/dsh-crew/types'
import type { TeamKey } from '../src/client/locales.ts'
import { teamChannelAddress, teamThreadAddress } from '../src/client/team-address.ts'
import {
  TEAM_CHANNEL_ID,
  TEAM_CHANNEL_KIND,
  TEAM_INBOX_ID,
  TEAM_INBOX_KIND,
  TEAM_MESSAGES_ID,
  TEAM_MESSAGES_KIND,
  TEAM_SESSION_HISTORY_ID,
  TEAM_SESSION_HISTORY_KIND,
  TEAM_TAB_IDS,
  TEAM_TASKS_ID,
  TEAM_TASKS_KIND,
  TEAM_THREAD_ID,
  TEAM_THREAD_KIND,
  teamTabDefinitions,
  teamTabTargetOf,
} from '../src/client/team-tab-types.ts'

const workspace = 'w1' as WorkspaceId
const channelRef = 'channel:engineering' as AgentTeamChannelRef
const threadRef = 'thread:9' as AgentTeamThreadRef
const memberId = 'member:iris' as AgentTeamMemberId

describe('Team right-sidebar tab definitions', () => {
  const reads: TeamKey[] = []
  const t = (key: TeamKey): string => {
    reads.push(key)
    return `#${key}`
  }
  const definitions = teamTabDefinitions(t)

  it('contributes one definition per Team page with unique ids and kinds', () => {
    expect(definitions).toHaveLength(6)
    expect(definitions.map(definition => definition.id)).toEqual([...TEAM_TAB_IDS])
    expect(new Set(definitions.map(definition => definition.kind)).size).toBe(6)
    for (const definition of definitions) expect(definition.id).toBe(`agent-team.${definition.kind}`)
  })

  it('claims Team addresses only through canOpen, and the copy is read per call', () => {
    reads.length = 0
    const channel = definitions.find(definition => definition.kind === TEAM_CHANNEL_KIND)!
    const thread = definitions.find(definition => definition.kind === TEAM_THREAD_KIND)!
    expect(channel.multiple).toBe(true)
    expect(channel.patterns?.[0]).toContain('dsh-resource://team/channel/')
    expect(channel.canOpen?.(teamChannelAddress(workspace, channelRef))).toBe(true)
    expect(channel.canOpen?.(teamThreadAddress(workspace, threadRef))).toBe(false)
    expect(thread.canOpen?.(teamThreadAddress(workspace, threadRef))).toBe(true)
    expect(channel.canOpen?.('dsh-resource://team/channel/w1')).toBe(false)
    const title = channel.title(teamChannelAddress(workspace, channelRef))
    expect(title).toBe('#channelTab')
    channel.title(teamChannelAddress(workspace, channelRef))
    expect(reads.filter(key => key === 'channelTab')).toHaveLength(2)
  })

  it('keeps list pages as parameterless page types with guide entries, and session history per Member', () => {
    const inbox = definitions.find(definition => definition.kind === TEAM_INBOX_KIND)!
    expect(inbox.patterns).toBeUndefined()
    expect(inbox.multiple).toBeUndefined()
    expect(inbox.title('sidebar://page/team-inbox')).toBe('#inboxTitle')
    expect(inbox.guide?.map(entry => entry.id)).toEqual(['agent-team-inbox'])
    const orders = definitions.flatMap(definition => (definition.guide ?? []).map(entry => entry.order))
    expect(orders).toEqual([...orders].sort((left, right) => left - right))
    const history = definitions.find(definition => definition.kind === TEAM_SESSION_HISTORY_KIND)!
    expect(history.multiple).toBe(true)
    expect(history.guide).toBeUndefined()
    expect(definitions.find(definition => definition.kind === TEAM_MESSAGES_KIND)!.id).toBe(TEAM_MESSAGES_ID)
    expect(definitions.find(definition => definition.kind === TEAM_TASKS_KIND)!.id).toBe(TEAM_TASKS_ID)
    expect(definitions.find(definition => definition.kind === TEAM_CHANNEL_KIND)!.id).toBe(TEAM_CHANNEL_ID)
    expect(definitions.find(definition => definition.kind === TEAM_THREAD_KIND)!.id).toBe(TEAM_THREAD_ID)
    expect(definitions.find(definition => definition.kind === TEAM_INBOX_KIND)!.id).toBe(TEAM_INBOX_ID)
    expect(history.id).toBe(TEAM_SESSION_HISTORY_ID)
  })
})

describe('teamTabTargetOf', () => {
  it('reads a Channel tab from its address alone', () => {
    expect(teamTabTargetOf({ kind: TEAM_CHANNEL_KIND, address: teamChannelAddress(workspace, channelRef), params: undefined }))
      .toEqual({ kind: TEAM_CHANNEL_KIND, workspaceId: workspace, channelRef })
  })

  it('reads a Thread tab from its address plus the channel/task context riding the open', () => {
    const target = teamTabTargetOf({
      kind: TEAM_THREAD_KIND,
      address: teamThreadAddress(workspace, threadRef),
      params: { channelRef, taskRef: 'task:1' as AgentTeamTaskRef, taskNumber: 7, threadOrigin: 'messages' },
    })
    expect(target).toEqual({ kind: TEAM_THREAD_KIND, workspaceId: workspace, threadRef, channelRef, taskRef: 'task:1' as AgentTeamTaskRef, taskNumber: 7, threadOrigin: 'messages' })
    expect(teamTabTargetOf({ kind: TEAM_THREAD_KIND, address: teamThreadAddress(workspace, threadRef), params: undefined }))
      .toEqual({ kind: TEAM_THREAD_KIND, workspaceId: workspace, threadRef })
  })

  it('keeps list pages parameterless and session history keyed by its Member', () => {
    expect(teamTabTargetOf({ kind: TEAM_INBOX_KIND, address: 'sidebar://page/team-inbox', params: undefined })).toEqual({ kind: TEAM_INBOX_KIND })
    expect(teamTabTargetOf({ kind: TEAM_TASKS_KIND, address: 'sidebar://page/team-tasks', params: undefined })).toEqual({ kind: TEAM_TASKS_KIND })
    expect(teamTabTargetOf({ kind: TEAM_MESSAGES_KIND, address: 'sidebar://page/team-message-center', params: undefined })).toEqual({ kind: TEAM_MESSAGES_KIND })
    expect(teamTabTargetOf({ kind: TEAM_SESSION_HISTORY_KIND, address: 'sidebar://page/team-session-history', params: { memberId, workspaceId: workspace } }))
      .toEqual({ kind: TEAM_SESSION_HISTORY_KIND, memberId, workspaceId: workspace })
    expect(teamTabTargetOf({ kind: TEAM_SESSION_HISTORY_KIND, address: 'sidebar://page/team-session-history', params: undefined })).toBeUndefined()
  })

  it('resolves nothing for an unclaimed address, an unknown kind, or a crossed surface', () => {
    expect(teamTabTargetOf({ kind: TEAM_CHANNEL_KIND, address: teamThreadAddress(workspace, threadRef), params: undefined })).toBeUndefined()
    expect(teamTabTargetOf({ kind: 'file', address: 'dsh-resource://file/session/s1/home/a.md', params: undefined })).toBeUndefined()
  })
})
