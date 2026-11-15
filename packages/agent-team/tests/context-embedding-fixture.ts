/**
 * Shared fixtures for embedding model tests: a complete on-disk model and the
 * matching manifest, so no test needs the network to reach the ready state.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BUILTIN_EMBEDDING_DIMENSION,
  BUILTIN_EMBEDDING_FILES,
  type EmbeddingModelManifest,
} from '../src/context/embedding/manifest.ts'

export function readyPayloads(): Readonly<Record<string, string>> {
  return Object.fromEntries(BUILTIN_EMBEDDING_FILES.map(path => [path, `payload:${path}`]))
}

export function baseManifest(payloads: Readonly<Record<string, string>> = readyPayloads()): EmbeddingModelManifest {
  return {
    version: 1,
    modelId: 'granite-embedding-97m-multilingual-r2',
    revision: 'main',
    dimension: BUILTIN_EMBEDDING_DIMENSION,
    completedAt: new Date(0).toISOString(),
    files: BUILTIN_EMBEDDING_FILES.map(path => ({
      path,
      bytes: Buffer.byteLength(payloads[path]!),
      sha256: '0'.repeat(64),
    })),
  }
}

export async function writeReadyModel(directory: string): Promise<void> {
  const payloads = readyPayloads()
  for (const path of BUILTIN_EMBEDDING_FILES) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, payloads[path]!)
  }
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(baseManifest(payloads))}\n`)
}
