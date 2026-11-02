import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamThreadRef } from '@grantyuan/dsh-crew/types'
import type { SidebarRightNavigationParams, SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TeamKey } from './locales.ts'
import type { TeamThreadOrigin } from './navigation.ts'
import { parseTeamChannelAddress, parseTeamThreadAddress } from './team-address.ts'

/**
 * The Team's tab types in the shipped right Sidebar. Each page the Team owns —
 * Channel, Thread, Inbox, Tasks, Message Center, session history — registers
 * through the Sidebar's public two-stage path: this file is stage one (what a
 * type IS: claims, chip copy, guide entries), the body adapter under
 * `sidebar.right.pane.tab` keyed by the same `id` is stage two.
 *
 * Channels and Threads are addressed resources: the whole
 * `dsh-resource://team/...` address is the tab's content identity, so the same
 * Channel reveals its existing tab while different Channels become different
 * tabs — the multi-view the dock could only stack vertically. The list pages
 * are parameterless page types that deduplicate per pane; session history
 * carries its branded Member id as page params because each Member is its own
 * page.
 */

export const TEAM_CHANNEL_KIND = 'team-channel'
export const TEAM_THREAD_KIND = 'team-thread'
export const TEAM_INBOX_KIND = 'team-inbox'
export const TEAM_TASKS_KIND = 'team-tasks'
export const TEAM_MESSAGES_KIND = 'team-message-center'
export const TEAM_SESSION_HISTORY_KIND = 'team-session-history'

/** Implementation identities — the keys the stage-two body and title register under. */
export const TEAM_CHANNEL_ID = `agent-team.${TEAM_CHANNEL_KIND}`
export const TEAM_THREAD_ID = `agent-team.${TEAM_THREAD_KIND}`
export const TEAM_INBOX_ID = `agent-team.${TEAM_INBOX_KIND}`
export const TEAM_TASKS_ID = `agent-team.${TEAM_TASKS_KIND}`
export const TEAM_MESSAGES_ID = `agent-team.${TEAM_MESSAGES_KIND}`
export const TEAM_SESSION_HISTORY_ID = `agent-team.${TEAM_SESSION_HISTORY_KIND}`

export const TEAM_TAB_IDS = [
  TEAM_CHANNEL_ID, TEAM_THREAD_ID, TEAM_INBOX_ID, TEAM_TASKS_ID, TEAM_MESSAGES_ID, TEAM_SESSION_HISTORY_ID,
] as const

/** Navigation params a Thread address carries beside its own identity. */
export interface TeamResourceParams {
  readonly channelRef?: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  readonly threadOrigin?: TeamThreadOrigin
}

/** Navigation params the session-history page needs: which Member, which Workspace. */
export interface TeamSessionHistoryParams {
  readonly memberId: AgentTeamMemberId
  readonly workspaceId?: WorkspaceId
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Thread context riding a `dsh-resource://team/thread/...` open. */
    readonly team: TeamResourceParams
  }
  interface SidebarRightTabParamsMap {
    readonly 'team-session-history': TeamSessionHistoryParams
  }
}

/** One copy lookup in the `team` namespace; the registry re-reads it on every use, so a language change needs no re-registration. */
export type TeamTabCopy = (key: TeamKey) => string

/**
 * The six Team tab types. `title` and guide copy are thunks over the `team`
 * dictionary; claims are exact-prefix checks through the address parser, so a
 * malformed `team` address opens nothing rather than mis-rendering.
 * @param t - the `team` copy lookup.
 * @returns one definition per Team page, in kind order.
 */
