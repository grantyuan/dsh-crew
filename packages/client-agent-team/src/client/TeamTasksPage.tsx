import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId, AgentTeamTaskRef, AgentTeamTaskRow } from '@grantyuan/dsh-crew/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChevronDownOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamPagePayload } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { mintRequestId } from './requests.ts'
import createCss from './create.module.css'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'
import taskCss from './tasks.module.css'

interface TeamTaskRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly task: AgentTeamTaskRow
}

interface TeamTasksPageProps {
  readonly useWorkspaces: TeamPagePayload['useWorkspaces']
  readonly loadTasks: TeamPagePayload['loadTasks']
  /** Wake source while the page is open: one scope-less subscription, like the Inbox page. */
  readonly subscribeChanges: TeamPagePayload['subscribeChanges']
  /** Host batch resolution behind every board move: acceptance, closing, and reopening. */
  readonly changeTasks: TeamPagePayload['changeTasks']
  /** The Workspace roster behind the assignment dialog's Member picker. */
  readonly loadMembers: TeamPagePayload['loadMembers']
  /** Thread read ahead of the assignment reply: it satisfies the unread fence and yields the revision. */
  readonly readThread: TeamPagePayload['readThread']
  /** The Human reply lane the assignment request posts through, in the Task's own Thread. */
  readonly reply: TeamPagePayload['reply']
  readonly selectWorkspace: TeamPagePayload['selectWorkspace']
  readonly selectThread: TeamPagePayload['selectThread']
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamPagePayload['t']
}

const OPEN_STATES = new Set(['todo', 'in_progress', 'in_review'])
const isOpen = (task: AgentTeamTaskRow): boolean => OPEN_STATES.has(task.status)

/** The one board lane a Task stands in, by its derived standing. */
type BoardColumnKey = 'todo' | 'in_progress' | 'in_review' | 'done'

interface BoardColumn {
  readonly key: BoardColumnKey
  readonly statuses: readonly string[]
  readonly titleKey: 'taskStatusTodo' | 'taskStatusInProgress' | 'taskStatusInReview' | 'tasksSectionDone'
}

/**
 * The board's four lanes in reading order. The open three are the ledger's
 * derived standing verbatim; the last lane gathers both terminal standings
 * under one "finished" roof, the card keeping its own done/closed dot.
 */
const BOARD_COLUMNS: readonly BoardColumn[] = [
  { key: 'todo', statuses: ['todo'], titleKey: 'taskStatusTodo' },
  { key: 'in_progress', statuses: ['in_progress'], titleKey: 'taskStatusInProgress' },
  { key: 'in_review', statuses: ['in_review'], titleKey: 'taskStatusInReview' },
  { key: 'done', statuses: ['done', 'closed'], titleKey: 'tasksSectionDone' },
]

const columnOf = (task: AgentTeamTaskRow): BoardColumn => BOARD_COLUMNS.find(column => column.statuses.includes(task.status)) ?? BOARD_COLUMNS[0]!

/**
 * The Human Task board: one `tasks` call per visible Workspace, resolved into
 * the four standing lanes of an agile board. The ledger's standing is derived
 * from Claims — the Human never writes a lane by hand — so every board move
 * maps onto the one Host write it really is:
 *
 * - dropping an open card on 已完成 (or its 验收 menu action) resolves the
 *   Task through the Host batch, which completes live Claims atomically;
 * - dragging a terminal card back out (or 重新打开) returns it to open
 *   standing, and its lane then re-derives from the surviving Claims;
 * - dropping a 待处理 card on 进行中 opens the assignment dialog: the
 *   request posts in the Human's voice into the Task's own Thread @-naming
 *   the chosen Member — the Member claims for itself (the only authority that
 *   can), and the card moves when the Claim lands.
 *
 * Sub-task trees stay visible as a `{done}/{total}` chip on the parent card —
 * the board is flat by design, one card per Task, so no Task hides inside
 * another lane. Open cards keep their selection checkbox and the multi-select
 * bar keeps its batch acceptance and closing. Dragging is the fast path; the
 * card menu carries the same actions for the keyboard, so nothing on this
 * board needs a pointer. Opening a card navigates to its Thread; selecting
 * acknowledges nothing and viewing acknowledges nothing.
 */
