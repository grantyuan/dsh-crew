/**
 * Five-route recall over the derived context index.
 *
 * Recall is synchronous and model-free: exact terms, FTS lexical search, facet
 * filters, a precomputed query vector, and (from the graph ticket onward) two
 * outgoing edges. Route results are fused with reciprocal-rank fusion so a
 * unit that is strong on several independent signals outranks one that is
 * strong on a single route. Missing routes degrade rather than fail.
 * @module @grantyuan/dsh-crew/context/recall
 */

import { extractFacets, roleFacetValue, subjectFacetValue } from './facets.ts'
import { charLength, extractKeywords, extractTopicTerms } from './keywords.ts'
import type { ContextFacetQuery, ContextSearchHit, ContextStore } from './store.ts'
import type { ContextFacet, ContextNodeStatus } from './types.ts'
import { contextNodeId } from './units.ts'
import { VectorIndex } from './vector-index.ts'

export type ContextRecallMode = 'auto' | 'exact' | 'lexical' | 'facet' | 'vector' | 'graph'

export type ContextRecallStatus = 'active' | 'superseded' | 'expired' | 'unverified'

export interface ContextRecallTimeRange {
  readonly fromMs?: number
  readonly toMs?: number
}

export interface ContextRecallQuery {
  readonly memberId: string
  readonly sessionId: string
  readonly query: string
  readonly mode?: ContextRecallMode
  readonly limit?: number
  readonly includeSuperseded?: boolean
  /** Resolve relative time words against this instant; defaults to now. */
  readonly now?: number
  readonly timezone?: string
  readonly timeRange?: ContextRecallTimeRange
  readonly subjects?: readonly string[]
  readonly roles?: readonly string[]
  /** Precomputed query embedding; absent means the vector route is skipped. */
  readonly queryVector?: Float32Array
}

export interface ContextRecallItem {
  readonly ref: string
  readonly sessionId: string
  readonly recordedAt: string
  readonly kind: string
  readonly status: ContextRecallStatus
  readonly importance: number
  readonly score: number
  readonly snippet: string
  readonly sources: readonly string[]
  /** Unit ref that replaced this one; only present on superseded items. */
  readonly supersededBy?: string
  /** When this belief stopped holding; only present on superseded/retired items. */
  readonly validTo?: string
}

export interface ContextRecallResult {
  readonly items: readonly ContextRecallItem[]
  readonly degraded: readonly string[]
  readonly reason?: string
}

type RouteName = 'exact' | 'lexical' | 'facet' | 'vector' | 'graph'

const ROUTE_WEIGHTS: Readonly<Record<RouteName, number>> = {
  exact: 1,
  lexical: 0.8,
  facet: 0.7,
  vector: 0.8,
  graph: 0.6,
}

const ROUTE_LIMIT = 50
const RRF_K = 60

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5
  return Math.max(1, Math.min(8, Math.floor(value)))
}

function wantsRoute(mode: ContextRecallMode, route: RouteName): boolean {
  return mode === 'auto' || mode === route
}

function mergeHits(...groups: readonly ContextSearchHit[][]): ContextSearchHit[] {
  const scores = new Map<string, number>()
  for (const group of groups) {
    for (const hit of group) {
      scores.set(hit.unitId, Math.max(scores.get(hit.unitId) ?? 0, hit.score))
    }
  }
  return [...scores.entries()]
    .map(([unitId, score]) => ({ unitId, score }))
    .sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))
}

/** FTS query terms: quote each token so punctuation cannot become syntax. */
function quoteAll(values: readonly string[]): string {
  return values.map(value => `"${value.replaceAll('"', '""')}"`).join(' OR ')
}

function lexicalQueries(keywords: ReturnType<typeof extractKeywords>): { word: string[]; trigram: string[] } {
  const word = new Set<string>()
  const trigram = new Set<string>()
  for (const keyword of keywords) {
    for (const token of keyword.term.match(/[A-Za-z0-9_]{2,}/gu) ?? []) word.add(token)
    if (charLength(keyword.term) >= 3) trigram.add(keyword.term)
  }
  return { word: [...word], trigram: [...trigram] }
}

function toFacetQuery(facet: ContextFacet): ContextFacetQuery | undefined {
  if (facet.dimension === 'time') {
    if (facet.startMs === undefined || facet.endMs === undefined) return undefined
    return { dimension: 'time', startMs: facet.startMs, endMs: facet.endMs }
  }
  if (facet.value === 'unresolved') return undefined
  return { dimension: facet.dimension, value: facet.value }
}

