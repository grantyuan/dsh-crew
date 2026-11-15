/**
 * Zero-model L1 extraction: kind, importance, keywords and facets.
 *
 * This runs synchronously inside the unit write transaction and must stay
 * cheap. Everything it produces is deterministic and rebuildable; the
 * `extraction` role may later add missing facets asynchronously but cannot
 * overwrite anything produced here.
 * @module @grantyuan/dsh-crew/context/extract-rules
 */

import { extractFacets } from './facets.ts'
import { extractKeywords, extractTopicTerms } from './keywords.ts'
import type {
  ContextImportance,
  ContextUnitExtraction,
  ContextUnitKind,
  ContextUnitRole,
} from './types.ts'

/** NFKC, CRLF→LF, trim, and cap runs of blank lines for stable hashing. */
export function normalizeUnitText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

const DECISION_MARKERS = /决定|确定|采用|选定|选择|要求|必须|约定|承诺|结论|方案是|不得|禁止|决定用/u
const MEMORY_MARKERS = /记住|记一下|以后|下次|长期|偏好|习惯/u
const ERROR_MARKERS = /error|exception|failed|failure|traceback|stack trace|失败|报错|错误|超时/iu

function kindAndImportance(text: string, role: ContextUnitRole): { kind: ContextUnitKind; importance: ContextImportance } {
  const decision = DECISION_MARKERS.test(text)
  const memory = MEMORY_MARKERS.test(text)
  const error = ERROR_MARKERS.test(text)

  if (role === 'notice') return { kind: 'auxiliary', importance: 0 }
  if (role === 'tool') {
    return error ? { kind: 'fact', importance: 2 } : { kind: 'process', importance: 0 }
  }
  if (role === 'assistant') {
    return decision ? { kind: 'decision', importance: 2 } : { kind: 'process', importance: 1 }
  }
  if (decision) {
    return { kind: 'decision', importance: /必须|不得|禁止|承诺/u.test(text) ? 3 : 2 }
  }
  if (memory) return { kind: 'memory', importance: 2 }
  return { kind: 'unclassified', importance: text === '' ? 0 : 1 }
}

export interface ExtractContextRulesInput {
  readonly text: string
  readonly role: ContextUnitRole
  readonly recordedAt: string
  readonly timezone?: string
  readonly toolName?: string
}

/**
 * Run all synchronous rules for one unit.
 *
 * `toolName` is accepted for future kind heuristics but the deterministic
 * baseline deliberately stays on role and text markers only, so classification
 * is reproducible after a rebuild without any stored context.
 */
export function extractContextRules(input: ExtractContextRulesInput): ContextUnitExtraction {
  const text = normalizeUnitText(input.text)
  const keywords = extractKeywords(text)
  const topics = extractTopicTerms(keywords)
  const facets = extractFacets({
    text,
    recordedAt: input.recordedAt,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    topics,
  })
  const { kind, importance } = kindAndImportance(text, input.role)
  return { kind, importance, keywords, facets }
}
