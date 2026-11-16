import { describe, expect, it } from 'vitest'
import { QUEUE_DISCIPLINE_TEXT, queueAdvanceNotice, queueAssignmentNotice, queueReassignedNotice } from '../src/queue-advance.ts'

describe('task-queue notice prose', () => {
  it('renders an assignment wake naming every placed entry with its note', () => {
    const text = queueAssignmentNotice({
      handle: 'builder',
      items: [
        { taskNumber: 12, subject: 'Investigate the regression', note: 'start here' },
        { taskNumber: 13, subject: 'Second task' },
      ],
    })
    expect(text).toContain('@builder Queue assignment: 2 tasks placed in your task queue.')
    expect(text).toContain('- Task #12 "Investigate the regression" — start here')
    expect(text).toContain('- Task #13 "Second task"')
    expect(text).toContain(QUEUE_DISCIPLINE_TEXT)
  })

  it('renders the singular assignment line for one entry', () => {
    const text = queueAssignmentNotice({ handle: 'builder', items: [{ taskNumber: 4, subject: 'Only task' }] })
    expect(text).toContain('1 task placed in your task queue.')
  })

  it('renders an advance wake with the next pending entry and the discipline line', () => {
    const text = queueAdvanceNotice({
      handle: 'builder',
      previous: { kind: 'done', taskNumber: 12 },
      next: { taskNumber: 13, subject: 'Second task', note: 'unblock the release' },
    })
    expect(text).toContain('Task #12 handed off — it now waits for Human acceptance.')
    expect(text).toContain('Your next queued task is Task #13 "Second task" — unblock the release')
    expect(text).toContain(QUEUE_DISCIPLINE_TEXT)
  })

  it('renders an empty-queue advance and a release advance without a next entry', () => {
    const done = queueAdvanceNotice({ handle: 'builder', previous: { kind: 'done', taskNumber: 12 } })
    expect(done).toContain('No other task is pending in your queue.')
    const released = queueAdvanceNotice({ handle: 'builder', previous: { kind: 'release', taskNumber: 7 } })
    expect(released).toContain('Task #7 released — its queue entry is back to pending and no longer yours to re-prompt.')
    expect(released).not.toContain('Your next queued task')
  })

  it('renders the reassignment wake for the receiving Member', () => {
    const text = queueReassignedNotice({
      handle: 'reviewer', byHandle: 'lead',
      task: { taskNumber: 9, subject: '叠放校验', note: 'moving' },
    })
    expect(text).toContain('@reviewer Queue reassignment: lead moved Task #9 "叠放校验" into your task queue — moving')
    expect(text).toContain(QUEUE_DISCIPLINE_TEXT)
  })
})
