// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamChannelRef, AgentTeamInbox, AgentTeamMemberId, AgentTeamThreadRef, AgentTeamView } from '@grantyuan/dsh-crew/types'
import type { TeamKey } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'
import { TeamDraftStore } from '../src/client/drafts.ts'
import { teamChannelAddress, teamThreadAddress } from '../src/client/team-address.ts'
import { TEAM_CHANNEL_KIND, TEAM_INBOX_KIND, TEAM_SESSION_HISTORY_KIND, TEAM_THREAD_KIND } from '../src/client/team-tab-types.ts'
import { TeamSidebarTabBody } from '../src/client/TeamSidebarTabBody.tsx'
import type { TeamSidebarTabBodyProps } from '../src/client/slots.ts'

/**
 * The sidebar tab body is a thin resolver: the page under it must render what
 * the tab's own address and params name, never the navigation snapshot's
 * current face. These benches render the body with a stubbed tab occurrence
 * (the shipped Sidebar's store and panes are out of this package's scope) and
 * assert the mount reads land on the right Workspace, Channel, Thread, or
 * Member — including two Channel tabs living independently at once.
 */

const workspace = 'w1' as WorkspaceId

const EMPTY_VIEW = {
  humanMemberId: 'member:human',
  workspaces: [], channels: [], members: [], tasks: [], threads: [], taskNumbers: [],
  items: [], activeTaskThreads: [], claims: [], activities: [],
  cursor: 0, hasMore: false,
} as unknown as AgentTeamView

const EMPTY_INBOX = {
  humanMemberId: 'member:human', items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0,
} as unknown as AgentTeamInbox

// useSyncExternalStore re-entrants forever when getSnapshot returns a fresh
// object every read; both doubles hand back the same reference, like the real
// TeamNavigation and TeamHumanIdentity do.
const NAVIGATION_SNAPSHOT = { mode: 'team' as const, workspaceId: workspace }
const IDENTITY_SNAPSHOT = { status: 'ready', name: 'Yus', updateAvailable: false } as const
const WORKSPACES_STATE = { items: [{ workspaceId: 'w1', title: 'Alpha' }] }

function bodyProps(tab: { readonly kind: string; readonly address: string; readonly params?: Record<string, unknown> | undefined }) {
  const remotes = {
    loadChannels: vi.fn(async () => ({ ok: true as const, value: EMPTY_VIEW })),
    loadMembers: vi.fn(async () => ({ ok: true as const, value: [] })),
    loadInbox: vi.fn(async () => ({ ok: true as const, value: EMPTY_INBOX })),
    loadTasks: vi.fn(async () => ({ ok: true as const, value: { tasks: [], taskNumbers: [] } })),
    loadMessageCenter: vi.fn(async () => ({ ok: true as const, value: { topics: [], messages: [] } })),
    readThread: vi.fn(async () => ({ ok: false as const, error: { message: 'bench' } })),
    loadThreadHistory: vi.fn(async () => ({ ok: false as const, error: { message: 'bench' } })),
    threadObservations: vi.fn(async () => ({ ok: true as const, value: { observations: [] } })),
    summarizeThread: vi.fn(async () => ({ ok: false as const, error: { message: 'bench' } })),
    putAttachment: vi.fn(async () => ({ ok: true as const, value: {} })),
    getAttachment: vi.fn(async () => ({ ok: false as const, error: { message: 'bench' } })),
    sendMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    joinChannel: vi.fn(async () => ({ ok: true as const, value: {} })),
    removeChannelMember: vi.fn(async () => ({ ok: true as const, value: {} })),
    reply: vi.fn(async () => ({ ok: true as const, value: {} })),
    editMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    recallMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    changeTask: vi.fn(async () => ({ ok: true as const, value: {} })),
    changeTasks: vi.fn(async () => ({ ok: true as const, value: {} })),
    promoteThread: vi.fn(async () => ({ ok: true as const, value: {} })),
    resolveTaskRefs: vi.fn(async () => ({ ok: true as const, value: {} })),
    resolveThreadRefs: vi.fn(async () => ({ ok: true as const, value: {} })),
    loadMemberSessions: vi.fn(async () => ({ ok: true as const, value: [] })),
    loadMemberSessionTranscript: vi.fn(async () => ({ ok: true as const, value: { events: [], cursor: 0, hasMore: false } })),
    loadExternalContext: vi.fn(async () => ({ ok: true as const, value: {} })),
  }
  // Stable snapshot references: useSyncExternalStore re-entrants forever when
  // getSnapshot returns a fresh object every read.
  const props = {
    useTabInfo: () => ({
      tab: {
        id: `tab:${tab.kind}:${tab.address}`,
        kind: tab.kind,
        contentId: tab.address,
        title: tab.kind,
        navigation: { address: tab.address, params: tab.params, revision: 1 },
        signal: new AbortController().signal,
      },
    }),
    useWorkspaces: (selector: (state: { items: readonly { workspaceId: string; title: string }[] }) => unknown) => selector(WORKSPACES_STATE),
    t: (key: TeamKey) => zh[key],
    navigation: { getSnapshot: () => NAVIGATION_SNAPSHOT, subscribe: () => () => {} },
    humanIdentity: { getSnapshot: () => IDENTITY_SNAPSHOT, subscribe: () => () => {} },
    subscribeChanges: () => () => {},
    drafts: new TeamDraftStore(),
    selectWorkspace: vi.fn(),
    selectThread: vi.fn(),
    selectChannel: vi.fn(),
    backFromThread: vi.fn(),
    backToChannels: vi.fn(),
    exitSessionHistory: vi.fn(),
    openMemberSession: vi.fn(),
    ...remotes,
  }
  return { props, remotes }
}

