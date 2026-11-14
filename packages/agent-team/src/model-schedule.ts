/**
 * Team-owned time-interval model routing.
 *
 * A Member may carry a `modelSchedule`: an ordered list of `HH:MM` windows
 * in the fixed Team coordination zone (UTC+8), each demanding one provider
 * route on the days its recurrence matches (absent = every day). This module
 * owns the arithmetic — which window covers the current instant, which
 * boundary in the next horizon actually changes the effective route, and
 * when a Member deserves its heads-up. It owns no
 * facts: the applied route lives on the Member entity (committed by the
 * Host through `team/member-model-scheduled`), and the Host applies every
 * effective-route change through the shared context-renewal path — the same
 * 重置 the Human menu uses — so a switch always starts a fresh generation
 * activating on the new route, never a half-swapped live Session.
 *
 * The monitor is a plain interval pass in the supervisor/watcher family:
 * each pass re-derives the desired route from the schedule and compares it
 * with the durable applied route, so the boundary needs no armed timer —
 * a Host that was down across a boundary converges on the next pass, and
 * a switch that cannot complete (the Member is mid-turn) simply remains
 * outstanding and lands on the next pass. Reminders fire once per boundary
 * from the Team Assistant's voice with the Member as the only explicit
 * recipient, ten minutes ahead, telling it to prepare its handover — the
 * latch is process-local like every other watcher's, so a restart may let
 * one heads-up through a second time; the switch itself never duplicates,
 * because its idempotence is the durable applied-vs-desired comparison.
 * @module @grantyuan/dsh-crew/model-schedule
 */

import { isDeepStrictEqual } from 'node:util'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberId,
  AgentTeamMemberModelSchedule,
  AgentTeamModelSelection,
} from './types.ts'
import {
  MINUTES_PER_DAY,
  MS_PER_MINUTE,
  TEAM_ZONE_OFFSET_MS,
  describeRecurrence,
  parseScheduleMinute,
  teamAbsoluteMinute,
  teamMinuteOfDay,
  windowOccurrencesAround,
} from './schedule-recurrence.ts'

// The Team-zone minute primitives and the window-bounds parser live in the
// recurrence authority (both schedules and the candidate-day expansion share
// them); this module keeps them importable from their historical path.
export { MINUTES_PER_DAY, TEAM_ZONE_OFFSET_MS, parseScheduleMinute, teamAbsoluteMinute, teamMinuteOfDay }

/** How often the monitor re-derives desired routes; matches the watch/liaison cadence. */
export const MODEL_SCHEDULE_PASS_INTERVAL_MS = 30 * 1000

/** How far ahead a route-changing boundary earns a heads-up. */
export const MODEL_SCHEDULE_NOTICE_AHEAD_MS = 10 * 60 * 1000

/**
 * Whether one window covers the given Team-zone day minute (start inclusive,
 * end exclusive, wrap allowed). The bounds-only shape is the shared window
 * arithmetic: the model schedule's routed windows and the stop schedule's
 * plain spans both satisfy it.
 */
export function scheduleWindowCovers(window: { readonly start: string; readonly end: string }, minuteOfDay: number): boolean {
  const start = parseScheduleMinute(window.start)
  const end = parseScheduleMinute(window.end)
  if (start === end) return false
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end
}

/**
 * The route the schedule demands at one epoch instant: the FIRST window whose
 * expanded occurrence contains the instant wins (config order is priority),
 * and no cover — or a disabled schedule — demands no override, leaving the
 * Member on its pinned route. Occurrences come from the candidate-day spread
 * ({@link windowOccurrencesAround}), so a window is effective only on the days
 * its recurrence matches, and a cross-midnight window begun the previous
 * evening still covers this morning.
 */
export function resolveScheduleRouteAt(schedule: AgentTeamMemberModelSchedule, epochMs: number): AgentTeamModelSelection | undefined {
  if (!schedule.enabled) return undefined
  for (const window of schedule.windows) {
    for (const occurrence of windowOccurrencesAround(window, epochMs)) {
      if (epochMs >= occurrence.startMs && epochMs < occurrence.endMs) return window.selection
    }
  }
  return undefined
}

/**
 * The daily-shape minute-of-day resolver: bounds-only, recurrence-blind. This
 * is the pre-recurrence contract — for windows without a recurrence it answers
 * exactly what {@link resolveScheduleRouteAt} answers on any day (the modular
 * bounds test and the expanded occurrences agree minute for minute). A window
 * carrying a recurrence has no day-independent answer; callers resolving real
 * moments must use {@link resolveScheduleRouteAt}.
 */
