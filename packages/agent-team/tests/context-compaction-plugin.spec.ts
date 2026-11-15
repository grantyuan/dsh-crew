import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  resetTeamCompactionSummarizerResolver,
  setTeamCompactionSummarizerResolver,
  teamCompactionSummary,
} from '../src/context/compaction-plugin.ts'

const input = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'keep the fold deterministic' }] }],
} as never
const agent = { session: { id: 's1' } } as unknown as Agent

afterEach(() => resetTeamCompactionSummarizerResolver())

describe('preset compaction engine', () => {
  it('routes summarization through the configured assistant role', async () => {
    const seen: string[] = []
    setTeamCompactionSummarizerResolver(() => async request => {
      seen.push(request.text)
      return { text: 'assistant summary', provider: 'assistant-provider', model: 'assistant-model' }
    })
    const result = await teamCompactionSummary(input, agent)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('keep the fold deterministic')
    expect(result).toEqual({
      summary: [{ type: 'text', text: 'assistant summary' }],
      provider: 'assistant-provider',
      model: 'assistant-model',
    })
  })

  it('returns undefined when the resolver declines so the shipped engine runs', async () => {
    let called = false
    setTeamCompactionSummarizerResolver(() => {
      called = true
      return async () => undefined
    })
    expect(await teamCompactionSummary(input, agent)).toBeUndefined()
    expect(called).toBe(true)
  })

  it('returns undefined when no resolver is installed', async () => {
    expect(await teamCompactionSummary(input, agent)).toBeUndefined()
  })

  it('falls back when the assistant call throws', async () => {
    setTeamCompactionSummarizerResolver(() => async () => {
      throw new Error('assistant down')
    })
    expect(await teamCompactionSummary(input, agent)).toBeUndefined()
  })
})
