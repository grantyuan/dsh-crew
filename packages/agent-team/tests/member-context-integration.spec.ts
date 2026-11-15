import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as memberContext from '../src/member-context.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fakeAgent(ctx: Context): Agent {
  return {
    id: SessionId('session:memory-test'), ctx, status: 'idle', options: { provider: 'mock', model: 'mock' },
    model: { current: () => undefined, select: () => {} },
    session: { surface: { nodes: [] }, events: [] } as never,
    inbox: {} as never,
    cancel() {}, whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {},
  } as Agent
}

async function preStep(ctx: Context, agent: Agent): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'mock' },
  }, async () => ({ kind: 'enter', messages: [] }))
}

async function mount(ctx: Context): Promise<void> {
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(memberContext) as Parameters<Context['plugin']>[0]
  await ctx.plugin(plugin)
}

describe('Team Member private memory composition', () => {
  it('resolves the Host service lazily when loaded as a Cordis namespace plugin', () => {
    expect('default' in memberContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(memberContext) as Record<string, unknown>
    expect(plugin).toBe(memberContext)
    expect(plugin.name).toBe('wowyuarm-agent-team-member-context')
    // No declared inject: the row mounts while the Host restores Members, so a
    // dependency on `agentTeam` would fail every startup preset mount.
    expect(plugin.inject).toBeUndefined()
  })

  it('does nothing while the Host service is absent', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })

  it('injects only the bound Member index and replaces changed or removed content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-memory-'))
    roots.push(root)
    const own = join(root, 'memory.md')
    await writeFile(own, 'own index')
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    const workspaces = [{ workspaceId: 'workspace:default', path: root, default: true }]
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent ? { privateMemoryPath: root } : undefined,
      workspacesForAgent: () => workspaces,
    } as never)
    await mount(ctx)

    const first = await preStep(ctx, agent)
    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('own index') }))
    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(`Private memory directory: ${root}`) }))

    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining('Team Workspace participation') }))
    workspaces.push({ workspaceId: 'workspace:other', path: join(root, 'other'), default: false })
    const joined = await preStep(ctx, agent)
    expect(joined.kind === 'enter' && joined.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(JSON.stringify(join(root, 'other', 'AGENTS.md')).slice(1, -1)) }))
    expect(joined.kind === 'enter' && joined.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('absolute paths') }))
    workspaces.pop()
    const left = await preStep(ctx, agent)
    expect(left.kind === 'enter' && left.messages.at(-1)?.content[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining('workspace:other') }))

    await writeFile(own, 'replacement index')
    const second = await preStep(ctx, agent)
    expect(second.kind === 'enter' && second.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('replacement index') }))

    await rm(own)
    const removed = await preStep(ctx, agent)
    expect(removed.kind === 'enter' && removed.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('index is empty') }))
    expect(removed.kind === 'enter' && removed.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(`Memory index: ${root}/memory.md`) }))
    await ctx.fiber.dispose()
  })

  it('does nothing for an ordinary unbound Agent', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    ctx.provide('agentTeam', { memberForAgent: () => undefined } as never)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })

  it('appends the recall snapshot after identity and only when the hit set changes', async () => {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'team-member-recall-'))
    roots.push(root)
    const events: unknown[] = []
    const session = {
      id: SessionId('session:memory-test'),
      surface: { nodes: [] as number[] },
      snapshotEvents: (from: number, to: number) => events.slice(from, to),
    }
    const agent = { ...fakeAgent(ctx), session } as unknown as Agent
    // A plain user turn is the recall query for this step.
    events.push(userMessage('Please re-check TS2339', { kind: 'user' }))
    session.surface.nodes.push(0)

    let snapshot = { text: '<recall-snapshot replaces="earlier-recall-snapshots">first hit</recall-snapshot>', hash: 'h1', itemCount: 1 }
    const requests: { query: string }[] = []
    ctx.provide('agentTeam', {
      memberForAgent: () => ({ handle: 'alice', description: '', privateMemoryPath: root }),
      workspacesForAgent: () => [],
      contextRecallSnapshotForAgent: async (_agent: Agent, request: { query: string }) => {
        requests.push(request)
        return snapshot
      },
    } as never)
    await mount(ctx)

    const first = await preStep(ctx, agent)
    expect(requests).toEqual([{ query: 'Please re-check TS2339' }])
    const firstRecall = recallMessages(first)
    expect(firstRecall).toHaveLength(1)
    expect(firstRecall[0]?.content[0]).toEqual(expect.objectContaining({ text: snapshot.text }))
    expect(firstRecall[0]?.source).toMatchObject({ kind: 'wowyuarm-agent-team-member-context', form: 'recall' })

    // Commit the injected block the way the Session log would, then step again:
    // the same hit set must not produce a second block.
    events.push(userMessage(snapshot.text, { kind: 'wowyuarm-agent-team-member-context', form: 'recall' }))
    session.surface.nodes.push(1)
    const second = await preStep(ctx, agent)
    expect(recallMessages(second)).toHaveLength(0)

    // A changed hit set is appended again, after the identity block.
    snapshot = { text: '<recall-snapshot replaces="earlier-recall-snapshots">second hit</recall-snapshot>', hash: 'h2', itemCount: 2 }
    const third = await preStep(ctx, agent)
    const thirdRecall = recallMessages(third)
    expect(thirdRecall).toHaveLength(1)
    expect(thirdRecall[0]?.content[0]).toEqual(expect.objectContaining({ text: snapshot.text }))
    expect(third.kind === 'enter' && third.messages.at(-2)?.source).toMatchObject({ form: 'instructions' })
    await ctx.fiber.dispose()
  })

  it('leaves the step untouched when the recall host call fails', async () => {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'team-member-recall-broken-'))
    roots.push(root)
    const events: unknown[] = [userMessage('anything', { kind: 'user' })]
    const agent = {
      ...fakeAgent(ctx),
      session: {
        id: SessionId('session:memory-test'),
        surface: { nodes: [0] },
        snapshotEvents: (from: number, to: number) => events.slice(from, to),
      },
    } as unknown as Agent
    ctx.provide('agentTeam', {
      memberForAgent: () => ({ handle: 'alice', description: '', privateMemoryPath: root }),
      workspacesForAgent: () => [],
      contextRecallSnapshotForAgent: async () => { throw new Error('index exploded') },
    } as never)
    await mount(ctx)
    const decision = await preStep(ctx, agent)
    // The identity block still arrives; only recall is skipped, because a
    // derived index must never block a turn.
    expect(decision.kind === 'enter' && decision.messages.at(-1)?.source).toMatchObject({ form: 'instructions' })
    await ctx.fiber.dispose()
  })
})

/** One `user/message` surface event; only the fields the plugin reads. */
function userMessage(text: string, source: Record<string, string>): unknown {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source } }
}

/** Recall blocks appended by this producer. */
function recallMessages(decision: PreStepDecision): { source?: { form?: string }; content: { type: string; text?: string }[] }[] {
  return decision.kind === 'enter'
    ? decision.messages.filter(message => 'form' in message.source && message.source.form === 'recall') as never
    : []
}
