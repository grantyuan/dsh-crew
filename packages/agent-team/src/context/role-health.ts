/**
 * Per-endpoint circuit breaker for functional context roles.
 *
 * The key includes the role and the effective endpoint, so a broken dedicated
 * endpoint never poisons the assistant fallback (and vice versa). Authentication
 * failures are recorded for the UI but do not count toward the breaker: retrying
 * a wrong key cannot help, and the user must edit the config.
 * @module @grantyuan/dsh-crew/context/role-health
 */

import type { ContextRoleError } from './role-client.ts'
import type { ContextModelRole, ContextRoleRoute } from './role-models.ts'

export type ContextCircuitState = 'closed' | 'open' | 'half-open'

export interface ContextRoleHealthSnapshot {
  readonly state: ContextCircuitState
  readonly lastError?: { readonly kind: string; readonly message: string; readonly at: number }
}

interface HealthEntry {
  failures: number[]
  openedAt?: number
  probeInFlight?: boolean
  lastError?: { kind: string; message: string; at: number }
}

const FAILURE_WINDOW_MS = 60_000
const FAILURE_THRESHOLD = 5
const OPEN_DURATION_MS = 5 * 60_000

function keyOf(route: ContextRoleRoute): string {
  return [route.role, route.source, route.baseURL ?? route.provider ?? '', route.model].join('|')
}

export class ContextRoleHealth {
  private readonly entries = new Map<string, HealthEntry>()

  private entry(key: string): HealthEntry {
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    const created: HealthEntry = { failures: [] }
    this.entries.set(key, created)
    return created
  }

  /** Whether a call may start; half-open admits exactly one probe. */
  check(route: ContextRoleRoute): { readonly allowed: boolean; readonly state: ContextCircuitState } {
    const entry = this.entry(keyOf(route))
    if (entry.openedAt === undefined) return { allowed: true, state: 'closed' }
    if (Date.now() - entry.openedAt < OPEN_DURATION_MS) return { allowed: false, state: 'open' }
    if (entry.probeInFlight === true) return { allowed: false, state: 'half-open' }
    entry.probeInFlight = true
    return { allowed: true, state: 'half-open' }
  }

  success(route: ContextRoleRoute): void {
    const entry = this.entry(keyOf(route))
    entry.failures = []
    delete entry.openedAt
    entry.probeInFlight = false
  }

  failure(route: ContextRoleRoute, error: ContextRoleError): void {
    const entry = this.entry(keyOf(route))
    entry.lastError = { kind: error.kind, message: error.message, at: Date.now() }
    entry.probeInFlight = false
    if (error.kind === 'role-auth') return
    const now = Date.now()
    entry.failures = entry.failures.filter(at => now - at <= FAILURE_WINDOW_MS)
    entry.failures.push(now)
    if (entry.failures.length >= FAILURE_THRESHOLD) entry.openedAt = now
  }

  /** Worst state across all endpoints of one role, for the settings card. */
  snapshot(role: ContextModelRole): ContextRoleHealthSnapshot {
    let worst: ContextCircuitState = 'closed'
    let lastError: ContextRoleHealthSnapshot['lastError']
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${role}|`)) continue
      const state = entry.openedAt === undefined
        ? 'closed'
        : Date.now() - entry.openedAt < OPEN_DURATION_MS ? 'open' : 'half-open'
      if (state === 'open' || (state === 'half-open' && worst === 'closed')) worst = state
      if (entry.lastError !== undefined && (lastError === undefined || entry.lastError.at > lastError.at)) {
        lastError = entry.lastError
      }
    }
    return { state: worst, ...(lastError === undefined ? {} : { lastError }) }
  }
}
