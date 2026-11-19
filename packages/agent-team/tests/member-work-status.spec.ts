import { afterEach, describe, expect, it, vi } from 'vitest'
// Ledger-only suite: keep the same headroom as the other ledger suites.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import {
  AgentTeamDeliveryBlockedError,
  AgentTeamLedger,
  agentTeamAssistantActor,
  agentTeamHumanActor,
  agentTeamWorkStatusOf,
} from '../src/ledger.ts'
import type { AgentTeamLedgerOptions } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type {
  AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamMemberWorkStatus,
  AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamSetMemberStatusRequest,
} from '../src/types.ts'

/**
 * Member work status: the ledger facts behind the `team_set_status` tool.
 * A Member declares busy/idle/waiting/free for itself; `working` is Host-only
 * (the delivery automation's commit under the recipient's member authority).
 * While a Member is busy or free, only the Human and the designated leader
 * can reach it — every other sender is refused at the ledger chokepoint.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const human = agentTeamHumanActor()
const assistant = agentTeamAssistantActor()

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function openLedger(): Promise<{ readonly ledger: AgentTeamLedger; readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation> }> {
  let tick = 0
  const options: AgentTeamLedgerOptions = { occurredAt: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() }
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  return { ledger: new AgentTeamLedger(table, options), table }
}

function memberActor(memberId: string, handle: string): AgentTeamMemberActor {
  return { kind: 'member', memberId: memberId as AgentTeamMemberId, handle }
}

const scoutId = 'member:agent-scout' as AgentTeamMemberId
const plannerId = 'member:agent-planner' as AgentTeamMemberId
const visitorId = 'member:agent-visitor' as AgentTeamMemberId
const scout = memberActor(scoutId, 'scout')
const planner = memberActor(plannerId, 'planner')
const visitor = memberActor(visitorId, 'visitor')

function agentMember(memberId: AgentTeamMemberId, handle: string, leader = false) {
  return { memberId, sessionId: SessionId('session:' + memberId), workspaceId: alpha, handle,
    description: handle + ' work', presetId: 'team-member', privateMemoryPath: '/tmp/' + handle,
    state: 'enabled' as const, ...(leader ? { leader: true } : {}) }
}

async function seedTeam(ledger: AgentTeamLedger): Promise<AgentTeamChannelRef> {
  await ledger.initialize()
  const channel = (await ledger.createChannel({ requestId: requestId('channel-a'), workspaceId: alpha,
    name: 'alpha-one', description: 'Alpha one', memberIds: [], actor: human })).value.channel
  await ledger.addMember({ requestId: requestId('member-scout'), workspaceId: alpha, handle: 'scout',
    description: 'Scout work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human,
    member: agentMember(scoutId, 'scout') })
  await ledger.addMember({ requestId: requestId('member-planner'), workspaceId: alpha, handle: 'planner',
    description: 'Planner work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human,
    member: agentMember(plannerId, 'planner', true) })
  await ledger.addMember({ requestId: requestId('member-visitor'), workspaceId: alpha, handle: 'visitor',
    description: 'Visitor work', presetId: 'team-member', channelRefs: [channel.channelRef], actor: human,
    member: agentMember(visitorId, 'visitor') })
  return channel.channelRef
}

describe('Member work status ledger facts', () => {
  it('defaults to idle and commits self-declared transitions with the previous recorded', async () => {
    const { ledger, table } = await openLedger()
    await seedTeam(ledger)
    const first = await ledger.setMemberStatus({ requestId: requestId('status-busy'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'busy' })
    if (first.value.kind !== 'committed') throw new Error('expected committed status')
    expect(first.value.status).toBe('busy')
    expect(first.value.member.workStatus).toBe('busy')
    // The first declaration replayed against an untouched Member: its recorded
    // previous proves the default work status is idle.
    const operations = [...table.entries()].map(([, operation]) => operation).filter(operation => operation.kind === 'team/member-status-changed')
    expect(operations.at(-1)).toMatchObject({ data: { memberId: scoutId, status: 'busy', previous: 'idle' } })

    const waiting = await ledger.setMemberStatus({ requestId: requestId('status-waiting'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'waiting' })
    if (waiting.value.kind !== 'committed') throw new Error('expected committed status')
    expect(waiting.value.member.workStatus).toBe('waiting')
    expect(waiting.value.member.handle).toBe('scout')

    const free = await ledger.setMemberStatus({ requestId: requestId('status-free'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'free' })
    expect(free.value.kind).toBe('committed')
    const idle = await ledger.setMemberStatus({ requestId: requestId('status-idle'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'idle' })
    expect(idle.value.kind).toBe('committed')
  })

  it('refuses working on the member-facing path and another Member\'s status', async () => {
    const { ledger } = await openLedger()
    await seedTeam(ledger)
    await expect(ledger.setMemberStatus({ requestId: requestId('status-working'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'working' as AgentTeamSetMemberStatusRequest['status'] }))
      .rejects.toThrow(/'working' is not a settable status; working is managed by the Host/)
    await expect(ledger.setMemberStatus({ requestId: requestId('status-other'), workspaceId: alpha, memberId: plannerId, actor: scout, status: 'busy' }))
      .rejects.toThrow(/a Member may only declare its own status/)
  })

  it('resolves an exact retry and collides on a changed payload', async () => {
    const { ledger } = await openLedger()
    await seedTeam(ledger)
    const first = await ledger.setMemberStatus({ requestId: requestId('status-retry'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'busy' })
    const position = ledger.position()
    const retry = await ledger.setMemberStatus({ requestId: requestId('status-retry'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'busy' })
    expect(retry.value.kind).toBe('resolved')
    if (first.value.kind !== 'committed' || retry.value.kind !== 'resolved') throw new Error('expected committed then resolved')
    expect(retry.value.receipt.operationId).toBe(first.value.receipt.operationId)
    expect(ledger.position()).toBe(position)
    await expect(ledger.setMemberStatus({ requestId: requestId('status-retry'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'idle' }))
      .rejects.toThrow(/was reused with a different operation or payload/)
  })

  it('the Host delivery commit lands working under the recipient\'s own authority', async () => {
    const { ledger } = await openLedger()
    await seedTeam(ledger)
    const busy = await ledger.setMemberStatus({ requestId: requestId('delivery-busy'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'busy' })
    expect(busy.value.kind).toBe('committed')
    const delivery = await ledger.setMemberStatusByDelivery({ requestId: requestId('delivery-working'), workspaceId: alpha, memberId: scoutId, actor: scout })
    expect(delivery.value.kind).toBe('committed')
    if (delivery.value.kind !== 'committed') throw new Error('expected committed delivery')
    expect(delivery.value.status).toBe('working')
    expect(delivery.value.member.workStatus).toBe('working')
    // The Human's reach into a busy Member is what flipped it back to working.
    const again = await ledger.setMemberStatusByDelivery({ requestId: requestId('delivery-working-2'), workspaceId: alpha, memberId: scoutId, actor: scout })
    if (again.value.kind !== 'committed') throw new Error('expected committed delivery')
    expect(again.value.member.workStatus).toBe('working')
  })

  it('replay accepts the stored chain and rejects a tampered previous', async () => {
    const { ledger, table } = await openLedger()
    await seedTeam(ledger)
    await ledger.setMemberStatus({ requestId: requestId('replay-busy'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'busy' })
    await ledger.setMemberStatus({ requestId: requestId('replay-idle'), workspaceId: alpha, memberId: scoutId, actor: scout, status: 'idle' })
    // A cold ledger over the same table validates the stored chain during
    // its constructor replay.
    expect(() => new AgentTeamLedger(table)).not.toThrow()
    // A forged operation whose previous does not match the replay projection
    // at that instant must stop the replay. Chain it onto the real head so
    // the structural checks pass and the semantic validation is what fails.
    const head = [...table.entries()].map(([, operation]) => operation).sort((a, b) => a.sequence - b.sequence).at(-1)!
    const forged: AgentTeamOperation = {
      kind: 'team/member-status-changed',
      sequence: head.sequence + 1,
      operationId: 'operation:forged-status' as AgentTeamOperationId,
      requestId: requestId('forged-status'),
      occurredAt: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)).toISOString(),
      actor: { ...scout },
      previousOperationId: head.operationId,
      data: { memberId: scoutId, workspaceId: alpha, status: 'free', previous: 'working' },
    }
    await table.put(forged.operationId, forged)
    expect(() => new AgentTeamLedger(table)).toThrow(/invalid Member status change/)
  })
})

describe('Delivery reachability while busy or free', () => {
  async function reachableHarness() {
    const { ledger } = await openLedger()
    const channelRef = await seedTeam(ledger)
    return { ledger, channelRef }
  }

  async function declareBusy(ledger: AgentTeamLedger, status: Exclude<AgentTeamMemberWorkStatus, 'working'> = 'busy'): Promise<void> {
    const result = await ledger.setMemberStatus({ requestId: requestId(`reach-${status}`), workspaceId: alpha, memberId: scoutId, actor: scout, status })
    expect(result.value.kind).toBe('committed')
  }

  it('the Human and the designated leader reach a busy Member; everyone else is refused', async () => {
    const { ledger, channelRef } = await reachableHarness()
    await declareBusy(ledger)
    const humanSend = await ledger.sendMessage({ requestId: requestId('reach-human'), workspaceId: alpha, channelRef, body: 'Human override', actor: human, recipients: [scoutId] })
    expect(humanSend.value.kind).toBe('committed')
    const leaderSend = await ledger.sendMessage({ requestId: requestId('reach-leader'), workspaceId: alpha, channelRef, body: 'Leader override', actor: planner, recipients: [scoutId] })
    expect(leaderSend.value.kind).toBe('committed')
    await expect(ledger.sendMessage({ requestId: requestId('reach-assistant'), workspaceId: alpha, channelRef, body: 'Assistant notice', actor: assistant, recipients: [scoutId] }))
      .rejects.toThrow(AgentTeamDeliveryBlockedError)
    await expect(ledger.sendMessage({ requestId: requestId('reach-visitor'), workspaceId: alpha, channelRef, body: 'Visitor ping', actor: visitor, recipients: [scoutId] }))
      .rejects.toThrow(/@scout \(busy\): only the Human or the designated Team leader can reach a Member while it is free or busy/)
  })

  it('a free Member is equally sealed against assistant and peer sends, by DM as well', async () => {
    const { ledger, channelRef } = await reachableHarness()
    await declareBusy(ledger, 'free')
    await expect(ledger.sendMessage({ requestId: requestId('free-assistant'), workspaceId: alpha, channelRef, body: 'Assistant notice', actor: assistant, recipients: [scoutId] }))
      .rejects.toThrow(/@scout \(free\)/)
    await expect(ledger.sendDm({ requestId: requestId('free-dm'), workspaceId: alpha, recipientMemberId: scoutId, body: 'peer dm', actor: visitor }))
      .rejects.toThrow(AgentTeamDeliveryBlockedError)
  })

  it('idle, waiting, and working Members are reachable by everyone', async () => {
    const { ledger, channelRef } = await reachableHarness()
    for (const status of ['idle', 'waiting'] as const) {
      await declareBusy(ledger, status)
      const assistantSend = await ledger.sendMessage({ requestId: requestId(`reach-${status}-assistant`), workspaceId: alpha, channelRef, body: 'Assistant notice', actor: assistant, recipients: [scoutId] })
      expect(assistantSend.value.kind).toBe('committed')
      const visitorSend = await ledger.sendMessage({ requestId: requestId(`reach-${status}-visitor`), workspaceId: alpha, channelRef, body: 'Visitor ping', actor: visitor, recipients: [scoutId] })
      expect(visitorSend.value.kind).toBe('committed')
    }
    // Working is the state a delivery leaves behind: still reachable.
    await ledger.setMemberStatusByDelivery({ requestId: requestId('reach-working'), workspaceId: alpha, memberId: scoutId, actor: scout })
    const workingSend = await ledger.sendMessage({ requestId: requestId('reach-working-visitor'), workspaceId: alpha, channelRef, body: 'Visitor ping', actor: visitor, recipients: [scoutId] })
    expect(workingSend.value.kind).toBe('committed')
  })

  it('the designated leader reaches a busy Member by DM; a non-leader peer does not', async () => {
    const { ledger } = await reachableHarness()
    await declareBusy(ledger)
    const leaderDm = await ledger.sendDm({ requestId: requestId('leader-dm-busy'), workspaceId: alpha, recipientMemberId: scoutId, body: 'leader dm', actor: planner })
    expect(leaderDm.value.recipient.memberId).toBe(scoutId)
    await expect(ledger.sendDm({ requestId: requestId('visitor-dm-busy'), workspaceId: alpha, recipientMemberId: scoutId, body: 'visitor dm', actor: visitor }))
      .rejects.toThrow(/@scout \(busy\)/)
  })
})
