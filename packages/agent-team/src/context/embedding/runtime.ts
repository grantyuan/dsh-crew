/**
 * Local ONNX embedding runtime.
 *
 * The built-in granite int8 model runs through an optional
 * `@huggingface/transformers` dependency. It is imported dynamically so a
 * missing package or unsupported platform degrades to lexical retrieval
 * instead of breaking activation. Downloads are owned by the model manager and
 * never happen on a main path.
 * @module @grantyuan/dsh-crew/context/embedding/runtime
 */

import { dirname, basename } from 'node:path'
import type { RoleEmbeddingResult } from '../role-client.ts'
import { BUILTIN_EMBEDDING_DIMENSION, BUILTIN_EMBEDDING_MODEL_ID } from './manifest.ts'
import { EmbeddingModelManager, type EmbeddingModelSnapshot } from './model-manager.ts'

export type LocalEmbeddingState = 'idle' | 'downloading' | 'loading' | 'ready' | 'model-unavailable' | 'runtime-unavailable' | 'failed'

export interface LocalEmbeddingSnapshot {
  readonly state: LocalEmbeddingState
  readonly modelId: string
  readonly dimension: number
  readonly error?: string
  readonly download: EmbeddingModelSnapshot
}

/** The subset of the transformers.js surface this runtime uses. */
interface TransformersPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<unknown>
}

interface TransformersModule {
  readonly pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
  readonly env?: Record<string, unknown>
}

export type TransformersModuleLoader = () => Promise<unknown>

export interface LocalEmbeddingRuntimeOptions {
  readonly manager?: EmbeddingModelManager
  readonly loadModule?: TransformersModuleLoader
  readonly batchSize?: number
}

const DEFAULT_BATCH_SIZE = 8

function defaultLoader(): Promise<unknown> {
  const specifier = '@huggingface/transformers'
  return import(/* @vite-ignore */ specifier)
}

/** Read a matrix out of the several tensor shapes transformers.js returns. */
function readRows(value: unknown): number[][] | undefined {
  if (Array.isArray(value)) {
    if (value.every(item => Array.isArray(item))) return value as number[][]
    const rows: number[][] = []
    for (const item of value) {
      const nested = readRows(item)
      if (nested === undefined) return undefined
      rows.push(...nested)
    }
    return rows
  }
  if (value === null || typeof value !== 'object') return undefined
  const tensor = value as { data?: ArrayLike<number>; dims?: readonly number[]; tolist?: () => unknown }
  if (typeof tensor.tolist === 'function') {
    try {
      const listed = tensor.tolist()
      if (Array.isArray(listed)) {
        return listed.every(item => Array.isArray(item)) ? listed as number[][] : [listed as number[]]
      }
    } catch {
      // Fall through to the flat buffer representation.
    }
  }
  if (tensor.data === undefined || !Array.isArray(tensor.dims)) return undefined
  const dims = tensor.dims
  if (dims.length === 2) {
    const rowCount = dims[0] ?? 0
    const width = dims[1] ?? 0
    const rows: number[][] = []
    for (let row = 0; row < rowCount; row += 1) {
      rows.push(Array.from(tensor.data).slice(row * width, (row + 1) * width))
    }
    return rows
  }
  if (dims.length === 1) return [Array.from(tensor.data)]
  return undefined
}

export class LocalEmbeddingRuntime {
  private readonly manager: EmbeddingModelManager
  private readonly loadModule: TransformersModuleLoader
  private readonly batchSize: number
  private state: LocalEmbeddingState = 'idle'
  private error: string | undefined
  private extractorPromise: Promise<TransformersPipeline | undefined> | undefined
  private extractor: TransformersPipeline | undefined

  constructor(options: LocalEmbeddingRuntimeOptions = {}) {
    this.manager = options.manager ?? new EmbeddingModelManager()
    this.loadModule = options.loadModule ?? defaultLoader
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  }

  /** True once the model files are verified on disk; load happens lazily. */
  available(): boolean {
    return this.manager.isReady()
  }

  /** Directory holding the verified files. */
  get directory(): string {
    return this.manager.snapshot().directory
  }

  status(): LocalEmbeddingSnapshot {
    return {
      state: this.state,
      modelId: BUILTIN_EMBEDDING_MODEL_ID,
      dimension: BUILTIN_EMBEDDING_DIMENSION,
      ...(this.error === undefined ? {} : { error: this.error }),
      download: this.manager.snapshot(),
    }
  }

