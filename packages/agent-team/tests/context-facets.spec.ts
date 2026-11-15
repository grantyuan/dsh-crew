import { describe, expect, it } from 'vitest'
import {
  extractFacets,
  extractRoleFacets,
  extractSpaceFacets,
  extractSubjectFacets,
  extractTimeFacets,
  extractTopicFacets,
  facetsFromEnrichment,
  roleFacetValue,
  wallToInstant,
} from '../src/context/facets.ts'

const RECORDED_AT = '2026-11-15T06:00:00.000Z'
const TIMEZONE = 'Asia/Shanghai'

/** Epoch ms for a wall-clock time in Asia/Shanghai (UTC+8, no DST). */
function shanghai(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return wallToInstant({ year, month, day }, hour, minute, TIMEZONE)
}

function timeFacet(text: string, recordedAt = RECORDED_AT): ReturnType<typeof extractTimeFacets>[number] | undefined {
  return extractTimeFacets(text, recordedAt, TIMEZONE)[0]
}

describe('extractTimeFacets', () => {
  it('resolves a relative day against the message time, not the clock', () => {
    expect(timeFacet('今天')).toMatchObject({ startMs: shanghai(2026, 11, 15), endMs: shanghai(2026, 11, 16), granularity: 'day' })
    expect(timeFacet('昨天')).toMatchObject({ startMs: shanghai(2026, 11, 14), endMs: shanghai(2026, 11, 15) })
    expect(timeFacet('明天')).toMatchObject({ startMs: shanghai(2026, 11, 16), endMs: shanghai(2026, 11, 17) })
  })

  it('uses the Member timezone when the recorded instant is near midnight UTC', () => {
    const lateUtc = '2026-11-14T18:00:00.000Z'
    expect(timeFacet('昨天', lateUtc)).toMatchObject({ startMs: shanghai(2026, 11, 14), endMs: shanghai(2026, 11, 15) })
  })

  it('intersects a weekday with a time-of-day period', () => {
    const facet = timeFacet('上周三下午')
    expect(facet).toMatchObject({
      raw: '上周三下午',
      startMs: shanghai(2026, 11, 4, 13),
      endMs: shanghai(2026, 11, 4, 18),
      granularity: 'afternoon',
      confidence: 0.9,
    })
  })

  it('applies a period to the message day when no date is given', () => {
    expect(timeFacet('下午再说')).toMatchObject({
      startMs: shanghai(2026, 11, 15, 13),
      endMs: shanghai(2026, 11, 15, 18),
      granularity: 'afternoon',
    })
  })

  it('resolves recent phrases against the recorded instant', () => {
    const recorded = Date.parse(RECORDED_AT)
    expect(timeFacet('刚才')).toMatchObject({ startMs: recorded - 600_000, endMs: recorded, granularity: 'minute', confidence: 0.6 })
    expect(timeFacet('刚才那会儿')).toMatchObject({ startMs: recorded - 1_200_000, endMs: recorded, confidence: 0.4 })
  })

  it('parses an absolute date and optional time', () => {
    expect(timeFacet('2026-11-10')).toMatchObject({
      startMs: shanghai(2026, 11, 10),
      endMs: shanghai(2026, 11, 11),
      granularity: 'day',
    })
    expect(timeFacet('2026-11-10 14:30')).toMatchObject({
      startMs: shanghai(2026, 11, 10, 14, 30),
      endMs: shanghai(2026, 11, 10, 15, 30),
      granularity: 'hour',
    })
  })

  it('resolves whole month and year ranges', () => {
    expect(timeFacet('下个月')).toMatchObject({ startMs: shanghai(2026, 12, 1), endMs: shanghai(2027, 1, 1), granularity: 'month' })
    expect(timeFacet('去年')).toMatchObject({ startMs: shanghai(2025, 1, 1), endMs: shanghai(2026, 1, 1), granularity: 'year' })
    expect(timeFacet('3年前')).toMatchObject({ startMs: shanghai(2023, 1, 1), endMs: shanghai(2024, 1, 1) })
  })

  it('records an unresolvable time word without guessing', () => {
    expect(timeFacet('改天再说')).toMatchObject({ value: 'unresolved', confidence: 0, source: 'rule' })
    expect(timeFacet('没有时间线索')).toBeUndefined()
  })
})

describe('extractSpaceFacets', () => {
  it('resolves cities and local/remote anchors', () => {
    const values = extractSpaceFacets('上周在北京，线上同步，本地缓存').map(facet => facet.value)
    expect(values).toEqual(expect.arrayContaining(['space:city:beijing', 'space:remote', 'space:local']))
  })
})

describe('extractRoleFacets', () => {
  it('maps dictionary words to coarse roles', () => {
    const values = extractRoleFacets('助理和公司一起评审').map(facet => facet.value)
    expect(values).toEqual(expect.arrayContaining(['role:agent', 'role:organization']))
    expect(roleFacetValue('智能体')).toBe('role:agent')
    expect(roleFacetValue('spacecraft')).toBe('open:spacecraft')
  })
})

describe('extractSubjectFacets', () => {
  it('uses exact Team identifiers', () => {
    const values = extractSubjectFacets('@alice workspace:team-a session:abcd channel:general').map(facet => facet.value)
    expect(values).toEqual(expect.arrayContaining([
      'member:alice',
      'workspace:team-a',
      'session:abcd',
      'channel:general',
    ]))
  })

  it('does not mistake a scoped package for a Member handle', () => {
    expect(extractSubjectFacets('安装 @scope/pkg 后重试')).toEqual([])
  })
})

describe('extractTopicFacets', () => {
  it('normalizes lexical topics', () => {
    expect(extractTopicFacets(['上下文压缩', 'Store'])).toMatchObject([
      { dimension: 'topic', value: 'topic:上下文压缩', source: 'rule' },
      { dimension: 'topic', value: 'topic:store', source: 'rule' },
    ])
  })
})

describe('extractFacets and model enrichment', () => {
  it('combines every rule dimension', () => {
    const facets = extractFacets({
      text: '昨天下午在北京和 @alice 讨论上下文压缩方案',
      recordedAt: RECORDED_AT,
      timezone: TIMEZONE,
      topics: ['上下文压缩'],
    })
    expect(new Set(facets.map(facet => facet.dimension))).toEqual(new Set(['time', 'space', 'subject', 'topic']))
  })

  it('converts enrichment into model-sourced facets', () => {
    const facets = facetsFromEnrichment({
      subjects: ['@bob', 'workspace:team-b'],
      topics: ['上下文压缩'],
      roles: ['agent'],
      confidence: 0.7,
      time: { startMs: shanghai(2026, 11, 15, 9), endMs: shanghai(2026, 11, 15, 10) },
    })
    expect(facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'subject', value: 'member:bob', source: 'model' }),
      expect.objectContaining({ dimension: 'subject', value: 'workspace:team-b', source: 'model' }),
      expect.objectContaining({ dimension: 'topic', value: 'topic:上下文压缩', source: 'model' }),
      expect.objectContaining({ dimension: 'role', value: 'role:agent', source: 'model' }),
      expect.objectContaining({ dimension: 'time', source: 'model', granularity: 'hour' }),
    ]))
  })
})
