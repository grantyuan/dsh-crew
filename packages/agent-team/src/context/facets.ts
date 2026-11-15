/**
 * Rule-based facet extraction: time, space, role, subject and topic.
 *
 * All dimensions are local and deterministic. Relative time resolves against
 * the message's `recordedAt` in the Member's timezone — never against the wall
 * clock — so "今天" keeps meaning the day the message was written. Models may
 * later add missing dimensions, but they never rewrite a rule facet.
 *
 * The reference functions are exported for tests and for the query-side parser
 * in the recall ticket; both sides must use the same calendar rules.
 * @module @grantyuan/dsh-crew/context/facets
 */

import { normalizeTerm } from './keywords.ts'
import type {
  ContextFacet,
  ContextTimeGranularity,
  ContextUnitEnrichment,
} from './types.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

interface DateMatch {
  readonly start: number
  readonly end: number
  readonly raw: string
  readonly granularity: ContextTimeGranularity
  readonly confidence: number
  /** Present only for matches covering exactly one calendar day. */
  readonly day?: CivilDate
}

interface PeriodMatch {
  readonly startHour: number
  /** Exclusive; 24 means the next midnight. */
  readonly endHour: number
  readonly raw: string
  readonly granularity: ContextTimeGranularity
  readonly confidence: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

interface WallParts extends CivilDate {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** Wall-clock parts of an instant in one timezone. */
export function wallParts(instant: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }
  const hour = read('hour')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  }
}

/** Offset of one timezone at an instant, in milliseconds east of UTC. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const wall = wallParts(instant, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant
}

/** Convert a wall-clock time in a timezone to an epoch millisecond instant. */
export function wallToInstant(civil: CivilDate, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(civil.year, civil.month - 1, civil.day, hour, minute, 0)
  const firstOffset = zoneOffsetMs(guess, timeZone)
  let instant = guess - firstOffset
  const secondOffset = zoneOffsetMs(instant, timeZone)
  if (secondOffset !== firstOffset) instant = guess - secondOffset
  return instant
}

