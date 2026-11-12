/**
 * Real-composition proof that a Member can delegate through the shipped
 * `subagent` tool and that the delegated child composes the preset the
 * Members' tool row names.
 *
 * The topology under test is the bug surface, not the plugin bodies: which
 * registry a preset lands in decides whether the host-plane SubagentRuntime —
 * which mints every child agent context in the host realm — can resolve it.
 * Rows are therefore taken from the shipped cordis.patch.yml verbatim and only
 * pruned (registries and preset definitions stay exactly where the patch puts
 * them, including the isolating group; preset bodies shrink to the delegation
 * tool row). The Host row becomes a probe that hands out the registry the Host
 * mounts Members from, standing in for the Host's single `agentPresets.mount`
 * call at Member activation.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentPresetRow from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import { executeToolCall } from './helpers/tool-call.ts'

const root = resolve(import.meta.dirname, '../../..')

const REGISTRY_ROW = '@deepseek-ai/dsh-agent-preset-registry'
const PRESET_ROW = '@deepseek-ai/dsh-agent-preset'
const DELEGATION_TOOL_ROW = '@deepseek-ai/dsh-tool-subagent'
const HOST_ROW = '@grantyuan/dsh-crew/host'

interface PresetRowConfig {
  readonly id: string
  readonly plugins?: readonly { readonly name?: unknown; readonly config?: Record<string, unknown> }[]
}

const roots: string[] = []
const contexts: Context[] = []
let hostProbe: Context | undefined

afterEach(async () => {
  hostProbe = undefined
  await Promise.all(contexts.splice(0).reverse().map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/**
 * The shipped patch reduced to the rows that decide preset resolution. The
 * delegation tool's `agentPreset` value is read back out of the pruned rows so
 * the assertions below follow the shipped configuration, not a copied literal.
 */
function delegationTopology(): { rows: EntryOptions[]; memberPresetId: string; childPresetId: string } {
  const shipped = applyEntryPatches([], loadOverlayPatches('delegation topology', resolve(root, 'cordis.patch.yml')), () => {})
  let memberPresetId = ''
  let childPresetId = ''
  const reduce = (rows: readonly EntryOptions[]): EntryOptions[] => rows.flatMap((row): EntryOptions[] => {
    if (row.group === true && Array.isArray(row.config)) {
      const nested = reduce(row.config as EntryOptions[])
      return nested.length === 0 ? [] : [{ ...row, config: nested }]
    }
    if (row.name === REGISTRY_ROW) return [row]
    if (row.name === HOST_ROW) return [{ id: row.id, name: 'cordis:teamHostProbe' }]
    if (row.name !== PRESET_ROW) return []
    const config = row.config as PresetRowConfig
    const plugins = (config.plugins ?? []).filter(plugin => plugin.name === DELEGATION_TOOL_ROW)
    if (plugins.length > 0) {
      const pinned = plugins[0]?.config?.agentPreset
      if (typeof pinned === 'string' && childPresetId === '') {
        memberPresetId = config.id
        childPresetId = pinned
      }
    }
    return [{ ...row, config: { ...config, plugins } }]
  })
  const rows = reduce(shipped)
  expect(memberPresetId).not.toBe('')
  expect(childPresetId).not.toBe('')
  return { rows, memberPresetId, childPresetId }
}

/** Text-only replies keep the spawned child's single turn short and idle. */
class TextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = 'Done.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: body }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: body.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Boot {
  readonly ctx: Context
  /** The in-group context standing in for the Team Host plugin. */
  readonly host: Context
  readonly memberPresetId: string
  readonly childPresetId: string
}

async function boot(): Promise<Boot> {
  const workspace = await mkdtemp(resolve(tmpdir(), 'dsh-crew-delegation-'))
  roots.push(workspace)
  const { rows, memberPresetId, childPresetId } = delegationTopology()

  const ctx = new Context()
  contexts.push(ctx)
  // Preset health resolves package rows by walking node_modules above the
  // baseUrl — this repository links the harness packages, as a profile does.
  ctx.baseUrl = pathToFileURL(workspace).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.teamHostProbe = {
    inject: ['agents', 'agentPresets'],
    apply(probeCtx: Context) {
      hostProbe = probeCtx
    },
  }
  // The real module map: rows resolve through the same physical classes this
  // test imported, so service and scope identities stay single-instance.
  const modules = new Map<string, unknown>([
    [REGISTRY_ROW, AgentPresetRegistry],
    [PRESET_ROW, AgentPresetRow],
    [DELEGATION_TOOL_ROW, SubagentTool],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const found = modules.get(specifier)
      if (found === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return found
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.llm.registerAdapter(['mock'], new TextAdapter())
  await ctx.plugin(AgentLoop, { agents: [] })
  // Continuable children are durable Sessions.
  await ctx.plugin(JsonlSessionPersistence, { root: resolve(workspace, 'sessions') })
  // Host plane: the shipped Web bundle mounts the preset registry, the
  // subagent runtime, and its backends beside the AgentLoop, outside every
  // bundle-declared isolation realm.
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })

  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect(hostProbe?.agentPresets).toBeDefined()
  return { ctx, host: hostProbe!, memberPresetId, childPresetId }
}

function waitForIdle(ctx: Context, agent: NonNullable<ReturnType<Context['agents']['get']>>): Promise<void> {
  if (agent.status === 'idle') return Promise.resolve()
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

describe('Member delegation preset topology', () => {
  it('composes the preset the delegation tool pins on the spawned child', async () => {
    const { ctx, host, memberPresetId, childPresetId } = await boot()
    // Members are created by the Team Host from inside the isolating group and
    // mounted from its own registry; the child is created by the host-plane
    // SubagentRuntime through the same agent factory.
    const member = await host.agents.create({
      sessionId: SessionId('delegation-member'),
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (agentCtx) => { await host.agentPresets.mount(agentCtx, memberPresetId) },
    })
    const result = await executeToolCall(ctx.tools, member.agent, ToolCallId('delegate-once'), 'subagent', {
      description: 'bounded sub-task',
      prompt: 'Answer briefly and stop.',
    })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const child = ctx.agents.list().find(agent => agent !== member.agent)
    expect(child).toBeDefined()
    // The child composes from the HOST registry: the in-group registry must
    // not see the binding, and both rosters carry the pinned definition.
    expect(ctx.agentPresets.composedPreset(child!.ctx)).toBe(childPresetId)
    expect(host.agentPresets.composedPreset(child!.ctx)).toBeUndefined()
    expect((await ctx.agentPresets.list()).map(row => row.id)).toContain(childPresetId)
    expect((await host.agentPresets.list()).map(row => row.id)).toContain(childPresetId)
    await waitForIdle(ctx, child!)
    await waitForIdle(ctx, member.agent)
  })
})
