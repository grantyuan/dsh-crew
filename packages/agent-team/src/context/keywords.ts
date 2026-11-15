/**
 * Deterministic keyword extraction for context units.
 *
 * One keyword mechanism serves exact identifiers, phrases and lexical terms.
 * Exact keys (paths, commands, IDs, error codes, versions, quoted phrases)
 * keep their original casing and punctuation because retrieval compares them
 * verbatim. Lexical terms are NFKC-normalized, lowercased and stripped so two
 * spellings of the same word collapse to one row.
 *
 * No model is involved here; this module must stay well under 5 ms per unit.
 * @module @grantyuan/dsh-crew/context/keywords
 */

import type { ContextKeyword } from './types.ts'

/** Upper bound from the design: exact keys plus 3–8 lexical terms. */
export const MAX_UNIT_KEYWORDS = 12

const MAX_EXACT_KEYWORDS = 8
const MAX_PHRASE_KEYWORDS = 2
const MAX_LEXICAL_KEYWORDS = 8

const HAN = /[\p{Script=Han}]/u
const WORD_LIKE = /[\p{L}\p{N}]/u

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'she', 'should', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would',
  'you', 'your',
  '的', '了', '和', '是', '在', '也', '就', '都', '而', '及', '与', '或', '一个', '我们', '你们', '他们', '这个',
  '那个', '可以', '需要', '已经', '因为', '所以', '但是', '如果', '然后', '现在', '还是', '不是', '没有', '什么',
  '怎么', '以及', '并且', '其中', '对于', '通过', '进行', '使用', '可能', '应该', '这', '那', '有', '会', '要',
  '我', '你', '他', '她', '它', '被', '把', '让', '给', '对', '从', '到', '为', '以', '于', '中', '上', '下',
])

/** Terms that look like error codes but are ordinary English words. */
const EXACT_NOISE = new Set(['error', 'errors', 'exception', 'warning', 'failed'])

let segmenter: Intl.Segmenter | undefined

function wordSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' })
  return segmenter
}

/**
 * Normalize a lexical term: NFKC, lowercase, remove edge punctuation, collapse
 * whitespace. Identifier characters (`- _ . / @ # : + ~`) survive so package
 * names and paths do not get shredded into unrelated words.
 */
export function normalizeTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_./@#:+~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Character count by code point, not UTF-16 unit. */
export function charLength(value: string): number {
  return Array.from(value).length
}

/** CJK 2-grams for fuzzy lookup; exact terms are indexed separately. */
export function cjkBigrams(term: string): string[] {
  const grams: string[] = []
  for (const run of term.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run)
    for (let index = 0; index + 1 < chars.length; index += 1) {
      grams.push(`${chars[index]}${chars[index + 1]}`)
    }
  }
  return [...new Set(grams)]
}

function isCandidateTerm(term: string): boolean {
  if (term === '' || STOP_WORDS.has(term)) return false
  if (!WORD_LIKE.test(term)) return false
  if (/^\d+$/u.test(term)) return false
  const length = charLength(term)
  return HAN.test(term) ? length >= 2 : length >= 3
}

interface ExactPattern {
  readonly pattern: RegExp
  readonly weight: number
  /** Capture group holding the identifier, defaulting to the whole match. */
  readonly group?: number
  /** Trim characters that belong to surrounding prose, not the identifier. */
  readonly trim?: RegExp
}

