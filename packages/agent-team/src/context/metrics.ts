/**
 * Small in-process metrics for functional context roles.
 *
 * The Team Host does not own a metrics backend; these counters exist so the
 * settings UI and failure reports can show call counts, p50/p95 latency and
 * queue depth without adding a dependency. They reset on Host restart, which
 * is acceptable for operational visibility.
 * @module @grantyuan/dsh-crew/context/metrics
 */

const LATENCY_WINDOW = 128

function metricKey(name: string, labels: Readonly<Record<string, string>>): string {
  const suffix = Object.keys(labels).sort().map(key => `${key}=${labels[key]}`).join(',')
  return suffix === '' ? name : `${name}{${suffix}}`
}

function percentile(samples: readonly number[], ratio: number): number | undefined {
  if (samples.length === 0) return undefined
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

export class ContextMetrics {
  private readonly counters = new Map<string, number>()
  private readonly latencies = new Map<string, number[]>()
  private readonly depths = new Map<string, number>()

  inc(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    const key = metricKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount)
  }

  observe(name: string, labels: Readonly<Record<string, string>>, value: number): void {
    const key = metricKey(name, labels)
    const samples = this.latencies.get(key) ?? []
    samples.push(value)
    if (samples.length > LATENCY_WINDOW) samples.splice(0, samples.length - LATENCY_WINDOW)
    this.latencies.set(key, samples)
  }

  setDepth(name: string, labels: Readonly<Record<string, string>>, depth: number): void {
    this.depths.set(metricKey(name, labels), depth)
  }

  count(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(metricKey(name, labels)) ?? 0
  }

  /** p50/p95 for one role/source pair. */
  latency(role: string, source: string): { p50?: number; p95?: number } {
    const prefix = metricKey('context_role_latency_ms', { role, source })
    return {
      ...(percentile(this.latencies.get(prefix) ?? [], 0.5) === undefined ? {} : { p50: percentile(this.latencies.get(prefix) ?? [], 0.5)! }),
      ...(percentile(this.latencies.get(prefix) ?? [], 0.95) === undefined ? {} : { p95: percentile(this.latencies.get(prefix) ?? [], 0.95)! }),
    }
  }

  depth(role: string): number {
    return this.depths.get(metricKey('context_role_queue_depth', { role })) ?? 0
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right)))
  }
}
