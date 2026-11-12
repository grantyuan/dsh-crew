import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const root = resolve(import.meta.dirname, '../../..')

/**
 * The deployment contract for Member delegation: the team-member preset ships
 * the subagent tools pinned to a plain worker child preset, and that child
 * preset carries no Team tools — a delegated worker answers to its parent
 * Member alone and never speaks for the team. These assertions read the real
 * patch text so a row rename or a plugin-list edit that quietly drops one of
 * them fails here rather than at boot.
 */
describe('team-member delegation preset contract', () => {
  it('mounts the subagent tools on Members, pinned to the worker preset', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@deepseek-ai/dsh-tool-subagent-control'")
    expect(patch).toMatch(/name: '@deepseek-ai\/dsh-tool-subagent'\s*\n\s*config:\s*\n\s*provider: spawn\s*\n\s*toolName: subagent\s*\n\s*agentPreset: team-subagent/)
  })

  it('ships a team-subagent child preset without the Team tools', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: wowyuarm-agent-team-preset-team-subagent')
    expect(patch).toContain('id: team-subagent')
    // Slice the child preset's own plugin list: from its row to the Host row
    // that follows it. The Team tools plugin must not appear inside it.
    const start = patch.indexOf('id: wowyuarm-agent-team-preset-team-subagent')
    const end = patch.indexOf('id: wowyuarm-agent-team-host')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const childSlice = patch.slice(start, end)
    expect(childSlice).not.toContain('@grantyuan/dsh-crew/tools')
    expect(childSlice).not.toContain('member-context')
    // A worker still gets the ordinary project tools it needs to do the task.
    expect(childSlice).toContain("name: '@deepseek-ai/dsh-tool-bash'")
    expect(childSlice).toContain("name: '@deepseek-ai/dsh-tool-fs'")
  })

  it('keeps the Team tools and the job tool on the Member preset itself', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    const memberStart = patch.indexOf('id: wowyuarm-agent-team-preset-team-member')
    const childStart = patch.indexOf('id: wowyuarm-agent-team-preset-team-subagent')
    expect(memberStart).toBeGreaterThan(-1)
    expect(childStart).toBeGreaterThan(memberStart)
    const memberSlice = patch.slice(memberStart, childStart)
    expect(memberSlice).toContain("name: '@grantyuan/dsh-crew/tools'")
    expect(memberSlice).toContain('tool-subagent')
  })

  it('registers the same child preset definition in the host-plane registry', async () => {
    // The shipped SubagentRuntime is a host-plane process singleton: it mints
    // every child agent context in the host realm, so the spawn resolves the
    // pinned `agentPreset` against the HOST registry — the group-private one
    // is unreachable from there. The Members' delegation tool still validates
    // its pin against the private registry it sees, so the definition must be
    // registered twice, and the YAML alias keeps both rows on one definition.
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('config: &team-subagent-preset')
    expect(patch).toContain('id: wowyuarm-agent-team-preset-team-subagent-host-plane')
    expect(patch).toContain('config: *team-subagent-preset')
    const alias = patch.indexOf('config: *team-subagent-preset')
    const anchor = patch.indexOf('config: &team-subagent-preset')
    expect(alias).toBeGreaterThan(anchor)
    const composed = applyEntryPatches([], loadOverlayPatches('delegation topology', resolve(root, 'cordis.patch.yml')), () => {})
    const inGroup = composed.find(entry => entry.id === 'wowyuarm-agent-team-scope')
    const groupRows = (Array.isArray(inGroup?.config) ? inGroup.config : []) as { id?: string; config?: unknown }[]
    const groupChild = groupRows.find(entry => entry.id === 'wowyuarm-agent-team-preset-team-subagent')
    const hostChild = composed.find(entry => entry.id === 'wowyuarm-agent-team-preset-team-subagent-host-plane')
    // One definition: the alias row shares the in-group row's config object.
    expect(groupChild).toBeDefined()
    expect(hostChild?.config).toBe(groupChild?.config)
  })
})