function addDays(civil: CivilDate, days: number): CivilDate {
  const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function addMonths(civil: CivilDate, months: number): CivilDate {
  const date = new Date(Date.UTC(civil.year, civil.month - 1 + months, 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 }
}

function weekdayOf(civil: CivilDate): number {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay()
}

/** Monday-based start of the week containing `civil`, shifted by weeks. */
function weekStart(civil: CivilDate, weeks: number): CivilDate {
  const sinceMonday = (weekdayOf(civil) + 6) % 7
  return addDays(civil, -sinceMonday + weeks * 7)
}

function dayRange(civil: CivilDate, timeZone: string): { start: number; end: number } {
  return {
    start: wallToInstant(civil, 0, 0, timeZone),
    end: wallToInstant(addDays(civil, 1), 0, 0, timeZone),
  }
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
}

function dayMatch(civil: CivilDate, raw: string, confidence: number, timeZone: string): DateMatch {
  const range = dayRange(civil, timeZone)
  return { start: range.start, end: range.end, raw, granularity: 'day', confidence, day: civil }
}

function referenceCivil(recordedAtMs: number, timeZone: string): CivilDate {
  const wall = wallParts(recordedAtMs, timeZone)
  return { year: wall.year, month: wall.month, day: wall.day }
}

function matchRelativeDate(text: string, reference: CivilDate, timeZone: string): DateMatch | undefined {
  const absolute = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?/u.exec(text)
  if (absolute !== null) {
    const civil: CivilDate = { year: Number(absolute[1]), month: Number(absolute[2]), day: Number(absolute[3]) }
    if (civil.month >= 1 && civil.month <= 12 && civil.day >= 1 && civil.day <= 31) {
      if (absolute[4] !== undefined && absolute[5] !== undefined) {
        const hour = Number(absolute[4])
        if (hour >= 0 && hour <= 23) {
          const start = wallToInstant(civil, hour, Number(absolute[5]), timeZone)
          return {
            start,
            end: start + HOUR_MS,
            raw: absolute[0],
            granularity: 'hour',
            confidence: 0.9,
            day: civil,
          }
        }
      }
      return dayMatch(civil, absolute[0], 0.9, timeZone)
    }
  }

  const relativeDay = /前天|昨天|今天|明天|后天/u.exec(text)
  if (relativeDay !== null) {
    const offset = { 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2 }[relativeDay[0]] ?? 0
    return dayMatch(addDays(reference, offset), relativeDay[0], 0.85, timeZone)
  }

  const weekDay = /(上|本|这|下)(?:个)?(?:周|星期)([一二三四五六日天])/u.exec(text)
  if (weekDay !== null) {
    const weeks = weekDay[1] === '上' ? -1 : weekDay[1] === '下' ? 1 : 0
    const index = WEEKDAY_INDEX[weekDay[2] ?? '']
    if (index !== undefined) {
      return dayMatch(addDays(weekStart(reference, weeks), index), weekDay[0], 0.85, timeZone)
    }
  }

  const wholeWeek = /(上|本|这|下)(?:个)?(?:周|星期)/u.exec(text)
  if (wholeWeek !== null) {
    const weeks = wholeWeek[1] === '上' ? -1 : wholeWeek[1] === '下' ? 1 : 0
    const startCivil = weekStart(reference, weeks)
    const range = dayRange(startCivil, timeZone)
    const next = dayRange(addDays(startCivil, 7), timeZone)
    return {
      start: range.start,
      end: next.start,
      raw: wholeWeek[0],
      granularity: 'week',
      confidence: 0.8,
    }
  }

  const month = /(上|本|这|下)(?:个)?月/u.exec(text)
  if (month !== null) {
    const months = month[1] === '上' ? -1 : month[1] === '下' ? 1 : 0
    const startCivil = addMonths(reference, months)
    const nextCivil = addMonths(reference, months + 1)
    return {
      start: dayRange(startCivil, timeZone).start,
      end: dayRange(nextCivil, timeZone).start,
      raw: month[0],
      granularity: 'month',
      confidence: 0.8,
    }
  }

  const year = /(前|去|今|明)年/u.exec(text)
  if (year !== null) {
    const offset = { 前: -2, 去: -1, 今: 0, 明: 1 }[year[1] ?? ''] ?? 0
    const startCivil: CivilDate = { year: reference.year + offset, month: 1, day: 1 }
    const nextCivil: CivilDate = { year: reference.year + offset + 1, month: 1, day: 1 }
    return {
      start: dayRange(startCivil, timeZone).start,
      end: dayRange(nextCivil, timeZone).start,
      raw: year[0],
      granularity: 'year',
      confidence: 0.8,
    }
  }

  const yearsAgo = /(\d{1,3})年前/u.exec(text)
  if (yearsAgo !== null) {
    const targetYear = reference.year - Number(yearsAgo[1])
    const startCivil: CivilDate = { year: targetYear, month: 1, day: 1 }
    const nextCivil: CivilDate = { year: targetYear + 1, month: 1, day: 1 }
    return {
      start: dayRange(startCivil, timeZone).start,
      end: dayRange(nextCivil, timeZone).start,
      raw: yearsAgo[0],
      granularity: 'year',
      confidence: 0.5,
    }
  }

  const bareWeekDay = /(?:周|星期)([一二三四五六日天])/u.exec(text)
  if (bareWeekDay !== null) {
    const index = WEEKDAY_INDEX[bareWeekDay[1] ?? '']
    if (index !== undefined) {
      return dayMatch(addDays(weekStart(reference, 0), index), bareWeekDay[0], 0.7, timeZone)
    }
  }

  return undefined
}

const PERIODS: readonly { readonly pattern: RegExp; readonly startHour: number; readonly endHour: number; readonly granularity: ContextTimeGranularity }[] = [
  { pattern: /凌晨/u, startHour: 0, endHour: 6, granularity: 'night' },
  { pattern: /清晨|早晨|早上/u, startHour: 6, endHour: 9, granularity: 'morning' },
  { pattern: /上午/u, startHour: 9, endHour: 12, granularity: 'morning' },
  { pattern: /中午/u, startHour: 12, endHour: 13, granularity: 'hour' },
  { pattern: /下午/u, startHour: 13, endHour: 18, granularity: 'afternoon' },
  { pattern: /傍晚/u, startHour: 18, endHour: 19, granularity: 'evening' },
  { pattern: /晚上|夜里|夜间/u, startHour: 19, endHour: 24, granularity: 'night' },
]

function matchPeriod(text: string): PeriodMatch | undefined {
  for (const period of PERIODS) {
    const match = period.pattern.exec(text)
    if (match === null) continue
    return {
      startHour: period.startHour,
      endHour: period.endHour,
      raw: match[0],
      granularity: period.granularity,
      confidence: 0.7,
    }
  }
  return undefined
}

function timeFacet(start: number, end: number, raw: string, granularity: ContextTimeGranularity, confidence: number, timeZone: string): ContextFacet {
  return {
    dimension: 'time',
    value: `${start}/${end}`,
    raw,
    startMs: start,
    endMs: end,
    granularity,
    tz: timeZone,
    confidence,
    source: 'rule',
  }
}

/**
 * Resolve relative and absolute time expressions in one text.
 *
 * A date phrase plus a time-of-day phrase intersect; a time-of-day alone
 * applies to the message's own day; an unresolvable time word records
 * `unresolved` with zero confidence instead of guessing.
 */
export function extractTimeFacets(text: string, recordedAt: string, timezone?: string): ContextFacet[] {
  const timeZone = timezone ?? defaultTimeZone()
  const recordedAtMs = Date.parse(recordedAt)
  if (!Number.isFinite(recordedAtMs)) return []

  const recent = /刚才那会儿|刚才/u.exec(text)
  if (recent !== null) {
    const minutes = recent[0] === '刚才那会儿' ? 20 : 10
    return [timeFacet(
      recordedAtMs - minutes * 60_000,
      recordedAtMs,
      recent[0],
      'minute',
      minutes === 20 ? 0.4 : 0.6,
      timeZone,
    )]
  }

  const reference = referenceCivil(recordedAtMs, timeZone)
  const date = matchRelativeDate(text, reference, timeZone)
  const period = matchPeriod(text)

  if (date !== undefined && period !== undefined && date.day !== undefined) {
    const start = wallToInstant(date.day, period.startHour, 0, timeZone)
    const end = period.endHour >= 24
      ? wallToInstant(addDays(date.day, 1), 0, 0, timeZone)
      : wallToInstant(date.day, period.endHour, 0, timeZone)
    const raw = date.raw.includes(period.raw) ? date.raw : `${date.raw}${period.raw}`
    return [timeFacet(start, end, raw, period.granularity, 0.9, timeZone)]
  }

  if (date !== undefined) {
    return [timeFacet(date.start, date.end, date.raw, date.granularity, date.confidence, timeZone)]
  }

  if (period !== undefined) {
    const start = wallToInstant(reference, period.startHour, 0, timeZone)
    const end = period.endHour >= 24
      ? wallToInstant(addDays(reference, 1), 0, 0, timeZone)
      : wallToInstant(reference, period.endHour, 0, timeZone)
    return [timeFacet(start, end, period.raw, period.granularity, period.confidence, timeZone)]
  }

  const unresolved = /改天|某天|以后|回头|稍后|过几天|晚一点|晚点/u.exec(text)
  if (unresolved !== null) {
    return [{ dimension: 'time', value: 'unresolved', raw: unresolved[0], confidence: 0, source: 'rule' }]
  }

  return []
}

interface CityAlias {
  readonly id: string
  readonly aliases: readonly string[]
}

const CITIES: readonly CityAlias[] = [
  { id: 'beijing', aliases: ['北京', 'beijing'] },
  { id: 'shanghai', aliases: ['上海', 'shanghai'] },
  { id: 'shenzhen', aliases: ['深圳', 'shenzhen'] },
  { id: 'guangzhou', aliases: ['广州', 'guangzhou'] },
  { id: 'hangzhou', aliases: ['杭州', 'hangzhou'] },
  { id: 'chengdu', aliases: ['成都', 'chengdu'] },
  { id: 'nanjing', aliases: ['南京', 'nanjing'] },
  { id: 'wuhan', aliases: ['武汉', 'wuhan'] },
  { id: 'xian', aliases: ['西安', "xi'an", 'xian'] },
  { id: 'suzhou', aliases: ['苏州', 'suzhou'] },
  { id: 'chongqing', aliases: ['重庆', 'chongqing'] },
  { id: 'tianjin', aliases: ['天津', 'tianjin'] },
  { id: 'hongkong', aliases: ['香港', 'hong kong', 'hongkong'] },
]

function pushUnique(facets: ContextFacet[], facet: ContextFacet): void {
  if (facets.some(item => item.dimension === facet.dimension && item.value === facet.value)) return
  facets.push(facet)
}

/** Space facets: local/remote anchors, known cities, and `open:` surfaces. */
export function extractSpaceFacets(text: string): ContextFacet[] {
  const facets: ContextFacet[] = []
  const local = /本地|本机|这里/u.exec(text)
  if (local !== null) {
    pushUnique(facets, { dimension: 'space', value: 'space:local', raw: local[0], confidence: 0.8, source: 'rule' })
  }
  const remote = /线上|远程|云端|远端/u.exec(text)
  if (remote !== null) {
    pushUnique(facets, { dimension: 'space', value: 'space:remote', raw: remote[0], confidence: 0.8, source: 'rule' })
  }
  const lower = text.toLowerCase()
  for (const city of CITIES) {
    const alias = city.aliases.find(name => lower.includes(name))
    if (alias === undefined) continue
    pushUnique(facets, { dimension: 'space', value: `space:city:${city.id}`, raw: alias, confidence: 0.8, source: 'rule' })
    if (facets.length >= 5) break
  }
  return facets
}

const ROLE_TERMS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'agent', pattern: /智能体|助手|助理|agent|机器人/iu },
  { id: 'human', pattern: /人类|用户|同事|负责人/u },
  { id: 'organization', pattern: /公司|团队|组织|部门|机构/u },
  { id: 'object', pattern: /文件|目录|脚本|服务|数据库|仓库|项目|模型/u },
]

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  agent: 'agent',
  智能体: 'agent',
  助手: 'agent',
  助理: 'agent',
  human: 'human',
  人: 'human',
  人类: 'human',
  用户: 'human',
  organization: 'organization',
  org: 'organization',
  组织: 'organization',
  团队: 'organization',
  公司: 'organization',
  object: 'object',
  物体: 'object',
  对象: 'object',
  location: 'location',
  地点: 'location',
}