describe('Team sidebar tab body', () => {
  afterEach(cleanup)

  it('renders the Channel its own address names, reading through it', async () => {
    const address = teamChannelAddress(workspace, 'channel:a' as AgentTeamChannelRef)
    const { props, remotes } = bodyProps({ kind: TEAM_CHANNEL_KIND, address })
    const { container } = render(<TeamSidebarTabBody {...(props as unknown as TeamSidebarTabBodyProps)} />)
    await waitFor(() => expect(remotes.loadChannels).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', channelRef: 'channel:a' })))
    expect(container.querySelector('[data-team-dock-welcome]')).toBeNull()
  })

  it('keeps two Channel tabs for two refs independent of one another', async () => {
    const first = bodyProps({ kind: TEAM_CHANNEL_KIND, address: teamChannelAddress(workspace, 'channel:a' as AgentTeamChannelRef) })
    const second = bodyProps({ kind: TEAM_CHANNEL_KIND, address: teamChannelAddress(workspace, 'channel:b' as AgentTeamChannelRef) })
    render(<TeamSidebarTabBody {...(first.props as unknown as TeamSidebarTabBodyProps)} />)
    render(<TeamSidebarTabBody {...(second.props as unknown as TeamSidebarTabBodyProps)} />)
    await waitFor(() => expect(first.remotes.loadChannels).toHaveBeenCalledWith(expect.objectContaining({ channelRef: 'channel:a' })))
    await waitFor(() => expect(second.remotes.loadChannels).toHaveBeenCalledWith(expect.objectContaining({ channelRef: 'channel:b' })))
    expect(first.remotes.loadChannels).not.toHaveBeenCalledWith(expect.objectContaining({ channelRef: 'channel:b' }))
  })

  it('rides the Thread address plus the channel/task context the open carried', async () => {
    const { props, remotes } = bodyProps({
      kind: TEAM_THREAD_KIND,
      address: teamThreadAddress(workspace, 'thread:9' as AgentTeamThreadRef),
      params: { channelRef: 'channel:a', taskNumber: 7 },
    })
    render(<TeamSidebarTabBody {...(props as unknown as TeamSidebarTabBodyProps)} />)
    await waitFor(() => expect(remotes.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:9' })))
    // The context the open carried rides the supplemental view read, not the
    // history request — same precedence the dock's tab gave it.
    await waitFor(() => expect(remotes.loadChannels).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', threadRef: 'thread:9', channelRef: 'channel:a' })))
  })

  it('opens a Member session history from its page params, and welcomes without them', async () => {
    const opened = bodyProps({ kind: TEAM_SESSION_HISTORY_KIND, address: 'sidebar://page/team-session-history', params: { memberId: 'member:iris', workspaceId: 'w1' } })
    const { container: openedBox } = render(<TeamSidebarTabBody {...(opened.props as unknown as TeamSidebarTabBodyProps)} />)
    await waitFor(() => expect(opened.remotes.loadMemberSessions).toHaveBeenCalledWith({ memberId: 'member:iris' }))
    expect(openedBox.querySelector('[data-team-dock-welcome]')).toBeNull()
    const bare = bodyProps({ kind: TEAM_SESSION_HISTORY_KIND, address: 'sidebar://page/team-session-history', params: undefined })
    const { container: bareBox } = render(<TeamSidebarTabBody {...(bare.props as unknown as TeamSidebarTabBodyProps)} />)
    expect(bareBox.querySelector('[data-team-dock-welcome]')).not.toBeNull()
  })

  it('draws the welcome surface for an unclaimed address or a kind no Team type registered', () => {
    const crossed = bodyProps({ kind: TEAM_CHANNEL_KIND, address: teamThreadAddress(workspace, 'thread:9' as AgentTeamThreadRef) })
    const { container: crossedBox } = render(<TeamSidebarTabBody {...(crossed.props as unknown as TeamSidebarTabBodyProps)} />)
    expect(crossedBox.querySelector('[data-team-dock-welcome]')).not.toBeNull()
    const unknown = bodyProps({ kind: 'some-other-kinds-tab', address: 'dsh-resource://file/session/s1/a.md' })
    const { container: unknownBox } = render(<TeamSidebarTabBody {...(unknown.props as unknown as TeamSidebarTabBodyProps)} />)
    expect(unknownBox.querySelector('[data-team-dock-welcome]')).not.toBeNull()
  })

  it('opens the Inbox page for the browsed Workspace without reading any Channel', async () => {
    const { props, remotes } = bodyProps({ kind: TEAM_INBOX_KIND, address: 'sidebar://page/team-inbox' })
    const { container } = render(<TeamSidebarTabBody {...(props as unknown as TeamSidebarTabBodyProps)} />)
    await waitFor(() => expect(remotes.loadInbox).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1' })))
    expect(remotes.loadChannels).not.toHaveBeenCalled()
    expect(container.querySelector('[data-team-dock-welcome]')).toBeNull()
  })
})
