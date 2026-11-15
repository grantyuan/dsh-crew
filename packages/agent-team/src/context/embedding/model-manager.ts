/**
 * Download manager for the built-in embedding model.
 *
 * The recommended tier is downloaded on demand, never asked from the user.
 * One process performs the download at a time (`download.lock` guards other
 * processes), every file is written to `*.part`, hashed while streaming, and
 * renamed only after the byte count matches `Content-Length`. Failures leave
 * the previous complete copy untouched and never throw into a main path.
 * @module @grantyuan/dsh-crew/context/embedding/model-manager
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import {
  BUILTIN_EMBEDDING_DIMENSION,
  BUILTIN_EMBEDDING_FILES,
  BUILTIN_EMBEDDING_MODEL_ID,
  BUILTIN_EMBEDDING_REVISION,
  embeddingFileURL,
  embeddingHfEndpoint,
  embeddingModelDirectory,
  parseEmbeddingModelManifest,
  type EmbeddingModelManifest,
  type EmbeddingModelManifestFile,
} from './manifest.ts'

export type EmbeddingModelState = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed'

/** Progress and health exposed to the settings UI. */
export interface EmbeddingModelSnapshot {
  readonly state: EmbeddingModelState
  readonly modelId: string
  readonly directory: string
  readonly downloadedBytes: number
  readonly totalBytes?: number
  readonly error?: string
  readonly updatedAt: number
}

export interface EmbeddingModelManagerOptions {
  readonly directory?: string
  readonly endpoint?: string
  readonly revision?: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

const PROGRESS_INTERVAL_MS = 250
const LOCK_STALE_MS = 30 * 60_000

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'download was cancelled'
  if (error instanceof Error) return error.message
  return 'embedding model download failed'
}

export class EmbeddingModelManager {
  private readonly directory: string
  private readonly endpoint: string
  private readonly revision: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private state: EmbeddingModelState = 'idle'
  private downloadedBytes = 0
  private completedBytes = 0
  private totalBytes: number | undefined
  private error: string | undefined
  private updatedAt = Date.now()
  private flight: Promise<boolean> | undefined
  private manifest: EmbeddingModelManifest | undefined

