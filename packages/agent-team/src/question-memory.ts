/**
 * Semantic question memory: one bounded model call that places a Human
 * question against the Human's own past top-level messages. The module owns
 * only the shape — the prompt (one system turn + one user turn, no tools, no
 * session identity, exactly the digest seam), the strict parse of the reply,
 * and the heuristic that decides whether a body reads as a question at all.
 * The Host owns everything durable: the analysis lands as a
 * `team/question-analyzed` ledger operation, and every effect (the intent
 * ask on conflict, the importance raise to the Leader on a repeat) rides
 * ordinary Team Assistant Messages.
 * @module @grantyuan/dsh-crew/question-memory
 */

/** How long the analysis call may run before the Host gives up. */
export const QUESTION_ANALYSIS_TIMEOUT_MS = 60_000

/** Reply token budget for the analysis call. */
export const QUESTION_ANALYSIS_MAX_TOKENS = 512

/** How many past Human messages one comparison may carry. */
export const QUESTION_HISTORY_LIMIT = 30

/** The stable first line of the analysis prompt; the test mocks route on it. */
export const QUESTION_ANALYSIS_SYSTEM_PREFIX = 'You compare a user question against the user\'s own earlier questions.'

/** One earlier Human message offered to the comparison. */
export interface QuestionMemoryEntry {
  /** 0-based index the model refers back to; stable within one call. */
  readonly index: number
  readonly occurredAt: string
  readonly excerpt: string
}

/** The strict parse of one analysis reply. */
export interface QuestionAnalysisParsed {
  /** Indices of past entries that ask the same thing again. */
  readonly repeats: readonly number[]
  /** Indices of past entries the new question contradicts or reopens. */
  readonly conflicts: readonly number[]
  /** One bounded sentence on what the question is about, in the user's language. */
  readonly digest: string
}

/**
 * Whether one Human top-level body reads as a question and earns an
 * analysis: an explicit question mark anywhere (full- or half-width), or a
 * Chinese interrogative form that often ships without one. Deliberately
 * conservative — a bare English statement or instruction costs no model
 * call, and a missed borderline question only loses a reminder, never a
 * fact.
 */
export function looksLikeQuestion(body: string): boolean {
  const text = body.trim()
  if (/[?？]/.test(text)) return true
  return /(如何|怎么|为什么|为何|是否|能不能|可不可以|什么时候|几时|多少)/.test(text)
}

/**
 * The two-turn payload: one system turn with the comparison rules and the
 * JSON shape, one user turn numbering the past questions and the new one.
 * Numbered indices are the only handle the reply may reference, so a model
 * cannot invent message refs.
 */
export function buildQuestionAnalysisMessages(input: {
  readonly question: string
  readonly past: readonly QuestionMemoryEntry[]
}): { readonly system: string; readonly messages: readonly { readonly role: 'user'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }[] } {
  const pastList = input.past.length === 0
    ? '(no earlier questions)'
    : input.past.map(entry => `[${entry.index}] ${entry.occurredAt} — ${entry.excerpt}`).join('\n')
  const system = [
    QUESTION_ANALYSIS_SYSTEM_PREFIX,
    'Compare the NEW question with each numbered earlier question semantically.',
    'Return ONLY a JSON object with these keys:',
    '- "repeats": array of indices of earlier questions that ask the same thing again (a genuine repeat, not merely related);',
    '- "conflicts": array of indices of earlier questions or instructions the NEW question contradicts, reopens after a decision, or asks for the opposite of;',
    '- "digest": one sentence (max 160 chars, the user\'s language) on what the NEW question is about.',
    'An empty array means none. Never mention any index that was not listed. No prose outside the JSON.',
  ].join('\n')
  const messages = [{
    role: 'user' as const,
    content: [{ type: 'text' as const, text: `Earlier questions:\n${pastList}\n\nNEW question:\n${input.question.slice(0, 1200)}` }],
  }]
  return { system, messages }
}

function unfence(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text)
  return (fence?.[1] ?? text).trim()
}

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined
}

/** Indices the reply named, clamped to the offered range, deduplicated. */
function parseIndices(value: unknown, pastCount: number): readonly number[] {
  if (!Array.isArray(value)) return []
  return Object.freeze([...new Set(value
    .filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry < pastCount))]
    .sort((left, right) => left - right))
}

/** Strictly parse one analysis reply; throws on garbage rather than guessing. */
export function parseQuestionAnalysis(text: string, pastCount: number): QuestionAnalysisParsed {
  const start = unfence(text).indexOf('{')
  const end = unfence(text).lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('question analysis reply has no JSON object')
  let body: unknown
  try {
    body = JSON.parse(unfence(text).slice(start, end + 1))
  } catch (error) {
    throw new Error(`question analysis reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof body !== 'object' || body === null) throw new Error('question analysis reply is not an object')
  const record = body as Record<string, unknown>
  const digest = bounded(record.digest, 200)
  if (digest === undefined) throw new Error('question analysis reply has no digest')
  return Object.freeze({
    repeats: parseIndices(record.repeats, pastCount),
    conflicts: parseIndices(record.conflicts, pastCount),
    digest,
  })
}
