import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamThreadRef } from '@grantyuan/dsh-crew/types'
import { parseTeamChannelAddress, parseTeamThreadAddress, teamChannelAddress, teamThreadAddress } from '../src/client/team-address.ts'

const workspace = 'w1' as WorkspaceId
const channelRef = 'channel:engineering' as AgentTeamChannelRef
const threadRef = 'thread:9' as AgentTeamThreadRef

describe('Team sidebar addresses', () => {
  it('round-trips a Channel address through the ref segments', () => {
    const address = teamChannelAddress(workspace, channelRef)
    expect(address).toBe('dsh-resource://team/channel/w1/channel%3Aengineering')
    expect(parseTeamChannelAddress(address)).toEqual({ workspaceId: workspace, channelRef })
  })

  it('round-trips a Thread address', () => {
    const address = teamThreadAddress(workspace, threadRef)
    expect(parseTeamThreadAddress(address)).toEqual({ workspaceId: workspace, threadRef })
  })

  it('keeps a ref carrying a separator inside one encoded segment', () => {
    const tricky = 'a/b#c%d 卷' as AgentTeamChannelRef
    const address = teamChannelAddress('w/1' as WorkspaceId, tricky)
    expect(parseTeamChannelAddress(address)).toEqual({ workspaceId: 'w/1' as WorkspaceId, channelRef: tricky })
  })

  it('rejects the wrong surface and malformed shapes', () => {
    const channel = teamChannelAddress(workspace, channelRef)
    const thread = teamThreadAddress(workspace, threadRef)
    expect(parseTeamChannelAddress(thread)).toBeUndefined()
    expect(parseTeamThreadAddress(channel)).toBeUndefined()
    for (const bad of [
      'dsh-resource://file/session/s1/home/a.md',
      'dsh-resource://team/channel/w1',
      'dsh-resource://team/channel//ref',
      'dsh-resource://team/channel/w1/',
      'dsh-resource://team/channel/w1/ref/extra',
      'dsh-resource://team/channel/w1/%zz',
      'team/channel/w1/ref',
    ]) {
      expect(parseTeamChannelAddress(bad)).toBeUndefined()
      expect(parseTeamThreadAddress(bad)).toBeUndefined()
    }
  })
})