export function TeamTasksPage({ useWorkspaces, loadTasks, subscribeChanges, changeTasks, loadMembers, readThread, reply, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamTasksPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamTaskRow[]>()
  // The Host names the Human's Member id on every payload; the page keeps it so
  // an owner chip that names the reader draws the one identity every seat draws.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Only the first refresh owns the loading surface; later wakes refresh the
  // rendered rows in place instead of flashing them back to skeleton.
  const loadedRef = useRef(false)
  // Wakes and the Workspace list can start refreshes faster than their reads
  // answer, and an older read may not lose the race on its own: without a
  // ticket, a slow first read can land after a fast second and overwrite fresh
  // rows with stale standing — exactly the "the list disagrees with the Thread"
  // mismatch this page must never show. Only the newest refresh may write.
  const refreshTicket = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadTasks({ workspaceId: workspace.workspaceId })
      return result.ok
        ? { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, tasks: result.value.tasks, humanMemberId: result.value.humanMemberId }
        : { ok: false as const, message: result.error.message }
    }))
    if (ticket !== refreshTicket.current) return
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    setRows(results.flatMap(result => result.ok
      ? result.tasks.map(task => ({ workspaceId: result.workspaceId, workspaceTitle: result.workspaceTitle, task }))
      : []))
    setError(failure?.ok === false ? failure.message : undefined)
    loadedRef.current = true
    setLoading(false)
  }, [loadTasks, workspaces])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh])

  // The selection holds full Task refs and survives wakes: rows refresh in
  // place, and the checkout keeps whatever it held unless the reader clears it.
  const [selected, setSelected] = useState<ReadonlySet<AgentTeamTaskRef>>(new Set())
  const [batchRunning, setBatchRunning] = useState(false)
  // One line of outcome feedback at a time — a committed count, the skipped
  // and failed summary the Host reported, or a transport error — cleared by
  // the next selection change or the next run.
  const [batchNote, setBatchNote] = useState<string>()
  // The card being dragged and the lane currently highlighted as a legal drop.
  const [draggingRef, setDraggingRef] = useState<AgentTeamTaskRef>()
  const [dropColumn, setDropColumn] = useState<BoardColumnKey>()

  const toggle = (taskRef: AgentTeamTaskRef, on: boolean): void => {
    setBatchNote(undefined)
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(taskRef)
      else next.delete(taskRef)
      return next
    })
  }

  /**
   * Resolve Tasks through the Host batch — one call per touched Workspace,
   * each Task its own durable operation. Both the multi-select bar and every
   * single-card move (menu action or drag) go through here, so the board has
   * exactly one resolution path and one feedback line.
   */
  const resolveTasks = async (action: 'accept' | 'close' | 'reopen', targets: readonly TeamTaskRow[]): Promise<void> => {
    if (batchRunning || targets.length === 0) return
    setBatchRunning(true)
    setBatchNote(undefined)
    try {
      // The batch Remote is one Workspace's resolution, so a move set spanning
      // Workspaces groups into one call per Workspace it touches.
      const byWorkspace = new Map<WorkspaceId, AgentTeamTaskRef[]>()
      for (const row of targets) {
        const bucket = byWorkspace.get(row.workspaceId) ?? []
        bucket.push(row.task.taskRef)
        byWorkspace.set(row.workspaceId, bucket)
      }
      const results = await Promise.all([...byWorkspace].map(([workspaceId, taskRefs]) =>
        changeTasks({ requestId: mintRequestId(), workspaceId, taskRefs, action })))
      const failed = results.filter(result => !result.ok)
      if (failed.length > 0) {
        setBatchNote(failed[0]!.error.message)
        return
      }
      const outcomes = results.flatMap(result => result.ok ? result.value.outcomes : [])
      const committed = outcomes.filter(outcome => outcome.kind === 'committed').length
      const skipped = outcomes.filter(outcome => outcome.kind === 'already_resolved').length
      const failedOutcomes = outcomes.filter(outcome => outcome.kind === 'failed')
      const parts: string[] = [committed > 0 ? t('tasksBatchCommitted', { count: committed }) : '']
      if (skipped > 0) parts.push(t('tasksBatchSkipped', { count: skipped }))
      if (failedOutcomes.length > 0) parts.push(t('tasksBatchFailed', { count: failedOutcomes.length, reason: failedOutcomes[0]!.reason }))
      setBatchNote(parts.filter(part => part !== '').join('；'))
      if (action !== 'reopen') setSelected(new Set())
      await refresh()
    } finally {
      setBatchRunning(false)
    }
  }

  const open = (row: TeamTaskRow): void => {
    selectWorkspace(row.workspaceId)
    selectThread(row.task.threadRef, row.task.channelRef, row.task.taskRef, row.task.taskNumber, 'tasks')
  }

  // The assignment dialog's target card; opening it loads the roster.
  const [assigning, setAssigning] = useState<TeamTaskRow>()

  /**
   * A lane accepts a drop only where the drop names a real Host write:
   * acceptance into the finished lane, a reopen back out of it, or the
   * assignment request from 待处理 into 进行中. Every other pair would have
   * to move a lane by hand — standing is derived from Claims, so the drag
   * simply does not land there.
   */
  const acceptsDrop = (column: BoardColumn, task: AgentTeamTaskRow): boolean => {
    const from = columnOf(task).key
    if (from === column.key) return false
    if (column.key === 'done') return isOpen(task)
    if (!isOpen(task)) return true
    return task.status === 'todo' && column.key === 'in_progress'
  }

  const dropInto = (column: BoardColumn, row: TeamTaskRow): void => {
    setDropColumn(undefined)
    setDraggingRef(undefined)
    if (column.key === 'done' && isOpen(row.task)) { void resolveTasks('accept', [row]); return }
    if (!isOpen(row.task) && column.key !== 'done') { void resolveTasks('reopen', [row]); return }
    if (row.task.status === 'todo' && column.key === 'in_progress') setAssigning(row)
  }

  const onMenuSelect = (id: string, row: TeamTaskRow): void => {
    if (id === 'accept') void resolveTasks('accept', [row])
    else if (id === 'close') void resolveTasks('close', [row])
    else if (id === 'reopen') void resolveTasks('reopen', [row])
    else if (id === 'assign') setAssigning(row)
  }

  const all = rows ?? []
  // The board is flat, but a parent still answers "how much of the split
  // underneath me is finished": one chip per card with any sub-tree, counted
  // over the merged rows whatever lanes the children sit in.
  const progressByParent = useMemo(() => {
    const childrenOf = new Map<AgentTeamTaskRef, readonly TeamTaskRow[]>()
    for (const row of all) {
      const parentRef = row.task.parentTaskRef
      if (parentRef === undefined) continue
      const bucket = [...(childrenOf.get(parentRef) ?? []), row]
      childrenOf.set(parentRef, bucket)
    }
    const memo = new Map<AgentTeamTaskRef, { readonly done: number, readonly total: number }>()
    const count = (parentRef: AgentTeamTaskRef): { readonly done: number, readonly total: number } => {
      const cached = memo.get(parentRef)
      if (cached !== undefined) return cached
      let done = 0
      let total = 0
      for (const child of childrenOf.get(parentRef) ?? []) {
        total += 1
        if (!isOpen(child.task)) done += 1
        const nested = count(child.task.taskRef)
        done += nested.done
        total += nested.total
      }
      const value = { done, total }
      memo.set(parentRef, value)
      return value
    }
    const progress = new Map<AgentTeamTaskRef, { readonly done: number, readonly total: number }>()
    for (const parentRef of childrenOf.keys()) progress.set(parentRef, count(parentRef))
    return progress
  }, [all])
  // A row names its Workspace only while the rows on screen span more than
  // one — the same rule the Inbox page speaks.
  const showWorkspace = new Set(all.map(row => row.workspaceTitle)).size > 1
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman
  const openRows = all.filter(row => isOpen(row.task))

  return <main className={css.surface} data-team-tasks>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('tasksTitle')}</h1>
          {rows !== undefined && all.length > 0 && <p className={inboxCss.headerMeta}>
            <span>{t('tasksHeaderOpen', { count: openRows.length })}</span>
          </p>}
        </div>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && rows === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingTasks')}</p></div>}
        {!loading && rows === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {rows !== undefined && (all.length === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('tasksEmptyTitle')}</strong>
                <span>{t('tasksEmptyHint')}</span>
              </div>
            </div>
          : <div className={taskCss.board}>
              {BOARD_COLUMNS.map(column => {
                const columnRows = all.filter(row => column.statuses.includes(row.task.status))
                const highlighted = dropColumn === column.key && draggingRef !== undefined
                  && all.some(row => row.task.taskRef === draggingRef && acceptsDrop(column, row.task))
                return <section
                  key={column.key}
                  className={[taskCss.boardColumn, ...(highlighted ? [taskCss.dropReady] : [])].join(' ')}
                  data-board-column={column.key}
                  aria-label={`${t(column.titleKey)} ${columnRows.length}`}
                  onDragOver={event => {
                    if (draggingRef === undefined) return
                    if (!all.some(row => row.task.taskRef === draggingRef && acceptsDrop(column, row.task))) return
                    event.preventDefault()
                    setDropColumn(column.key)
                  }}
                  onDragLeave={() => { if (dropColumn === column.key) setDropColumn(undefined) }}
                  onDrop={event => {
                    event.preventDefault()
                    const row = all.find(candidate => candidate.task.taskRef === draggingRef)
                    if (row === undefined) return
                    dropInto(column, row)
                  }}
                >
                  <h2 className={inboxCss.sectionTitle}>{t(column.titleKey)}<span className={inboxCss.sectionCount}>{columnRows.length}</span></h2>
                  <div className={taskCss.columnCards}>
                    {columnRows.length === 0 && <p className={taskCss.columnEmpty}>{t('tasksColumnEmpty')}</p>}
                    {columnRows.map(row => <TaskCard
                      key={row.task.taskRef}
                      row={row}
                      showWorkspace={showWorkspace}
                      progress={progressByParent.get(row.task.taskRef)}
                      human={human}
                      dragging={draggingRef === row.task.taskRef}
                      selected={selected.has(row.task.taskRef)}
                      selectable={isOpen(row.task)}
                      onToggle={toggle}
                      onOpen={() => { open(row) }}
                      onDragStart={() => { setDraggingRef(row.task.taskRef) }}
                      onDragEnd={() => { setDraggingRef(undefined); setDropColumn(undefined) }}
                      menu={menuItems(row, t)}
                      onMenuSelect={id => { onMenuSelect(id, row) }}
                      t={t}
                    />)}
                  </div>
                </section>
              })}
            </div>)}
        {rows !== undefined && all.length > 0 && selected.size > 0 && <div className={taskCss.batchBar} role="toolbar" aria-label={t('tasksBatchSelected', { count: selected.size })}>
          <span className={taskCss.batchCount}>{t('tasksBatchSelected', { count: selected.size })}</span>
          <Button size="sm" variant="primary" disabled={batchRunning} onClick={() => { void resolveTasks('accept', all.filter(row => selected.has(row.task.taskRef))) }}>{t('tasksBatchAccept')}</Button>
          <Button size="sm" variant="outline" disabled={batchRunning} onClick={() => { void resolveTasks('close', all.filter(row => selected.has(row.task.taskRef))) }}>{t('tasksBatchClose')}</Button>
          <Button size="sm" variant="ghost" disabled={batchRunning} onClick={() => { setSelected(new Set()); setBatchNote(undefined) }}>{t('tasksBatchClear')}</Button>
          {(batchRunning || batchNote !== undefined) && <span className={taskCss.batchNote}>{batchRunning ? t('tasksBatchSubmitting') : batchNote}</span>}
        </div>}
        {/* A committed run clears its own selection, so its feedback would
            die with the bar; the note outlives it as one status line until
            the reader selects again. A failed run keeps its selection, so
            its note stays on the bar where the actions still are. A card
            move made without any selection shares the same status line. */}
        {rows !== undefined && all.length > 0 && selected.size === 0 && !batchRunning && batchNote !== undefined && <p className={taskCss.batchNote} role="status">{batchNote}</p>}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
    {assigning !== undefined && <TaskAssignDialog
      row={assigning}
      loadMembers={loadMembers}
      readThread={readThread}
      reply={reply}
      onClose={() => { setAssigning(undefined) }}
      onSent={async name => {
        setAssigning(undefined)
        setBatchNote(t('tasksAssignSent', { name }))
        await refresh()
      }}
      t={t}
    />}
  </main>
}

