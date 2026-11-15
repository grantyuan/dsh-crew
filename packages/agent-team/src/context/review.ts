import type { ContextStore, StoredContextUnit } from './store.ts'
import type {
  ContextReviewCluster,
  ContextReviewDecision,
  ContextReviewEdge,
  ContextReviewRequest,
  ContextReviewResult,
} from './types.ts'
import { contextNodeId } from './units.ts'

export interface ContextReviewSeed {
  readonly ref: string
}

/**
 * Build a read-only "what was decided and what changed" view from the graph.
 * Generation (L3) summaries are not produced yet, so that field stays empty.
 */
export function reviewContext(
  store: ContextStore,
  memberId: string,
  request: ContextReviewRequest,
  seeds: readonly ContextReviewSeed[],
): ContextReviewResult {
  const includeSuperseded = request.includeSuperseded ?? true
  const topic = request.topic?.trim()
  const around = request.around?.trim()
  const degraded: string[] = []
  if (topic === undefined && around === undefined) degraded.push('review-needs-topic-or-around')

  const seedRefs = new Set<string>()
  if (around !== undefined && around.startsWith('cu:')) seedRefs.add(around)
  if (around === undefined) for (const seed of seeds) if (seed.ref.startsWith('cu:')) seedRefs.add(seed.ref)

  const nodeIds = [...seedRefs].map(contextNodeId)
  const neighbors = nodeIds.length === 0
    ? []
    : store.graphNeighbors(memberId, nodeIds, request.depth ?? 2, 24)
  for (const neighbor of neighbors) seedRefs.add(neighbor.ref)

  const units = [...seedRefs]
    .map(ref => store.getUnit(ref))
    .filter((unit): unit is StoredContextUnit => unit !== undefined)
  const statuses = store.unitStatuses(memberId, units.map(unit => unit.unitId))

  const clusters = new Map<string, StoredContextUnit[]>()
  for (const unit of units) {
    if (topic !== undefined && !unit.text.toLowerCase().includes(topic.toLowerCase())
      && !store.listFacets(unit.unitId).some(facet => facet.dimension === 'topic' && facet.value.toLowerCase().includes(topic.toLowerCase()))) {
      continue
    }
    const topics = store.listFacets(unit.unitId)
      .filter(facet => facet.dimension === 'topic')
      .map(facet => facet.value)
    const label = topic ?? topics[0] ?? 'overview'
    const bucket = clusters.get(label) ?? []
    bucket.push(unit)
    clusters.set(label, bucket)
  }
  if (clusters.size === 0 && units.length > 0) {
    clusters.set(topic ?? around ?? 'overview', units)
  }

  const decisions: ContextReviewDecision[] = []
  const rendered: ContextReviewCluster[] = []
  for (const [label, members] of [...clusters].sort(([left], [right]) => left.localeCompare(right))) {
    const clusterDecisions: ContextReviewDecision[] = []
    const openQuestions: string[] = []
    const segments = new Set<string>()
    for (const unit of members) {
      const status = statuses.get(unit.unitId)
      if (!includeSuperseded && status?.status === 'superseded') continue
      const segment = store.segmentForSeq(memberId, unit.sessionId, unit.seq)
      if (segment !== undefined) segments.add(segment.segmentId)
      if (unit.kind === 'decision') {
        clusterDecisions.push({
          ref: unit.unitId,
          text: excerpt(unit.text),
          status: reviewStatus(status?.status),
          validFrom: unit.recordedAt,
          ...(status?.validTo === undefined ? {} : { validTo: status.validTo }),
          ...(status?.supersededByRef === undefined ? {} : { supersededBy: status.supersededByRef }),
        })
      }
      if (/[?？]|待定|\bTODO\b|open question/i.test(unit.text)) openQuestions.push(excerpt(unit.text))
    }
    clusterDecisions.sort((left, right) => left.validFrom.localeCompare(right.validFrom))
    decisions.push(...clusterDecisions)
    rendered.push({
      topic: label,
      decisions: clusterDecisions,
      openQuestions,
      segments: [...segments].sort(),
      generations: [],
    })
  }

  const edges = renderEdges(store, memberId, units)
  const superseded = decisions.filter(decision => decision.status === 'superseded').length
  const narrative = units.length === 0
    ? 'No indexed context matched this review.'
    : `Reviewed ${units.length} unit(s) across ${rendered.length} topic cluster(s): `
      + `${decisions.length} decision(s), ${superseded} superseded, `
      + `${rendered.reduce((sum, cluster) => sum + cluster.openQuestions.length, 0)} open question(s), ${edges.length} edge(s).`
  return { clusters: rendered, edges, narrative, includeSuperseded, degraded }
}

function excerpt(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`
}

function reviewStatus(status: string | undefined): ContextReviewDecision['status'] {
  if (status === 'superseded') return 'superseded'
  if (status === 'retired') return 'expired'
  if (status === 'unverified') return 'unverified'
  return 'active'
}

function renderEdges(store: ContextStore, memberId: string, units: readonly StoredContextUnit[]): ContextReviewEdge[] {
  const refs = new Map(units.map(unit => [contextNodeId(unit.unitId), unit.unitId]))
  const edges = store.edgesAmong(memberId, [...refs.keys()])
  return edges
    .map(edge => ({
      from: refs.get(edge.srcId) ?? edge.srcId,
      to: refs.get(edge.dstId) ?? edge.dstId,
      kind: edge.kind,
      validFrom: edge.validFrom,
      ...(edge.validTo === undefined ? {} : { validTo: edge.validTo }),
    }))
    .sort((left, right) => `${left.from}${left.to}${left.kind}`.localeCompare(`${right.from}${right.to}${right.kind}`))
}