function dedupeFacetQueries(filters: readonly ContextFacetQuery[]): ContextFacetQuery[] {
  const seen = new Set<string>()
  const unique: ContextFacetQuery[] = []
  for (const filter of filters) {
    const key = filter.dimension === 'time'
      ? `time:${filter.startMs}:${filter.endMs}`
      : `${filter.dimension}:${filter.value}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(filter)
  }
  return unique
}

function snippetOf(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed
}

/**
 * Run recall for one query. The caller owns timeouts and passes a query vector
 * only when a background embedding pass already produced one.
 */
export function recallContext(store: ContextStore, query: ContextRecallQuery): ContextRecallResult {
  const limit = clampLimit(query.limit)
  const mode = query.mode ?? 'auto'
  const degraded = new Set<string>()
  const routes: { name: RouteName; hits: ContextSearchHit[] }[] = []

  const text = query.query.trim()
  const keywords = extractKeywords(text)
  const exactTerms = keywords.filter(keyword => keyword.kind === 'exact').map(keyword => keyword.term)

  if (wantsRoute(mode, 'exact')) {
    if (exactTerms.length > 0) {
      routes.push({ name: 'exact', hits: store.searchExactTerms(query.memberId, exactTerms, ROUTE_LIMIT) })
    } else if (mode === 'exact') {
      degraded.add('exact-no-terms')
    }
  }

  if (wantsRoute(mode, 'lexical') && text !== '') {
    const terms = keywords.map(keyword => keyword.term)
    const { word, trigram } = lexicalQueries(keywords)
    let wordHits: ContextSearchHit[] = []
    let trigramHits: ContextSearchHit[] = []
    try {
      if (word.length > 0) {
        wordHits = store.searchLexicalFts(query.memberId, quoteAll(word), ROUTE_LIMIT, 'word')
        if (wordHits.length === 0 && store.capabilities.word === false) degraded.add('lexical-like')
      }
      if (trigram.length > 0) {
        trigramHits = store.searchLexicalFts(query.memberId, quoteAll(trigram), ROUTE_LIMIT, 'trigram')
      }
    } catch {
      wordHits = []
      trigramHits = []
    }
    let hits = mergeHits(wordHits, trigramHits)
    if (hits.length === 0) {
      hits = store.searchLexicalLike(query.memberId, terms.length > 0 ? terms : [text], ROUTE_LIMIT)
      if (hits.length > 0) degraded.add('lexical-like')
    }
    if (hits.length > 0) routes.push({ name: 'lexical', hits })
  } else if (mode === 'lexical' && text === '') {
    degraded.add('lexical-no-query')
  }

  if (wantsRoute(mode, 'facet')) {
    const topics = extractTopicTerms(keywords)
    const ruleFacets = extractFacets({
      text,
      recordedAt: new Date(query.now ?? Date.now()).toISOString(),
      ...(query.timezone === undefined ? {} : { timezone: query.timezone }),
      topics,
    })
    const filters: ContextFacetQuery[] = []
    if (query.timeRange !== undefined) {
      const startMs = query.timeRange.fromMs ?? 0
      const endMs = query.timeRange.toMs ?? Number.MAX_SAFE_INTEGER
      if (endMs > startMs) filters.push({ dimension: 'time', startMs, endMs })
    } else {
      for (const facet of ruleFacets) {
        if (facet.dimension !== 'time') continue
        const filter = toFacetQuery(facet)
        if (filter !== undefined) filters.push(filter)
      }
    }
    for (const facet of ruleFacets) {
      if (facet.dimension === 'time') continue
      const filter = toFacetQuery(facet)
      if (filter !== undefined) filters.push(filter)
    }
    for (const subject of query.subjects ?? []) {
      const value = subjectFacetValue(subject)
      if (value !== '') filters.push({ dimension: 'subject', value })
    }
    for (const role of query.roles ?? []) {
      filters.push({ dimension: 'role', value: roleFacetValue(role) })
    }
    const unique = dedupeFacetQueries(filters)
    if (unique.length > 0) {
      routes.push({ name: 'facet', hits: store.searchFacetFilters(query.memberId, unique, ROUTE_LIMIT) })
    } else if (mode === 'facet') {
      degraded.add('facet-no-filters')
    }
  }

  if (wantsRoute(mode, 'vector')) {
    if (query.queryVector !== undefined && query.queryVector.length > 0) {
      routes.push({ name: 'vector', hits: new VectorIndex(store).search(query.queryVector, { memberId: query.memberId, limit: ROUTE_LIMIT }) })
    } else if (mode === 'vector') {
      degraded.add('vector-pending')
    }
  }

  if (wantsRoute(mode, 'graph')) {
    // Graph seeds are the strongest units already found by the text routes; a
    // pure graph query falls back to a lexical seed so an explicit `mode:
    // 'graph'` still has somewhere to start.
    let seedHits = mergeHits(...routes.map(route => route.hits)).slice(0, 5)
    if (seedHits.length === 0 && text !== '') {
      seedHits = store.searchLexicalLike(query.memberId, [text], 5)
    }
    if (seedHits.length === 0) {
      if (mode === 'graph') degraded.add('graph-no-seeds')
    } else {
      const seeds = new Set(seedHits.map(hit => hit.unitId))
      const hits = store.graphNeighbors(
        query.memberId,
        seedHits.map(hit => contextNodeId(hit.unitId)),
        3,
        ROUTE_LIMIT,
      )
        .filter(hit => !seeds.has(hit.ref))
        .map(hit => ({ unitId: hit.ref, score: hit.weight / hit.depth }))
      if (hits.length > 0) routes.push({ name: 'graph', hits })
      else if (mode === 'graph') degraded.add('graph-no-results')
    }
  }

  const fused = new Map<string, { score: number; sources: Set<RouteName> }>()
  for (const route of routes) {
    route.hits.forEach((hit, index) => {
      const entry = fused.get(hit.unitId) ?? { score: 0, sources: new Set<RouteName>() }
      entry.score += ROUTE_WEIGHTS[route.name] / (RRF_K + index + 1)
      entry.sources.add(route.name)
      fused.set(hit.unitId, entry)
    })
  }

  const ranked = [...fused.entries()]
    .map(([unitId, entry]) => ({ unitId, ...entry }))
    .sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))

  // Belief state is applied after fusion: a stale version never outranks its
  // replacement, and the default result hides superseded/retired units entirely.
  const present = new Set(ranked.map(entry => entry.unitId))
  const statuses = store.unitStatuses(query.memberId, ranked.map(entry => entry.unitId))
  const shaped: ContextRecallItem[] = []
  for (const entry of ranked) {
    const unit = store.getUnit(entry.unitId)
    if (unit === undefined) continue
    const belief = statuses.get(entry.unitId)
    const status = belief?.status ?? 'current'
    if (status === 'superseded' || status === 'retired') {
      if (query.includeSuperseded !== true) continue
      // When the replacement is also a candidate, the old version adds no
      // information; keep only the newest member of the chain.
      if (belief?.supersededByRef !== undefined && present.has(belief.supersededByRef)) continue
    }
    shaped.push({
      ref: unit.unitId,
      sessionId: unit.sessionId,
      recordedAt: unit.recordedAt,
      kind: unit.kind,
      status: recallStatus(status),
      importance: unit.importance,
      score: Number((entry.score * statusFactor(status)).toFixed(6)),
      snippet: snippetOf(unit.text),
      sources: [...entry.sources].sort(),
      ...(belief?.supersededByRef === undefined ? {} : { supersededBy: belief.supersededByRef }),
      ...(belief?.validTo === undefined ? {} : { validTo: belief.validTo }),
    })
  }
  shaped.sort((left, right) => right.score - left.score || left.ref.localeCompare(right.ref))

  return { items: shaped.slice(0, limit), degraded: [...degraded].sort() }
}

function recallStatus(status: ContextNodeStatus): ContextRecallStatus {
  return status === 'current' ? 'active' : status === 'retired' ? 'expired' : status
}

/** Ranking weight per belief state; retired beliefs stay last but palpable when explicitly requested. */
function statusFactor(status: ContextNodeStatus): number {
  switch (status) {
    case 'current': return 1
    case 'unverified': return 0.7
    case 'superseded': return 0.25
    case 'retired': return 0.1
  }
}

/**
 * Stable degraded-reason vocabulary for callers and tests.
 */
export const CONTEXT_RECALL_DEGRADED = Object.freeze({
  graphNoSeeds: 'graph-no-seeds',
  graphNoResults: 'graph-no-results',
  lexicalLike: 'lexical-like',
  vectorPending: 'vector-pending',
  exactNoTerms: 'exact-no-terms',
  facetNoFilters: 'facet-no-filters',
})
