import { describe, expect, it } from 'vitest'
import { buildQuestionAnalysisMessages, looksLikeQuestion, parseQuestionAnalysis, QUESTION_ANALYSIS_SYSTEM_PREFIX } from '../src/question-memory.ts'

describe('question-memory heuristics and parse', () => {
  it('sees questions in question marks and Chinese interrogatives, not in statements', () => {
    expect(looksLikeQuestion('这个方案是否可行?')).toBe(true)
    expect(looksLikeQuestion('why is the build red?')).toBe(true) // the half-width mark fires first
    expect(looksLikeQuestion('如何修复构建?')).toBe(true)
    expect(looksLikeQuestion('发布方案该如何选择')).toBe(true)
    expect(looksLikeQuestion('我已经把构建修好了')).toBe(false)
    expect(looksLikeQuestion('部署完成了')).toBe(false)
  })

  it('builds one system turn and one user turn with numbered history and no tools', () => {
    const { system, messages } = buildQuestionAnalysisMessages({
      question: '新问题',
      past: [{ index: 0, occurredAt: '2026-11-07T04:00:00.000Z', excerpt: '旧问题' }],
    })
    expect(system.startsWith(QUESTION_ANALYSIS_SYSTEM_PREFIX)).toBe(true)
    expect(system).toContain('"repeats"')
    expect(messages).toHaveLength(1)
    const text = messages[0]!.content[0]!.type === 'text' ? messages[0]!.content[0]!.text : ''
    expect(text).toContain('[0] 2026-11-07T04:00:00.000Z — 旧问题')
    expect(text).toContain('新问题')
  })

  it('parses the strict JSON reply, clamps indices, and throws on garbage', () => {
    const parsed = parseQuestionAnalysis('```json\n{"repeats":[0,4,1],"conflicts":[2],"digest":"新问题摘要"}\n```', 2)
    expect(parsed.repeats).toEqual([0, 1])
    expect(parsed.conflicts).toEqual([])
    expect(parsed.digest).toBe('新问题摘要')
    expect(() => parseQuestionAnalysis('not json', 1)).toThrow()
    expect(() => parseQuestionAnalysis('{"repeats":[]}', 1)).toThrow(/digest/)
    expect(parseQuestionAnalysis('{"repeats":[9],"conflicts":[],"digest":"x"}', 1).repeats).toEqual([])
  })
})