/** Normalize any role surface to a coarse `role:` value or `open:`. */
export function roleFacetValue(value: string): string {
  const key = normalizeTerm(value)
  const known = ROLE_ALIASES[key]
  return known === undefined ? `open:${key}` : `role:${known}`
}

/** Coarse role facets, derived from a small built-in dictionary. */
export function extractRoleFacets(text: string): ContextFacet[] {
  const facets: ContextFacet[] = []
  for (const role of ROLE_TERMS) {
    const match = role.pattern.exec(text)
    if (match === null) continue
    pushUnique(facets, { dimension: 'role', value: `role:${role.id}`, raw: match[0], confidence: 0.6, source: 'rule' })
  }
  return facets
}

function pushSubject(facets: ContextFacet[], value: string, raw: string, confidence: number): void {
  if (value === '') return
  pushUnique(facets, { dimension: 'subject', value, raw, confidence, source: 'rule' })
}

/** Subject facets from exact Team identifiers; never guess a pronoun referent. */
export function extractSubjectFacets(text: string): ContextFacet[] {
  const facets: ContextFacet[] = []

  const handlePattern = /@([A-Za-z0-9][A-Za-z0-9_-]{1,31})(?![\w/-])/gu
  for (const match of text.matchAll(handlePattern)) {
    const handle = (match[1] ?? '').toLowerCase()
    pushSubject(facets, `member:${handle}`, match[0], 0.95)
  }

  const workspacePattern = /\bworkspace(?:Id)?['":=\s]+([A-Za-z0-9_-]{2,64})/giu
  for (const match of text.matchAll(workspacePattern)) {
    pushSubject(facets, `workspace:${(match[1] ?? '').toLowerCase()}`, match[0], 0.9)
  }

  const sessionPattern = /\bsession(?:Id)?['":=\s]+([A-Za-z0-9_-]{4,64})/giu
  for (const match of text.matchAll(sessionPattern)) {
    pushSubject(facets, `session:${(match[1] ?? '').toLowerCase()}`, match[0], 0.9)
  }

  const channelPattern = /\bchannel(?:Id)?['":=\s]+([A-Za-z0-9_-]{2,64})/giu
  for (const match of text.matchAll(channelPattern)) {
    pushSubject(facets, `channel:${(match[1] ?? '').toLowerCase()}`, match[0], 0.9)
  }

  return facets
}

/** Topic facets reuse the unit's top lexical terms; no second topic index. */
export function extractTopicFacets(topics: readonly string[]): ContextFacet[] {
  const facets: ContextFacet[] = []
  for (const topic of topics) {
    const normalized = normalizeTerm(topic)
    if (normalized === '') continue
    pushUnique(facets, { dimension: 'topic', value: `topic:${normalized}`, raw: topic, confidence: 0.5, source: 'rule' })
  }
  return facets
}

export interface ExtractFacetsInput {
  readonly text: string
  readonly recordedAt: string
  readonly timezone?: string
  readonly topics?: readonly string[]
}

/** All rule facets for one unit, in a stable dimension order. */
export function extractFacets(input: ExtractFacetsInput): ContextFacet[] {
  const facets: ContextFacet[] = []
  for (const facet of extractTimeFacets(input.text, input.recordedAt, input.timezone)) pushUnique(facets, facet)
  for (const facet of extractSpaceFacets(input.text)) pushUnique(facets, facet)
  for (const facet of extractRoleFacets(input.text)) pushUnique(facets, facet)
  for (const facet of extractSubjectFacets(input.text)) pushUnique(facets, facet)
  for (const facet of extractTopicFacets(input.topics ?? [])) pushUnique(facets, facet)
  return facets
}

/** Convert a model subject surface to the same `subject:` vocabulary rules use. */
export function subjectFacetValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^(?:member|workspace|session|channel|open):/iu.test(trimmed)) return trimmed.toLowerCase()
  if (trimmed.startsWith('@')) return `member:${trimmed.slice(1).toLowerCase()}`
  return `open:${normalizeTerm(trimmed)}`
}

/** Convert model enrichment into facets that only fill missing dimensions. */
export function facetsFromEnrichment(enrichment: ContextUnitEnrichment): ContextFacet[] {
  const facets: ContextFacet[] = []
  const confidence = Math.max(0, Math.min(1, enrichment.confidence))

  for (const subject of enrichment.subjects) {
    const value = subjectFacetValue(subject)
    if (value === '') continue
    pushUnique(facets, { dimension: 'subject', value, raw: subject, confidence, source: 'model' })
  }
  for (const topic of enrichment.topics) {
    const normalized = normalizeTerm(topic)
    if (normalized === '') continue
    pushUnique(facets, { dimension: 'topic', value: `topic:${normalized}`, raw: topic, confidence, source: 'model' })
  }
  for (const role of enrichment.roles) {
    const value = roleFacetValue(role)
    pushUnique(facets, { dimension: 'role', value, raw: role, confidence, source: 'model' })
  }
  if (enrichment.time !== undefined) {
    pushUnique(facets, {
      dimension: 'time',
      value: `${enrichment.time.startMs}/${enrichment.time.endMs}`,
      startMs: enrichment.time.startMs,
      endMs: enrichment.time.endMs,
      granularity: enrichment.time.endMs - enrichment.time.startMs >= DAY_MS ? 'day' : 'hour',
      confidence,
      source: 'model',
    })
  }
  return facets
}

/** Conversion of a wall-clock day range, used by tests and the recall parser. */
export function civilDayRange(civil: CivilDate, timeZone: string): { start: number; end: number } {
  return dayRange(civil, timeZone)
}
