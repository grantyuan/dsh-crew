import { describe, expect, it } from 'vitest'
import { CapabilityAssessor, capabilityAssessmentText, CAPABILITY_ASSESSMENT_COOLDOWN_MS } from '../src/capability-assessment.ts'
import type { AgentTeamMemberId, AgentTeamTaskRef } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const alpha = 'workspace:alpha' as WorkspaceId
const id = (value: string): AgentTeamMemberId => value as AgentTeamMemberId

const leader = { memberId: id('member:lead'), handle: 'lead' }

function harness(options: {
  readonly enabled?: boolean
  readonly work?: number
} = {}) {
  const enabled = options.enabled ?? true
  const work = options.work ?? 0
  const members = [
    { memberId: id('member:lead'), handle: 'lead', currentScore: undefined },
    { memberId: id('member:worker'), handle: 'worker', currentScore: 5 },
  ]
  const notices: Array<{ readonly leader: { readonly memberId: AgentTeamMemberId; readonly handle: string }; readonly targets: readonly { readonly memberId: AgentTeamMemberId; readonly handle: string; readonly finished: number }[] }> = []
  const logs: string[] = []
  let position = 100
  const assessor = new CapabilityAssessor({
    workspaces: () => [{ workspaceId: alpha, leader }],
    assessmentEnabled: () => enabled,
    membersToAssess: () => members.filter(member => member.memberId !== leader.memberId),
    completedSince: () => ({ finished: work, taskRefs: work > 0 ? ['task:1' as AgentTeamTaskRef] : [] }),
    position: () => position,
    notify: async (notifiedLeader, targets) => { notices.push({ leader: notifiedLeader, targets }) },
    log: message => { logs.push(message) },
  })
  return { assessor, notices, logs, bump: () => { position += 1 } }
}

describe('CapabilityAssessor passes', () => {
  it('asks the Leader once per Member with accumulated finished work', async () => {
    const h = harness({ work: 2 })
    await h.assessor.runPass(1_000)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.leader).toEqual(leader)
    expect(h.notices[0]?.targets[0]).toMatchObject({ handle: 'worker', finished: 2, currentScore: 5 })
    // The cooldown keeps the reminder quiet even with fresh work next pass.
    await h.assessor.runPass(1_000 + 60_000)
    expect(h.notices).toHaveLength(1)
    await h.assessor.runPass(1_000 + CAPABILITY_ASSESSMENT_COOLDOWN_MS + 60_000)
    expect(h.notices).toHaveLength(2)
  })

  it('stays silent when the switch is off or no work accumulated', async () => {
    const off = harness({ enabled: false, work: 3 })
    await off.assessor.runPass(1_000)
    expect(off.notices).toHaveLength(0)
    const idle = harness({ enabled: true, work: 0 })
    await idle.assessor.runPass(1_000)
    expect(idle.notices).toHaveLength(0)
  })

  it('writes the assessment ask with the evidence and the decision that stays the Leader\'s', () => {
    const text = capabilityAssessmentText({
      leaderHandle: 'lead',
      targets: [{ memberId: id('member:worker'), handle: 'worker', currentScore: 5, finished: 3, taskRefs: ['task:1' as AgentTeamTaskRef, 'task:2' as AgentTeamTaskRef] }],
    })
    expect(text).toContain('@lead')
    expect(text).toContain('@worker finished 3 work item(s) (task:1, task:2) — currently 5/10')
    expect(text).toContain('team_rate action=set')
  })
})
