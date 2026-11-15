/**
 * Original-source reads behind `context_recall`.
 *
 * A recall item or review segment cites a `cu:` unit ref or a `seg:` window.
 * Reading it returns the indexed message text, bounded, together with the
 * belief state the graph already holds. The read is derived-only: it never
 * touches the Session log, the Team ledger, or the graph.
 * @module @grantyuan/dsh-crew/context/read
 */

import type { ContextStore, StoredContextUnit } from './store.ts'
import type { ContextUnitStatus } from './types.ts'
import { contextNodeId } from './units.ts'

/** Default bound from the design; callers may raise it only within the cap. */
export const CONTEXT_READ = {
  defaultMaxChars: 4_000,
  minMaxChars: 200,
  maxMaxChars: 16_000,
} as const

export type ContextReadStatus = 'active' | 'superseded' | 'expired' | 'unverified'

export interface ParsedContextReadRef {
  readonly sessionId: string
  readonly fromSeq: number
  readonly toSeq: number
}

export interface ContextReadUnitView {
  readonly ref: string
  readonly status: ContextReadStatus
  readonly confidence: number
  readonly supersededBy?: string
  readonly validTo?: string
}

export interface ContextReadRequest {
  readonly ref: string
  readonly maxChars?: number
}

export type ContextReadResult =
  | {
    readonly ok: true
    readonly ref: string
    readonly sessionId: string
    readonly fromSeq: number
    readonly toSeq: number
    readonly text: string
    readonly truncated: boolean
    readonly totalChars: number
    readonly status: ContextReadStatus
    readonly confidence: number
    readonly supersededBy?: string
    readonly validTo?: string
    readonly units: readonly ContextReadUnitView[]
  }
  | { readonly ok: false; readonly reason: 'read-invalid-ref' | 'read-ref-not-indexed' | 'index-unavailable' | 'read-failed' }

/** Parse `cu:<sessionId>:<seq>` or `seg:<sessionId>:<from>-<to>`. */
export function parseContextReadRef(ref: string): ParsedContextReadRef | undefined {
  const unit = /^cu:(.+):(\d+)$/u.exec(ref)
  if (unit !== null) {
    const seq = Number(unit[2])
    return Number.isSafeInteger(seq) ? { sessionId: unit[1]!, fromSeq: seq, toSeq: seq } : undefined
  }
  const segment = /^seg:(.+):(\d+)-(\d+)$/u.exec(ref)
  if (segment === null) return undefined
  const fromSeq = Number(segment[2])
  const toSeq = Number(segment[3])
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq > toSeq) return undefined
  return { sessionId: segment[1]!, fromSeq, toSeq }
}

/**
 * Read the indexed original text for one ref and attach its belief state.
 * A ref the index does not hold is a stated reason, never an error.
 */
export function readContextSource(
  store: ContextStore,
  memberId: string,
  request: ContextReadRequest,
): ContextReadResult {
  const parsed = parseContextReadRef(request.ref)
  if (parsed === undefined) return { ok: false, reason: 'read-invalid-ref' }
  const units = store.listUnits(memberId, parsed.sessionId, { fromSeq: parsed.fromSeq, toSeq: parsed.toSeq })
  if (units.length === 0) return { ok: false, reason: 'read-ref-not-indexed' }

  const statuses = store.unitStatuses(memberId, units.map(unit => unit.unitId))
  const views = units.map(unit => readUnitView(store, unit, statuses.get(unit.unitId)))
  const full = units.map(unit => `[${unit.seq} ${unit.role}/${unit.kind}] ${unit.text}`).join('\n\n')
  const maxChars = clamp(request.maxChars ?? CONTEXT_READ.defaultMaxChars, CONTEXT_READ.minMaxChars, CONTEXT_READ.maxMaxChars)
  const truncated = full.length > maxChars
  const text = truncated ? `${full.slice(0, maxChars - 1)}…` : full
  const status = aggregateStatus(views)
  const confidence = views.reduce((lowest, view) => Math.min(lowest, view.confidence), 1)
  const replaced = views.find(view => view.supersededBy !== undefined)
  const ended = views.find(view => view.validTo !== undefined)
  return {
    ok: true,
    ref: request.ref,
    sessionId: parsed.sessionId,
    fromSeq: units[0]!.seq,
    toSeq: units[units.length - 1]!.seq,
    text,
    truncated,
    totalChars: full.length,
    status,
    confidence,
    ...(replaced?.supersededBy === undefined ? {} : { supersededBy: replaced.supersededBy }),
    ...(ended?.validTo === undefined ? {} : { validTo: ended.validTo }),
    units: views,
  }
}

function readUnitView(
  store: ContextStore,
  unit: StoredContextUnit,
  status: ContextUnitStatus | undefined,
): ContextReadUnitView {
  return {
    ref: unit.unitId,
    status: readStatus(status?.status),
    confidence: store.getNode(contextNodeId(unit.unitId))?.confidence ?? 1,
    ...(status?.supersededByRef === undefined ? {} : { supersededBy: status.supersededByRef }),
    ...(status?.validTo === undefined ? {} : { validTo: status.validTo }),
  }
}

function readStatus(status: string | undefined): ContextReadStatus {
  if (status === 'superseded') return 'superseded'
  if (status === 'retired') return 'expired'
  if (status === 'unverified') return 'unverified'
  return 'active'
}

/** The range keeps its strongest state: one live unit means the range is live. */
function aggregateStatus(views: readonly ContextReadUnitView[]): ContextReadStatus {
  if (views.some(view => view.status === 'active')) return 'active'
  if (views.some(view => view.status === 'unverified')) return 'unverified'
  if (views.some(view => view.status === 'superseded')) return 'superseded'
  return 'expired'
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}
