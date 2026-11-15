import { describe, expect, it } from 'vitest'
import { GENERAL_MODEL_PROMPTS } from '../src/context/prompts/general-model.ts'
import { SMALL_MODEL_PROMPTS } from '../src/context/prompts/small-model.ts'
import { CONTEXT_ROLE_TASKS, buildContextRolePrompt } from '../src/context/prompts/role-prompts.ts'

describe('context role prompt families', () => {
  it('covers every task in both families', () => {
    for (const task of CONTEXT_ROLE_TASKS) {
      expect(SMALL_MODEL_PROMPTS[task]).toBeDefined()
      expect(GENERAL_MODEL_PROMPTS[task]).toBeDefined()
      expect(SMALL_MODEL_PROMPTS[task].system).not.toBe(GENERAL_MODEL_PROMPTS[task].system)
    }
  })

  it('keeps the general prompt declarative about the served role', () => {
    for (const role of ['assistant', 'decision', 'extraction'] as const) {
      const prompt = buildContextRolePrompt({ role, task: 'classify', profile: 'general', payload: { unit: 'x' } })
      expect(prompt.system).toContain(`"${role}"`)
      expect(prompt.system).toContain('JSON')
      expect(prompt.system).toContain('main assistant')
    }
  })

  it('does not add a role declaration to the small prompt', () => {
    const prompt = buildContextRolePrompt({ role: 'decision', task: 'classify', profile: 'small', payload: { unit: 'x' } })
    expect(prompt.system).not.toContain('You are serving')
    expect(prompt.messages[0]?.content).toContain('"unit": "x"')
  })

  it('rejects embedding roles and spreads the payload verbatim', () => {
    expect(() => buildContextRolePrompt({ role: 'embedding', task: 'enrich', profile: 'embedding' as never, payload: {} })).toThrow()
    const prompt = buildContextRolePrompt({
      role: 'extraction',
      task: 'enrich',
      profile: 'general',
      payload: { text: '中文 and English', path: '/tmp/a.ts' },
    })
    expect(prompt.messages[0]?.content).toContain('中文 and English')
    expect(prompt.messages[0]?.content).toContain('/tmp/a.ts')
  })
})
