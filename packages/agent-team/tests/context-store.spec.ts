import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextStore } from '../src/context/store.ts'
import type { ContextUnitInput } from '../src/context/types.ts'
import { buildContextUnit } from '../src/context/units.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const cleanups: (() => void)[] = []

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-context-store-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'v1.sqlite')
}

function openStore(path = ':memory:', disableFts = false): ContextStore {
  const store = new ContextStore({ path, ...(disableFts ? { disableFts: true } : {}) })
  cleanups.push(() => store.close())
  return store
}

function makeUnit(overrides: Partial<ContextUnitInput> = {}): ReturnType<typeof buildContextUnit> {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq: 1,
    role: 'user',
    text: '决定采用 packages/agent-team/src/context/store.ts，@alice 负责，昨天下午完成。',
    recordedAt: '2026-11-15T06:00:00.000Z',
    timezone: 'Asia/Shanghai',
    ...overrides,
  }, { now: NOW })
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('ContextStore unit writes', () => {
  it('stores one unit with derived rows and treats an unchanged rewrite as a no-op', () => {
    const store = openStore()
    const unit = makeUnit()
    const first = store.writeUnit(unit, { enqueueEnrichment: true })
    expect(first).toEqual({ unitId: 'cu:s1:1', inserted: true, changed: false, enrichQueued: true })

    expect(store.getUnit('cu:s1:1')).toMatchObject({
      memberId: 'm1',
      sessionId: 's1',
      seq: 1,
      role: 'user',
      kind: 'decision',
      importance: 2,
      textHash: unit.textHash,
    })
    expect(store.listKeywords('cu:s1:1').map(keyword => keyword.term)).toContain('packages/agent-team/src/context/store.ts')
    expect(store.listFacets('cu:s1:1').map(facet => facet.value)).toContain('member:alice')
    expect(store.pendingOutboxCount('enrich')).toBe(1)

    const again = store.writeUnit(unit, { enqueueEnrichment: true })
    expect(again).toEqual({ unitId: 'cu:s1:1', inserted: false, changed: false, enrichQueued: false })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })

  it('replaces derived rows when the same seq gets new text', () => {
    const store = openStore()
    store.writeUnit(makeUnit(), { enqueueEnrichment: true })
    const changed = makeUnit({ text: '改成 @bob 负责 tests/context-store.spec.ts，今天完成。' })
    const result = store.writeUnit(changed, { enqueueEnrichment: true })

    expect(result).toEqual({ unitId: 'cu:s1:1', inserted: false, changed: true, enrichQueued: true })
    const terms = store.listKeywords('cu:s1:1').map(keyword => keyword.term)
    expect(terms).toContain('tests/context-store.spec.ts')
    expect(terms).not.toContain('packages/agent-team/src/context/store.ts')
    const subjects = store.listFacets('cu:s1:1').filter(facet => facet.dimension === 'subject').map(facet => facet.value)
    expect(subjects).toContain('member:bob')
    expect(subjects).not.toContain('member:alice')
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })

  it('keeps the WAL journal and schema version on a file database', () => {
    const path = tempDatabase()
    const store = openStore(path)
    expect(store.capabilities).toMatchObject({ word: true, trigram: true, schemaVersion: 1 })

    const check = new DatabaseSync(path)
    try {
      expect(check.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    } finally {
      check.close()
    }
  })

  it('writes units when FTS is unavailable', () => {
    const store = openStore(':memory:', true)
    expect(store.capabilities).toMatchObject({ word: false, trigram: false })
    const result = store.writeUnit(makeUnit())
    expect(result.inserted).toBe(true)
    expect(store.getUnit('cu:s1:1')?.kind).toBe('decision')
  })

  it('indexes the text and removes the old body on rewrite', () => {
    const path = tempDatabase()
    const store = openStore(path)
    store.writeUnit(makeUnit({ text: 'alpha unique token here' }))

    const check = new DatabaseSync(path)
    try {
      const before = check.prepare("SELECT count(*) AS count FROM unit_fts WHERE body MATCH 'alpha'").get() as { count: number }
      expect(before.count).toBe(1)
    } finally {
      check.close()
    }

    store.writeUnit(makeUnit({ text: 'beta replacement token' }))
    const after = new DatabaseSync(path)
    try {
      const old = after.prepare("SELECT count(*) AS count FROM unit_fts WHERE body MATCH 'alpha'").get() as { count: number }
      const next = after.prepare("SELECT count(*) AS count FROM unit_fts WHERE body MATCH 'beta'").get() as { count: number }
      expect(old.count).toBe(0)
      expect(next.count).toBe(1)
    } finally {
      after.close()
    }
  })
})

describe('ContextStore outbox', () => {
  it('counts attempts and drops after the third failure', () => {
    const store = openStore()
    store.writeUnit(makeUnit(), { enqueueEnrichment: true })
    const [row] = store.claimEnrichment(10)
    expect(row).toBeDefined()

    expect(store.failOutbox(row!.id, 'first')).toEqual({ dropped: false, attempts: 1 })
    expect(store.failOutbox(row!.id, 'second')).toEqual({ dropped: false, attempts: 2 })
    expect(store.pendingOutboxCount('enrich')).toBe(1)
    expect(store.failOutbox(row!.id, 'third')).toEqual({ dropped: true, attempts: 3 })
    expect(store.pendingOutboxCount('enrich')).toBe(0)
  })

  it('defers without consuming an attempt', () => {
    const store = openStore()
    store.writeUnit(makeUnit(), { enqueueEnrichment: true })
    const [row] = store.claimEnrichment(10)
    store.deferOutbox(row!.id, 0)
    const [again] = store.claimEnrichment(10)
    expect(again?.attempts).toBe(0)
    expect(store.pendingOutboxCount('enrich')).toBe(1)
  })
})

describe('ContextStore enrichment merge', () => {
  it('adds only missing values and never overwrites rule rows', () => {
    const store = openStore()
    store.writeUnit(makeUnit())
    const result = store.applyEnrichment('cu:s1:1', {
      keywords: [
        { term: 'packages/agent-team/src/context/store.ts', kind: 'term', weight: 0.5, source: 'model' },
        { term: '上下文压缩', kind: 'term', weight: 0.5, source: 'model' },
      ],
      facets: [
        { dimension: 'subject', value: 'member:alice', confidence: 0.9, source: 'model' },
        { dimension: 'subject', value: 'member:bob', confidence: 0.9, source: 'model' },
        { dimension: 'topic', value: 'topic:上下文压缩', confidence: 0.6, source: 'model' },
      ],
    })

    expect(result).toEqual({ termsAdded: 1, facetsAdded: 2 })
    const terms = store.listKeywords('cu:s1:1')
    expect(terms.filter(keyword => keyword.term === 'packages/agent-team/src/context/store.ts')).toHaveLength(1)
    expect(terms.some(keyword => keyword.term === '上下文压缩' && keyword.source === 'model')).toBe(true)

    const subjects = store.listFacets('cu:s1:1').filter(facet => facet.dimension === 'subject')
    expect(subjects.filter(facet => facet.value === 'member:alice')).toHaveLength(1)
    expect(subjects.find(facet => facet.value === 'member:alice')?.source).toBe('rule')
    expect(subjects.some(facet => facet.value === 'member:bob')).toBe(true)
  })
})

describe('ContextStore recall state', () => {
  it('round-trips a cursor per member and session', () => {
    const store = openStore()
    expect(store.getRecallState('m1', 's1', 'snapshot')).toBeUndefined()
    store.setRecallState('m1', 's1', 'snapshot', 'hash-a')
    expect(store.getRecallState('m1', 's1', 'snapshot')).toBe('hash-a')
    store.setRecallState('m1', 's1', 'snapshot', 'hash-b')
    expect(store.getRecallState('m1', 's1', 'snapshot')).toBe('hash-b')
    expect(store.getRecallState('m2', 's1', 'snapshot')).toBeUndefined()
  })
})
