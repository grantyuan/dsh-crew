import { useSyncExternalStore } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamSidebarTabBodyProps } from './slots.ts'
import { useHumanIdentity } from './human-identity.ts'
import {
  TEAM_CHANNEL_KIND,
  TEAM_INBOX_KIND,
  TEAM_MESSAGES_KIND,
  TEAM_SESSION_HISTORY_KIND,
  TEAM_TASKS_KIND,
  TEAM_THREAD_KIND,
  teamTabTargetOf,
} from './team-tab-types.ts'
import { WelcomeSurface } from './TeamWelcomeSurface.tsx'
import { TeamChannelPage } from './TeamChannelPage.tsx'
import { TeamInboxPage } from './TeamInboxPage.tsx'
import { TeamMessageCenterPage } from './TeamMessageCenterPage.tsx'
import { TeamSessionHistoryPage } from './TeamSessionHistoryPage.tsx'
import { TeamTasksPage } from './TeamTasksPage.tsx'
import { TeamThreadPage } from './TeamThreadPage.tsx'

/**
 * One Team tab body in the shipped right Sidebar: the page the tab stands for,
 * resolved from the tab's own address and navigation params — never from the
 * navigation snapshot's current face, so tabs for different Channels or
 * Threads work independently side by side. The browsed Workspace of the
 * snapshot only stands in where an open carried no Workspace at all (a page
 * seeded from the guide); an unresolvable tab draws the welcome surface.
 *
 * The dock's `TeamPageSurface` dispatch is the second caller of the same pages
 * with the same named props; while the dock still exists the two stay mirrors,
 * and the dock retires with its contract ticket.
 */
export function TeamSidebarTabBody(props: TeamSidebarTabBodyProps) {
  const { useTabInfo, useWorkspaces, t, navigation, humanIdentity, ...pages } = props
  const { tab } = useTabInfo()
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const humanAvatarProps = identity.avatarUrl === undefined ? {} : { humanAvatarUrl: identity.avatarUrl }
  const workspaceItems = useWorkspaces(state => state.items)
  const target = teamTabTargetOf({ kind: tab.kind, address: tab.contentId, params: tab.navigation.params })
  if (target === undefined) {
    const fallbackId = navigationState.workspaceId
    const fallbackTitle = fallbackId === undefined ? undefined : workspaceItems.find(workspace => workspace.workspaceId === fallbackId)?.title
    return <WelcomeSurface {...(fallbackId === undefined ? {} : { workspaceId: fallbackId })} {...(fallbackTitle === undefined ? {} : { workspaceTitle: fallbackTitle })} t={t} />
  }
  switch (target.kind) {
    case TEAM_INBOX_KIND:
      return <TeamInboxPage key={tab.id} useWorkspaces={useWorkspaces} loadInbox={pages.loadInbox} subscribeChanges={pages.subscribeChanges} readThread={pages.readThread} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} humanName={humanName} {...humanAvatarProps} t={t} />
    case TEAM_TASKS_KIND:
      return <TeamTasksPage key={tab.id} useWorkspaces={useWorkspaces} loadTasks={pages.loadTasks} subscribeChanges={pages.subscribeChanges} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} changeTasks={pages.changeTasks} loadMembers={pages.loadMembers} readThread={pages.readThread} reply={pages.reply} humanName={humanName} {...humanAvatarProps} t={t} />
    case TEAM_MESSAGES_KIND:
      return <TeamMessageCenterPage key={tab.id} useWorkspaces={useWorkspaces} loadMessageCenter={pages.loadMessageCenter} loadChannels={pages.loadChannels} readThread={pages.readThread} reply={pages.reply} subscribeChanges={pages.subscribeChanges} selectWorkspace={pages.selectWorkspace} selectThread={pages.selectThread} humanName={humanName} {...humanAvatarProps} t={t} />
    case TEAM_SESSION_HISTORY_KIND: {
      const workspaceId: WorkspaceId | undefined = target.workspaceId ?? navigationState.workspaceId
      // Leaving the review page closes its own tab: unlike a Thread's Back —
      // which lands on the list or Channel the Thread came from — session
      // history has no page underneath it, so the tab is what the Human left.
      return <TeamSessionHistoryPage key={tab.id} memberId={target.memberId} {...(workspaceId === undefined ? {} : { workspaceId })} loadMembers={pages.loadMembers} loadMemberSessions={pages.loadMemberSessions} loadMemberSessionTranscript={pages.loadMemberSessionTranscript} loadExternalContext={pages.loadExternalContext} exitSessionHistory={() => {
        pages.exitSessionHistory()
        tab.actions.close()
      }} t={t} />
    }
    case TEAM_THREAD_KIND:
      return <TeamThreadPage key={tab.id} humanName={humanName} {...humanAvatarProps} workspaceId={target.workspaceId} putAttachment={pages.putAttachment} threadRef={target.threadRef} {...(target.threadOrigin === undefined ? {} : { threadOrigin: target.threadOrigin })} {...(target.focusSequence === undefined ? {} : { focusSequence: target.focusSequence })} backFromThread={pages.backFromThread} selectChannel={pages.selectChannel} selectThread={pages.selectThread} resolveTaskRefs={pages.resolveTaskRefs} resolveThreadRefs={pages.resolveThreadRefs} openMemberSession={pages.openMemberSession} {...(target.channelRef === undefined ? {} : { channelRef: target.channelRef })} {...(target.taskRef === undefined ? {} : { taskRef: target.taskRef })} {...(target.taskNumber === undefined ? {} : { taskNumber: target.taskNumber })} drafts={pages.drafts} getAttachment={pages.getAttachment} readThread={pages.readThread} loadChannels={pages.loadChannels} loadThreadHistory={pages.loadThreadHistory} threadObservations={pages.threadObservations} summarizeThread={pages.summarizeThread} subscribeChanges={pages.subscribeChanges} loadMembers={pages.loadMembers} reply={pages.reply} editMessage={pages.editMessage} recallMessage={pages.recallMessage} changeTask={pages.changeTask} promoteThread={pages.promoteThread} t={t} />
    case TEAM_CHANNEL_KIND:
      return <TeamChannelPage key={tab.id} humanName={humanName} {...humanAvatarProps} workspaceId={target.workspaceId} channelRef={target.channelRef} drafts={pages.drafts} putAttachment={pages.putAttachment} getAttachment={pages.getAttachment} loadChannels={pages.loadChannels} subscribeChanges={pages.subscribeChanges} loadMembers={pages.loadMembers} loadInbox={pages.loadInbox} sendMessage={pages.sendMessage} joinChannel={pages.joinChannel} removeChannelMember={pages.removeChannelMember} selectThread={pages.selectThread} selectChannel={pages.selectChannel} backToChannels={pages.backToChannels} resolveTaskRefs={pages.resolveTaskRefs} resolveThreadRefs={pages.resolveThreadRefs} openMemberSession={pages.openMemberSession} t={t} />
  }
}