export function resolveScheduleRoute(schedule: AgentTeamMemberModelSchedule, minuteOfDay: number): AgentTeamModelSelection | undefined {
  if (!schedule.enabled) return undefined
  for (const window of schedule.windows) {
    if (scheduleWindowCovers(window, minuteOfDay)) return window.selection
  }
  return undefined
}

/** Route equality with absent-meaning-no-override semantics. */
export function sameScheduleRoute(a: AgentTeamModelSelection | undefined, b: AgentTeamModelSelection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return isDeepStrictEqual(a, b)
}

/** One stable latch key for one route (or the pinned-route fallback). */
export function scheduleRouteKey(selection: AgentTeamModelSelection | undefined): string {
  return selection === undefined ? 'pinned' : `${selection.provider}\u0000${selection.model}\u0000${selection.reasoningEffort ?? ''}`
}

/** A boundary inside the notice horizon that changes the effective route. */
export interface ModelScheduleBoundary {
  /** The epoch instant the route changes (aligned to the Team-zone minute). */
  readonly atMs: number
  /** Absolute Team-zone minute of the boundary — the once-per-boundary latch key. */
  readonly absoluteMinute: number
  /** The route demanded from the boundary on; undefined means the schedule stops overriding. */
  readonly incoming: AgentTeamModelSelection | undefined
  /** The owning window's recurrence phrase (e.g. `on workdays`); empty for a plain daily window. */
  readonly recurrenceText: string
}

/**
 * Boundaries in `(now, now + horizonMs]` where the schedule's resolved route
 * changes — the start and end of every occurrence the candidate days expand,
 * filtered to edges the route actually crosses. Window starts and ends whose
 * crossing leaves the route exactly as it was earn nothing (no reminder, and
 * no switch, because the effective route never moved). Deduplicated by
 * absolute minute: a Member gets one heads-up per change instant, not one per
 * window touching it. Horizon distance stays on the minute grid (whole
 * minutes from the running minute), exactly like the pre-recurrence passes.
 */
export function upcomingRouteChanges(schedule: AgentTeamMemberModelSchedule, nowMs: number, horizonMs = MODEL_SCHEDULE_NOTICE_AHEAD_MS): readonly ModelScheduleBoundary[] {
  if (!schedule.enabled) return []
  const nowMinute = teamAbsoluteMinute(nowMs)
  const byMinute = new Map<number, ModelScheduleBoundary>()
  for (const window of schedule.windows) {
    for (const occurrence of windowOccurrencesAround(window, nowMs)) {
      // Occurrence edges are exact Team-zone minute instants, so their
      // absolute Team-zone minute is a whole number, and the distance to now
      // is whole minutes on the same grid the latch keys use.
      for (const edgeMs of [occurrence.startMs, occurrence.endMs]) {
        const absoluteMinute = teamAbsoluteMinute(edgeMs)
        const delta = absoluteMinute - nowMinute
        // delta <= 0: the crossing minute is already running or gone — the pass
        // itself applies a due change; a heads-up now would be a note after the fact.
        if (delta <= 0 || delta * MS_PER_MINUTE > horizonMs) continue
        const before = resolveScheduleRouteAt(schedule, edgeMs - MS_PER_MINUTE)
        const after = resolveScheduleRouteAt(schedule, edgeMs)
        if (sameScheduleRoute(before, after)) continue
        const boundary: ModelScheduleBoundary = {
          atMs: edgeMs,
          absoluteMinute,
          incoming: after,
          recurrenceText: describeRecurrence(window.recurrence),
        }
        if (!byMinute.has(boundary.absoluteMinute)) byMinute.set(boundary.absoluteMinute, boundary)
      }
    }
  }
  return [...byMinute.values()].sort((a, b) => a.absoluteMinute - b.absoluteMinute)
}

/** Options wiring one monitor onto its Host. */
export interface ModelScheduleMonitorOptions {
  /** Every stored Member (any state); the pass narrows to enabled non-external Agent Members. */
  readonly members: () => readonly AgentTeamAgentMember[]
  /**
   * Commit the desired applied route when it differs, and land the live
   * switch through the Host's context-renewal (reset) path. Resolves true
   * when nothing further is outstanding for `desired` (switched, or the
   * Member holds no live generation and the next activation will pick it up),
   * false when the Member is mid-turn and the switch must retry. A throw is
   * logged and retried on the next pass.
   */
  readonly applySwitch: (member: AgentTeamAgentMember, desired: AgentTeamModelSelection | undefined) => Promise<boolean>
  /** Deliver one pre-switch heads-up in the Team Assistant's voice; a throw retries the same boundary next pass. */
  readonly remind: (member: AgentTeamAgentMember, boundary: ModelScheduleBoundary) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly noticeAheadMs?: number
}

