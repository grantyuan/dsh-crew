/**
 * Team-owned automatic capability assessment.
 *
 * The Human rates every Member 1..10 in the editor and the designated Leader
 * adjusts those ratings through `team_rate`; this module covers the third
 * lane, and it only exists when the Human switched it on — the durable
 * `autoCapabilityAssessment` switch on the Leader's Member entity. When on,
 * the Host watches for Members whose finished work has accumulated since the
 * last assessment (their own Claim completions plus Tasks the Human accepted
 * over their still-active Claims) and, past a per-Member cooldown, asks the
 * Leader — through the ordinary Team Assistant mention — to re-read that
 * work and re-rate the Member with `team_rate`. The Leader decides: adjust
 * the score, or ignore the reminder; nothing is ever written on the
 * Member's behalf by this lane.
 *
 * Latches are process-local like every watcher's: a restarted Host may let
 * one assessment ask through again, which is a repeated reminder, never a
 * doubled rating — the rating itself is a durable Member fact only the
 * Human, the Leader, and nothing else write.
 * @module @grantyuan/dsh-crew/capability-assessment
 */

import type { AgentTeamMemberId, AgentTeamTaskRef } from './types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** How often the assessor re-checks for accumulated finished work. */
export const CAPABILITY_ASSESSMENT_INTERVAL_MS = 10 * 60 * 1000

/** How long one Member's assessment stays quiet after it last fired. */
export const CAPABILITY_ASSESSMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** One Member with finished work the Leader should re-look at. */
export interface CapabilityAssessmentTarget {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  readonly currentScore: number | undefined
  readonly finished: number
  readonly taskRefs: readonly AgentTeamTaskRef[]
}

/** The designated Leader one assessment addresses. */
export interface CapabilityAssessmentLeader {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

export interface CapabilityAssessmentOptions {
  /** Every enabled Workspace the Host serves, at pass time. */
  readonly workspaces: () => readonly { readonly workspaceId: WorkspaceId; readonly leader: CapabilityAssessmentLeader | undefined }[]
  /** Whether the assessment switch stands for the Leader of this Workspace. */
  readonly assessmentEnabled: (leaderMemberId: AgentTeamMemberId) => boolean
  /** Every enabled non-external Agent Member of one Workspace, except its Leader. */
  readonly membersToAssess: (workspaceId: WorkspaceId, leaderMemberId: AgentTeamMemberId) => readonly { readonly memberId: AgentTeamMemberId; readonly handle: string; readonly currentScore: number | undefined }[]
  /** Finished work one Member accumulated since the last assessment. */
  readonly completedSince: (memberId: AgentTeamMemberId, sinceSequence: number) => { readonly finished: number; readonly taskRefs: readonly AgentTeamTaskRef[] }
  /** The ledger position the next assessment measures from. */
  readonly position: () => number
  /** Deliver one assessment ask; a throw is logged and retried next pass. */
  readonly notify: (leader: CapabilityAssessmentLeader, targets: readonly CapabilityAssessmentTarget[]) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
  readonly intervalMs?: number
  readonly cooldownMs?: number
}

export class CapabilityAssessor {
  private readonly intervalMs: number
  private readonly cooldownMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private passRunning = false
  private disposed = false
  /** Per-Member assessment latch: the position measured from and the wall clock it fired at. */
  private readonly assessed = new Map<AgentTeamMemberId, { readonly sinceSequence: number; readonly at: number }>()

  constructor(private readonly options: CapabilityAssessmentOptions) {
    this.intervalMs = options.intervalMs ?? CAPABILITY_ASSESSMENT_INTERVAL_MS
    this.cooldownMs = options.cooldownMs ?? CAPABILITY_ASSESSMENT_COOLDOWN_MS
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
   * One assessment pass. Overlapping passes are skipped rather than queued,
   * exactly like the other monitors; the delivery is serialized on the
   * Host's send path anyway.
   */
  async runPass(now = Date.now()): Promise<void> {
    if (this.disposed || this.passRunning) return
    this.passRunning = true
    try {
      for (const { workspaceId, leader } of this.options.workspaces()) {
        if (leader === undefined || !this.options.assessmentEnabled(leader.memberId)) continue
        const targets: CapabilityAssessmentTarget[] = []
        for (const member of this.options.membersToAssess(workspaceId, leader.memberId)) {
          const latch = this.assessed.get(member.memberId)
          if (latch !== undefined && now - latch.at < this.cooldownMs) continue
          const sinceSequence = latch?.sinceSequence ?? 0
          const work = this.options.completedSince(member.memberId, sinceSequence)
          if (work.finished <= 0) continue
          targets.push({ ...member, finished: work.finished, taskRefs: work.taskRefs })
          // The latch moves before delivery: a slow or failed post retries
          // on a later pass with the newer evidence window, not a doubled ask.
          this.assessed.set(member.memberId, { sinceSequence: this.options.position(), at: now })
        }
        if (targets.length === 0) continue
        try {
          await this.options.notify(leader, targets)
        } catch (error) {
          this.options.log(`capability assessment for leader '${leader.handle}' failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      this.passRunning = false
    }
  }
}

/**
 * The assessment ask: posted in the Team Assistant's voice with the Leader
 * as the only explicit recipient, it lists each Member's finished work since
 * the last look and states the decision that is the Leader's own — re-rate
 * with `team_rate`, or ignore. Quoted handles are authored here; quoted
 * bodies must be neutralized before they reach this builder.
 */
export function capabilityAssessmentText(input: {
  readonly leaderHandle: string
  readonly targets: readonly CapabilityAssessmentTarget[]
}): string {
  const lines = [
    `@${input.leaderHandle} Capability assessment due — these Members finished work since you last looked:`,
    ...input.targets.map(target =>
      `- @${target.handle} finished ${target.finished} work item(s)${target.taskRefs.length > 0 ? ` (${target.taskRefs.join(', ')})` : ''} — currently ${target.currentScore === undefined ? 'unrated' : `${target.currentScore}/10`}`),
    'Re-read that work and re-rate what changed with team_rate action=set (1..10, with your reason); if the standing score still fits, ignore this reminder. Weight the ratings when you assign or reassign Tasks.',
  ]
  return lines.join('\n')
}
