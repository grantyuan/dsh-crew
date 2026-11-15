#!/usr/bin/env node
/**
 * Synthetic acceptance run for the derived context index.
 *
 * The numbers are not a product benchmark: they exercise this repository's
 * synchronous intake, the L2 commit transaction, and the recall fusion path on
 * one machine so a regression is visible. Spec §14.2 owns the thresholds; this
 * script never changes them.
 *
 *   npm run test:perf -- --scale=100 --members=8 --concurrency=2 --queries=200
 *   npm run test:perf -- --scale=100 --json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { commitPreparedEpoch, digestHash } from '../packages/agent-team/src/context/compaction.ts'
import { ContextCoordinator } from '../packages/agent-team/src/context/coordinator.ts'
import { rollupGeneration } from '../packages/agent-team/src/context/generation.ts'
import { ContextService } from '../packages/agent-team/src/context/service.ts'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..')
const ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, 'artifacts', 'perf')
const SCALES = [100, 500, 1000]
const WINDOW_UNITS = 10
const INDEX_BATCH_UNITS = 50

const THRESHOLDS = {
  100: {
    increment: { p50: 40, p95: 120 },
    commit: { p50: 25, p95: 80, max: 200 },
    hot: { p50: 8, p95: 25 },
    cold: { p50: 40, p95: 120 },
    write: { unitsPerSecond: 600 },
    cpu: { average: 0.4, burst: 2 },
    rss: { deltaMb: 256 },
    error: { rate: 0.005 },
    timeout: { recall: 0.001, commit: 0.0005 },
    concurrency: { ratio: 1.5 },
    disk: { mb: 300 },
  },
  500: {
    increment: { p50: 50, p95: 150 },
    commit: { p50: 30, p95: 100, max: 250 },
    hot: { p50: 10, p95: 30 },
    cold: { p50: 60, p95: 180 },
    write: { unitsPerSecond: 400 },
    cpu: { average: 0.5, burst: 2 },
    rss: { deltaMb: 512 },
    error: { rate: 0.005 },
    timeout: { recall: 0.001, commit: 0.0005 },
    concurrency: { ratio: 1.5 },
    disk: { mb: 800 },
  },
  1000: {
    increment: { p50: 60, p95: 180 },
    commit: { p50: 35, p95: 120, max: 300 },
    hot: { p50: 12, p95: 40 },
    cold: { p50: 80, p95: 250 },
    write: { unitsPerSecond: 300 },
    cpu: { average: 0.6, burst: 2 },
    rss: { deltaMb: 768 },
    error: { rate: 0.01 },
    timeout: { recall: 0.001, commit: 0.0005 },
    concurrency: { ratio: 1.5 },
    disk: { mb: 1500 },
  },
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  printHelp()
  process.exit(0)
}
if (args.coldChild === true) {
  runColdChild(args)
} else {
  await runMain(args)
}

function parseArgs(argv) {
  const parsed = {
    scale: 100,
    members: 8,
    concurrency: 2,
    queries: 200,
    json: false,
    coldChild: false,
    db: undefined,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [name, inline] = token.split('=', 2)
    const value = inline === undefined ? argv[index + 1] : inline
    const consume = inline === undefined && value !== undefined && !value.startsWith('--')
    if (consume) index += 1
    if (name === '--scale') parsed.scale = Number(value)
    else if (name === '--members') parsed.members = Number(value)
    else if (name === '--concurrency') parsed.concurrency = Number(value)
    else if (name === '--queries') parsed.queries = Number(value)
    else if (name === '--db') parsed.db = value
    else if (name === '--json') parsed.json = true
    else if (name === '--cold-child') parsed.coldChild = true
    else if (name === '--help') parsed.help = true
  }
  return parsed
}

function printHelp() {
  process.stdout.write([
    'Usage: npm run test:perf -- [options]',
    '',
    '  --scale=100|500|1000  synthetic rounds (default 100)',
    '  --members=8           Member lanes (default 8)',
    '  --concurrency=2       turns per Member lane (default 2)',
    '  --queries=200         hot recall samples (default 200)',
    '  --json                print the JSON report instead of the table',
    '',
    'Writes artifacts/perf/<scale>.json. Cold recall runs in a separate process.',
    '',
  ].join('\n'))
}

async function runMain(options) {
  const scale = SCALES.includes(options.scale) ? options.scale : 100
  const members = Math.max(1, Math.trunc(options.members))
  const concurrency = Math.max(1, Math.trunc(options.concurrency))
  const queries = Math.max(20, Math.trunc(options.queries))
  const thresholds = THRESHOLDS[scale]
  const databasePath = join(ARTIFACT_DIRECTORY, `.context-perf-${scale}-${process.pid}.sqlite`)
  mkdirSync(ARTIFACT_DIRECTORY, { recursive: true })
  removeDatabase(databasePath)

  const baseline = process.memoryUsage()
  const rssSamples = [baseline.rss]
  const service = new ContextService({
    path: databasePath,
    onError: (error, stage) => {
      process.stderr.write(`context-perf: ${stage}: ${error instanceof Error ? error.message : String(error)}\n`)
    },
  })
  const store = service.contextStore()
  if (store === undefined) throw new Error('context index unavailable')
  const coordinator = new ContextCoordinator({ store, enrichmentEnabled: () => false })

  const ingest = ingestRounds(coordinator, scale, members, rssSamples)
  const commits = await measureCommits(store, members)
  const recall = measureRecall(service, members, queries)
  const concurrencyResult = await measureConcurrentRecall(service, members, concurrency, queries, recall.hot)
  const write = measureIndexWrites(coordinator)
  for (let member = 0; member < members; member += 1) {
    rollupGeneration(store, memberId(member), sessionId(member))
  }
  const rssAfter = process.memoryUsage()
  rssSamples.push(rssAfter.rss)
  service.close()

  const cold = runColdChildProcess(databasePath, options)
  const indexAssertions = checkIndexPlans(databasePath)
  const disk = readDiskUsage(databasePath)
  removeDatabase(databasePath)

  const metrics = {
    increment: { ...percentiles(ingest.samples), max: round(maxOf(ingest.samples)), count: ingest.samples.length },
    commit: { ...percentiles(commits.samples), max: round(maxOf(commits.samples)), count: commits.samples.length },
    recallHot: { ...percentiles(recall.hot), count: recall.hot.length, warmups: recall.warmups },
    recallCold: cold.metrics,
    indexWrite: write,
    cpu: {
      averageCores: round(ingest.cpuCores),
      burstCores: round(ingest.burstCores),
      totalCpuSeconds: round(ingest.totalCpuSeconds),
      elapsedMs: round(ingest.elapsedMs),
    },
    rss: {
      baselineBytes: baseline.rss,
      afterBytes: rssAfter.rss,
      deltaBytes: rssAfter.rss - baseline.rss,
      peakBytes: Math.max(...rssSamples),
    },
    recallErrors: { failures: recall.failures, total: recall.hot.length + recall.warmups, rate: ratio(recall.failures, recall.hot.length + recall.warmups) },
    timeout: {
      recallTimeouts: recall.timeouts,
      recallRate: ratio(recall.timeouts, recall.hot.length),
      commitTimeouts: commits.timeouts,
      commitRate: ratio(commits.timeouts, commits.samples.length),
    },
    concurrency: concurrencyResult,
    diskMb: round(disk.totalBytes / (1024 * 1024)),
  }

  const checks = buildChecks(metrics, thresholds)
  const passed = checks.every(check => check.pass) && indexAssertions.every(assertion => assertion.pass)
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    node: process.version,
    platform: `${platform()} ${arch()}`,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    scale,
    members,
    concurrency,
    queries,
    thresholds,
    metrics,
    checks,
    indexAssertions,
    disk,
    notes: [
      'Cold recall runs in a separate Node process with no in-process warm index; the OS page cache is not cleared.',
      'Commit latency times commitPreparedEpoch with a no-op surface replacement callback; it excludes any model call.',
      'Index-write throughput uses 50 sequential unit writes; the store has no cross-unit batch transaction API.',
      'Concurrency is simulated with async lanes over one event loop, not separate processes or worker threads.',
      'Vector indexing lag is not measured because this run does not configure an embedding role.',
    ],
    passed,
  }
  const outputPath = join(ARTIFACT_DIRECTORY, `${scale}.json`)
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printReport(report, outputPath)
  if (!passed) process.exitCode = 1
}

function ingestRounds(coordinator, rounds, members, rssSamples) {
  const sequence = Array.from({ length: members }, () => 0)
  const samples = []
  const cpuBuckets = []
  const bucketSize = Math.max(10, Math.ceil(rounds / 20))
  const started = performance.now()
  const cpuStarted = process.cpuUsage()
  let bucketStart = started
  let bucketCpu = process.cpuUsage()
  for (let round = 0; round < rounds; round += 1) {
    const member = round % members
    sequence[member] += 1
    const text = syntheticMessage(round)
    const cpuBefore = process.cpuUsage()
    const startedAt = performance.now()
    coordinator.record({
      memberId: memberId(member),
      sessionId: sessionId(member),
      seq: sequence[member],
      role: 'user',
      text,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + round * 1000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    const elapsed = performance.now() - startedAt
    const cpuDelta = process.cpuUsage(cpuBefore)
    samples.push(elapsed)
    void cpuDelta
    if ((round + 1) % 25 === 0) rssSamples.push(process.memoryUsage().rss)
    if ((round + 1) % bucketSize === 0) {
      const bucketElapsed = performance.now() - bucketStart
      const delta = process.cpuUsage(bucketCpu)
      cpuBuckets.push(((delta.user + delta.system) / 1000) / bucketElapsed)
      bucketStart = performance.now()
      bucketCpu = process.cpuUsage()
    }
  }
  const elapsedMs = performance.now() - started
  const totalCpu = process.cpuUsage(cpuStarted)
  return {
    samples,
    elapsedMs,
    totalCpuSeconds: (totalCpu.user + totalCpu.system) / 1_000_000,
    cpuCores: ((totalCpu.user + totalCpu.system) / 1000) / elapsedMs,
    burstCores: maxOf(cpuBuckets),
  }
}

async function measureCommits(store, members) {
  const samples = []
  let timeouts = 0
  for (let member = 0; member < members; member += 1) {
    const id = memberId(member)
    const session = sessionId(member)
    const units = store.listUnits(id, session)
    let frontier = store.getEpoch(id, session).frontierSeq
    while (frontier < units.length) {
      const fromSeq = frontier + 1
      const toSeq = Math.min(units.length, frontier + WINDOW_UNITS)
      const window = units.filter(unit => unit.seq >= fromSeq && unit.seq <= toSeq)
      const digest = {
        summary: `Window ${fromSeq}-${toSeq}: ${window.length} units.`,
        decisions: window.filter(unit => unit.kind === 'decision').map(unit => unit.text),
        commitments: [],
        openLoops: [],
      }
      store.savePendingEpoch({
        memberId: id,
        sessionId: session,
        digest,
        commitments: [],
        hash: digestHash(digest),
        fromSeq,
        toSeq,
        now: new Date(Date.UTC(2026, 0, 2, 0, 0, 0) + frontier * 1000),
      })
      const startedAt = performance.now()
      const result = await commitPreparedEpoch(store, {
        memberId: id,
        sessionId: session,
        compactor: { compactPrepared: async () => {} },
      })
      const elapsed = performance.now() - startedAt
      if (!result.ok) throw new Error(`commit failed: ${result.reason}`)
      if (elapsed > 5_000) timeouts += 1
      samples.push(elapsed)
      frontier = toSeq
    }
  }
  return { samples, timeouts }
}

function measureRecall(service, members, queries) {
  const fixed = queryList(queries)
  let failures = 0
  let timeouts = 0
  for (let index = 0; index < 50; index += 1) {
    const query = fixed[index % fixed.length]
    const member = index % members
    try {
      service.recall({ memberId: memberId(member), sessionId: sessionId(member), query, limit: 5 })
    } catch {
      failures += 1
    }
  }
  const samples = []
  for (let index = 0; index < queries; index += 1) {
    const member = index % members
    const startedAt = performance.now()
    try {
      const result = service.recall({ memberId: memberId(member), sessionId: sessionId(member), query: fixed[index % fixed.length], limit: 5 })
      if (result.reason === 'recall-failed' || result.reason === 'index-unavailable') failures += 1
    } catch {
      failures += 1
    }
    const elapsed = performance.now() - startedAt
    if (elapsed > 2_000) timeouts += 1
    samples.push(elapsed)
  }
  return { hot: samples, warmups: 50, failures, timeouts }
}

async function measureConcurrentRecall(service, members, concurrency, queries, hotSamples) {
  const fixed = queryList(queries)
  let next = 0
  const samples = []
  const lanes = members * concurrency
  const work = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= queries) return
      const member = index % members
      await Promise.resolve()
      const startedAt = performance.now()
      service.recall({ memberId: memberId(member), sessionId: sessionId(member), query: fixed[index % fixed.length], limit: 5 })
      samples.push(performance.now() - startedAt)
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => work()))
  const concurrentP95 = percentiles(samples).p95
  return {
    lanes,
    samples: samples.length,
    p50: round(percentiles(samples).p50),
    p95: round(concurrentP95),
    ratio: round(concurrentP95 / Math.max(0.001, percentiles(hotSamples).p95)),
  }
}

function measureIndexWrites(coordinator) {
  const batches = 2
  const samples = []
  const startedAt = performance.now()
  for (let batch = 0; batch < batches; batch += 1) {
    for (let index = 0; index < INDEX_BATCH_UNITS; index += 1) {
      const seq = batch * INDEX_BATCH_UNITS + index + 1
      coordinator.record({
        memberId: 'perf-write',
        sessionId: 'perf-write-session',
        seq,
        role: 'user',
        text: syntheticMessage(seq + 10_000),
        recordedAt: new Date(Date.UTC(2026, 0, 3, 0, 0, 0) + seq * 1000).toISOString(),
        timezone: 'Asia/Shanghai',
      })
    }
    samples.push(performance.now() - startedAt)
  }
  const totalMs = performance.now() - startedAt
  const units = batches * INDEX_BATCH_UNITS
  return {
    batchSize: INDEX_BATCH_UNITS,
    batches,
    units,
    elapsedMs: round(totalMs),
    unitsPerSecond: round(units / (totalMs / 1000)),
    samples: samples.map(round),
  }
}

function runColdChildProcess(databasePath, options) {
  const output = execFileSync(process.execPath, [
    '--import', 'tsx',
    SCRIPT_PATH,
    '--cold-child',
    `--db=${databasePath}`,
    `--scale=${options.scale}`,
    `--members=${options.members}`,
    '--queries=20',
    '--json',
  ], { cwd: REPOSITORY_ROOT, encoding: 'utf8', env: process.env })
  return JSON.parse(output)
}

function runColdChild(options) {
  const databasePath = options.db
  if (databasePath === undefined || !existsSync(databasePath)) throw new Error('cold child needs --db')
  const service = new ContextService({ path: databasePath })
  const queries = queryList(Math.max(20, Math.trunc(options.queries)))
  const samples = []
  let failures = 0
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now()
    try {
      const result = service.recall({ memberId: memberId(index % options.members), sessionId: sessionId(index % options.members), query: queries[index % queries.length], limit: 5 })
      if (result.reason === 'recall-failed' || result.reason === 'index-unavailable') failures += 1
    } catch {
      failures += 1
    }
    samples.push(performance.now() - startedAt)
  }
  service.close()
  process.stdout.write(`${JSON.stringify({
    metrics: { ...percentiles(samples), count: samples.length },
    failures,
    samples: samples.map(round),
  })}\n`)
}

function checkIndexPlans(databasePath) {
  if (!existsSync(databasePath)) return []
  const database = new DatabaseSync(databasePath)
  const cases = [
    {
      name: 'facet',
      sql: 'EXPLAIN QUERY PLAN SELECT owner_id FROM facet WHERE dimension = ? AND value = ?',
      params: ['workspace', 'ws-0'],
      expected: 'facet_value',
    },
    {
      name: 'time',
      sql: 'EXPLAIN QUERY PLAN SELECT unit_id FROM unit WHERE member_id = ? AND recorded_at >= ? AND recorded_at <= ?',
      params: ['m0', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'],
      expected: 'unit_member_time',
    },
    {
      name: 'term',
      sql: 'EXPLAIN QUERY PLAN SELECT owner_id FROM term WHERE term = ? AND term_kind = ?',
      params: ['alpha', 'word'],
      expected: 'term_lookup',
    },
    {
      name: 'segment',
      sql: 'EXPLAIN QUERY PLAN SELECT segment_id FROM context_segment WHERE member_id = ? AND session_id = ? AND from_seq <= ? AND to_seq >= ?',
      params: ['m0', 's0', 10, 1],
      expected: 'context_segment_frontier',
    },
    {
      name: 'memory-node',
      sql: 'EXPLAIN QUERY PLAN SELECT node_id FROM memory_node WHERE member_id = ? AND ref = ?',
      params: ['m0', 'cu:s0:1'],
      expected: 'memory_node_member_ref',
    },
  ]
  const assertions = cases.map(item => {
    const plan = database.prepare(item.sql).all(...item.params).map(row => String(row.detail ?? '')).join('; ')
    return { query: item.name, expected: item.expected, plan, pass: plan.includes(item.expected) }
  })
  database.close()
  return assertions
}

function readDiskUsage(databasePath) {
  const sizes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(file => existsSync(file))
    .map(file => statSync(file).size)
  const database = existsSync(databasePath) ? new DatabaseSync(databasePath) : undefined
  let pages = 0
  let pageSize = 0
  if (database !== undefined) {
    pages = Number(database.prepare('PRAGMA page_count').get()?.page_count ?? 0)
    pageSize = Number(database.prepare('PRAGMA page_size').get()?.page_size ?? 0)
    database.close()
  }
  return { totalBytes: sizes.reduce((sum, size) => sum + size, 0), pages, pageSize }
}

function buildChecks(metrics, thresholds) {
  const checks = []
  const add = (metric, measured, limit, pass, unit = 'ms') => checks.push({
    metric,
    measured: round(measured),
    limit,
    unit,
    pass,
  })
  add('increment p50', metrics.increment.p50, thresholds.increment.p50, metrics.increment.p50 <= thresholds.increment.p50)
  add('increment p95', metrics.increment.p95, thresholds.increment.p95, metrics.increment.p95 <= thresholds.increment.p95)
  add('commit p50', metrics.commit.p50, thresholds.commit.p50, metrics.commit.p50 <= thresholds.commit.p50)
  add('commit p95', metrics.commit.p95, thresholds.commit.p95, metrics.commit.p95 <= thresholds.commit.p95)
  add('commit max', metrics.commit.max, thresholds.commit.max, metrics.commit.max <= thresholds.commit.max)
  add('recall hot p50', metrics.recallHot.p50, thresholds.hot.p50, metrics.recallHot.p50 <= thresholds.hot.p50)
  add('recall hot p95', metrics.recallHot.p95, thresholds.hot.p95, metrics.recallHot.p95 <= thresholds.hot.p95)
  add('recall cold p50', metrics.recallCold.p50, thresholds.cold.p50, metrics.recallCold.p50 <= thresholds.cold.p50)
  add('recall cold p95', metrics.recallCold.p95, thresholds.cold.p95, metrics.recallCold.p95 <= thresholds.cold.p95)
  add('index write', metrics.indexWrite.unitsPerSecond, thresholds.write.unitsPerSecond,
    metrics.indexWrite.unitsPerSecond >= thresholds.write.unitsPerSecond, 'units/s')
  add('cpu average', metrics.cpu.averageCores, thresholds.cpu.average, metrics.cpu.averageCores <= thresholds.cpu.average, 'cores')
  add('cpu burst', metrics.cpu.burstCores, thresholds.cpu.burst, metrics.cpu.burstCores <= thresholds.cpu.burst, 'cores')
  add('rss delta', metrics.rss.deltaBytes / (1024 * 1024), thresholds.rss.deltaMb,
    metrics.rss.deltaBytes / (1024 * 1024) <= thresholds.rss.deltaMb, 'MB')
  add('recall error rate', metrics.recallErrors.rate * 100, thresholds.error.rate * 100,
    metrics.recallErrors.rate <= thresholds.error.rate, '%')
  add('recall timeout rate', metrics.timeout.recallRate * 100, thresholds.timeout.recall * 100,
    metrics.timeout.recallRate <= thresholds.timeout.recall, '%')
  add('commit timeout rate', metrics.timeout.commitRate * 100, thresholds.timeout.commit * 100,
    metrics.timeout.commitRate <= thresholds.timeout.commit, '%')
  add('concurrency p95 ratio', metrics.concurrency.ratio, thresholds.concurrency.ratio,
    metrics.concurrency.ratio <= thresholds.concurrency.ratio, 'x')
  add('disk', metrics.diskMb, thresholds.disk.mb, metrics.diskMb <= thresholds.disk.mb, 'MB')
  return checks
}

function printReport(report, outputPath) {
  const lines = [
    `Context perf — scale ${report.scale}, ${report.members} members × ${report.concurrency} turns, ${report.queries} queries`,
    `node ${report.node}; ${report.platform}; ${report.cpuModel}`,
    '',
    'metric                          measured     limit      result',
  ]
  for (const check of report.checks) {
    lines.push(`${check.metric.padEnd(31)} ${String(check.measured).padStart(9)}${check.unit.padEnd(5)} ${String(check.limit).padStart(8)}${check.unit.padEnd(5)} ${check.pass ? 'PASS' : 'FAIL'}`)
  }
  lines.push('', 'EXPLAIN QUERY PLAN')
  for (const assertion of report.indexAssertions) {
    lines.push(`  ${assertion.pass ? 'PASS' : 'FAIL'} ${assertion.query} → ${assertion.expected}: ${assertion.plan}`)
  }
  lines.push('', `Samples: ingest ${report.metrics.increment.count}, commit ${report.metrics.commit.count}, hot ${report.metrics.recallHot.count}, cold ${report.metrics.recallCold.count}`)
  lines.push(`Report: ${outputPath}`)
  lines.push(`Overall: ${report.passed ? 'PASS' : 'FAIL'}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

function syntheticMessage(round) {
  const roll = pseudoRandom(round)
  const file = `src/module-${round % 37}.ts`
  if (roll < 0.55) return `Processing step ${round}: updated ${file} and reran the focused test for case ${round}.`
  if (roll < 0.75) return `决定：采用方案 ${round % 11}，在 ${file} 保留兼容层，并记录验收口径 ${round}.`
  if (roll < 0.85) return `Auxiliary note ${round}: the metric sample at ${file}:${round} looked noisy.`
  if (roll < 0.95) return `Remember that the ${file} owner prefers the smaller diff; revisit on 2026-02-${String((round % 27) + 1).padStart(2, '0')}.`
  return `Tool output ${round}: ${file} exited with code 0 after ${round % 9} checks.`
}

function queryList(count) {
  const topics = ['方案', '兼容层', 'module-', '处理', 'decision', 'metric', 'owner', '验收', 'test', 'exited']
  const list = []
  for (let index = 0; index < count; index += 1) {
    const topic = topics[index % topics.length]
    list.push(index % 4 === 0 ? `module-${index % 37}.ts` : `${topic} ${index % 23}`)
  }
  return list
}

function memberId(index) {
  return `m${index}`
}

function sessionId(index) {
  return `s${index}`
}

function pseudoRandom(seed) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

function percentiles(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    p50: round(nearestRank(sorted, 0.5)),
    p95: round(nearestRank(sorted, 0.95)),
  }
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(percentile * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function maxOf(samples) {
  return samples.length === 0 ? 0 : Math.max(...samples)
}

function ratio(part, total) {
  return total === 0 ? 0 : part / total
}

function round(value) {
  return Math.round(value * 100) / 100
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function removeDatabase(databasePath) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true })
}
