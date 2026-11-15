import { describe, expect, it } from 'vitest'
import { extractContextRules, normalizeUnitText } from '../src/context/extract-rules.ts'
import type { ContextUnitRole } from '../src/context/types.ts'

const RECORDED_AT = '2026-11-15T06:00:00.000Z'
const TIMEZONE = 'Asia/Shanghai'

function rules(role: ContextUnitRole, text: string): ReturnType<typeof extractContextRules> {
  return extractContextRules({ role, text, recordedAt: RECORDED_AT, timezone: TIMEZONE })
}

describe('normalizeUnitText', () => {
  it('normalizes newlines and blank-line runs', () => {
    expect(normalizeUnitText('  A\r\nB\r\n\r\n\r\n\r\nC  ')).toBe('A\nB\n\nC')
  })

  it('applies NFKC so full-width identifiers collapse', () => {
    expect(normalizeUnitText('ｖ１．２．３')).toBe('v1.2.3')
  })
})

describe('extractContextRules classification', () => {
  it('marks an explicit user decision as high importance', () => {
    const result = rules('user', '决定采用方案 A，必须在下周完成')
    expect(result.kind).toBe('decision')
    expect(result.importance).toBe(3)
  })

  it('keeps a soft user decision at importance 2', () => {
    const result = rules('user', '我选择方案 B')
    expect(result.kind).toBe('decision')
    expect(result.importance).toBe(2)
  })

  it('marks remembered preferences as memory', () => {
    const result = rules('user', '请记住我的偏好：回答要短')
    expect(result.kind).toBe('memory')
    expect(result.importance).toBe(2)
  })

  it('treats plain assistant prose as process', () => {
    const result = rules('assistant', '我先看一下代码')
    expect(result.kind).toBe('process')
    expect(result.importance).toBe(1)
  })

  it('treats a tool error as a fact worth enriching', () => {
    const result = rules('tool', 'TypeError: boom at handler')
    expect(result.kind).toBe('fact')
    expect(result.importance).toBe(2)
  })

  it('keeps notices at zero importance', () => {
    const result = rules('notice', 'context reset')
    expect(result.kind).toBe('auxiliary')
    expect(result.importance).toBe(0)
  })
})

describe('extractContextRules keywords', () => {
  it('keeps exact identifiers beside lexical terms', () => {
    const result = rules(
      'user',
      '修改 packages/agent-team/src/context/store.ts，运行 npm run test:browser，错误 ENOENT，见 https://example.com/a/b。',
    )
    const terms = result.keywords.map(keyword => keyword.term)
    expect(terms).toContain('packages/agent-team/src/context/store.ts')
    expect(terms).toContain('npm run test:browser')
    expect(terms).toContain('ENOENT')
    expect(terms).toContain('https://example.com/a/b')
  })

  it('caps the keyword set at twelve', () => {
    const result = rules(
      'user',
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau',
    )
    expect(result.keywords.length).toBeLessThanOrEqual(12)
  })
})

describe('extractContextRules facets', () => {
  it('produces time, space, subject and topic facets without a model', () => {
    const result = rules('user', '昨天下午在北京和 @alice 讨论上下文压缩方案')
    const dimensions = new Set(result.facets.map(facet => facet.dimension))
    expect(dimensions).toEqual(new Set(['time', 'space', 'subject', 'topic']))
    expect(result.facets.find(facet => facet.dimension === 'subject')?.value).toBe('member:alice')
    expect(result.facets.find(facet => facet.dimension === 'space')?.value).toBe('space:city:beijing')
    expect(result.facets.find(facet => facet.dimension === 'time')?.granularity).toBe('afternoon')
  })
})
