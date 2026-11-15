import { describe, expect, it } from 'vitest'
import {
  MAX_UNIT_KEYWORDS,
  cjkBigrams,
  extractExactKeys,
  extractKeywords,
  extractLexicalKeywords,
  extractTopicTerms,
  normalizeTerm,
} from '../src/context/keywords.ts'

describe('normalizeTerm', () => {
  it('NFKC-normalizes, lowercases and strips edge punctuation', () => {
    expect(normalizeTerm('  Ｈｅｌｌｏ，World!!  ')).toBe('hello world')
  })

  it('preserves identifier characters used by paths and packages', () => {
    expect(normalizeTerm('packages/agent-team/src/store.ts')).toBe('packages/agent-team/src/store.ts')
    expect(normalizeTerm('@scope/pkg@1.2.3')).toBe('@scope/pkg@1.2.3')
  })
})

describe('cjkBigrams', () => {
  it('emits overlapping pairs for every Han run', () => {
    expect(cjkBigrams('上下文压缩')).toEqual(['上下', '下文', '文压', '压缩'])
    expect(cjkBigrams('a上下文b')).toEqual(['上下', '下文'])
  })
})

describe('extractExactKeys', () => {
  it('finds paths, commands, error codes, issues, commits and URLs', () => {
    const terms = extractExactKeys(
      '修改 packages/agent-team/src/context/store.ts，运行 npm run test:browser，'
      + '错误 ENOENT，issue #123，commit abc1234，见 https://example.com/a/b。',
    ).map(keyword => keyword.term)
    expect(terms).toContain('packages/agent-team/src/context/store.ts')
    expect(terms).toContain('npm run test:browser')
    expect(terms).toContain('ENOENT')
    expect(terms).toContain('#123')
    expect(terms).toContain('abc1234')
    expect(terms).toContain('https://example.com/a/b')
  })

  it('finds versions and scoped packages', () => {
    const terms = extractExactKeys('升级 v1.2.3，安装 @scope/pkg@2.0.0').map(keyword => keyword.term)
    expect(terms).toContain('v1.2.3')
    expect(terms).toContain('@scope/pkg')
  })

  it('extracts backticked identifiers verbatim', () => {
    expect(extractExactKeys('运行 `pnpm vitest run` 后通过')[0]).toMatchObject({
      term: 'pnpm vitest run',
      kind: 'exact',
      source: 'deterministic',
    })
  })

  it('deduplicates repeated identifiers', () => {
    const terms = extractExactKeys('ENOENT 和 ENOENT').map(keyword => keyword.term)
    expect(terms.filter(term => term === 'ENOENT')).toHaveLength(1)
  })
})

describe('extractLexicalKeywords', () => {
  it('drops stop words and weights repeated terms higher', () => {
    const keywords = extractLexicalKeywords('the strategy for the strategy of context management')
    const terms = keywords.map(keyword => keyword.term)
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('for')
    expect(keywords.find(keyword => keyword.term === 'strategy')?.weight).toBeGreaterThan(
      keywords.find(keyword => keyword.term === 'management')?.weight ?? 0,
    )
  })

  it('segments Chinese words', () => {
    expect(extractLexicalKeywords('上下文压缩策略').map(keyword => keyword.term)).toContain('压缩')
  })
})

describe('extractKeywords', () => {
  it('keeps quoted phrases as phrase keywords before lexical terms', () => {
    const keywords = extractKeywords('请使用“上下文压缩”策略')
    expect(keywords[0]).toMatchObject({ term: '上下文压缩', kind: 'phrase' })
  })

  it('caps merged output at the unit limit', () => {
    const keywords = extractKeywords(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi',
    )
    expect(keywords.length).toBeLessThanOrEqual(MAX_UNIT_KEYWORDS)
  })
})

describe('extractTopicTerms', () => {
  it('returns lexical terms only', () => {
    const keywords = extractKeywords('packages/agent-team/src/context/store.ts 上下文压缩 strategy')
    const topics = extractTopicTerms(keywords)
    expect(topics).not.toContain('packages/agent-team/src/context/store.ts')
    expect(topics.length).toBeGreaterThan(0)
    expect(topics.length).toBeLessThanOrEqual(3)
  })
})
