import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamInterruptRef,
  AgentTeamInterruptView,
  AgentTeamMemberId,
  AgentTeamMemberTaskQueue,
  AgentTeamModelSelection,
  AgentTeamQueueEntryItem,
  AgentTeamQueueEntryRef,
  AgentTeamRequestId,
  AgentTeamTaskRow,
  AgentTeamTasks,
  AgentTeamView,
} from '@grantyuan/dsh-crew/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconArchiveOutlineRegular, IconClockOutlineRegular, IconEditOutlineRegular, IconGaugeOutlineRegular, IconInspectOutlineRegular, IconNewChatOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatAbsoluteTime, formatInboxTime, taskStatusDot } from './team-formatters.ts'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { SortableRow, useSidebarRowDrag } from './sidebar-drag.tsx'
import { moveSidebarItem, useSidebarOrder } from './sidebar-order.ts'
import { useSidebarSectionOpen, setSidebarSectionOpen } from './sidebar-sections.ts'
import { mintRequestId } from './requests.ts'
import { diagnosticText } from './TeamPresenceDot.tsx'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { AgentEditorDialog, ContextPickerField, MemberPromptDialog, ModelFallbackPickerField, ModelPickerField, parseContextWindow, sameModel, warmModelCatalog } from './TeamMemberEditor.tsx'
import { TeamAgentImport } from './TeamAgentImport.tsx'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamAgentsPanelProps {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly loadTasks: TeamSidebarProps['loadTasks']
  readonly queueAssign: TeamSidebarProps['queueAssign']
  readonly queueAmend: TeamSidebarProps['queueAmend']
  readonly queueReassign: TeamSidebarProps['queueReassign']
  /** Human Channel-membership grant behind the queue dialog's join-and-reassign fallback. */
  readonly joinChannel: TeamSidebarProps['joinChannel']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly addMember: TeamSidebarProps['addMember']
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
  readonly curateMemberPrompt: TeamSidebarProps['curateMemberPrompt']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly clearMemberContext: TeamSidebarProps['clearMemberContext']
  readonly compactMemberContext: TeamSidebarProps['compactMemberContext']
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly selectSessionHistory: TeamSidebarProps['selectSessionHistory']
  readonly diagnoseMember: TeamSidebarProps['diagnoseMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly joinWorkspace: TeamSidebarProps['joinWorkspace']
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly selectThread: TeamSidebarProps['selectThread']
  /** The Member Session currently embedded in the conversation seat, if any. */
  readonly memberSessionId?: AgentTeamClientMemberStatus['member']['sessionId']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onCreatingChange: (request: AgentTeamAddMemberRequest, creating: boolean) => void
  readonly t: TeamSidebarProps['t']
}

export function TeamAgentsPanel({ workspaceId, loadMembers, loadMemberTasks, loadTasks, queueAssign, queueAmend, queueReassign, joinChannel, sendMessage, subscribeChanges, addMember, updateMember, loadPromptView, curateMemberPrompt, recoverMember, clearMemberContext, compactMemberContext, loadMemberInterrupts, releaseMemberInterrupt, selectSessionHistory, diagnoseMember, archiveMember, joinWorkspace, leaveWorkspace, loadChannels, loadModels, selectThread, memberSessionId, openMemberSession, onCreatingChange, t }: TeamAgentsPanelProps) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const [fallbacks, setFallbacks] = useState<readonly AgentTeamModelSelection[]>([])
  const [policy, setPolicy] = useState<'continue' | 'fresh'>('continue')
  const [windowText, setWindowText] = useState('')
  const [promptText, setPromptText] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const parsedWindow = parseContextWindow(windowText)
  const windowInvalid = Number.isNaN(parsedWindow)
  const [creating, setCreating] = useState(false)
  const [retryRequest, setRetryRequest] = useState<AgentTeamAddMemberRequest>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Same presentation-preference ordering as the Channels list; the drag
  // commits through one shared mutation.
  const agentRefs = useMemo(() => members.map(status => status.member.memberId), [members])
  const orderedAgentRefs = useSidebarOrder(workspaceId, 'agents', agentRefs)
  const orderedMembers = useMemo(() => {
    const byId = new Map(members.map(status => [status.member.memberId, status]))
    return orderedAgentRefs.map(memberId => byId.get(memberId)).filter(status => status !== undefined)
  }, [orderedAgentRefs, members])
  const applyMove = (movedRef: typeof agentRefs[number], targetRef: typeof agentRefs[number], marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'agents', orderedAgentRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedAgentRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'agents')

  // Observed old→new Session binding per Member while this panel is
  // mounted. A model-initiated rollover moves the binding without any
  // Client action; when the conversation seat is showing the Member's
  // previous live Session, the panel follows to the new one exactly once —
  // but only after the refreshed status is actually active, so the commit
  // window (binding moved, new Session not yet live) never redirects to a
  // Session that does not exist. The follow requires the seat to still show
  // the previous Session at completion as well: a rollover observed while
  // unavailable stays pending, and navigating away before it completes
  // cancels the follow instead of pulling the pane back.
  const observedSessionIds = useRef(new Map<string, AgentTeamClientMemberStatus['member']['sessionId']>())
  const pendingFollows = useRef(new Map<string, { readonly previousSessionId: AgentTeamClientMemberStatus['member']['sessionId']; readonly nextSessionId: AgentTeamClientMemberStatus['member']['sessionId'] }>())
  // The seat's embedded Session id rides a ref: the change subscription may
  // deliver an invalidation through a refresh closure captured before the
  // seat rebinds, and the follow decision must always read the live value.
  const seatSessionIdRef = useRef(memberSessionId)
  seatSessionIdRef.current = memberSessionId
  const openMemberSessionRef = useRef(openMemberSession)
  openMemberSessionRef.current = openMemberSession
  const followRollover = useCallback((statuses: readonly AgentTeamClientMemberStatus[]) => {
    for (const status of statuses) {
      const memberId = status.member.memberId
      const observed = observedSessionIds.current.get(memberId)
      if (observed === undefined) {
        observedSessionIds.current.set(memberId, status.member.sessionId)
        continue
      }
      if (observed !== status.member.sessionId) {
        observedSessionIds.current.set(memberId, status.member.sessionId)
        // Only the exact previous live page follows; browsing an older
        // archive or another Member stays untouched. A binding change seen
        // before any page is embedded is still recorded so the observation
        // baseline stays current.
        const seatSessionId = seatSessionIdRef.current
        if (seatSessionId !== undefined && observed === seatSessionId) pendingFollows.current.set(memberId, { previousSessionId: observed, nextSessionId: status.member.sessionId })
        else pendingFollows.current.delete(memberId)
      }
      const pending = pendingFollows.current.get(memberId)
      if (pending !== undefined && pending.nextSessionId === status.member.sessionId && status.availability === 'active') {
        // The seat must still show the followed Member's previous Session at
        // completion too: the commit window can outlive the user's patience,
        // and navigating away (or onto another Member/archive view) cancels
        // the follow instead of yanking the pane back onto the new Session.
        const seatSessionId = seatSessionIdRef.current
        pendingFollows.current.delete(memberId)
        if (seatSessionId !== undefined && seatSessionId === pending.previousSessionId) openMemberSessionRef.current(pending.nextSessionId)
      }
    }
  }, [])

  // Only the first refresh owns the loading surface; presence wakes (Agent
  // running/idle) ride the dedicated scope and refresh rows in place.
  const loadedRef = useRef(false)
  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const result = await loadMembers({ workspaceId })
    if (result.ok) {
      // Archived Members are hidden from every surface; the row disappears
      // the moment the workspace-scope wake delivers the archived state.
      const next = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      setMembers(next)
      followRollover(next)
      setError(undefined)
      loadedRef.current = true
    } else {
      setError(result.error.message)
    }
    setLoading(false)
  }, [loadMembers, workspaceId, followRollover])

  useEffect(() => { void refresh() }, [refresh])
  // Warm the Host model catalog while the roster loads, so the create and
  // edit pickers open with rows instead of paying the first read on open.
  // Mount-scoped (not per refresh): presence wakes must not refetch it.
  useEffect(() => { warmModelCatalog(loadModels) }, [loadModels])
  useEffect(() => subscribeChanges({ kind: 'workspace', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    // The section stays mounted across Channel creation, so the Member roster
    // rides every workspace invalidation.
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])
  // Presence transitions commit nothing: the Host wakes only this scope, so
  // the green dots stay live without any catalog refetch.
  useEffect(() => subscribeChanges({ kind: 'presence', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])

  const closeForm = () => {
    if (creating) return
    setFormOpen(false)
    queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const provision = async (request: AgentTeamAddMemberRequest) => {
    setCreating(true)
    onCreatingChange(request, true)
    setError(undefined)
    setRetryRequest(request)
    try {
      const result = await addMember(request)
      if (result.ok) {
        const committed = { ...result.value.status, workspaceIds: result.value.workspaceIds }
        setMembers(current => {
          const retained = current.filter(status => status.member.memberId !== committed.member.memberId)
          return committed.member.state === 'inactive' || committed.member.state === 'archived' ? retained : [...retained, committed]
        })
        setHandle('')
        setDescription('')
        setModel(undefined)
        setFallbacks([])
        setPolicy('continue')
        setWindowText('')
        setPromptText('')
        setFormOpen(false)
        if (result.value.status.presence === 'unavailable') {
          setError(diagnosticText(result.value.status) || t('statusUnavailable'))
        } else {
          setRetryRequest(undefined)
        }
        queueMicrotask(() => { triggerRef.current?.focus() })
      } else {
        await refresh()
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      onCreatingChange(request, false)
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (normalizedHandle.length === 0 || creating || windowInvalid) return
    const stagedPrompt = promptText.trim() === '' ? undefined : promptText
    const sameRequest = retryRequest !== undefined && retryRequest.workspaceId === workspaceId
      && retryRequest.handle === normalizedHandle && retryRequest.description === normalizedDescription
      && sameModel(retryRequest.model, model)
      && (retryRequest.contextStartPolicy ?? 'continue') === policy
      && retryRequest.contextWindow === parsedWindow
      && (retryRequest.prompt?.customPrompt ?? undefined) === stagedPrompt
      && retryRequest.channelRefs.length === 0
    void provision(sameRequest ? retryRequest : {
      requestId: mintRequestId(),
      workspaceId,
      handle: normalizedHandle,
      description: normalizedDescription,
      presetId: 'team-member',
      // No initial Channels at creation: the Member joins Channels later from
      // the Channel side and stays reachable through its DM view meanwhile.
      channelRefs: [],
      ...(model === undefined ? {} : { model }),
      ...(fallbacks.length === 0 ? {} : { modelFallbacks: fallbacks }),
      // Same absent-clears mapping as the editor: the fresh policy is only
      // sent when picked, and an empty window input means "follow the route
      // window".
      ...(policy === 'fresh' ? { contextStartPolicy: policy } : {}),
      ...(parsedWindow === undefined ? {} : { contextWindow: parsedWindow }),
      // The staged paragraph rides the member-added commit; an empty or blank
      // one stays absent — the same shape the Host's normalization stores.
      ...(stagedPrompt === undefined ? {} : { prompt: { customPrompt: stagedPrompt } }),
    })
  }

  return (
    <div className={css.panel}>
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('addAgent')}
        closeLabel={t('close')}
        className={createCss.dialogWide!}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={creating} onClick={closeForm}>{t('cancel')}</Button>{!importing && <Button type="submit" form="team-agent-create-form" variant="primary" disabled={creating || handle.trim().length === 0 || windowInvalid}>{creating ? t('creatingAgent') : t('createAgent')}</Button>}</>}
      >
        <Button className={createCss.modeSwitch!} variant="outline" disabled={creating} aria-expanded={importing} onClick={() => { setImporting(value => !value); setError(undefined) }}>{importing ? t('createAgent') : t('importAgentTitle')}</Button>
        {formOpen && importing ? <TeamAgentImport workspaceId={workspaceId} loadMembers={loadMembers} joinWorkspace={joinWorkspace} onPending={setCreating} onJoined={async () => { await refresh(); setFormOpen(false); queueMicrotask(() => { triggerRef.current?.focus() }) }} t={t} /> : <form id="team-agent-create-form" className={createCss.form} onSubmit={submit}>
          <label className={createCss.field}>
            <span>{t('agentName')}</span>
            <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); setRetryRequest(undefined) }} disabled={creating} autoFocus />
          </label>
          <label className={createCss.field}>
            <span>{t('agentDescription')}{t('optionalSuffix')}</span>
            <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); setRetryRequest(undefined) }} disabled={creating} />
          </label>
          <ModelPickerField model={model} onModelChange={choice => { setModel(choice); setRetryRequest(undefined) }} loadModels={loadModels} disabled={creating} t={t} />
          <ModelFallbackPickerField fallbacks={fallbacks} onChange={next => { setFallbacks(next); setRetryRequest(undefined) }} primary={model} loadModels={loadModels} disabled={creating} t={t} />
          <ContextPickerField
            policy={policy}
            onPolicyChange={next => { setPolicy(next); setRetryRequest(undefined) }}
            windowText={windowText}
            onWindowTextChange={text => { setWindowText(text); setRetryRequest(undefined) }}
            invalid={windowInvalid}
            disabled={creating}
            t={t}
          />
          <div className={createCss.field}>
            <span>{t('memberPrompt')}</span>
            <Button variant="outline" disabled={creating} onClick={() => { setPromptOpen(true) }}>{t('memberPromptEdit')}</Button>
            <small className={css.editHint}>{t('memberPromptHint')}</small>
          </div>
          {formOpen && error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
        </form>}
      </Modal>
      {formOpen && promptOpen && (
        <MemberPromptDialog
          mode="stage"
          initialText={promptText}
          onApply={next => { setPromptText(next); setRetryRequest(undefined) }}
          onClose={() => { setPromptOpen(false) }}
          t={t}
        />
      )}
      <TeamSidebarSection
        title={t('agents')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'agents', open) }}
        actions={(
          <Tooltip label={t('addAgent')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addAgent')} onClick={() => { setError(undefined); setImporting(false); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && members.length === 0 && <p className={css.emptyState}>{t('loadingAgents')}</p>}
        {/* `members` is empty both before the first successful load and after a
            failed one, so the empty claim additionally requires a clear error. */}
        {!loading && error === undefined && members.length === 0 && <p className={css.emptyState}>{t('emptyAgents')}</p>}
        <div className={css.agentList}>
          {orderedMembers.map(status => (
            <SortableRow key={status.member.memberId} drag={drag} orderKey={status.member.memberId}>
              <AgentRow workspaceId={workspaceId} leaveWorkspace={leaveWorkspace} status={status} {...(memberSessionId === undefined ? {} : { current: status.member.sessionId === memberSessionId })} updateMember={updateMember} loadPromptView={loadPromptView} curateMemberPrompt={curateMemberPrompt} recoverMember={recoverMember} clearMemberContext={clearMemberContext} compactMemberContext={compactMemberContext} loadMemberInterrupts={loadMemberInterrupts} releaseMemberInterrupt={releaseMemberInterrupt} selectSessionHistory={selectSessionHistory} diagnoseMember={diagnoseMember} archiveMember={archiveMember} loadChannels={loadChannels} loadModels={loadModels} openMemberSession={openMemberSession} members={members} loadMemberTasks={loadMemberTasks} loadTasks={loadTasks} queueAssign={queueAssign} queueAmend={queueAmend} queueReassign={queueReassign} joinChannel={joinChannel} sendMessage={sendMessage} selectThread={selectThread} onUpdated={refresh} t={t} />
            </SortableRow>
          ))}
        </div>
      </TeamSidebarSection>
      {!formOpen && error !== undefined && (
        <div className={css.retryError} role="alert">
          <span>{error}</span>
          {retryRequest !== undefined && <button type="button" className={css.textButton} disabled={creating} onClick={() => { setFormOpen(true) }}>{t('retry')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * One sidebar Agent row: the select button opens the Member's own Session
 * conversation page, the avatar carries identity plus the presence badge, and
 * the row menu opens the editor. The row menu's Task-queue entry opens the
 * Member's working queue — current Claims and unclaimed Channel work, each
 * row opening its Thread, each row asking the Team leader to reassign it.
 */
function AgentRow({ workspaceId, leaveWorkspace, status, current, updateMember, loadPromptView, curateMemberPrompt, recoverMember, clearMemberContext, compactMemberContext, loadMemberInterrupts, releaseMemberInterrupt, selectSessionHistory, diagnoseMember, archiveMember, loadChannels, loadModels, openMemberSession, members, loadMemberTasks, loadTasks, queueAssign, queueAmend, queueReassign, joinChannel, sendMessage, selectThread, onUpdated, t }: {
  readonly workspaceId: WorkspaceId
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly status: AgentTeamClientMemberStatus
  /** This Member's Session is the one embedded in the conversation seat. */
  readonly current?: boolean
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadPromptView: TeamSidebarProps['loadPromptView']
  readonly curateMemberPrompt: TeamSidebarProps['curateMemberPrompt']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly clearMemberContext: TeamSidebarProps['clearMemberContext']
  readonly compactMemberContext: TeamSidebarProps['compactMemberContext']
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly selectSessionHistory: TeamSidebarProps['selectSessionHistory']
  readonly diagnoseMember: TeamSidebarProps['diagnoseMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  /** Human Message lane behind the freeform-requirement assignment. */
  readonly sendMessage: TeamSidebarProps['sendMessage']
  /** The Workspace roster, behind the queue dialog's reassign and append pickers. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly loadTasks: TeamSidebarProps['loadTasks']
  readonly queueAssign: TeamSidebarProps['queueAssign']
  readonly queueAmend: TeamSidebarProps['queueAmend']
  readonly queueReassign: TeamSidebarProps['queueReassign']
  /** Human Channel-membership grant behind the reassign dialog's join-and-reassign fallback. */
  readonly joinChannel: TeamSidebarProps['joinChannel']
  readonly selectThread: TeamSidebarProps['selectThread']
  readonly onUpdated: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [interruptsOpen, setInterruptsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const [archivePending, setArchivePending] = useState(false)
  const [resetPending, setResetPending] = useState(false)
  const [compactPending, setCompactPending] = useState(false)
  const [diagnosePending, setDiagnosePending] = useState(false)
  const [compactModel, setCompactModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const archiveRequest = useRef<ReturnType<typeof mintRequestId>>()
  const withdrawing = workspaceId !== status.member.workspaceId
  // Both row actions ride the same runtime remote: the Host steers a live
  // session, rebuilds an orphaned composition, or re-runs a failed activation.
  const recover = async (): Promise<void> => {
    try {
      const result = await recoverMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      await onUpdated()
      if (!result.ok) {
        setRowAlert(t('restartFailed', { message: result.error.message }))
        return
      }
      if (result.value.status.availability === 'unavailable') {
        setRowAlert(t('restartStillUnavailable', { diagnostic: diagnosticText(result.value.status) || t('statusUnavailable') }))
        return
      }
      setRowAlert(undefined)
      // A page opened while the Member was down predates the live Session;
      // re-selecting is a no-op when already bound and rebinds when stale.
      if (current === true) openMemberSession(status.member.sessionId)
    } catch (cause) {
      setRowAlert(t('restartFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  const archive = async (): Promise<void> => {
    if (archivePending) return
    setArchivePending(true)
    setRowAlert(undefined)
    archiveRequest.current ??= mintRequestId()
    const request = { requestId: archiveRequest.current, memberId: status.member.memberId }
    try {
      const result = withdrawing ? await leaveWorkspace({ ...request, workspaceId }) : await archiveMember(request)
      if (!result.ok) throw new Error(result.error.message)
      setArchiving(false)
      archiveRequest.current = undefined
      await onUpdated()
    } catch (cause) {
      setRowAlert(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivePending(false)
    }
  }
  const reset = async (): Promise<void> => {
    if (resetPending) return
    setResetPending(true)
    setRowAlert(undefined)
    try {
      const result = await clearMemberContext({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      if (!result.ok) throw new Error(result.error.message)
      setResetting(false)
      await onUpdated()
      // The seat may still show the retired Session; rebind it to the renewed one.
      if (current === true) openMemberSession(result.value.status.member.sessionId)
    } catch (cause) {
      setRowAlert(t('resetAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setResetPending(false)
    }
  }
  const compact = async (): Promise<void> => {
    if (compactPending) return
    setCompactPending(true)
    setRowAlert(undefined)
    try {
      const result = await compactMemberContext({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
        ...(compactModel === undefined ? {} : { model: compactModel }),
      })
      if (!result.ok) throw new Error(result.error.message)
      setCompacting(false)
      // Schedule-time acknowledgement only: the Host runs the compaction
      // behind the Member's current activity, and the conversation surface
      // shows the committed summary once it lands.
      setRowAlert(t('compactAgentScheduled'))
      await onUpdated()
    } catch (cause) {
      setRowAlert(t('compactAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCompactPending(false)
    }
  }
  // The Host creates or reuses the durable `doctor` Member, starts it on a
  // fresh Session, and hands it the failed Member's transcript as research
  // material; the doctor reports its analysis to the Human.
  const diagnose = async (): Promise<void> => {
    if (diagnosePending) return
    setDiagnosePending(true)
    setRowAlert(undefined)
    try {
      const result = await diagnoseMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      if (!result.ok) throw new Error(result.error.message)
      setRowAlert(t('analyzeAgentDispatched', { name: status.member.handle }))
      await onUpdated()
    } catch (cause) {
      setRowAlert(t('analyzeAgentFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setDiagnosePending(false)
    }
  }
  return (
    <>
      <div className={css.agentRow} data-agent-row data-menu-open={menuOpen || undefined}>
        <button type="button" className={css.agentSelect} aria-label={t('openAgentSession', { name: status.member.handle })} aria-current={current ? 'page' : undefined} disabled={status.availability !== 'active'} onClick={() => { openMemberSession(status.member.sessionId) }}>
          <TeamMemberIdentity status={status} name={status.member.handle.replace(/^@/, '')} className={css.agentCopy} t={t} />
        </button>
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsAgent', { name: status.member.handle })}
            items={[
              { id: 'edit', label: t('editAgent'), icon: <IconEditOutlineRegular /> },
              ...(status.presence === 'error' ? [
                { id: 'resume', label: t('resumeAgent'), icon: <IconPlayOutlineRegular /> },
                { id: 'diagnose', label: t('analyzeAgent'), icon: <IconInspectOutlineRegular /> },
              ] : []),
              ...(status.availability === 'unavailable' ? [{ id: 'restart', label: t('restartAgent'), icon: <IconRefreshOutlineRegular /> }] : []),
              // Both context actions need a live Member Session: the Host
              // rollover replaces the active log, and compaction is scheduled
              // behind the active Agent's current activity.
              ...(status.availability === 'active' ? [
                { id: 'reset', label: t('resetAgent'), icon: <IconNewChatOutlineRegular /> },
                { id: 'compact', label: t('compactAgent'), icon: <IconGaugeOutlineRegular /> },
              ] : []),
              // Session history reads the stored lineage: it works for every
              // lifecycle state, because archived logs survive suspensions
              // and renewals alike.
              { id: 'history', label: t('sessionHistory'), icon: <IconClockOutlineRegular /> },
              // The Member's working queue: current Claims plus unclaimed
              // Channel work, each row navigable and reassignable.
              { id: 'tasks', label: t('agentTasks'), icon: <IconChecklistOutlineRegular /> },
              // The interrupt stack is a durable ledger read: the Host annotates
              // the return verdict only while the Member is live, and the dialog
              // degrades to unverified entries otherwise.
              { id: 'interrupts', label: t('interrupts'), icon: <IconPauseOutlineRegular /> },
              { id: 'archive', label: t(withdrawing ? 'withdrawAgent' : 'archiveAgent'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'edit') setEditing(true)
              else if (id === 'archive') setArchiving(true)
              else if (id === 'reset') setResetting(true)
              else if (id === 'history') selectSessionHistory(status.member.memberId)
              else if (id === 'tasks') setTasksOpen(true)
              else if (id === 'interrupts') setInterruptsOpen(true)
              else if (id === 'compact') {
                setCompactModel(undefined)
                setCompacting(true)
              }
              else if (id === 'diagnose') void diagnose()
              else void recover()
            }}
            onOpenChange={setMenuOpen}
          />
        </span>
      </div>
      {!archiving && !resetting && !compacting && rowAlert !== undefined && <div className={css.rowAlert} role="alert">{rowAlert}</div>}
      {resetting && (
        <Modal
          open
          onClose={() => { if (!resetPending) setResetting(false) }}
          title={t('resetAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={resetPending} onClick={() => { setResetting(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={resetPending} onClick={() => { void reset() }}>{t('resetAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('resetAgentNotice', { name: status.member.handle })}</p>
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {compacting && (
        <Modal
          open
          onClose={() => { if (!compactPending) setCompacting(false) }}
          title={t('compactAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={compactPending} onClick={() => { setCompacting(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={compactPending} onClick={() => { void compact() }}>{compactPending ? t('compactAgentRunning') : t('compactAgentRun')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('compactAgentNotice', { name: status.member.handle })}</p>
          <ModelPickerField model={compactModel} onModelChange={setCompactModel} loadModels={loadModels} disabled={compactPending} t={t} defaultLabel={t('compactModelFollowSession')} />
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {archiving && (
        <Modal
          open
          onClose={() => { if (!archivePending) setArchiving(false) }}
          title={t(withdrawing ? 'withdrawAgentTitle' : 'archiveAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={archivePending} onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={archivePending} onClick={() => { void archive() }}>{t(withdrawing ? 'withdrawAgent' : 'archiveAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t(withdrawing ? 'withdrawAgentNotice' : 'archiveAgentNotice', { name: status.member.handle })}</p>
          {!withdrawing && status.workspaceIds.length > 1 && <p>{t('archiveOtherWorkspaces', { count: status.workspaceIds.length - 1 })}</p>}
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {editing && (
        <AgentEditorDialog
          status={status}
          updateMember={updateMember}
          loadPromptView={loadPromptView}
          curateMemberPrompt={curateMemberPrompt}
          loadModels={loadModels}
          onCommitted={onUpdated}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
      {interruptsOpen && (
        <MemberInterruptsDialog
          workspaceId={workspaceId}
          status={status}
          loadMemberInterrupts={loadMemberInterrupts}
          releaseMemberInterrupt={releaseMemberInterrupt}
          onClose={() => { setInterruptsOpen(false) }}
          t={t}
        />
      )}
      {tasksOpen && (
        <MemberTasksDialog
          workspaceId={workspaceId}
          status={status}
          members={members}
          loadMemberTasks={loadMemberTasks}
          loadTasks={loadTasks}
          loadChannels={loadChannels}
          sendMessage={sendMessage}
          queueAssign={queueAssign}
          queueAmend={queueAmend}
          queueReassign={queueReassign}
          joinChannel={joinChannel}
          selectThread={selectThread}
          onClose={() => { setTasksOpen(false) }}
          t={t}
        />
      )}
    </>
  )
}

/** Abbreviated anchor display: the full ref rides the row's title. */
const shortCheckpointRef = (ref: string): string => ref.length > 30 ? `${ref.slice(0, 24)}…` : ref

/**
 * One Member's pending interrupt stack, newest first: the durable memory the
 * Member pinned when its work was interrupted, each entry annotated with the
 * Host's live verdict on whether the anchor can still be returned to. The
 * Human can release an entry the Member will never resume; `resumed` closes
 * stay the Host's own and are never offered here.
 */
function MemberInterruptsDialog({ workspaceId, status, loadMemberInterrupts, releaseMemberInterrupt, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly status: AgentTeamClientMemberStatus
  readonly loadMemberInterrupts: TeamSidebarProps['loadMemberInterrupts']
  readonly releaseMemberInterrupt: TeamSidebarProps['releaseMemberInterrupt']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [items, setItems] = useState<readonly AgentTeamInterruptView[]>()
  const [error, setError] = useState<string>()
  const [releasingRef, setReleasingRef] = useState<AgentTeamInterruptRef>()
  const reload = useCallback(async () => {
    try {
      const result = await loadMemberInterrupts({ workspaceId, memberId: status.member.memberId })
      if (result.ok) {
        setItems(result.value.items)
        setError(undefined)
      } else {
        setError(t('interruptsLoadFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setError(t('interruptsLoadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [loadMemberInterrupts, workspaceId, status.member.memberId, t])
  useEffect(() => { void reload() }, [reload])
  const release = async (interruptRef: AgentTeamInterruptRef): Promise<void> => {
    if (releasingRef !== undefined) return
    setReleasingRef(interruptRef)
    try {
      const result = await releaseMemberInterrupt({ requestId: mintRequestId(), workspaceId, memberId: status.member.memberId, interruptRef })
      if (!result.ok) setError(t('interruptsReleaseFailed', { message: result.error.message }))
      await reload()
    } catch (cause) {
      setError(t('interruptsReleaseFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setReleasingRef(undefined)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('interruptsTitle', { name: status.member.handle })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
    >
      {items === undefined && error === undefined && <p className={createCss.state}>{t('interruptsLoading')}</p>}
      {items !== undefined && items.length === 0 && <p className={createCss.state}>{t('interruptsEmpty')}</p>}
      {items !== undefined && items.length > 0 && <ul className={createCss.sectionList}>
        {items.map(item => (
          <li key={item.interruptRef} className={createCss.sectionRow}>
            <span className={createCss.badge}>{item.restorable ? t('interruptsRestorable') : t('interruptsNotRestorable')}</span>
            <span>{item.label}</span>
            <small>{item.incompleteState}</small>
            <small title={item.checkpointRef}>{t('interruptsCheckpoint', { ref: shortCheckpointRef(item.checkpointRef) })} · {formatAbsoluteTime(item.recordedAt)}</small>
            {!item.restorable && item.reason !== undefined && <small>{item.reason}</small>}
            <Button variant="outline" disabled={releasingRef !== undefined} onClick={() => { void release(item.interruptRef) }}>{releasingRef === item.interruptRef ? t('interruptsReleasing') : t('interruptsRelease')}</Button>
          </li>
        ))}
      </ul>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </Modal>
  )
}

/**
 * One Member's private task queue: the ordered todo-list the Human and the
 * Leader assign work through. The working section (active or handed-off
 * Claims) leads, the pending section follows in execution order. Pending
 * entries carry the Human's real queue writes — reassign, remove, move
 * up/down — plus the append picker; started entries are the Task lifecycle's
 * to retire, so their controls disable with the reason. Every write is a
 * non-optimistic ledger operation: one stable requestId per action, refusal
 * shown in place, projection re-read after the commit.
 */
function MemberTasksDialog({ workspaceId, status, members, loadMemberTasks, loadTasks, loadChannels, sendMessage, queueAssign, queueAmend, queueReassign, joinChannel, selectThread, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly status: AgentTeamClientMemberStatus
  /** The Workspace roster, behind the reassign and append pickers. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly loadTasks: TeamSidebarProps['loadTasks']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  /** Human Message lane behind the freeform-requirement assignment. */
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly queueAssign: TeamSidebarProps['queueAssign']
  readonly queueAmend: TeamSidebarProps['queueAmend']
  readonly queueReassign: TeamSidebarProps['queueReassign']
  readonly joinChannel: TeamSidebarProps['joinChannel']
  readonly selectThread: TeamSidebarProps['selectThread']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [queue, setQueue] = useState<AgentTeamMemberTaskQueue>()
  const [error, setError] = useState<string>()
  const [pendingAction, setPendingAction] = useState<string>()
  const [reassigning, setReassigning] = useState<AgentTeamQueueEntryItem>()
  const [appending, setAppending] = useState(false)
  // One stable requestId per (action, entry): a retried click replays the
  // committed operation instead of double-writing.
  const requestIds = useRef(new Map<string, ReturnType<typeof mintRequestId>>())
  const requestIdFor = (key: string): AgentTeamRequestId => {
    let value = requestIds.current.get(key)
    if (value === undefined) {
      value = mintRequestId()
      requestIds.current.set(key, value)
    }
    return value
  }
  const reload = useCallback(async () => {
    try {
      const result = await loadMemberTasks({ workspaceId })
      if (result.ok) {
        setQueue(result.value.queues.find(item => item.memberId === status.member.memberId))
        setError(undefined)
      } else {
        setError(t('agentTasksLoadFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setError(t('agentTasksLoadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [loadMemberTasks, workspaceId, status.member.memberId, t])
  useEffect(() => { void reload() }, [reload])
  const entries = queue?.entries ?? []
  const working = entries.filter(entry => entry.standing !== 'pending')
  const pending = entries.filter(entry => entry.standing === 'pending')

  const runAmend = async (key: string, action: 'remove' | 'reorder', payload: { readonly entryRef?: AgentTeamQueueEntryRef; readonly order?: readonly AgentTeamQueueEntryRef[] }): Promise<void> => {
    if (pendingAction !== undefined) return
    setPendingAction(key)
    setError(undefined)
    try {
      const result = await queueAmend({ requestId: requestIdFor(key), workspaceId, memberId: status.member.memberId, action, ...payload })
      if (!result.ok) setError(result.error.message)
      await reload()
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setPendingAction(undefined)
    }
  }

  // One reorder is the whole pending order swapped across the nearest pending
  // neighbour; working and awaiting entries hold their seats at the head.
  const move = (entryRef: AgentTeamQueueEntryRef, direction: 'up' | 'down'): void => {
    if (pendingAction !== undefined) return
    const order = entries.map(entry => entry.entryRef)
    const index = order.indexOf(entryRef)
    const step = direction === 'up' ? -1 : 1
    let target = index + step
    while (target >= 0 && target < entries.length && entries[target]?.standing !== 'pending') target += step
    if (index < 0 || target < 0 || target >= entries.length) return
    const moved = order[index]!
    order[index] = order[target]!
    order[target] = moved
    void runAmend(`reorder:${entryRef}`, 'reorder', { order })
  }

  const remove = (entryRef: AgentTeamQueueEntryRef): void => { void runAmend(`remove:${entryRef}`, 'remove', { entryRef }) }
  // The assigner NAME inside the row's 「由 {name} 安排」 label: the Human is
  // not an Agent roster row and names itself; a departed Member degrades to
  // the raw id the ledger stored.
  const addedByName = (memberId: AgentTeamMemberId): string => {
    if (memberId === 'member:human') return 'Human'
    const roster = members.find(member => member.member.memberId === memberId)
    return roster === undefined ? memberId : roster.member.handle.replace(/^@/, '')
  }
  const renderEntry = (entry: AgentTeamQueueEntryItem, position?: number, menuLabel?: string) => (
    <li key={entry.entryRef} className={createCss.sectionRow}>
      <button type="button" className={css.queueRowMain} title={entry.note === undefined ? entry.task.subject : `${entry.task.subject} — ${entry.note}`}
        onClick={() => { selectThread(entry.task.threadRef, entry.task.channelRef, entry.task.taskRef, entry.task.taskNumber) }}>
        {position !== undefined && <strong className={css.queuePosition}>{position}</strong>}
        <TeamStateDot state={taskStatusDot(entry.task.status)} />
        <strong>{t('taskLabel', { number: entry.task.taskNumber })}</strong>
        <span className={css.queueRowSubject}>{entry.task.subject}</span>
        {entry.note !== undefined && <small title={entry.note}>{entry.note}</small>}
        <small>{t('agentTasksAddedBy', { name: addedByName(entry.addedBy) })}</small>
        <small>{formatInboxTime(entry.addedAt, t)}</small>
      </button>
      {entry.standing === 'pending' && menuLabel !== undefined && (
        <TeamRowMenu
          label={menuLabel}
          items={[
            { id: 'reassign', label: t('agentTasksReassign') },
            { id: 'remove', label: t('agentTasksRemove'), danger: true },
            { id: 'up', label: t('agentTasksMoveUp') },
            { id: 'down', label: t('agentTasksMoveDown') },
          ]}
          onSelect={(id) => {
            if (id === 'reassign') setReassigning(entry)
            else if (id === 'remove') remove(entry.entryRef)
            else move(entry.entryRef, id === 'up' ? 'up' : 'down')
          }}
        />
      )}
    </li>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentTasksTitle', { name: status.member.handle })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<>
        <Button variant="outline" onClick={onClose}>{t('close')}</Button>
        <Button variant="primary" onClick={() => { setAppending(true) }}>{t('agentTasksAppend')}</Button>
      </>}
    >
      <p className={createCss.notice}>{t('agentTasksQueueHint')}</p>
      {queue === undefined && error === undefined && <p className={createCss.state}>{t('agentTasksLoading')}</p>}
      {queue !== undefined && entries.length === 0 && <p className={createCss.state}>{t('agentTasksEmpty')}</p>}
      {working.length > 0 && <h3 className={css.queueHeading}>{t('agentTasksCurrent')}</h3>}
      {working.length > 0 && <ul className={createCss.sectionList}>
        {working.map(entry => renderEntry(entry, undefined, t('agentTasksEntryMenu', { number: entry.task.taskNumber })))}
      </ul>}
      {working.length > 0 && <p className={createCss.notice}>{t('agentTasksStartedHint')}</p>}
      {pending.length > 0 && <h3 className={css.queueHeading}>{t('agentTasksPending')}</h3>}
      {pending.length > 0 && <ul className={createCss.sectionList}>
        {pending.map((entry, index) => renderEntry(entry, index + 1, t('agentTasksEntryMenu', { number: entry.task.taskNumber })))}
      </ul>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      {reassigning !== undefined && (
        <QueueReassignDialog
          workspaceId={workspaceId}
          entry={reassigning}
          holder={status}
          members={members}
          queueReassign={queueReassign}
          joinChannel={joinChannel}
          onCommitted={reload}
          onClose={() => { setReassigning(undefined) }}
          t={t}
        />
      )}
      {appending && (
        <QueueAppendDialog
          workspaceId={workspaceId}
          holder={status}
          members={members}
          loadTasks={loadTasks}
          loadMemberTasks={loadMemberTasks}
          loadChannels={loadChannels}
          sendMessage={sendMessage}
          queueAssign={queueAssign}
          onCommitted={reload}
          onClose={() => { setAppending(false) }}
          t={t}
        />
      )}
    </Modal>
  )
}

/**
 * The real reassignment: pick a receiving Member and one ledger operation
 * moves the pending entry from this queue into theirs. When the receiver has
 * not joined the Task's Channel, the refusal offers the one-step fallback —
 * join the Channel, then replay the same reassignment request.
 */
function QueueReassignDialog({ workspaceId, entry, holder, members, queueReassign, joinChannel, onCommitted, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly entry: AgentTeamQueueEntryItem
  readonly holder: AgentTeamClientMemberStatus
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly queueReassign: TeamSidebarProps['queueReassign']
  readonly joinChannel: TeamSidebarProps['joinChannel']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [targetId, setTargetId] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [joining, setJoining] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [needsJoin, setNeedsJoin] = useState(false)
  const [error, setError] = useState<string>()
  // One request identity for the whole dialog: the join fallback replays the
  // exact refused reassignment, and a double click replays the committed one.
  const requestId = useRef<ReturnType<typeof mintRequestId>>()
  const requestIdFor = (): AgentTeamRequestId => {
    requestId.current ??= mintRequestId()
    return requestId.current
  }
  const targets = members.filter(member => member.member.state === 'enabled' && member.member.memberId !== holder.member.memberId)
  const target = targets.find(member => member.member.memberId === targetId)
  const commit = async (): Promise<boolean> => {
    if (target === undefined) return false
    const result = await queueReassign({ requestId: requestIdFor(), workspaceId, entryRef: entry.entryRef,
      fromMemberId: holder.member.memberId, toMemberId: target.member.memberId })
    if (!result.ok) {
      // The ledger's channel-authority refusal names the missing membership:
      // surface the one-step join-and-reassign fallback for exactly that case.
      if (/has not joined Channel|does not participate/.test(result.error.message)) setNeedsJoin(true)
      else setError(result.error.message)
      return false
    }
    return true
  }
  const reassign = async (): Promise<void> => {
    if (target === undefined || committing) return
    setCommitting(true)
    setError(undefined)
    try {
      if (await commit()) {
        setCommitted(true)
        await onCommitted()
      }
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCommitting(false)
    }
  }
  const joinAndReassign = async (): Promise<void> => {
    if (target === undefined || joining) return
    setJoining(true)
    setError(undefined)
    try {
      const joined = await joinChannel({ requestId: mintRequestId(), workspaceId, channelRef: entry.task.channelRef, memberId: target.member.memberId })
      if (!joined.ok) throw new Error(joined.error.message)
      if (await commit()) {
        setCommitted(true)
        await onCommitted()
      }
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setJoining(false)
    }
  }
  const items: MenuEntry[] = targets.map(member => ({
    id: member.member.memberId,
    label: <>{member.member.handle.replace(/^@/, '')}<small className={css.menuHint}>{` ${member.member.description}`}</small></>,
  }))
  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentTasksReassignTitle', { number: entry.task.taskNumber })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={committed
        ? <Button variant="primary" onClick={onClose}>{t('close')}</Button>
        : <>
          <Button variant="outline" disabled={committing || joining} onClick={onClose}>{t('cancel')}</Button>
          {needsJoin
            ? <Button variant="primary" disabled={committing || joining || target === undefined} onClick={() => { void joinAndReassign() }}>{joining ? t('agentTasksJoining') : t('agentTasksJoinAndAssign')}</Button>
            : <Button variant="primary" disabled={committing || joining || target === undefined} onClick={() => { void reassign() }}>{committing ? t('agentTasksReassignCommitting') : t('agentTasksReassignConfirm')}</Button>}
        </>}
    >
      {committed ? <p className={createCss.notice}>{t('agentTasksReassignCommitted')}</p> : <>
        <p className={createCss.notice}>{t('agentTasksReassignIntro', { number: entry.task.taskNumber, subject: entry.task.subject })}</p>
        {targets.length === 0 && <p className={createCss.error}>{t('agentTasksReassignNoTargets')}</p>}
        {targets.length > 0 && (
          <div className={createCss.field}>
            <span>{t('agentTasksReassignTarget')}</span>
            <Menu
              open={pickerOpen}
              portal
              className={createCss.menuCap!}
              items={items}
              selectedIds={targetId === undefined ? [] : [targetId]}
              onSelect={id => { setTargetId(id); setNeedsJoin(false); setPickerOpen(false) }}
              onClose={() => { setPickerOpen(false) }}
              anchor={
                <button
                  type="button"
                  className={createCss.selectTrigger!}
                  aria-label={t('agentTasksReassignTarget')}
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen}
                  onClick={() => { setPickerOpen(value => !value) }}
                >
                  <span className={createCss.selectValue}>{target === undefined ? t('agentTasksReassignTargetPlaceholder') : target.member.handle.replace(/^@/, '')}</span>
                  <span className={`${createCss.chevron!} ${pickerOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
                </button>
              }
            />
          </div>
        )}
        {needsJoin && <p className={createCss.notice}>{t('agentTasksJoinHint', { name: target?.member.handle.replace(/^@/, '') ?? '' })}</p>}
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </>}
    </Modal>
  )
}

/**
 * The append picker: every open todo Task in the Workspace that no queue
 * holds, queued to this Member's tail with an optional note. The ledger
 * re-validates channel membership and occupancy, so a stale pick refuses in
 * place instead of silently mis-routing.
 */
function QueueAppendDialog({ workspaceId, holder, members, loadTasks, loadMemberTasks, loadChannels, sendMessage, queueAssign, onCommitted, onClose, t }: {
  readonly workspaceId: WorkspaceId
  readonly holder: AgentTeamClientMemberStatus
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly loadTasks: TeamSidebarProps['loadTasks']
  readonly loadMemberTasks: TeamSidebarProps['loadMemberTasks']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  /** Human Message lane: the freeform requirement mints its Task card through an asTask send. */
  readonly sendMessage: TeamSidebarProps['sendMessage']
  readonly queueAssign: TeamSidebarProps['queueAssign']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  // Two ways to put work on the queue: pick an existing board card, or hand
  // over a freeform requirement the Host mints into a card atomically. The
  // queue entry always references a real Task either way — one lifecycle.
  const [mode, setMode] = useState<'board' | 'text'>('board')
  const [candidates, setCandidates] = useState<readonly AgentTeamTaskRow[]>()
  const [error, setError] = useState<string>()
  const [pickedId, setPickedId] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [note, setNote] = useState('')
  const [requirement, setRequirement] = useState('')
  const [channels, setChannels] = useState<AgentTeamView['channels']>()
  const [channelId, setChannelId] = useState<string>()
  const [channelPickerOpen, setChannelPickerOpen] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [committedNote, setCommittedNote] = useState<string>()
  const picked = candidates?.find(task => task.taskRef === pickedId)
  const channel = channels?.find(entry => entry.channelRef === channelId)
  const reload = useCallback(async () => {
    try {
      const [tasks, queues] = await Promise.all([loadTasks({ workspaceId }), loadMemberTasks({ workspaceId })])
      if (!tasks.ok) throw new Error(tasks.error.message)
      if (!queues.ok) throw new Error(queues.error.message)
      const queuedRefs = new Set(queues.value.queues.flatMap(queue => queue.entries.map(entry => entry.task.taskRef)))
      setCandidates(tasks.value.tasks.filter(task => task.status === 'todo' && task.resolution === 'open' && !queuedRefs.has(task.taskRef)))
      setError(undefined)
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }, [loadTasks, loadMemberTasks, workspaceId, t])
  useEffect(() => { void reload() }, [reload])
  // The text form's default landing Channel: the first active one the Member
  // has joined — the constraint the ledger itself enforces for a queue entry.
  useEffect(() => { void (async () => {
    const view = await loadChannels({ workspaceId })
    if (!view.ok) return
    setChannels(view.value.channels)
    const joined = new Set(view.value.members.filter(membership => membership.memberId === holder.member.memberId).map(membership => membership.channelRef))
    const first = view.value.channels.find(entry => entry.state === 'active' && joined.has(entry.channelRef))
    setChannelId(first?.channelRef)
  })() }, [loadChannels, workspaceId, holder.member.memberId])
  const appendBoard = async (): Promise<void> => {
    if (picked === undefined || committing) return
    setCommitting(true)
    setError(undefined)
    try {
      const trimmedNote = note.trim()
      const result = await queueAssign({ requestId: mintRequestId(), workspaceId, memberId: holder.member.memberId,
        items: [{ taskRef: picked.taskRef, ...(trimmedNote === '' ? {} : { note: trimmedNote }) }] })
      if (!result.ok) throw new Error(result.error.message)
      setCommittedNote(t('agentTasksAppendCommitted'))
      await onCommitted()
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCommitting(false)
    }
  }
  const appendText = async (): Promise<void> => {
    const body = requirement.trim()
    if (body === '' || channel === undefined || committing) return
    setCommitting(true)
    setError(undefined)
    try {
      // The card is the byproduct: one asTask send mints the Task in the
      // landing Channel, the very next call queues it. Both are existing
      // ledger operations — no second work kind is born here.
      const created = await sendMessage({ requestId: mintRequestId(), workspaceId, channelRef: channel.channelRef, body, asTask: true })
      if (!created.ok) throw new Error(created.error.message)
      if (created.value.kind !== 'committed' || created.value.task === undefined) {
        throw new Error(t('agentTasksActionFailed', { message: t('agentTasksAppendNoCard') }))
      }
      const queued = await queueAssign({ requestId: mintRequestId(), workspaceId, memberId: holder.member.memberId,
        items: [{ taskRef: created.value.task.taskRef }] })
      if (!queued.ok) throw new Error(queued.error.message)
      setCommittedNote(t('agentTasksAppendTextCommitted'))
      await onCommitted()
    } catch (cause) {
      setError(t('agentTasksActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setCommitting(false)
    }
  }
  const items: MenuEntry[] = (candidates ?? []).map(task => ({
    id: task.taskRef,
    label: <>{t('taskLabel', { number: task.taskNumber })}<small className={css.menuHint}>{` ${task.subject}`}</small></>,
  }))
  const channelItems: MenuEntry[] = (channels ?? []).filter(entry => entry.state === 'active').map(entry => ({
    id: entry.channelRef,
    label: entry.name,
  }))
  return (
    <Modal
      open
      onClose={onClose}
      title={t('agentTasksAppendTitle', { name: holder.member.handle })}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={committedNote !== undefined
        ? <Button variant="primary" onClick={onClose}>{t('close')}</Button>
        : <>
          <Button variant="outline" disabled={committing} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary"
            disabled={committing || (mode === 'board' ? picked === undefined : requirement.trim() === '' || channel === undefined)}
            onClick={() => { void (mode === 'board' ? appendBoard() : appendText()) }}>
            {committing ? t('agentTasksAppendCommitting') : mode === 'board' ? t('agentTasksAppendConfirm') : t('agentTasksAppendCreate')}
          </Button>
        </>}
    >
      {committedNote !== undefined ? <p className={createCss.notice}>{committedNote}</p> : <>
        <Button className={createCss.modeSwitch!} variant="outline" disabled={committing}
          onClick={() => { setMode(value => value === 'board' ? 'text' : 'board'); setError(undefined) }}>
          {mode === 'board' ? t('agentTasksAppendModeText') : t('agentTasksAppendModeBoard')}
        </Button>
        {mode === 'board' ? <>
          <p className={createCss.notice}>{t('agentTasksAppendIntro', { name: holder.member.handle })}</p>
          {candidates === undefined && error === undefined && <p className={createCss.state}>{t('agentTasksLoading')}</p>}
          {candidates !== undefined && candidates.length === 0 && <p className={createCss.state}>{t('agentTasksAppendEmpty')}</p>}
          {candidates !== undefined && candidates.length > 0 && (
            <div className={createCss.field}>
              <span>{t('agentTasksAppendTask')}</span>
              <Menu
                open={pickerOpen}
                portal
                className={createCss.menuCap!}
                items={items}
                selectedIds={pickedId === undefined ? [] : [pickedId]}
                onSelect={id => { setPickedId(id); setPickerOpen(false) }}
                onClose={() => { setPickerOpen(false) }}
                anchor={
                  <button
                    type="button"
                    className={createCss.selectTrigger!}
                    aria-label={t('agentTasksAppendTask')}
                    aria-haspopup="menu"
                    aria-expanded={pickerOpen}
                    onClick={() => { setPickerOpen(value => !value) }}
                  >
                    <span className={createCss.selectValue}>{picked === undefined ? t('agentTasksAppendPlaceholder') : t('taskLabel', { number: picked.taskNumber })}</span>
                    <span className={`${createCss.chevron!} ${pickerOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
                  </button>
                }
              />
            </div>
          )}
          {picked !== undefined && (
            <label className={createCss.field}>
              <span>{t('agentTasksAppendNote')}</span>
              <Input value={note} placeholder={t('agentTasksAppendNotePlaceholder')} onChange={event => { setNote(event.target.value) }} disabled={committing} />
            </label>
          )}
        </> : <>
          <p className={createCss.notice}>{t('agentTasksAppendTextIntro')}</p>
          <label className={createCss.field}>
            <span>{t('agentTasksAppendText')}</span>
            <Input value={requirement} placeholder={t('agentTasksAppendTextPlaceholder')} onChange={event => { setRequirement(event.target.value) }} disabled={committing} />
          </label>
          <div className={createCss.field}>
            <span>{t('agentTasksAppendChannel')}</span>
            <Menu
              open={channelPickerOpen}
              portal
              className={createCss.menuCap!}
              items={channelItems}
              selectedIds={channelId === undefined ? [] : [channelId]}
              onSelect={id => { setChannelId(id); setChannelPickerOpen(false) }}
              onClose={() => { setChannelPickerOpen(false) }}
              anchor={
                <button
                  type="button"
                  className={createCss.selectTrigger!}
                  aria-label={t('agentTasksAppendChannel')}
                  aria-haspopup="menu"
                  aria-expanded={channelPickerOpen}
                  onClick={() => { setChannelPickerOpen(value => !value) }}
                >
                  <span className={createCss.selectValue}>{channel === undefined ? t('agentTasksAppendChannelPlaceholder') : channel.name}</span>
                  <span className={`${createCss.chevron!} ${channelPickerOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
                </button>
              }
            />
            <small className={css.editHint}>{t('agentTasksAppendChannelHint')}</small>
          </div>
        </>}
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </>}
    </Modal>
  )
}