/** The card menu is the keyboard path for everything a drag can do. */
function menuItems(row: TeamTaskRow, t: TeamPagePayload['t']): readonly MenuEntry[] {
  if (!isOpen(row.task)) return [{ id: 'reopen', label: t('reopenTask') }]
  const entries: MenuEntry[] = [{ id: 'accept', label: t('acceptTask') }]
  if (row.task.status === 'todo') entries.push({ id: 'assign', label: t('tasksAssign') })
  entries.push({ id: 'close', label: t('closeTask') })
  return entries
}

/**
 * One Task card: the shipped Inbox row shape — status dot, identity line
 * (Task number, standing, sub-tree progress), owner stack, relative time,
 * bounded subject — with the board's two additions: the card is the drag
 * handle for a lane move, and it carries the overflow menu holding the same
 * moves for the keyboard. The checkbox stays outside the row button and the
 * menu stops its own clicks, so selecting and opening never collide.
 */
function TaskCard({ row, showWorkspace, progress, human, dragging, selected, selectable, onToggle, onOpen, onDragStart, onDragEnd, menu, onMenuSelect, t }: {
  readonly row: TeamTaskRow
  readonly showWorkspace: boolean
  readonly progress?: { readonly done: number, readonly total: number } | undefined
  readonly human: TeamAvatarHuman | undefined
  readonly dragging: boolean
  readonly selected: boolean
  readonly selectable: boolean
  readonly onToggle: (taskRef: AgentTeamTaskRef, on: boolean) => void
  readonly onOpen: () => void
  readonly onDragStart: () => void
  readonly onDragEnd: () => void
  readonly menu: readonly MenuEntry[]
  readonly onMenuSelect: (id: string) => void
  readonly t: TeamPagePayload['t']
}) {
  const { task } = row
  const owners = namedAvatarOwners(task.claimOwners, human)
  const rowButton = <button
    type="button"
    className={inboxCss.row}
    draggable
    onDragStart={event => {
      // jsdom fires drag events without a DataTransfer; the page tracks the
      // drag in state anyway, so the payload is best-effort for real DnD.
      event.dataTransfer?.setData('text/plain', task.taskRef)
      if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
      onDragStart()
    }}
    onDragEnd={onDragEnd}
    onClick={onOpen}
    data-task-ref={task.taskRef}
    data-task-status={task.status}
  >
    <span className={inboxCss.rowActor} aria-hidden="true">
      <TeamStateDot state={taskStatusDot(task.status)} />
    </span>
    <span className={inboxCss.rowLine}>
      <span className={inboxCss.rowCrumb}>
        {showWorkspace && <span className={inboxCss.rowWorkspace}>{row.workspaceTitle}</span>}
        {showWorkspace && ' / '}
        <span className={inboxCss.rowTask}>{t('taskLabel', { number: task.taskNumber })}</span>
        {' '}
        <span>{formatTaskStatus(task.status, t)}</span>
        {progress !== undefined && <span> · {t('tasksSubtaskProgress', { done: progress.done, total: progress.total })}</span>}
      </span>
      {owners.length > 0 && <span className={taskCss.rowOwners}>
        <TeamAvatarStack owners={owners} label={claimersLabel(owners, t)} human={human} />
      </span>}
      <time className={inboxCss.rowTime} dateTime={task.lastActivityAt} title={formatAbsoluteTime(task.lastActivityAt)}>{formatInboxTime(task.lastActivityAt, t)}</time>
    </span>
    <span className={inboxCss.rowPreview}>{task.subject}</span>
  </button>
  return <div className={[taskCss.cardShell, ...(dragging ? [taskCss.cardDragging] : [])].join(' ')}>
    {selectable && <input
      type="checkbox"
      className={taskCss.rowCheck}
      aria-label={t('tasksSelectRow', { number: task.taskNumber })}
      checked={selected}
      onChange={event => { onToggle(task.taskRef, event.target.checked) }}
    />}
    {rowButton}
    <span className={taskCss.cardMenu}>
      <TeamRowMenu label={t('tasksMenuLabel', { number: task.taskNumber })} items={menu} onSelect={onMenuSelect} />
    </span>
  </div>
}

