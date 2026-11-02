import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamThreadRef } from '@grantyuan/dsh-crew/types'

/**
 * The Team's `dsh-resource://` addresses. The resource type segment is `team`;
 * the next segment picks the surface (`channel` or `thread`) and the two that
 * follow are the Workspace id and the branded ref, each percent-encoded so a
 * ref carrying a separator still round-trips through one segment. The whole
 * address is the tab's content identity, so two opens of the same Channel are
 * the same tab and two Channels are two tabs.
 */

const TEAM_PREFIX = 'dsh-resource://team/'

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** Split an address into `[surface, workspaceId, ref]` past the `team/` prefix. */
function segmentsOf(address: string, surface: string): readonly [string, string] | undefined {
  if (!address.startsWith(`${TEAM_PREFIX}${surface}/`)) return undefined
  const rest = address.slice(`${TEAM_PREFIX}${surface}/`.length)
  const separator = rest.indexOf('/')
  if (separator <= 0 || separator === rest.length - 1) return undefined
  if (rest.indexOf('/', separator + 1) !== -1) return undefined
  const workspaceId = decodeSegment(rest.slice(0, separator))
  const ref = decodeSegment(rest.slice(separator + 1))
  if (workspaceId === undefined || ref === undefined) return undefined
  return [workspaceId, ref]
}

export function teamChannelAddress(workspaceId: WorkspaceId, channelRef: AgentTeamChannelRef): string {
  return `${TEAM_PREFIX}channel/${encodeSegment(workspaceId)}/${encodeSegment(channelRef)}`
}

export function teamThreadAddress(workspaceId: WorkspaceId, threadRef: AgentTeamThreadRef): string {
  return `${TEAM_PREFIX}thread/${encodeSegment(workspaceId)}/${encodeSegment(threadRef)}`
}

export interface TeamChannelTarget {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
}

export interface TeamThreadTarget {
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
}

/** Read a Channel address back, or `undefined` when it is not one. */
export function parseTeamChannelAddress(address: string): TeamChannelTarget | undefined {
  const parts = segmentsOf(address, 'channel')
  if (parts === undefined) return undefined
  return { workspaceId: parts[0] as WorkspaceId, channelRef: parts[1] as AgentTeamChannelRef }
}

/** Read a Thread address back, or `undefined` when it is not one. */
export function parseTeamThreadAddress(address: string): TeamThreadTarget | undefined {
  const parts = segmentsOf(address, 'thread')
  if (parts === undefined) return undefined
  return { workspaceId: parts[0] as WorkspaceId, threadRef: parts[1] as AgentTeamThreadRef }
}
