import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TeamTabFace } from './dock.ts'
import type { TeamThreadOrigin } from './navigation.ts'
import type { TeamNavigationActions } from './navigation.ts'
import { teamChannelAddress, teamThreadAddress } from './team-address.ts'
import { TEAM_INBOX_KIND, TEAM_MESSAGES_KIND, TEAM_SESSION_HISTORY_KIND, TEAM_TASKS_KIND } from './team-tab-types.ts'

/**
 * The landing controller: one Team navigation face becomes one tab in the
 * shipped right Sidebar. Channels and Threads ride their `dsh-resource://team`
 * address (same address reveals the standing tab, different ones become tabs
 * beside each other); the list pages open as page types by kind; session
 * history carries its branded Member id as page params. An overview face lands
 * no tab — the column keeps whatever the Human last stood on.
 *
 * Without a mounted Session surface the Sidebar's commands throw: that is the
 * documented no-session wiring state, not a Human error, so the landing is
 * swallowed here. The navigation snapshot still remembers the face, and the
 * Team-mode re-entry pass replays it once a Session stands again.
 */
/** One Thread open's navigation params: the context the leaf carries beside
 * its own identity, plus the one-shot locate anchor when the open is a
 * Message Center 「定位」. The anchor rides params, not the address: two opens
 * of one Thread are one tab, and a new anchor is a re-navigation. */
export interface TeamThreadOpenParams {
  readonly channelRef?: string
  readonly taskRef?: string
  readonly taskNumber?: number
  readonly threadOrigin?: TeamThreadOrigin
  readonly focusSequence?: number
}

export function openTeamTabFor(face: TeamTabFace, sidebarRight: ISidebarRight, focusSequence?: number): void {
  try {
    switch (face.kind) {
      case 'channel':
        if (face.workspaceId !== undefined && face.channelRef !== undefined) sidebarRight.openResource(teamChannelAddress(face.workspaceId, face.channelRef))
        break
      case 'thread':
        if (face.workspaceId !== undefined && face.threadRef !== undefined) {
          sidebarRight.openResource(teamThreadAddress(face.workspaceId, face.threadRef), {
            params: {
              ...(face.channelRef === undefined ? {} : { channelRef: face.channelRef }),
              ...(face.taskRef === undefined ? {} : { taskRef: face.taskRef }),
              ...(face.taskNumber === undefined ? {} : { taskNumber: face.taskNumber }),
              ...(face.threadOrigin === undefined ? {} : { threadOrigin: face.threadOrigin }),
              ...(focusSequence === undefined ? {} : { focusSequence }),
            } satisfies TeamThreadOpenParams as never,
          })
        }
        break
      case 'inbox':
        sidebarRight.openTab(TEAM_INBOX_KIND)
        break
      case 'tasks':
        sidebarRight.openTab(TEAM_TASKS_KIND)
        break
      case 'messages':
        sidebarRight.openTab(TEAM_MESSAGES_KIND)
        break
      case 'sessionHistory':
        if (face.memberId !== undefined) sidebarRight.openTab(TEAM_SESSION_HISTORY_KIND, { params: { memberId: face.memberId, ...(face.workspaceId === undefined ? {} : { workspaceId: face.workspaceId }) } })
        break
      case 'overview':
        break
    }
  } catch {
    // No Session surface is mounted; the remembered face waits for the replay.
  }
}

/**
 * The navigation actions whose every move names a page that should stand in
 * the Sidebar: the raw snapshot write lands first (the memory stays the
 * authority for what Team mode reopens), then the landing pass opens or reveals
 * the tab the moved-to face names. Workspace selection and the Member-session
 * overlays are excluded: they browse or swap the center, they do not name a
 * page to open. `backFromThread` rides through — its face is the origin list or
 * the Channel, and revealing that standing tab is exactly Back's meaning.
 */
export function withTeamSidebarTabs(actions: TeamNavigationActions, land: () => void): TeamNavigationActions {
  return {
    ...actions,
    selectChannel: channelRef => {
      actions.selectChannel(channelRef)
      land()
    },
    selectThread: (threadRef, channelRef, taskRef, taskNumber, origin, focusSequence) => {
      actions.selectThread(threadRef, channelRef, taskRef, taskNumber, origin, focusSequence)
      land()
    },
    selectInbox: () => {
      actions.selectInbox()
      land()
    },
    selectTasks: () => {
      actions.selectTasks()
      land()
    },
    selectMessages: () => {
      actions.selectMessages()
      land()
    },
    selectSessionHistory: memberId => {
      actions.selectSessionHistory(memberId)
      land()
    },
    backFromThread: () => {
      actions.backFromThread()
      land()
    },
  }
}
