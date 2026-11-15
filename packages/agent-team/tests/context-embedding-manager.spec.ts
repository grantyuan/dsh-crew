import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddingModelManager } from '../src/context/embedding/model-manager.ts'
import {
  BUILTIN_EMBEDDING_FILES,
  BUILTIN_EMBEDDING_ONNX_PATH,
  parseEmbeddingModelManifest,
} from '../src/context/embedding/manifest.ts'
import { writeReadyModel } from './context-embedding-fixture.ts'

const roots: string[] = []

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-embedding-manager-'))
  roots.push(directory)
  return directory
}

function fixtureFetch(payloads: Readonly<Record<string, string>>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const path = BUILTIN_EMBEDDING_FILES.find(candidate => url.endsWith(`/${candidate}`))
    if (path === undefined || payloads[path] === undefined) {
      return new Response('missing', { status: 404 })
    }
    const bytes = Buffer.from(payloads[path]!)
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
  }) as typeof fetch
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('embedding model manager', () => {
  it('downloads every file, writes a manifest and becomes ready', async () => {
    const directory = await tempDirectory()
    const calls: string[] = []
    const payloads = Object.fromEntries(BUILTIN_EMBEDDING_FILES.map(path => [path, `payload:${path}`]))
    const manager = new EmbeddingModelManager({ directory, endpoint: 'https://hf.test', fetchImpl: fixtureFetch(payloads, calls) })

    await expect(manager.ensure()).resolves.toBe(true)
    expect(manager.isReady()).toBe(true)
    expect(manager.snapshot().state).toBe('ready')
    expect(calls).toHaveLength(BUILTIN_EMBEDDING_FILES.length)
    expect(await readFile(join(directory, BUILTIN_EMBEDDING_ONNX_PATH), 'utf8')).toBe(payloads[BUILTIN_EMBEDDING_ONNX_PATH])

    const manifest = parseEmbeddingModelManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
    expect(manifest?.files).toHaveLength(BUILTIN_EMBEDDING_FILES.length)
    expect(manifest?.dimension).toBe(384)

    const again: string[] = []
    const reused = new EmbeddingModelManager({ directory, endpoint: 'https://hf.test', fetchImpl: fixtureFetch(payloads, again) })
    await expect(reused.ensure()).resolves.toBe(true)
    expect(again).toHaveLength(0)
  })

  it('fails without a manifest when a download is truncated', async () => {
    const directory = await tempDirectory()
    const payloads = Object.fromEntries(BUILTIN_EMBEDDING_FILES.map(path => [path, 'short']))
    const fetchImpl = (async (_input: string | URL | Request) => {
      const bytes = Buffer.from(payloads[BUILTIN_EMBEDDING_FILES[0]!]!)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength + 10) } })
    }) as typeof fetch
    const manager = new EmbeddingModelManager({ directory, fetchImpl })

    await expect(manager.ensure()).resolves.toBe(false)
    expect(manager.snapshot().state).toBe('failed')
    expect(manager.snapshot().error).toContain('truncated')
    expect(manager.isReady()).toBe(false)
    await expect(stat(join(directory, `${BUILTIN_EMBEDDING_FILES[0]}.part`))).rejects.toThrow()
  })

  it('shares one flight across concurrent callers', async () => {
    const directory = await tempDirectory()
    let calls = 0
    const payloads = Object.fromEntries(BUILTIN_EMBEDDING_FILES.map(path => [path, `payload:${path}`]))
    const fetchImpl = (async (_input: string | URL | Request) => {
      calls += 1
      const url = String(_input)
      const path = BUILTIN_EMBEDDING_FILES.find(candidate => url.endsWith(`/${candidate}`))!
      const bytes = Buffer.from(payloads[path]!)
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
    }) as typeof fetch
    const manager = new EmbeddingModelManager({ directory, fetchImpl })

    const results = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()])
    expect(results, manager.snapshot().error).toEqual([true, true, true])
    expect(calls).toBe(BUILTIN_EMBEDDING_FILES.length)
  })

  it('respects a fresh lock and clears a stale one', async () => {
    const directory = await tempDirectory()
    const payloads = Object.fromEntries(BUILTIN_EMBEDDING_FILES.map(path => [path, `payload:${path}`]))
    await writeFile(join(directory, 'download.lock'), '{"pid":1}')
    const blocked = new EmbeddingModelManager({ directory, fetchImpl: fixtureFetch(payloads, []) })
    await expect(blocked.ensure()).resolves.toBe(false)
    expect(blocked.snapshot().error).toContain('another process')

    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(join(directory, 'download.lock'), old, old)
    const recovered = new EmbeddingModelManager({ directory, fetchImpl: fixtureFetch(payloads, []) })
    await expect(recovered.ensure()).resolves.toBe(true)
  })

  it('is ready offline when the previous download is complete', async () => {
    const directory = await tempDirectory()
    await writeReadyModel(directory)
    const calls: string[] = []
    const manager = new EmbeddingModelManager({ directory, fetchImpl: fixtureFetch({}, calls) })
    await expect(manager.ensure()).resolves.toBe(true)
    expect(calls).toHaveLength(0)
    expect(manager.snapshot().state).toBe('ready')
    expect(parseEmbeddingModelManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))).toBeDefined()
  })
})
