/**
 * Team-owned time-interval stop-run scheduling.
 *
 * A Member may carry a `stopSchedule`: an ordered list of daily `HH:MM`
 * windows in the fixed Team coordination zone (UTC+8) during which the
 * Member must not run. This module owns the arithmetic — which window
 * covers the current minute, which boundaries sit inside the notice
 * horizon, and which boundary has just crossed — and the notice texts. It
 * owns no facts: the schedule is durable Human intent on the Member entity,
 * and the only consequences are Team Assistant notifications delivered at
 * the boundaries. The Host never forces a running turn down — the orderly
 * wrap-up the wrap-up notice asks for (handover document, Manager report,
 * stating the stop interval) is the contract, and killing the turn would
 * cut exactly that report short.
 *
 * The monitor is a plain interval pass in the supervisor/watcher family,
 * mirroring the model-schedule monitor: each pass re-derives the boundary
 * picture from the schedule, so the boundary needs no armed timer — a Host
 * that was down across a start converges on the next pass while the window
 * stands, and a resume converges within its freshness bound. Reminders
 * fire once per boundary from the Team Assistant's voice with the Member as
 * the only explicit recipient; the latch is process-local like every other
 * watcher's, so a restart may let one notice through a second time.
 * @module @grantyuan/dsh-crew/stop-schedule
 */

import type {
  AgentTeamAgentMember,
  AgentTeamMemberStopSchedule,
  AgentTeamMemberStopWindow,
} from './types.ts'
import {
  MINUTES_PER_DAY,
  MS_PER_MINUTE,
  describeRecurrence,
  teamAbsoluteMinute,
  windowCoversAt,
  windowOccurrencesAround,
} from './schedule-recurrence.ts'

/** How often the monitor re-derives the boundary picture; matches the watch/liaison cadence. */
export const STOP_SCHEDULE_PASS_INTERVAL_MS = 30 * 1000

/** How far ahead a window start earns its wrap-up heads-up. */
export const STOP_SCHEDULE_NOTICE_AHEAD_MS = 30 * 60 * 1000

/**
 * How long after a window end the resume notice still converges. Past this
 * the crossing is history, not an event: a wrap window's previous-day end
 * would otherwise sit eligible through every covered minute and greet a
 * newly enabled window with a stale "you may start again".
 */
export const STOP_SCHEDULE_RESUME_STALE_MS = 60 * 60 * 1000

/** What one boundary means: the window begins (stop) or ends (resume). */
export type StopScheduleBoundaryKind = 'stop' | 'resume'

/** One boundary of one stop window occurrence, resolved to an epoch instant. */
export interface StopScheduleBoundary {
  /** The epoch instant the boundary sits on (aligned to the Team-zone minute). */
  readonly atMs: number
  /** Absolute Team-zone minute of the boundary — the once-per-boundary latch key part. */
  readonly absoluteMinute: number
  readonly kind: StopScheduleBoundaryKind
  /** The window the boundary belongs to (the notice names its bounds and recurrence). */
  readonly window: AgentTeamMemberStopWindow
}

/**
 * Window starts inside `(now, now + horizonMs]` — the moments a running
 * Member must be told (half an hour ahead) to wrap up. Window ends earn no
 * heads-up: the resume notice belongs AFTER the window, never before.
 * Starts come from the candidate-day occurrence spread, so only a matched
 * start day offers its boundary. Deduplicated by absolute minute:
 * overlapping windows starting together earn one heads-up, naming the first
 * window's bounds.
 */
export function upcomingStopBoundaries(schedule: AgentTeamMemberStopSchedule, nowMs: number, horizonMs = STOP_SCHEDULE_NOTICE_AHEAD_MS): readonly StopScheduleBoundary[] {
  if (!schedule.enabled) return []
  const nowMinute = teamAbsoluteMinute(nowMs)
  const byMinute = new Map<number, StopScheduleBoundary>()
  for (const window of schedule.windows) {
    for (const occurrence of windowOccurrencesAround(window, nowMs)) {
      // Occurrence edges are exact Team-zone minute instants, so their
      // absolute Team-zone minute is a whole number, and the distance to now
      // is whole minutes on the same grid the latch keys use.
      const absoluteMinute = teamAbsoluteMinute(occurrence.startMs)
      const delta = absoluteMinute - nowMinute
      // delta <= 0: the window is already running or the start is gone — the
      // pass itself delivers the boundary-stop notice while the window stands,
      // a heads-up now would be a note after the fact.
      if (delta <= 0 || delta * MS_PER_MINUTE > horizonMs) continue
      if (!byMinute.has(absoluteMinute)) byMinute.set(absoluteMinute, { atMs: occurrence.startMs, absoluteMinute, kind: 'stop', window })
    }
  }
  return [...byMinute.values()].sort((a, b) => a.absoluteMinute - b.absoluteMinute)
}

