/**
 * The fixed prose of the Host's task-queue notices. The queue's automation
 * contract lives here in one place: an assignment or an advance names the
 * next work, and every wake repeats the routing discipline — analyze before
 * starting, merge/split only with the Leader's confirmation, and never touch
 * order or priorities yourself. These are ordinary Team Assistant Messages in
 * the Task's own Channel, so they land in the Member's Inbox like any other
 * Team fact; the texts are the durable trace, not a second channel.
 */

/** The discipline every queue wake restates. Sits in the notice so a Member never depends on remembering the preset. */
export const QUEUE_DISCIPLINE_TEXT = 'Before starting a new task, review your whole queue first (team_queue list): if entries should be merged or split, propose it to the Leader and wait for confirmation before restructuring. Queue order and priorities are managed by the Human or the Leader — never adjust them yourself; work the queue in its given order.'

function taskLabel(task: { readonly taskNumber: number; readonly subject: string }): string {
  return `Task #${task.taskNumber} "${task.subject}"`
}

/** The assignment wake: names the freshly placed entries, first pending first. */
export function queueAssignmentNotice(input: {
  readonly handle: string
  readonly items: readonly { readonly taskNumber: number; readonly subject: string; readonly note?: string }[]
}): string {
  const lines = input.items.map(task => `${taskLabel(task)}${task.note === undefined ? '' : ` — ${task.note}`}`)
  return [
    `@${input.handle} Queue assignment: ${input.items.length} task${input.items.length === 1 ? '' : 's'} placed in your task queue.`,
    ...lines.map(line => `- ${line}`),
    QUEUE_DISCIPLINE_TEXT,
  ].join('\n')
}

/** The advance wake after a hand-off (claim done) or a release: names the next pending entry, if one exists. */
export function queueAdvanceNotice(input: {
  readonly handle: string
  readonly previous: { readonly kind: 'done' | 'release'; readonly taskNumber: number }
  readonly next?: { readonly taskNumber: number; readonly subject: string; readonly note?: string }
}): string {
  const previousLine = input.previous.kind === 'done'
    ? `Task #${input.previous.taskNumber} handed off — it now waits for Human acceptance.`
    : `Task #${input.previous.taskNumber} released — its queue entry is back to pending and no longer yours to re-prompt.`
  if (input.next === undefined) {
    return `@${input.handle} Queue advance: ${previousLine} No other task is pending in your queue.`
  }
  return [
    `@${input.handle} Queue advance: ${previousLine}`,
    `Your next queued task is ${taskLabel(input.next)}${input.next.note === undefined ? '' : ` — ${input.next.note}`}`,
    QUEUE_DISCIPLINE_TEXT,
  ].join('\n')
}

/** The reassignment wake for the receiving Member: the entry moved into their queue. */
export function queueReassignedNotice(input: {
  readonly handle: string
  readonly byHandle: string
  readonly task: { readonly taskNumber: number; readonly subject: string; readonly note?: string }
}): string {
  return [
    `@${input.handle} Queue reassignment: ${input.byHandle} moved ${taskLabel(input.task)} into your task queue${input.task.note === undefined ? '' : ` — ${input.task.note}`}`,
    QUEUE_DISCIPLINE_TEXT,
  ].join('\n')
}
