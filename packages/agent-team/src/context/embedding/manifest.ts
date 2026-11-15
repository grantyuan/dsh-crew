/**
 * Built-in embedding model manifest.
 *
 * The recommended tier is fixed: IBM Granite 97m multilingual r2, official
 * int8 ONNX quantization, 384 dimensions. The user never supplies this model;
 * an enabled embedding role with no endpoint downloads it on first use. The
 * manifest is the integrity record written after a successful download, so a
 * half-written cache is never mistaken for a ready model.
 * @module @grantyuan/dsh-crew/context/embedding/manifest
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Stable model id used by the settings UI and the embedding route. */
export const BUILTIN_EMBEDDING_MODEL_ID = 'granite-embedding-97m-multilingual-r2'

/** Hugging Face repository of the built-in embedding model. */
export const BUILTIN_EMBEDDING_REPO = 'ibm-granite/granite-embedding-97m-multilingual-r2'

/** Pinned repository revision; `main` resolves to the official release tag. */
export const BUILTIN_EMBEDDING_REVISION = 'main'

/** Output dimension of the built-in model. Index geometry depends on it. */
export const BUILTIN_EMBEDDING_DIMENSION = 384

/** ONNX file name inside the repository. */
export const BUILTIN_EMBEDDING_ONNX_PATH = 'onnx/model_quint8_avx2.onnx'

/** Files required to load and run the model locally. */
export const BUILTIN_EMBEDDING_FILES: readonly string[] = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  BUILTIN_EMBEDDING_ONNX_PATH,
]

/** Cache directory for the built-in model; one directory per quantization tier. */
export function embeddingModelDirectory(): string {
  return dshHomePath('agent-team', 'models', 'granite-embedding-97m-multilingual-r2', 'r2-int8')
}

/**
 * Resolve the Hugging Face endpoint. Mirrors the ecosystem conventions so an
 * operator behind a mirror can set `HF_ENDPOINT` or the Team-specific
 * `DSH_AGENT_TEAM_HF_ENDPOINT` without editing plugin config.
 */
export function embeddingHfEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.DSH_AGENT_TEAM_HF_ENDPOINT ?? env.HF_ENDPOINT ?? '').trim()
  return (configured === '' ? 'https://huggingface.co' : configured).replace(/\/+$/, '')
}

/** Absolute download URL for one repository file. */
export function embeddingFileURL(endpoint: string, path: string, revision: string = BUILTIN_EMBEDDING_REVISION): string {
  return `${endpoint.replace(/\/+$/, '')}/${BUILTIN_EMBEDDING_REPO}/resolve/${revision}/${path}`
}

/** One verified file recorded in the manifest. */
export interface EmbeddingModelManifestFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** Integrity record written atomically after every file is downloaded. */
export interface EmbeddingModelManifest {
  readonly version: 1
  readonly modelId: string
  readonly revision: string
  readonly dimension: number
  readonly completedAt: string
  readonly files: readonly EmbeddingModelManifestFile[]
}

/** Validate a parsed `manifest.json`; anything malformed means "not ready". */
export function parseEmbeddingModelManifest(value: unknown): EmbeddingModelManifest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (record.modelId !== BUILTIN_EMBEDDING_MODEL_ID) return undefined
  if (record.dimension !== BUILTIN_EMBEDDING_DIMENSION) return undefined
  if (typeof record.revision !== 'string' || typeof record.completedAt !== 'string') return undefined
  if (!Array.isArray(record.files)) return undefined
  const files: EmbeddingModelManifestFile[] = []
  for (const item of record.files) {
    if (item === null || typeof item !== 'object') return undefined
    const file = item as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.bytes !== 'number' || typeof file.sha256 !== 'string') return undefined
    if (!BUILTIN_EMBEDDING_FILES.includes(file.path)) return undefined
    files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 })
  }
  if (files.length !== BUILTIN_EMBEDDING_FILES.length) return undefined
  return {
    version: 1,
    modelId: record.modelId,
    revision: record.revision,
    dimension: record.dimension,
    completedAt: record.completedAt,
    files,
  }
}