/**
 * The assignment dialog: pick a Member from the Workspace roster and send one
 * Human reply into the Task's own Thread @-naming them, asking them to claim
 * it. The request never moves standing by itself — the Claim is the Member's
 * own commitment, so the card moves when they claim, not when this dialog
 * closes. The reply needs the Thread read first (the unread fence) and its
 * current revision, which that same read returns.
 */
function TaskAssignDialog({ row, loadMembers, readThread, reply, onClose, onSent, t }: {
  readonly row: TeamTaskRow
  readonly loadMembers: TeamPagePayload['loadMembers']
  readonly readThread: TeamPagePayload['readThread']
  readonly reply: TeamPagePayload['reply']
  readonly onClose: () => void
  readonly onSent: (name: string) => Promise<void> | void
  readonly t: TeamPagePayload['t']
}) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>()
  const [membersError, setMembersError] = useState<string>()
  const [targetId, setTargetId] = useState<string>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let mounted = true
    void loadMembers({ workspaceId: row.workspaceId }).then(result => {
      if (!mounted) return
      if (result.ok) setMembers(result.value)
      else setMembersError(result.error.message)
    })
    return () => { mounted = false }
  }, [loadMembers, row.workspaceId])
  // Any enabled Agent Member of the Workspace may be asked; the Human and
  // departed rows never answer an assignment.
  const targets = (members ?? []).filter(member => member.member.state === 'enabled' && member.member.memberId !== 'member:human')
  const target = targets.find(member => member.member.memberId === targetId)
  const bodyBase = t('tasksAssignBodyTemplate', {
    handle: target?.member.handle ?? '',
    label: t('taskLabel', { number: row.task.taskNumber }),
    subject: row.task.subject,
  })
  const send = async (): Promise<void> => {
    if (target === undefined || sending) return
    setSending(true)
    setError(undefined)
    try {
      // The reply fence needs the reader caught up and the revision in hand;
      // one bounded read answers both, exactly like opening the Thread does.
      const read = await readThread({ requestId: mintRequestId(), workspaceId: row.workspaceId, threadRef: row.task.threadRef })
      if (!read.ok) throw new Error(read.error.message)
      const result = await reply({
        requestId: mintRequestId(),
        workspaceId: row.workspaceId,
        taskRef: row.task.taskRef,
        body: [bodyBase, ...(note.trim() === '' ? [] : [note.trim()])].join('\n'),
        baseRevision: read.value.thread.revision,
      })
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.kind !== 'committed') throw new Error(result.value.kind)
      await onSent(target.member.handle)
    } catch (cause) {
      setError(t('tasksAssignFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setSending(false)
    }
  }
  return <Modal
    open
    onClose={onClose}
    title={t('tasksAssignTitle', { number: row.task.taskNumber })}
    description={row.task.subject}
    closeLabel={t('close')}
    contentClassName={createCss.dialogContent!}
    footer={<>
      <Button variant="outline" disabled={sending} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={sending || target === undefined} onClick={() => { void send() }}>{sending ? t('tasksAssignSending') : t('tasksAssignSend')}</Button>
    </>}
  >
    <div className={createCss.form}>
      <p className={createCss.notice}>{t('tasksAssignHint')}</p>
      <div className={createCss.field}>
        <span>{t('tasksAssignMember')}</span>
        <Menu
          open={pickerOpen}
          portal
          className={createCss.menuCap!}
          items={targets.map(member => ({ id: member.member.memberId, label: member.member.handle.replace(/^@/, '') }))}
          selectedIds={targetId === undefined ? [] : [targetId]}
          onSelect={id => { setTargetId(id); setPickerOpen(false) }}
          onClose={() => { setPickerOpen(false) }}
          anchor={
            <button
              type="button"
              className={createCss.selectTrigger!}
              aria-label={t('tasksAssignMember')}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              disabled={sending || (members !== undefined && targets.length === 0)}
              onClick={() => { setPickerOpen(value => !value) }}
            >
              <span className={createCss.selectValue}>{target === undefined ? t('tasksAssignMember') : target.member.handle.replace(/^@/, '')}</span>
              <span className={`${createCss.chevron!} ${pickerOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
            </button>
          }
        />
      </div>
      <label className={createCss.field}>
        <span>{t('tasksAssignNoteLabel')}</span>
        <Input value={note} onChange={event => { setNote(event.target.value) }} disabled={sending} />
      </label>
      {membersError !== undefined && <p className={createCss.error} role="alert">{membersError}</p>}
      {members !== undefined && membersError === undefined && targets.length === 0 && <p className={createCss.error} role="alert">{t('tasksAssignMemberNone')}</p>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </div>
  </Modal>
}