export class ModelScheduleMonitor {
  private readonly intervalMs: number
  private readonly noticeAheadMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false
  /**
   * Members whose live switch for a desired route has not yet landed (a
   * mid-turn Member defers it): the key is that exact route, so the pass
   * keeps driving the same switch until it completes, and a config change
   * simply replaces what is outstanding.
   */
  private readonly pendingSwitch = new Map<AgentTeamMemberId, string>()
  /** Delivered reminders, keyed Member + absolute boundary minute; pruned past one day and a change. */
  private readonly reminded = new Map<string, number>()

  constructor(private readonly options: ModelScheduleMonitorOptions) {
    this.intervalMs = options.intervalMs ?? MODEL_SCHEDULE_PASS_INTERVAL_MS
    this.noticeAheadMs = options.noticeAheadMs ?? MODEL_SCHEDULE_NOTICE_AHEAD_MS
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

  /**
   * One schedule pass. Overlapping passes are skipped rather than queued,
   * exactly like the other monitors: the switch body is serialized on the
   * Host's lifecycle queue anyway.
   */
  async runPass(now = Date.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      for (const member of this.options.members()) {
        if (member.state !== 'enabled' || member.external === true) {
          this.pendingSwitch.delete(member.memberId)
          continue
        }
        const schedule = member.modelSchedule
        const desired = schedule !== undefined && schedule.enabled
          ? resolveScheduleRouteAt(schedule, now)
          : undefined
        const desiredKey = scheduleRouteKey(desired)
        // Drive a switch when the durable applied route disagrees with the
        // schedule, or while a previously attempted switch for this exact
        // route still waits for a turn boundary.
        if (desiredKey !== scheduleRouteKey(member.scheduledModel) || this.pendingSwitch.get(member.memberId) === desiredKey) {
          try {
            const landed = await this.options.applySwitch(member, desired)
            if (landed) this.pendingSwitch.delete(member.memberId)
            else this.pendingSwitch.set(member.memberId, desiredKey)
          } catch (error) {
            this.pendingSwitch.set(member.memberId, desiredKey)
            this.options.log(`model schedule switch for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (schedule === undefined || !schedule.enabled) continue
        for (const boundary of upcomingRouteChanges(schedule, now, this.noticeAheadMs)) {
          const key = `${member.memberId}\u0000${boundary.absoluteMinute}`
          if (this.reminded.has(key)) continue
          try {
            await this.options.remind(member, boundary)
            this.reminded.set(key, boundary.absoluteMinute)
          } catch (error) {
            this.options.log(`model schedule notice for member '${member.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const nowMinute = teamAbsoluteMinute(now)
      for (const [key, absoluteMinute] of this.reminded) {
        if (nowMinute - absoluteMinute > MINUTES_PER_DAY + 720) this.reminded.delete(key)
      }
    } finally {
      this.passRunning = false
    }
  }
}

/**
 * The pre-switch heads-up: posted in the Team Assistant's voice into one of
 * the Member's Channels with the Member as the only explicit recipient, it
 * names the incoming route, the owning window's recurrence, and the moment,
 * and states the one expectation — hand the work over before the reset lands,
 * because the new generation starts from an empty context on the new route.
 */
export function modelScheduleSwitchNoticeText(input: {
  readonly memberHandle: string
  readonly whenText: string
  readonly incoming: AgentTeamModelSelection | undefined
  /** The effective window's recurrence phrase (e.g. `on workdays`); empty or absent for a plain daily window. */
  readonly recurrenceText?: string
}): string {
  const recurrencePhrase = input.recurrenceText === undefined || input.recurrenceText === '' ? '' : ` ${input.recurrenceText}`
  const route = input.incoming === undefined
    ? 'back onto its pinned route (no scheduled window covers the moment)'
    : `onto ${input.incoming.provider}/${input.incoming.model}`
  const lines = [
    `@${input.memberHandle} Model switch notice: your Team model schedule${recurrencePhrase} switches your model route ${route} at ${input.whenText}. The switch lands through a context reset — a fresh Session starts empty on the new route, and you will remember nothing of this one.`,
    'Prepare before it lands: finish or stop the work you are mid-way through (jobs included), write the current state and your next steps into your private memory, and post to the relevant Thread whatever the Team must not lose with this context.',
    'After the reset, re-orient through your memory index, team_view, and team_inbox before continuing.',
  ]
  return lines.join('\n')
}