/**
 * The most recent crossing of every window boundary, resolved on the
 * candidate-day occurrence spread. A stop boundary is the start of the
 * occurrence that still covers the current minute (inside the window, the
 * stop expectation stands; start inclusive, so the start minute itself
 * counts); a resume boundary is the end of an occurrence that has just
 * ended — within {@link STOP_SCHEDULE_RESUME_STALE_MS} — while the window
 * no longer covers the moment through any occurrence. Deduplicated by
 * absolute minute and kind: overlapping windows crossing together earn one
 * notice.
 */
export function crossedStopBoundaries(schedule: AgentTeamMemberStopSchedule, nowMs: number): readonly StopScheduleBoundary[] {
  if (!schedule.enabled) return []
  const nowMinute = teamAbsoluteMinute(nowMs)
  const byKey = new Map<string, StopScheduleBoundary>()
  for (const window of schedule.windows) {
    const covering = windowCoversAt(window, nowMs)
    for (const occurrence of windowOccurrencesAround(window, nowMs)) {
      // The covering occurrence's start is the crossed stop edge — including
      // the start minute itself, where the edge is exact now (start inclusive).
      if (nowMs >= occurrence.startMs && nowMs < occurrence.endMs) {
        const boundary: StopScheduleBoundary = { atMs: occurrence.startMs, absoluteMinute: teamAbsoluteMinute(occurrence.startMs), kind: 'stop', window }
        const key = `${boundary.absoluteMinute}\u0000stop`
        if (!byKey.has(key)) byKey.set(key, boundary)
        continue
      }
      // An end just past, with the window no longer covering, is the resume
      // crossing — including the end minute itself, where the edge is exact
      // now (end exclusive).
      const delta = nowMinute - teamAbsoluteMinute(occurrence.endMs)
      if (!covering && delta >= 0 && delta * MS_PER_MINUTE <= STOP_SCHEDULE_RESUME_STALE_MS) {
        const boundary: StopScheduleBoundary = { atMs: occurrence.endMs, absoluteMinute: teamAbsoluteMinute(occurrence.endMs), kind: 'resume', window }
        const key = `${boundary.absoluteMinute}\u0000resume`
        if (!byKey.has(key)) byKey.set(key, boundary)
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.absoluteMinute - b.absoluteMinute)
}

/**
 * The recurrence phrase inside the window parenthetical, e.g.
 * `(22:00–06:00 Team time, on workdays)`. A plain daily window phrases as
 * nothing, so pre-recurrence notices render byte-identically to before.
 */
function windowRecurrenceSuffix(window: AgentTeamMemberStopWindow): string {
  const phrase = describeRecurrence(window.recurrence)
  return phrase === '' ? '' : `, ${phrase}`
}

/**
 * The half-an-hour-ahead wrap-up notice: posted in the Team Assistant's
 * voice with the Member as the only explicit recipient, it names the window,
 * its recurrence, and the moment, and carries the full wrap-up contract —
 * finish or park the work, write the handover document, report progress and
 * wrap-up status to the Manager before finishing, and state the stop interval.
 */
export function stopScheduleWrapUpNoticeText(input: {
  readonly memberHandle: string
  readonly whenText: string
  readonly window: AgentTeamMemberStopWindow
}): string {
  const lines = [
    `@${input.memberHandle} Stop-run notice: your stop-run window (${input.window.start}–${input.window.end} Team time${windowRecurrenceSuffix(input.window)}) starts at ${input.whenText} — in 30 minutes you must stop running.`,
    `Before you stop: finish or safely park the work you are mid-way through (background jobs included); write a handover document into your private memory (current state, next steps, open risks, where everything lives); and before you finish, report your progress and wrap-up status to the Manager (your Team's designated leader), stating that you will be stopped from ${input.window.start} to ${input.window.end}.`,
  ]
  return lines.join('\n')
}

/**
 * The boundary notice: the window has started and the Member is still
 * working — stop now, keep only the essential wrap-up (the handover
 * document and the Manager report), and start nothing new inside the window.
 */
export function stopScheduleBoundaryNoticeText(input: {
  readonly memberHandle: string
  readonly window: AgentTeamMemberStopWindow
}): string {
  const lines = [
    `@${input.memberHandle} Stop window started: your stop-run window (${input.window.start}–${input.window.end} Team time${windowRecurrenceSuffix(input.window)}) has started — stop running now.`,
    'Complete only the essential wrap-up (the handover document and the Manager report from the earlier notice) and end your turn; do not start new work inside the window.',
  ]
  return lines.join('\n')
}

/**
 * The resume notice: the window has ended — the Member may start again, and
 * its first move is to ask the Manager how to carry out the follow-up work.
 */
export function stopScheduleResumeNoticeText(input: {
  readonly memberHandle: string
  readonly window: AgentTeamMemberStopWindow
}): string {
  const lines = [
    `@${input.memberHandle} Stop window ended: your stop-run window (${input.window.start}–${input.window.end} Team time${windowRecurrenceSuffix(input.window)}) has ended — you may start again.`,
    'Before resuming work, ask the Manager how to carry out the follow-up work: they hold your wrap-up report and the Team\'s current priorities.',
  ]
  return lines.join('\n')
}

/** Options wiring one monitor onto its Host. */
export interface StopScheduleMonitorOptions {
  /** Every stored Member (any state); the pass narrows to enabled non-external Agent Members. */
  readonly members: () => readonly AgentTeamAgentMember[]
  /** Whether the Member's Session is live (idle or mid-turn) — a stopped Member earns no wrap-up heads-up. */
  readonly isRunning: (member: AgentTeamAgentMember) => boolean
  /** Whether the Member is mid-turn — only a still-working Member earns the boundary-stop notice. */
  readonly isMidTurn: (member: AgentTeamAgentMember) => boolean
  /** Deliver one notice in the Team Assistant's voice; a throw retries the same boundary next pass. */
  readonly notify: (member: AgentTeamAgentMember, body: string) => Promise<void>
  /** Renders one boundary instant for the wrap-up notice; defaults to the ISO instant. */
  readonly formatWhen?: (atMs: number) => string
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly noticeAheadMs?: number
}

export class StopScheduleMonitor {
  private readonly intervalMs: number
  private readonly noticeAheadMs: number
  private readonly formatWhen: (atMs: number) => string
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false
  /** Delivered notices, keyed Member + kind + absolute boundary minute; pruned past one day and a half-day. */
  private readonly delivered = new Map<string, number>()

  constructor(private readonly options: StopScheduleMonitorOptions) {
    this.intervalMs = options.intervalMs ?? STOP_SCHEDULE_PASS_INTERVAL_MS
    this.noticeAheadMs = options.noticeAheadMs ?? STOP_SCHEDULE_NOTICE_AHEAD_MS
    this.formatWhen = options.formatWhen ?? (atMs => new Date(atMs).toISOString())
  }

  /** Begin the periodic pass; called once the Host has restored every Member. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.runPass() }, this.intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private async deliver(member: AgentTeamAgentMember, key: string, boundary: StopScheduleBoundary, body: string): Promise<void> {
    try {
      await this.options.notify(member, body)
      this.delivered.set(key, boundary.absoluteMinute)
    } catch (error) {
      this.options.log(`stop schedule notice for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One schedule pass. Overlapping passes are skipped rather than queued,
   * exactly like the other monitors: the notice body is serialized on the
   * Host's send path anyway.
   */
  async runPass(now = Date.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      for (const member of this.options.members()) {
        if (member.state !== 'enabled' || member.external === true) continue
        const schedule = member.stopSchedule
        if (schedule === undefined || !schedule.enabled) continue
        for (const boundary of upcomingStopBoundaries(schedule, now, this.noticeAheadMs)) {
          const key = `${member.memberId}\u0000wrap\u0000${boundary.absoluteMinute}`
          if (this.delivered.has(key)) continue
          if (!this.options.isRunning(member)) continue
          await this.deliver(member, key, boundary, stopScheduleWrapUpNoticeText({
            memberHandle: member.handle,
            whenText: this.formatWhen(boundary.atMs),
            window: boundary.window,
          }))
        }
        for (const boundary of crossedStopBoundaries(schedule, now)) {
          const verb = boundary.kind === 'stop' ? 'stop' : 'resume'
          const key = `${member.memberId}\u0000${verb}\u0000${boundary.absoluteMinute}`
          if (this.delivered.has(key)) continue
          if (boundary.kind === 'stop' && !this.options.isMidTurn(member)) continue
          await this.deliver(member, key, boundary, boundary.kind === 'stop'
            ? stopScheduleBoundaryNoticeText({ memberHandle: member.handle, window: boundary.window })
            : stopScheduleResumeNoticeText({ memberHandle: member.handle, window: boundary.window }))
        }
      }
      const nowMinute = teamAbsoluteMinute(now)
      for (const [key, absoluteMinute] of this.delivered) {
        if (nowMinute - absoluteMinute > MINUTES_PER_DAY + 720) this.delivered.delete(key)
      }
    } finally {
      this.passRunning = false
    }
  }
}
