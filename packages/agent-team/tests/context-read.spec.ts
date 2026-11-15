import { afterEach, describe, expect, it } from 'vitest'
import { parseContextReadRef, readContextSource } from '../src/context/read.ts'
import { ContextStore } from '../src/context/store.ts'
import { buildContextUnit } from '../src/context/units.ts'

const NOW = (): Date => new Date('2026-11-15T06:00:00.000Z')
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function openStore(): ContextStore {
  const store = new ContextStore({ path: ':memory:', disableFts: true })
  cleanups.push(() => store.close())
  return store
}

function makeUnit(seq: number, text: string) {
  return buildContextUnit({
    memberId: 'm1',
    sessionId: 's1',
    seq,
    role: 'user',
    text,
    recordedAt: `2026-11-15T06:${String(seq).padStart(2, '0')}:00.000Z`,
    timezone: 'Asia/Shanghai',
  }, { now: NOW })
}

describe('context_recall read', () => {
  it('parses unit and window refs and rejects anything else', () => {
    expect(parseContextReadRef('cu:s1:7')).toEqual({ sessionId: 's1', fromSeq: 7, toSeq: 7 })
    expect(parseContextReadRef('seg:s1:2-5')).toEqual({ sessionId: 's1', fromSeq: 2, toSeq: 5 })
    expect(parseContextReadRef('seg:s1:5-2')).toBeUndefined()
    expect(parseContextReadRef('checkpoint:s1:1')).toBeUndefined()
  })

  it('reads one unit back with its text and belief state', () => {
    const store = openStore()
    store.writeUnit(makeUnit(1, 'The embedding size is 1024.'))

    const read = readContextSource(store, 'm1', { ref: 'cu:s1:1' })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect(read).toMatchObject({ ref: 'cu:s1:1', sessionId: 's1', fromSeq: 1, toSeq: 1, status: 'active', truncated: false })
    expect(read.text).toContain('The embedding size is 1024.')
    expect(read.confidence).toBeGreaterThan(0)
  })

  it('reads a window and truncates it at the requested character bound', () => {
    const store = openStore()
    store.writeUnit(makeUnit(1, 'first '.repeat(80)))
    store.writeUnit(makeUnit(2, 'second '.repeat(80)))

    const read = readContextSource(store, 'm1', { ref: 'seg:s1:1-2', maxChars: 200 })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect(read).toMatchObject({ fromSeq: 1, toSeq: 2, truncated: true })
    expect(read.text.length).toBe(200)
    expect(read.text.endsWith('…')).toBe(true)
    expect(read.totalChars).toBeGreaterThan(200)
  })

  it('marks a superseded source with its replacement and validity end', () => {
    const store = openStore()
    store.writeUnit(makeUnit(1, 'The embedding size is 1024.'))
    store.writeUnit(makeUnit(2, 'Correction: the embedding size is 768.'))
    store.supersedeUnit('cu:s1:2', 'cu:s1:1', new Date('2026-11-15T07:30:00.000Z'))

    const read = readContextSource(store, 'm1', { ref: 'cu:s1:1' })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect(read.status).toBe('superseded')
    expect(read.supersededBy).toBe('cu:s1:2')
    expect(read.validTo).toBe('2026-11-15T07:30:00.000Z')
    expect(read.units[0]).toMatchObject({ ref: 'cu:s1:1', status: 'superseded', supersededBy: 'cu:s1:2' })
  })

  it('states why a ref cannot be read instead of throwing', () => {
    const store = openStore()
    expect(readContextSource(store, 'm1', { ref: 'seg:s1:1-2' })).toEqual({ ok: false, reason: 'read-ref-not-indexed' })
    expect(readContextSource(store, 'm1', { ref: 'cu:s1:1' })).toEqual({ ok: false, reason: 'read-ref-not-indexed' })
    expect(readContextSource(store, 'm1', { ref: 'whatever' })).toEqual({ ok: false, reason: 'read-invalid-ref' })
  })
})