  /**
   * Download and load the model. Safe to call without awaiting: a failure is
   * recorded in {@link status} and embedding calls simply fall back.
   */
  async prepare(signal?: AbortSignal): Promise<boolean> {
    if (this.state === 'ready') return true
    if (this.manager.isReady()) {
      const extractor = await this.loadExtractor(signal)
      return extractor !== undefined
    }
    this.state = 'downloading'
    const downloaded = await this.manager.ensure(signal)
    if (!downloaded) {
      this.state = 'model-unavailable'
      this.error = this.manager.snapshot().error ?? 'embedding model download failed'
      return false
    }
    const extractor = await this.loadExtractor(signal)
    return extractor !== undefined
  }

  async embed(texts: readonly string[], signal: AbortSignal): Promise<RoleEmbeddingResult> {
    const started = Date.now()
    if (texts.length === 0) {
      return { vectors: [], dimension: BUILTIN_EMBEDDING_DIMENSION, modelId: BUILTIN_EMBEDDING_MODEL_ID, latencyMs: 0 }
    }
    const extractor = await this.loadExtractor(signal)
    if (extractor === undefined) {
      throw new Error(this.error ?? 'local embedding runtime is unavailable')
    }
    const vectors: Float32Array[] = []
    for (let offset = 0; offset < texts.length; offset += this.batchSize) {
      if (signal.aborted) throw new Error('local embedding call was cancelled')
      const batch = texts.slice(offset, offset + this.batchSize)
      const output = await extractor(batch, { pooling: 'mean', normalize: true })
      const rows = readRows(output)
      if (rows === undefined || rows.length !== batch.length) {
        throw new Error('local embedding model returned an unexpected output shape')
      }
      for (const row of rows) {
        if (row.length !== BUILTIN_EMBEDDING_DIMENSION) {
          throw new Error(`local embedding model returned ${row.length} dimensions, expected ${BUILTIN_EMBEDDING_DIMENSION}`)
        }
        vectors.push(Float32Array.from(row))
      }
    }
    return {
      vectors,
      dimension: BUILTIN_EMBEDDING_DIMENSION,
      modelId: BUILTIN_EMBEDDING_MODEL_ID,
      latencyMs: Date.now() - started,
    }
  }

  dispose(): void {
    this.extractor = undefined
    this.extractorPromise = undefined
    this.state = 'idle'
  }

  private loadExtractor(signal?: AbortSignal): Promise<TransformersPipeline | undefined> {
    if (this.extractor !== undefined) return Promise.resolve(this.extractor)
    if (this.extractorPromise !== undefined) return this.extractorPromise
    this.extractorPromise = this.load(signal).finally(() => {
      this.extractorPromise = undefined
    })
    return this.extractorPromise
  }

  private async load(signal?: AbortSignal): Promise<TransformersPipeline | undefined> {
    if (signal?.aborted === true) return undefined
    if (!this.manager.isReady()) {
      this.state = 'model-unavailable'
      this.error = 'embedding model files are not downloaded'
      return undefined
    }
    this.state = 'loading'
    this.error = undefined
    let module: TransformersModule
    try {
      module = await this.loadModule() as TransformersModule
    } catch (error) {
      this.state = 'runtime-unavailable'
      this.error = error instanceof Error ? error.message : 'transformers runtime is unavailable'
      return undefined
    }
    if (typeof module.pipeline !== 'function') {
      this.state = 'runtime-unavailable'
      this.error = 'transformers runtime does not expose a pipeline'
      return undefined
    }
    const directory = this.manager.snapshot().directory
    try {
      if (module.env !== undefined) {
        module.env.allowRemoteModels = false
        module.env.allowLocalModels = true
        module.env.localModelPath = dirname(directory)
      }
      const loaded = await module.pipeline('feature-extraction', basename(directory), { local_files_only: true })
      if (typeof loaded !== 'function') {
        this.state = 'failed'
        this.error = 'transformers pipeline did not return a callable extractor'
        return undefined
      }
      this.extractor = loaded as TransformersPipeline
      this.state = 'ready'
      return this.extractor
    } catch (error) {
      this.state = 'failed'
      this.error = error instanceof Error ? error.message : 'local embedding model failed to load'
      return undefined
    }
  }
}
