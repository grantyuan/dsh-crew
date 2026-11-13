import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'

function workspaceFeed() {
  return {
    getSnapshot: () => ({ items: [{ workspaceId: 'workspace:one' as never, title: 'One', path: '/one', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined }),
    subscribe: () => () => {},
  }
}

async function bench(persisted: string | null = null) {
  vi.stubGlobal('localStorage', {
    getItem: () => persisted,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  // The Team change stream the Client opens as soon as it mounts; the bench
  // never renders, so nothing consumes a change.
  const agentTeamFace = {
    changes: vi.fn(async function* () { /* the bench never renders, so nothing consumes a change */ }),
  }
  ctx.provide('remote', {
    $mount: async () => async () => {},
    $stream: (options: ConstructorParameters<typeof RemoteStream<{ version: number }>>[1]) => new RemoteStream<{ version: number }>({
      generation: { getSnapshot: () => ({}) as never, subscribe: () => () => {} },
    }, options),
    agentTeam: agentTeamFace,
  } as never)
  // The real Remote service registers each namespace twice — as a property of
  // `ctx.remote` and as the dotted service `remote.<name>` — because a plugin
  // reaches one or the other depending on whether it injects the namespace
  // (`ctx.inject(['remote.agentTeam'])`) or reads the mounted object.
  ctx.provide('remote.agentTeam', agentTeamFace)
  // rc.1: the client declares the model-catalog sub-namespace; the bench
  // supplies it so the takeover fiber is not left pending on inject.
  ctx.provide('remote.session', { modelCatalog: vi.fn(async () => ({ ok: true, value: { groups: [], failures: [] } })) })
  ctx.provide('conversation', { input: { for: () => ({ submit: vi.fn() }) } } as never)
  // The plugin declares these runtime services; the takeover bench only mounts
  // them, it never drives sessions or the model catalog.
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    search: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
  } as never)
  const uiWorkspace = { openSession: vi.fn(), startSession: vi.fn(), connectWorkspace: vi.fn(async () => 'workspace:one') }
  ctx.provide('uiWorkspace', uiWorkspace as never)
  // The Team lands its pages through the Sidebar's navigation face and
  // registers its tab types at apply time; the bench records both without the
  // shipped Sidebar behind them.
  const openResource = vi.fn()
  const openTab = vi.fn()
  // `isExpanded`/`toggleExpanded` are part of the shipped face the Member
  // session swap reads to hold the column's open state; the bench answers
  // collapsed so the restore path has nothing to do.
  const isExpanded = vi.fn(() => false)
  const toggleExpanded = vi.fn()
  ctx.provide('sidebarRight', {
    openResource,
    openTab,
    mounted: { getSnapshot: () => undefined, subscribe: () => () => {} },
    isExpanded,
    toggleExpanded,
  } as never)
  const tabTypes: { id: string; kind: string }[] = []
  ctx.provide('sidebarRightTabs', {
    register: (definition: { id: string; kind: string }) => {
      tabTypes.push(definition)
      return () => {
        const index = tabTypes.indexOf(definition)
        if (index >= 0) tabTypes.splice(index, 1)
      }
    },
    get: (kind: string) => tabTypes.find(definition => definition.kind === kind),
    entries: () => tabTypes,
  } as never)
  ctx.provide('connection', { api: { llm: { models: vi.fn(async () => ({ result: { ok: true, value: { groups: [], failures: [] } } })) } } } as never)
  ctx.provide('workspaces', {
    list: workspaceFeed(),
    pickDirectory: vi.fn(async () => null),
    create: vi.fn(),
  } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const root = () => null
  slots.register({ name: 'root', children: {
    sidebar: { kind: 'single', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
    rightbar: { kind: 'single', scope: 'root' },
  } } as never, root)
  slots.register({ name: 'sidebar', children: {
    'sidebar.workspaces': { kind: 'single', scope: 'root' },
    'sidebar.settings': { kind: 'single', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } } as never, root)
  slots.register({ name: 'sidebar.workspaces', priority: 0 }, root)
  slots.register({ name: 'sidebar.settings', priority: 0 }, root)
  // ui-sidebar-right occupies the right column in the shipped composition; the
  // bench mirrors that baseline so the specs can prove the Team leaves it
  // alone: its pages land as Sidebar tab types, never as a rightbar takeover.
  slots.register({ name: 'rightbar', priority: 0 }, root)
  // The shipped Conversation occupies the keyed main panel under the reserved
  // 'conversation' key and declares the composer seats below it, mirroring
  // the 0.1.5 ui-layout + ui-conversation tree. Team mode never registers
  // here: the conversation seat — Human or embedded Member — stays shipped.
  slots.register({ name: 'main', key: 'conversation', priority: 0, children: {
    'main.conversation': { kind: 'single', scope: 'session-maybe' },
  } } as never, root)
  slots.register({ name: 'main.conversation', priority: 0, children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
  } } as never, root)
  return { ctx, slots, uiWorkspace, openResource, openTab, tabTypes }
}

describe('Team Client slot takeover', () => {
  it('enters and leaves Team mode by shadowing its two seats, and never takes the right column or the center', async () => {
    const { ctx, slots, tabTypes } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(slots.entriesOfSlot('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entriesOfSlot('main')).toHaveLength(1)
    expect(slots.entriesOfSlot('rightbar')).toHaveLength(1)
    expect(slots.entriesOfSlot('sidebar.settings')).toHaveLength(1)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(1)
    // The six Team pages ride the Sidebar's public tab registry from apply on.
    expect(tabTypes.map(tab => tab.kind)).toEqual(['team-channel', 'team-thread', 'team-inbox', 'team-tasks', 'team-message-center', 'team-session-history'])

    ctx.teamNavigation.actions().enterTeam()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(2)
    expect(slots.entries('sidebar.settings')).toHaveLength(2)
    expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
    // The right column stays the shipped Sidebar's, and so does the center.
    expect(slots.entriesOfSlot('rightbar')).toHaveLength(1)
    expect(slots.entriesOfSlot('rightbar')[0]!.options.priority).toBe(0)
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.spec('sidebar.workspaces.directoryFlow')).toBeUndefined()

    ctx.teamNavigation.actions().leaveTeam()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('rightbar')).toHaveLength(1)
    expect(slots.entries('sidebar.settings')).toHaveLength(1)
    // The tab types outlive the mode: they are registered for the plugin's
    // lifetime, not mode-shadowed, and dispose only with the fiber.
    expect(tabTypes).toHaveLength(6)

    await fiber.dispose()
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(slots.spec('sidebar.workspaces.directoryFlow')).toBeUndefined()
  })

  it('fails loudly when another takeover claims a Team seat at the same priority', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.teamNavigation.actions().enterTeam()
    expect(() => slots.register({ name: 'sidebar.workspaces', priority: -100 }, () => null))
      .toThrow(/already has a registration at priority -100/i)
  })

  it('repeats enter and leave without leaking shadows, then restores every shipped seat on unload', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (let index = 0; index < 3; index += 1) {
      ctx.teamNavigation.actions().enterTeam()
      expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
      ctx.teamNavigation.actions().leaveTeam()
      expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
      expect(slots.entries('rightbar')).toHaveLength(1)
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
    }
    ctx.teamNavigation.actions().enterTeam()
    await fiber.dispose()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('rightbar')).toHaveLength(1)
    expect(slots.entries('sidebar.settings')).toHaveLength(1)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
  })

  it('mounts Team shadows immediately when persisted mode is Team, and lands the remembered page', async () => {
    const { ctx, slots, openResource } = await bench(JSON.stringify({ mode: 'team', workspaceId: 'workspace:one', channelRef: 'channel:engineering' }))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.teamNavigation.getSnapshot().mode).toBe('team')
    expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
    // A boot restored into Team mode is that mode's entry for this run: the
    // remembered Channel lands as a Sidebar tab.
    expect(openResource).toHaveBeenCalledWith(expect.stringContaining('dsh-resource://team/channel/'))
    await fiber.dispose()
    expect(slots.entriesOfSlot('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entriesOfSlot('rightbar')).toHaveLength(1)
  })

  it('keeps Team chrome mounted for a Member Session view and restores the return session on leave', async () => {
    const { ctx, slots, uiWorkspace } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const sessions = ctx.get('sessions') as unknown as {
      list: { getSnapshot: () => { byId?: Record<string, unknown> } }
    }
    // The root restore owner reads the list snapshot's `mainView` retention
    // (the 0.1.7 selection projection) before rebinding, so the bench's list
    // double carries the selected row.
    sessions.list.getSnapshot = () => ({ byId: { 'session:human-origin': { id: 'session:human-origin', retainedBy: { mainView: 1 } } } })

    ctx.teamNavigation.actions().selectWorkspace('workspace:one' as never)
    ctx.teamNavigation.actions().enterTeam()

    // Drive the real wiring through the workspaces shadow's injected remotes —
    // the same payload the Agent card button consumes.
    const shadow = slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.options.priority === -100)
    expect(shadow).toBeDefined()
    const injected = (shadow!.inject as () => Record<string, unknown>)()
    ;(injected.openMemberSession as (sessionId: string) => void)('session:builder')

    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session:builder')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:builder', returnToSessionId: 'session:human-origin' })
    // The conversation seat and the right column are shipped in every Team
    // state; only the two side shadows move.
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('rightbar')).toHaveLength(1)
    // The Member view registers no composer surface at all: the shipped
    // InputBar owns the bar, its trigger overlay, and the dock — the Team
    // chrome is sidebar-only around the embedded session.
    expect(slots.entries('conversation.composer.bar')).toHaveLength(0)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    // Direct Member-to-Member navigation keeps the zero-surface invariant.
    sessions.list.getSnapshot = () => ({ byId: { 'session:reviewer': { id: 'session:reviewer', retainedBy: { mainView: 1 } }, 'session:human-origin': {} } })
    ctx.teamNavigation.actions().enterMemberSession('session:reviewer' as never)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(slots.entries('sidebar.workspaces')).toHaveLength(2)
    expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
    expect(slots.entriesOfSlot('sidebar.settings')[0]!.options.priority).toBe(-100)

    // The footer's wrapped leave closes the Member view and restores the
    // Human's original session before deregistering the Team chrome.
    const footer = slots.entriesOfSlot('sidebar.footer.action')[0]!
    const footerActions = (footer.inject as () => Record<string, unknown>)()
    ;(footerActions.leaveTeam as () => void)()

    expect(uiWorkspace.openSession).toHaveBeenLastCalledWith('session:human-origin')
    expect(ctx.teamNavigation.getSnapshot()).toEqual({ mode: 'conversation', workspaceId: 'workspace:one' })
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(slots.entriesOfSlot('main')).toHaveLength(1)
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)

    await fiber.dispose()
  })

  it('never captures a Member Session as the return target when the main view still retains one', async () => {
    const { ctx, slots, uiWorkspace } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const sessions = ctx.get('sessions') as unknown as {
      list: { getSnapshot: () => { byId?: Record<string, unknown> } }
    }
    ctx.teamNavigation.actions().selectWorkspace('workspace:one' as never)
    ctx.teamNavigation.actions().enterTeam()
    const shadow = slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.options.priority === -100)
    const injected = (shadow!.inject as () => Record<string, unknown>)()

    // Nothing is retained yet, so this first entry has no return target at all.
    ;(injected.openMemberSession as (sessionId: string) => void)('session:builder')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session:builder')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:builder' })
    expect(ctx.teamNavigation.getSnapshot().returnToSessionId).toBeUndefined()

    // The workspace service retains the Member's session, and leaving the view
    // restores nothing (there was no return target), so the retention stays on
    // the departed Member — the state the next entry must not read as the
    // Human's own conversation.
    sessions.list.getSnapshot = () => ({ byId: { 'session:builder': { id: 'session:builder', retainedBy: { mainView: 1 } } } })
    ctx.teamNavigation.actions().exitMemberSession()
    expect(uiWorkspace.openSession).toHaveBeenCalledTimes(1)

    // A second Member entry therefore captures no return target: returning into
    // another Member's session would strand the Human one view deeper instead
    // of back at their own conversation.
    ;(injected.openMemberSession as (sessionId: string) => void)('session:reviewer')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:reviewer' })
    expect(ctx.teamNavigation.getSnapshot().returnToSessionId).toBeUndefined()
    expect(uiWorkspace.openSession).toHaveBeenLastCalledWith('session:reviewer')

    await fiber.dispose()
  })

  it('closes an embedded Member Session view when explicit Team navigation arrives', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.teamNavigation.actions().enterTeam()
    ctx.teamNavigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    // The conversation seat never changed hands; the Member view is a
    // selection, not a Team takeover.
    expect(slots.entries('main')).toHaveLength(1)

    ctx.teamNavigation.actions().selectChannel('channel:engineering' as never)
    expect(ctx.teamNavigation.getSnapshot().memberSessionId).toBeUndefined()
    expect(slots.entries('main')).toHaveLength(1)
    // Team chrome stays mounted through the whole exchange; the Channel lands
    // as a Sidebar tab, not as a takeover.
    expect(slots.entries('rightbar')).toHaveLength(1)

    await fiber.dispose()
  })

})