const EXACT_PATTERNS: readonly ExactPattern[] = [
  { pattern: /https?:\/\/[^\s<>()"'`，。；！？、（）【】《》]+/gu, weight: 1, trim: /[),.;!?，。；！？、）】》]+$/u },
  { pattern: /`([^`\n]{1,160})`/gu, weight: 0.9, group: 1 },
  { pattern: /(?<![\w:./-])\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+/gu, weight: 0.95 },
  { pattern: /(?<![\w:./-])(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]*\.[A-Za-z0-9]{1,8}\b/gu, weight: 0.95 },
  { pattern: /\b[A-Za-z]:\\[^\s"'`<>|]+/gu, weight: 0.95 },
  { pattern: /(?:^|[\s(（])(#\d{1,6}|GH-\d+)\b/gu, weight: 0.95, group: 1 },
  { pattern: /\b(?:commit|sha|revision|rev)[\s:]+([0-9a-f]{7,40})\b/giu, weight: 0.95, group: 1 },
  { pattern: /\b(?:E[A-Z]{2,}\d{0,4}|[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|[A-Z]{2,}-\d{2,}|(?:TS|HTTP)[ _-]?\d{2,4})\b/gu, weight: 0.9 },
  { pattern: /\b((?:npm|pnpm|npx|yarn|git|node|python3?|pip3?|pytest|vitest|docker|kubectl|curl|make|go|cargo|java|mvn|gradle)\s+(?:--?[\w-]+|[a-z0-9@._:/-]+)(?:\s+(?:--?[\w-]+|[a-z0-9@._:/-]+)){0,5})/giu, weight: 0.9, group: 1, trim: /[.,;:!?，。；！？]+$/u },
  { pattern: /\b(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+[\w.+-]*/gu, weight: 0.9 },
  { pattern: /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gu, weight: 0.9 },
  { pattern: /(?<![\w@.])v?\d+\.\d+\.\d+(?:[-+][\w.]+)?(?![\w.])/gu, weight: 0.85 },
  { pattern: /(?<![\w@.])v\d+\.\d+(?![\w.])/gu, weight: 0.8 },
]

const PHRASE_PATTERNS: readonly RegExp[] = [
  /"([^"\n]{2,40})"/gu,
  /“([^”\n]{2,40})”/gu,
  /「([^」\n]{2,40})」/gu,
  /『([^』\n]{2,40})』/gu,
]

/**
 * Extract exact identifiers. Order is stable and the same identifier found by
 * two patterns is kept once, at the first (higher-weight) occurrence.
 */
export function extractExactKeys(text: string): ContextKeyword[] {
  const seen = new Set<string>()
  const keywords: ContextKeyword[] = []
  for (const spec of EXACT_PATTERNS) {
    spec.pattern.lastIndex = 0
    for (const match of text.matchAll(spec.pattern)) {
      const raw = (spec.group === undefined ? match[0] : match[spec.group]) ?? ''
      const term = (spec.trim === undefined ? raw : raw.replace(spec.trim, '')).trim()
      if (term === '') continue
      const key = term.toLowerCase()
      if (seen.has(key) || EXACT_NOISE.has(key)) continue
      seen.add(key)
      keywords.push({ term, kind: 'exact', weight: spec.weight, source: 'deterministic' })
      if (keywords.length >= MAX_EXACT_KEYWORDS) return keywords
    }
  }
  return keywords
}

/** Extract short quoted phrases; these are the design's `phrase` keywords. */
export function extractPhraseKeywords(text: string): ContextKeyword[] {
  const seen = new Set<string>()
  const keywords: ContextKeyword[] = []
  for (const pattern of PHRASE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const term = (match[1] ?? '').trim()
      const key = term.toLowerCase()
      if (term === '' || seen.has(key)) continue
      seen.add(key)
      keywords.push({ term, kind: 'phrase', weight: 0.85, source: 'deterministic' })
      if (keywords.length >= MAX_PHRASE_KEYWORDS) return keywords
    }
  }
  return keywords
}

/** Extract normalized lexical terms, frequency-weighted and stop-word filtered. */
export function extractLexicalKeywords(text: string): ContextKeyword[] {
  const counts = new Map<string, number>()
  for (const segment of wordSegmenter().segment(text)) {
    if (!segment.isWordLike) continue
    const term = normalizeTerm(segment.segment)
    if (!isCandidateTerm(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([term, count]): ContextKeyword => ({
      term,
      kind: 'term',
      weight: Math.min(0.85, 0.45 + 0.1 * (count - 1)),
      source: 'deterministic',
    }))
    .sort((left, right) => right.weight - left.weight || charLength(right.term) - charLength(left.term))
    .slice(0, MAX_LEXICAL_KEYWORDS)
}

/**
 * Merge exact keys, quoted phrases and lexical terms into one bounded set.
 * Deduplication is case-insensitive but the retained spelling is exact's.
 */
export function extractKeywords(text: string): ContextKeyword[] {
  const seen = new Set<string>()
  const merged: ContextKeyword[] = []
  const add = (keyword: ContextKeyword): void => {
    const key = keyword.term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    merged.push(keyword)
  }
  for (const keyword of extractExactKeys(text)) add(keyword)
  for (const keyword of extractPhraseKeywords(text)) add(keyword)
  for (const keyword of extractLexicalKeywords(text)) add(keyword)
  return merged.slice(0, MAX_UNIT_KEYWORDS)
}

/** Topic candidates: lexical terms only, so identifiers are not repeated. */
export function extractTopicTerms(keywords: readonly ContextKeyword[], limit = 3): string[] {
  const terms: string[] = []
  for (const keyword of keywords) {
    if (keyword.kind !== 'term') continue
    if (terms.includes(keyword.term)) continue
    terms.push(keyword.term)
    if (terms.length >= limit) break
  }
  return terms
}