  constructor(options: EmbeddingModelManagerOptions = {}) {
    this.directory = options.directory ?? embeddingModelDirectory()
    this.endpoint = options.endpoint ?? embeddingHfEndpoint()
    this.revision = options.revision ?? BUILTIN_EMBEDDING_REVISION
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** Synchronous readiness for route resolution; true only after verified files exist. */
  isReady(): boolean {
    return this.manifest !== undefined
  }

  /** Filesystem path for one model file. */
  filePath(path: string): string {
    return join(this.directory, path)
  }

  snapshot(): EmbeddingModelSnapshot {
    return {
      state: this.state,
      modelId: BUILTIN_EMBEDDING_MODEL_ID,
      directory: this.directory,
      downloadedBytes: this.downloadedBytes,
      ...(this.totalBytes === undefined ? {} : { totalBytes: this.totalBytes }),
      ...(this.error === undefined ? {} : { error: this.error }),
      updatedAt: this.updatedAt,
    }
  }

  /**
   * Ensure the model exists. Returns `false` for any failure; never throws.
   * Concurrent callers share one flight, and an already-ready cache is verified
   * by size only (hashing 98 MB on every start would delay activation).
   */
  ensure(signal?: AbortSignal): Promise<boolean> {
    if (this.manifest !== undefined) return Promise.resolve(true)
    if (this.flight !== undefined) return this.flight
    this.flight = this.download(signal).finally(() => {
      this.flight = undefined
    })
    return this.flight
  }

  /** Manual retry from the settings UI; same semantics as {@link ensure}. */
  retry(signal?: AbortSignal): Promise<boolean> {
    this.error = undefined
    return this.ensure(signal)
  }

  private setState(state: EmbeddingModelState, error?: string): void {
    this.state = state
    this.error = error
    this.updatedAt = this.now()
  }

  private async download(signal?: AbortSignal): Promise<boolean> {
    this.setState('checking')
    try {
      await mkdir(this.directory, { recursive: true })
      const cached = await this.readManifest()
      if (cached !== undefined) {
        this.manifest = cached
        this.downloadedBytes = cached.files.reduce((total, file) => total + file.bytes, 0)
        this.totalBytes = this.downloadedBytes
        this.setState('ready')
        return true
      }
      await this.acquireLock()
      try {
        const files = await this.fetchAll(signal)
        const manifest: EmbeddingModelManifest = {
          version: 1,
          modelId: BUILTIN_EMBEDDING_MODEL_ID,
          revision: this.revision,
          dimension: BUILTIN_EMBEDDING_DIMENSION,
          completedAt: new Date(this.now()).toISOString(),
          files,
        }
        const manifestPath = join(this.directory, 'manifest.json')
        await writeFile(`${manifestPath}.part`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await rename(`${manifestPath}.part`, manifestPath)
        this.manifest = manifest
        this.setState('ready')
        return true
      } finally {
        await this.releaseLock()
      }
    } catch (error) {
      for (const path of BUILTIN_EMBEDDING_FILES) {
        await rm(`${this.filePath(path)}.part`, { force: true }).catch(() => undefined)
      }
      this.setState('failed', errorMessage(error))
      return false
    }
  }

  /** Read and size-check a previous complete download. */
  private async readManifest(): Promise<EmbeddingModelManifest | undefined> {
    let text: string
    try {
      text = await readFile(join(this.directory, 'manifest.json'), 'utf8')
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    const manifest = parseEmbeddingModelManifest(parsed)
    if (manifest === undefined) return undefined
    for (const file of manifest.files) {
      try {
        const info = await stat(this.filePath(file.path))
        if (!info.isFile() || info.size !== file.bytes) return undefined
      } catch {
        return undefined
      }
    }
    return manifest
  }

  private async fetchAll(signal?: AbortSignal): Promise<EmbeddingModelManifestFile[]> {
    this.downloadedBytes = 0
    this.completedBytes = 0
    this.totalBytes = undefined
    this.setState('downloading')
    const files: EmbeddingModelManifestFile[] = []
    for (const path of BUILTIN_EMBEDDING_FILES) {
      const file = await this.fetchFile(path, signal)
      files.push(file)
      this.completedBytes += file.bytes
      this.downloadedBytes = this.completedBytes
    }
    this.totalBytes = this.completedBytes
    return files
  }

  private async fetchFile(path: string, signal?: AbortSignal): Promise<EmbeddingModelManifestFile> {
    const target = this.filePath(path)
    const part = `${target}.part`
    await mkdir(dirname(target), { recursive: true })
    const response = await this.fetchImpl(embeddingFileURL(this.endpoint, path, this.revision), {
      method: 'GET',
      redirect: 'follow',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      throw new Error(`embedding model download failed for ${path} (HTTP ${response.status})`)
    }
    const expected = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(expected) && expected > 0) {
      this.totalBytes = (this.totalBytes ?? 0) + expected
    }
    const body = response.body
    if (body === null) throw new Error(`embedding model download returned an empty body for ${path}`)
    const reader = body.getReader()
    const handle = await open(part, 'w')
    const hash = createHash('sha256')
    let bytes = 0
    let lastReport = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        hash.update(chunk.value)
        await handle.write(chunk.value)
        const now = this.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          this.downloadedBytes = this.completedBytes + bytes
          this.updatedAt = now
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    if (Number.isFinite(expected) && expected > 0 && bytes !== expected) {
      await rm(part, { force: true })
      throw new Error(`embedding model file ${path} was truncated (${bytes}/${expected} bytes)`)
    }
    await rename(part, target)
    return { path, bytes, sha256: hash.digest('hex') }
  }

  private lockPath(): string {
    return join(this.directory, 'download.lock')
  }

  private async acquireLock(): Promise<void> {
    const lock = this.lockPath()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, at: this.now() }), { flag: 'wx' })
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let age = 0
        try {
          age = this.now() - (await stat(lock)).mtimeMs
        } catch {
          continue
        }
        if (age < LOCK_STALE_MS) {
          throw new Error('another process is downloading the embedding model')
        }
        await rm(lock, { force: true })
      }
    }
    throw new Error('embedding model download lock is unavailable')
  }

  private async releaseLock(): Promise<void> {
    await rm(this.lockPath(), { force: true }).catch(() => undefined)
  }
}
