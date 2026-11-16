import { afterEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger, MAX_QUEUE_ENTRIES, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamAgentMember, AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask, AgentTeamTaskRef } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

interface TeamHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => [alpha].map(id => ({ id, path: process.cwd() })),
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  // Inject-list requirement; these tests never assemble a prompt (no live sessions).
  ctx.provide('systemPrompt', { assemble: async () => ({ sections: [], contexts: [], tools: [], variables: [] }) })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, fiber, facility }
}

function replayLedger(test: TeamHarness): AgentTeamLedger {
  return new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

function withTask<T extends { readonly task?: AgentTeamTask | undefined }>(result: T): T & { readonly task: AgentTeamTask } {
  if (result.task === undefined) throw new Error('expected a Task overlay')
  return result as T & { readonly task: AgentTeamTask }
}

/** Queue writes throw on refusal (no fences), so the ledger envelope is the only wrapper. */
function ledgerCommitted<T>(result: { readonly value: T; readonly committed: boolean }): T {
  if (!result.committed) throw new Error('expected a committed ledger result')
  return result.value
}

interface Actor {
  readonly member: AgentTeamAgentMember
  readonly actor: AgentTeamMemberActor
}

/** One member plus one channel with one open Task, ready for queue work. */
interface QueueFixture {
  readonly test: TeamHarness
  readonly ledger: AgentTeamLedger
  readonly worker: Actor
  readonly peer: Actor
  readonly leader: Actor
  readonly taskRef: AgentTeamTaskRef
  readonly revision: number
}

async function addMember(ledger: AgentTeamLedger, channelRef: AgentTeamChannelRef | undefined, seed: string): Promise<Actor> {
  const memberId = `member:${seed}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = {
    memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle: seed,
    description: 'Test Agent', presetId: 'team-member', privateMemoryPath: `/tmp/${memberId}`, state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId(`add:${seed}`), actor: agentTeamHumanActor(), member,
    handle: member.handle, description: member.description, presetId: member.presetId, workspaceId: alpha,
    channelRefs: channelRef === undefined ? [] : [channelRef] })
  return { member, actor: { kind: 'member', memberId, handle: member.handle } }
}

async function queueFixture(): Promise<QueueFixture> {
  const test = await harness()
  const ledger = replayLedger(test)
  const channel = (await ledger.createChannel({ requestId: requestId('channel'), workspaceId: alpha,
    name: 'work', description: '', memberIds: [], actor: agentTeamHumanActor() })).value.channel
  const worker = await addMember(ledger, channel.channelRef, 'worker')
  const peer = await addMember(ledger, channel.channelRef, 'peer')
  const leader = await addMember(ledger, channel.channelRef, 'lead')
  await ledger.updateMember({ requestId: requestId('designate'), memberId: leader.member.memberId,
    handle: leader.member.handle, description: leader.member.description, leader: true, actor: agentTeamHumanActor() })
  const sent = withTask(committed((await ledger.sendMessage({ requestId: requestId('task'), workspaceId: alpha,
    channelRef: channel.channelRef, body: 'Investigate the regression', asTask: true, actor: worker.actor })).value))
  return { test, ledger, worker, peer, leader, taskRef: sent.task.taskRef, revision: sent.thread.revision }
}

/** Open one more unqueued, unclaimed Task in a fresh Channel; extra Actors join the Channel too. */
async function freeTask(ledger: AgentTeamLedger, worker: Actor, seed: string, extra: readonly Actor[] = []): Promise<{ readonly taskRef: AgentTeamTaskRef; readonly revision: number }> {
  const channel = (await ledger.createChannel({ requestId: requestId(`channel:${seed}`), workspaceId: alpha,
    name: `free-${seed}`, description: '', memberIds: [worker.member.memberId, ...extra.map(actor => actor.member.memberId)], actor: agentTeamHumanActor() })).value.channel
  const sent = withTask(committed((await ledger.sendMessage({ requestId: requestId(`task:${seed}`), workspaceId: alpha,
    channelRef: channel.channelRef, body: `free task ${seed}`, asTask: true, actor: worker.actor })).value))
  return { taskRef: sent.task.taskRef, revision: sent.thread.revision }
}

function queueOf(ledger: AgentTeamLedger, memberId: AgentTeamMemberId) {
  return ledger.memberTasksForWorkspace({ workspaceId: alpha }).queues.find(queue => queue.memberId === memberId)?.entries ?? []
}

describe('AgentTeam member task queue ledger', () => {
  it('assigns open Tasks in order, appending and inserting by position', async () => {
    const { test, ledger, worker, leader, taskRef } = await queueFixture()
    const second = await freeTask(ledger, worker, 'second')

    const assigned = ledgerCommitted(await ledger.queueAssign({ requestId: requestId('assign-1'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef, note: 'start here' }], actor: leader.actor }))
    expect(assigned.queue.map(entry => entry.task.taskRef)).toEqual([taskRef])
    expect(assigned.queue[0]?.note).toBe('start here')
    expect(assigned.queue[0]?.addedBy).toBe(leader.member.memberId)
    expect(assigned.queue[0]?.standing).toBe('pending')

    const inserted = ledgerCommitted(await ledger.queueAssign({ requestId: requestId('assign-2'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef: second.taskRef }], atIndex: 0, actor: leader.actor }))
    expect(inserted.queue.map(entry => entry.task.taskRef)).toEqual([second.taskRef, taskRef])
    expect(queueOf(ledger, worker.member.memberId).map(entry => entry.task.taskRef)).toEqual([second.taskRef, taskRef])

    const replay = replayLedger(test)
    expect(replay.memberTasksForWorkspace({ workspaceId: alpha }).queues.find(queue => queue.memberId === worker.member.memberId)?.entries)
      .toEqual(queueOf(ledger, worker.member.memberId))
    replay.validate()
  })

  it('rejects assignments that violate the queueing preconditions', async () => {
    const { ledger, worker, peer, leader, taskRef } = await queueFixture()
    await ledger.queueAssign({ requestId: requestId('assign-first'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef }], actor: leader.actor })
    // Already queued for someone else.
    await expect(ledger.queueAssign({ requestId: requestId('assign-dup'), workspaceId: alpha,
      memberId: peer.member.memberId, items: [{ taskRef }], actor: leader.actor })).rejects.toThrow(/already queued/)

    // Target has not joined the Task's Channel.
    const outsider = await addMember(ledger, undefined, 'outsider')
    const unshared = await freeTask(ledger, worker, 'unshared')
    await expect(ledger.queueAssign({ requestId: requestId('assign-outsider'), workspaceId: alpha,
      memberId: outsider.member.memberId, items: [{ taskRef: unshared.taskRef }], actor: leader.actor })).rejects.toThrow(/has not joined Channel/)

    // A plain Member has no queue authority; the Human does.
    const plain = await freeTask(ledger, worker, 'plain', [peer])
    await expect(ledger.queueAssign({ requestId: requestId('assign-worker'), workspaceId: alpha,
      memberId: peer.member.memberId, items: [{ taskRef: plain.taskRef }], actor: worker.actor })).rejects.toThrow(/not the Leader/)
    const humanAssigned = await ledger.queueAssign({ requestId: requestId('assign-human'), workspaceId: alpha,
      memberId: peer.member.memberId, items: [{ taskRef: plain.taskRef }], actor: agentTeamHumanActor() })
    expect(humanAssigned.committed).toBe(true)
    expect(humanAssigned.value.memberId).toBe(peer.member.memberId)
  })

  it('blocks claiming a queued Task by anyone but its queued Member, then frees it on removal', async () => {
    const { ledger, worker, peer, leader, taskRef, revision } = await queueFixture()
    const assigned = ledgerCommitted(await ledger.queueAssign({ requestId: requestId('assign-1'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef }], actor: leader.actor }))
    const entryRef = assigned.queue[0]!.entryRef

    await expect(ledger.changeClaim({ requestId: requestId('claim-peer'), workspaceId: alpha, taskRef,
      baseRevision: revision, action: 'claim', direction: 'Take it over', actor: peer.actor })).rejects.toThrow(/queued for/)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim-owner'), workspaceId: alpha, taskRef,
      baseRevision: revision, action: 'claim', direction: 'Implement it', actor: worker.actor })).value)
    expect(queueOf(ledger, worker.member.memberId)[0]?.standing).toBe('working')
    // A started entry is the Task lifecycle's to retire, not the queue's.
    await expect(ledger.queueAmend({ requestId: requestId('remove-working'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'remove', entryRef, actor: leader.actor })).rejects.toThrow(/already started/)

    const released = committed((await ledger.changeClaim({ requestId: requestId('release-owner'), workspaceId: alpha, taskRef,
      baseRevision: claimed.thread.revision, action: 'release', claimRef: claimed.claim.claimRef, actor: worker.actor })).value)
    await ledger.queueAmend({ requestId: requestId('remove-pending'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'remove', entryRef, actor: leader.actor })
    expect(queueOf(ledger, worker.member.memberId)).toEqual([])
    // Occupancy cleared: the freed Task claims normally again.
    expect(committed((await ledger.changeClaim({ requestId: requestId('claim-peer-2'), workspaceId: alpha, taskRef,
      baseRevision: released.thread.revision, action: 'claim', direction: 'Free to take', actor: peer.actor })).value).claim.owner).toBe(peer.member.memberId)
  })

  it('amends notes and reorders the queue under the permutation rule', async () => {
    const { ledger, worker, leader, taskRef } = await queueFixture()
    const second = await freeTask(ledger, worker, 'second')
    const third = await freeTask(ledger, worker, 'third')
    const assigned = ledgerCommitted(await ledger.queueAssign({ requestId: requestId('assign-all'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef, note: 'original' }, { taskRef: second.taskRef }, { taskRef: third.taskRef }], actor: leader.actor }))
    const [firstRef, secondRef, thirdRef] = assigned.queue.map(entry => entry.entryRef)

    const modified = ledgerCommitted(await ledger.queueAmend({ requestId: requestId('modify-1'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'modify', entryRef: firstRef!, note: 'retuned note', actor: leader.actor }))
    expect(modified.queue.find(entry => entry.entryRef === firstRef)?.note).toBe('retuned note')
    const cleared = ledgerCommitted(await ledger.queueAmend({ requestId: requestId('modify-2'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'modify', entryRef: firstRef!, actor: leader.actor }))
    expect(cleared.queue.find(entry => entry.entryRef === firstRef)?.note).toBeUndefined()

    await expect(ledger.queueAmend({ requestId: requestId('reorder-bad'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'reorder', order: [firstRef!, secondRef!], actor: leader.actor })).rejects.toThrow(/permutation/)
    const reordered = ledgerCommitted(await ledger.queueAmend({ requestId: requestId('reorder-1'), workspaceId: alpha,
      memberId: worker.member.memberId, action: 'reorder', order: [thirdRef!, firstRef!, secondRef!], actor: leader.actor }))
    expect(reordered.queue.map(entry => entry.task.taskRef)).toEqual([third.taskRef, taskRef, second.taskRef])
  })

  it('reassigns a pending entry atomically and refuses started entries or unreachable targets', async () => {
    const { ledger, worker, peer, leader, taskRef, revision } = await queueFixture()
    const assigned = ledgerCommitted(await ledger.queueAssign({ requestId: requestId('assign-1'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef, note: 'moving' }], actor: leader.actor }))
    const entryRef = assigned.queue[0]!.entryRef

    const outsider = await addMember(ledger, undefined, 'outsider')
    await expect(ledger.queueReassign({ requestId: requestId('reassign-outsider'), workspaceId: alpha,
      entryRef, fromMemberId: worker.member.memberId, toMemberId: outsider.member.memberId, actor: leader.actor })).rejects.toThrow(/has not joined Channel/)
    await expect(ledger.queueReassign({ requestId: requestId('reassign-self'), workspaceId: alpha,
      entryRef, fromMemberId: worker.member.memberId, toMemberId: worker.member.memberId, actor: leader.actor })).rejects.toThrow(/two different Members/)

    const moved = ledgerCommitted(await ledger.queueReassign({ requestId: requestId('reassign-1'), workspaceId: alpha,
      entryRef, fromMemberId: worker.member.memberId, toMemberId: peer.member.memberId, actor: leader.actor }))
    expect(moved.entry.note).toBe('moving')
    expect(moved.entry.addedBy).toBe(leader.member.memberId)
    expect(moved.toQueue.map(entry => entry.task.taskRef)).toEqual([taskRef])
    expect(queueOf(ledger, worker.member.memberId)).toEqual([])
    // Occupancy moved with the entry: the original owner now refuses.
    await expect(ledger.changeClaim({ requestId: requestId('claim-old-owner'), workspaceId: alpha, taskRef,
      baseRevision: revision, action: 'claim', direction: 'Steal back', actor: worker.actor })).rejects.toThrow(/queued for/)
  })

  it('retries by requestId idempotently and rejects a reused id with a different payload', async () => {
    const { ledger, worker, leader, taskRef } = await queueFixture()
    const request = { requestId: requestId('assign-idem'), workspaceId: alpha, memberId: worker.member.memberId,
      items: [{ taskRef, note: 'same' }], actor: leader.actor }
    const first = await ledger.queueAssign(request)
    const retry = await ledger.queueAssign(request)
    expect(first.committed).toBe(true)
    expect(retry.committed).toBe(false)
    expect(retry.value.queue.map(entry => entry.task.taskRef)).toEqual([taskRef])
    const other = await freeTask(ledger, worker, 'other')
    await expect(ledger.queueAssign({ ...request, items: [{ taskRef: other.taskRef }] })).rejects.toThrow(/was reused/)
  })

  it('clears queue entries when their Task resolves, the Member departs, or the Channel hides', async () => {
    const { test, ledger, worker, peer, leader, taskRef, revision } = await queueFixture()
    const second = await freeTask(ledger, worker, 'second')
    const peerTask = await freeTask(ledger, worker, 'peer-task', [peer])
    await ledger.queueAssign({ requestId: requestId('assign-1'), workspaceId: alpha, memberId: worker.member.memberId,
      items: [{ taskRef }, { taskRef: second.taskRef }], actor: leader.actor })
    await ledger.queueAssign({ requestId: requestId('assign-peer'), workspaceId: alpha, memberId: peer.member.memberId,
      items: [{ taskRef: peerTask.taskRef }], actor: leader.actor })
    expect(queueOf(ledger, worker.member.memberId)).toHaveLength(2)

    // Accepting the first Task drops only its entry.
    await ledger.changeTask({ requestId: requestId('accept-1'), workspaceId: alpha, taskRef, action: 'accept', baseRevision: revision, actor: agentTeamHumanActor() })
    expect(queueOf(ledger, worker.member.memberId).map(entry => entry.task.taskRef)).toEqual([second.taskRef])

    // Archiving the Member (its default Workspace cannot be left) drops its whole queue; the peer's queue survives.
    await ledger.archiveMember({ requestId: requestId('archive-worker'), memberId: worker.member.memberId, actor: agentTeamHumanActor() })
    expect(queueOf(ledger, worker.member.memberId)).toEqual([])
    expect(queueOf(ledger, peer.member.memberId)).toHaveLength(1)

    // Archiving the Channel hides the peer's queued work with it.
    const channelRef = ledger.tasksForWorkspace({ workspaceId: alpha }).tasks.find(row => row.taskRef === peerTask.taskRef)!.channelRef
    await ledger.archiveChannel({ requestId: requestId('archive'), workspaceId: alpha, channelRef, actor: agentTeamHumanActor() })
    expect(queueOf(ledger, peer.member.memberId)).toEqual([])

    const replay = replayLedger(test)
    expect(replay.memberTasksForWorkspace({ workspaceId: alpha })).toEqual(ledger.memberTasksForWorkspace({ workspaceId: alpha }))
    replay.validate()
  })

  it('enforces the queue capacity and batch bounds', async () => {
    const { ledger, worker, leader } = await queueFixture()
    const channel = (await ledger.createChannel({ requestId: requestId('channel-bulk'), workspaceId: alpha, name: 'bulk', description: '', memberIds: [worker.member.memberId], actor: agentTeamHumanActor() })).value.channel
    const refs: AgentTeamTaskRef[] = []
    for (let index = 0; index < MAX_QUEUE_ENTRIES; index += 1) {
      const sent = withTask(committed((await ledger.sendMessage({ requestId: requestId(`bulk:${index}`), workspaceId: alpha,
        channelRef: channel.channelRef, body: `bulk task ${index}`, asTask: true, actor: worker.actor })).value))
      refs.push(sent.task.taskRef)
    }
    // One request carries at most six items.
    await expect(ledger.queueAssign({ requestId: requestId('oversize'), workspaceId: alpha,
      memberId: worker.member.memberId, items: refs.slice(0, 7).map(taskRef => ({ taskRef })), actor: leader.actor })).rejects.toThrow(/at most 6/)
    for (let index = 0; index < MAX_QUEUE_ENTRIES; index += 1) {
      await ledger.queueAssign({ requestId: requestId(`fill:${index}`), workspaceId: alpha,
        memberId: worker.member.memberId, items: [{ taskRef: refs[index]! }], actor: leader.actor })
    }
    const extra = withTask(committed((await ledger.sendMessage({ requestId: requestId('bulk-extra'), workspaceId: alpha,
      channelRef: channel.channelRef, body: 'one too many', asTask: true, actor: worker.actor })).value))
    await expect(ledger.queueAssign({ requestId: requestId('overflow'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef: extra.task.taskRef }], actor: leader.actor })).rejects.toThrow(/queue limit/)
  })

  it('reads the next pending entry in order, skipping a released Task on request', async () => {
    const { ledger, worker, leader, taskRef, revision } = await queueFixture()
    const second = await freeTask(ledger, worker, 'second')
    const third = await freeTask(ledger, worker, 'third')
    await ledger.queueAssign({ requestId: requestId('assign-all'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef, note: 'first' }, { taskRef: second.taskRef }, { taskRef: third.taskRef }], actor: leader.actor })

    const next = ledger.nextQueueEntryForMember(worker.member.memberId, alpha)
    expect(next?.taskRef).toBe(taskRef)
    expect(next?.note).toBe('first')
    expect(next?.taskNumber).toBeGreaterThan(0)

    // A working or awaiting entry never qualifies; only pending ones do.
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim-first'), workspaceId: alpha, taskRef,
      baseRevision: revision, action: 'claim', direction: 'Walk the queue', actor: worker.actor })).value)
    expect(ledger.nextQueueEntryForMember(worker.member.memberId, alpha)?.taskRef).toBe(second.taskRef)

    // After release the entry is pending again, but the advance read skips it on request.
    await ledger.changeClaim({ requestId: requestId('release-first'), workspaceId: alpha, taskRef,
      baseRevision: claimed.thread.revision, action: 'release', claimRef: claimed.claim.claimRef, actor: worker.actor })
    expect(ledger.nextQueueEntryForMember(worker.member.memberId, alpha)?.taskRef).toBe(taskRef)
    expect(ledger.nextQueueEntryForMember(worker.member.memberId, alpha, taskRef)?.taskRef).toBe(second.taskRef)
    expect(ledger.nextQueueEntryForMember(leader.member.memberId, alpha)).toBeUndefined()
  })

  it('replays queue operations with the same projection and revalidates standings', async () => {
    const { test, ledger, worker, peer, leader, taskRef } = await queueFixture()
    const second = await freeTask(ledger, worker, 'second')
    await ledger.queueAssign({ requestId: requestId('assign-1'), workspaceId: alpha,
      memberId: worker.member.memberId, items: [{ taskRef, note: 'first' }, { taskRef: second.taskRef }], actor: leader.actor })
    const assigned = queueOf(ledger, worker.member.memberId)
    await ledger.queueAmend({ requestId: requestId('reorder'), workspaceId: alpha, memberId: worker.member.memberId,
      action: 'reorder', order: [assigned[1]!.entryRef, assigned[0]!.entryRef], actor: leader.actor })
    await ledger.queueReassign({ requestId: requestId('reassign'), workspaceId: alpha,
      entryRef: assigned[0]!.entryRef, fromMemberId: worker.member.memberId, toMemberId: peer.member.memberId, actor: agentTeamHumanActor() })
    await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: second.taskRef,
      baseRevision: second.revision, action: 'claim', direction: 'Walk the queue', actor: worker.actor })

    const before = ledger.memberTasksForWorkspace({ workspaceId: alpha })
    const replay = replayLedger(test)
    const after = replay.memberTasksForWorkspace({ workspaceId: alpha })
    expect(after).toEqual(before)
    expect(after.queues.find(queue => queue.memberId === worker.member.memberId)?.entries[0]?.standing).toBe('working')
    expect(after.queues.find(queue => queue.memberId === peer.member.memberId)?.entries.map(entry => entry.task.taskRef)).toEqual([taskRef])
    replay.validate()
  })
})
