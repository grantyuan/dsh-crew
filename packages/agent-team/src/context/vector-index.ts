/**
 * Brute-force vector route for the derived context index.
 *
 * P1 indexes hundreds of units per Member, so a linear cosine scan is both
 * faster to ship and easier to verify than a vector extension. The route is
 * optional: no query vector means the recall snapshot degrades to the
 * exact/lexical/facet routes without waiting for an embedding call.
 * @module @grantyuan/dsh-crew/context/vector-index
 */

import type { ContextStore, StoredContextUnit } from './store.ts'

export interface VectorSearchOptions {
  readonly memberId: string
  readonly limit: number
  /** Restrict to one embedding space when the configured model changed. */
  readonly model?: string
}

export interface VectorHit {
  readonly unitId: string
  readonly score: number
}

/** Cosine similarity; a zero-length or mismatched pair scores null. */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number | undefined {
  if (left.length === 0 || left.length !== right.length) return undefined
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/** Normalize any numeric vector to compact float32 storage form. */
export function toVector(values: readonly number[]): Float32Array {
  return Float32Array.from(values, value => (Number.isFinite(value) ? value : 0))
}

export class VectorIndex {
  private readonly store: ContextStore

  constructor(store: ContextStore) {
    this.store = store
  }

  /** Store one unit embedding; an empty vector is ignored. */
  upsert(unitId: string, model: string, values: Float32Array | readonly number[]): void {
    const vector = values instanceof Float32Array ? values : toVector(values)
    if (vector.length === 0) return
    this.store.upsertVector(unitId, model, vector)
  }

  /** Units that still need an embedding pass, oldest first. */
  pending(limit: number, memberId?: string): StoredContextUnit[] {
    return this.store.pendingVectorUnits(limit, memberId)
  }

  /** Rank stored vectors by cosine similarity to one query vector. */
  search(query: Float32Array, options: VectorSearchOptions): VectorHit[] {
    if (query.length === 0) return []
    const hits: VectorHit[] = []
    for (const candidate of this.store.listVectors(options.memberId, options.model)) {
      const score = cosineSimilarity(query, candidate.values)
      if (score === undefined || score <= 0) continue
      hits.push({ unitId: candidate.unitId, score })
    }
    return hits
      .sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))
      .slice(0, Math.max(1, options.limit))
  }
}