export function teamTabDefinitions(t: TeamTabCopy): readonly SidebarRightTabDefinition[] {
  return [
    {
      id: TEAM_CHANNEL_ID,
      kind: TEAM_CHANNEL_KIND,
      multiple: true,
      patterns: ['dsh-resource://team/channel/[\\s\\S]+'],
      canOpen: address => parseTeamChannelAddress(address) !== undefined,
      title: () => t('channelTab'),
    },
    {
      id: TEAM_THREAD_ID,
      kind: TEAM_THREAD_KIND,
      multiple: true,
      patterns: ['dsh-resource://team/thread/[\\s\\S]+'],
      canOpen: address => parseTeamThreadAddress(address) !== undefined,
      title: () => t('threadTab'),
    },
    {
      id: TEAM_INBOX_ID,
      kind: TEAM_INBOX_KIND,
      title: () => t('inboxTitle'),
      guide: [{ id: 'agent-team-inbox', order: 30, title: () => t('inboxTitle'), description: () => t('inboxTitle') }],
    },
    {
      id: TEAM_TASKS_ID,
      kind: TEAM_TASKS_KIND,
      title: () => t('tasksTitle'),
      guide: [{ id: 'agent-team-tasks', order: 40, title: () => t('tasksTitle'), description: () => t('tasksTitle') }],
    },
    {
      id: TEAM_MESSAGES_ID,
      kind: TEAM_MESSAGES_KIND,
      title: () => t('messagesTitle'),
      guide: [{ id: 'agent-team-messages', order: 50, title: () => t('messagesTitle'), description: () => t('messagesTitle') }],
    },
    {
      id: TEAM_SESSION_HISTORY_ID,
      kind: TEAM_SESSION_HISTORY_KIND,
      multiple: true,
      title: () => t('historyTab'),
    },
  ]
}

/** What one tab occurrence stands for, resolved from its kind, address, and params. */
export type TeamTabTarget =
  | { readonly kind: typeof TEAM_CHANNEL_KIND; readonly workspaceId: WorkspaceId; readonly channelRef: AgentTeamChannelRef }
  | {
    readonly kind: typeof TEAM_THREAD_KIND
    readonly workspaceId: WorkspaceId
    readonly threadRef: AgentTeamThreadRef
    readonly channelRef?: AgentTeamChannelRef
    readonly taskRef?: AgentTeamTaskRef
    readonly taskNumber?: number
    readonly threadOrigin?: TeamThreadOrigin
  }
  | { readonly kind: typeof TEAM_INBOX_KIND | typeof TEAM_TASKS_KIND | typeof TEAM_MESSAGES_KIND }
  | { readonly kind: typeof TEAM_SESSION_HISTORY_KIND; readonly memberId: AgentTeamMemberId; readonly workspaceId?: WorkspaceId }

/**
 * Resolve a tab occurrence to what its body must render. The address and its
 * params are authoritative; where an open carried no Workspace for a page that
 * wants one (a session history opened from the guide), the body falls back to
 * the browsed Workspace of the navigation snapshot itself. An unclaimed
 * address, a kind nobody registered, or a session-history page without its
 * Member id resolves to `undefined`, which the body draws as the welcome
 * surface.
 */
export function teamTabTargetOf(input: {
  readonly kind: string
  readonly address: string
  readonly params: SidebarRightNavigationParams | undefined
}): TeamTabTarget | undefined {
  switch (input.kind) {
    case TEAM_CHANNEL_KIND: {
      const parsed = parseTeamChannelAddress(input.address)
      if (parsed === undefined) return undefined
      return { kind: TEAM_CHANNEL_KIND as typeof TEAM_CHANNEL_KIND, workspaceId: parsed.workspaceId, channelRef: parsed.channelRef }
    }
    case TEAM_THREAD_KIND: {
      const parsed = parseTeamThreadAddress(input.address)
      if (parsed === undefined) return undefined
      const params = input.params as TeamResourceParams | undefined
      return {
        kind: TEAM_THREAD_KIND as typeof TEAM_THREAD_KIND,
        workspaceId: parsed.workspaceId,
        threadRef: parsed.threadRef,
        ...(params?.channelRef === undefined ? {} : { channelRef: params.channelRef }),
        ...(params?.taskRef === undefined ? {} : { taskRef: params.taskRef }),
        ...(params?.taskNumber === undefined ? {} : { taskNumber: params.taskNumber }),
        ...(params?.threadOrigin === undefined ? {} : { threadOrigin: params.threadOrigin }),
      }
    }
    case TEAM_INBOX_KIND:
      return { kind: TEAM_INBOX_KIND as typeof TEAM_INBOX_KIND }
    case TEAM_TASKS_KIND:
      return { kind: TEAM_TASKS_KIND as typeof TEAM_TASKS_KIND }
    case TEAM_MESSAGES_KIND:
      return { kind: TEAM_MESSAGES_KIND as typeof TEAM_MESSAGES_KIND }
    case TEAM_SESSION_HISTORY_KIND: {
      const params = input.params as TeamSessionHistoryParams | undefined
      if (params?.memberId === undefined) return undefined
      return { kind: TEAM_SESSION_HISTORY_KIND, memberId: params.memberId, ...(params.workspaceId === undefined ? {} : { workspaceId: params.workspaceId }) }
    }
    default:
      return undefined
  }
}
