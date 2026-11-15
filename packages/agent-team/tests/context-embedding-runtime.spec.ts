import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_EMBEDDING_DIMENSION } from '../src/context/embedding/manifest.ts'
import { EmbeddingModelManager } from '../src/context/embedding/model-manager.ts'
import { LocalEmbeddingRuntime } from '../src/context/embedding/runtime.ts'
import { writeReadyModel } from './context-embedding-fixture.ts'

const roots: string[] = []

async function readyDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-embedding-runtime-'))
  roots.push(directory)
  await writeReadyModel(directory)
  return directory
}

async function emptyDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-embedding-runtime-empty-'))
  roots.push(directory)
  return directory
}

function manager(directory: string): EmbeddingModelManager {
  return new EmbeddingModelManager({ directory, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch })
}

function tensor(rows: number): { data: Float32Array; dims: number[] } {
  const data = new Float32Array(rows * BUILTIN_EMBEDDING_DIMENSION)
  for (let index = 0; index < data.length; index += 1) data[index] = 0.5
  return { data, dims: [rows, BUILTIN_EMBEDDING_DIMENSION] }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('local embedding runtime', () => {
  it('loads the local model and embeds in bounded batches', async () => {
    const directory = await readyDirectory()
    const batches: number[] = []
    const runtime = new LocalEmbeddingRuntime({
      manager: manager(directory),
      batchSize: 8,
      loadModule: async () => ({
        pipeline: async (_task: string, model: string) => {
          expect(model).toBe(directory.split('/').at(-1))
          return async (texts: string[]) => {
            batches.push(texts.length)
            return tensor(texts.length)
          }
        },
      }),
    })

    expect(runtime.available()).toBe(false)
    await expect(runtime.prepare()).resolves.toBe(true)
    expect(runtime.available()).toBe(true)
    expect(runtime.status().state).toBe('ready')

    const texts = Array.from({ length: 10 }, (_, index) => `text ${index}`)
    const result = await runtime.embed(texts, new AbortController().signal)
    expect(result.dimension).toBe(BUILTIN_EMBEDDING_DIMENSION)
    expect(result.vectors).toHaveLength(10)
    expect(batches).toEqual([8, 2])
  })

  it('degrades when the optional transformers runtime is missing', async () => {
    const directory = await readyDirectory()
    const runtime = new LocalEmbeddingRuntime({
      manager: manager(directory),
      loadModule: async () => {
        throw new Error("Cannot find package '@huggingface/transformers'")
      },
    })

    await expect(runtime.prepare()).resolves.toBe(false)
    expect(runtime.status().state).toBe('runtime-unavailable')
    await expect(runtime.embed(['a'], new AbortController().signal)).rejects.toThrow('Cannot find package')
  })

  it('refuses to embed before the model is downloaded', async () => {
    const directory = await emptyDirectory()
    const runtime = new LocalEmbeddingRuntime({ manager: manager(directory) })
    expect(runtime.available()).toBe(false)
    await expect(runtime.embed(['a'], new AbortController().signal)).rejects.toThrow('not downloaded')
    expect(runtime.status().state).toBe('model-unavailable')
  })

  it('rejects a model with the wrong output dimension', async () => {
    const directory = await readyDirectory()
    const runtime = new LocalEmbeddingRuntime({
      manager: manager(directory),
      loadModule: async () => ({
        pipeline: async () => async (texts: string[]) => ({ data: new Float32Array(texts.length * 3), dims: [texts.length, 3] }),
      }),
    })
    await expect(runtime.prepare()).resolves.toBe(true)
    await expect(runtime.embed(['a'], new AbortController().signal)).rejects.toThrow('expected 384')
  })
})
