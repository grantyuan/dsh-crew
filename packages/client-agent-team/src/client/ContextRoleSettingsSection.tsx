import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentTeamContextRoleConfig, AgentTeamContextRoleName, AgentTeamContextRoleView } from '@grantyuan/dsh-crew/types'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './context-role-settings.module.css'

/**
 * Functional context model roles: four independent cards, every field
 * optional, plus the built-in embedding model's download state.
 *
 * The page owns no copy of the settings. Reads answer the Host's live view;
 * saves are non-optimistic and replace the whole view with the Host's
 * post-write answer. A blank endpoint and model mean "not configured", which
 * is why the enable switch cannot be turned on for an empty card; a saved API
 * key is never returned, so the key field starts blank and blank keeps it.
 */

export interface ContextRoleSaveRequest {
  readonly role: AgentTeamContextRoleName
  readonly baseURL?: string
  readonly model?: string
  readonly apiKey?: string | null
  readonly enabled?: boolean
}

export interface ContextRoleSettingsInjected {
  read: () => Promise<AgentTeamContextRoleConfig>
  save: (request: ContextRoleSaveRequest) => Promise<AgentTeamContextRoleConfig>
  retryEmbedding: () => Promise<AgentTeamContextRoleConfig>
}

export type ContextRoleSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'team'>
  & ContextRoleSettingsInjected

interface RoleDraft {
  baseURL: string
  model: string
  apiKey: string
  enabled: boolean
}

function draftOf(entry: AgentTeamContextRoleView): RoleDraft {
  return { baseURL: entry.baseURL, model: entry.model, apiKey: '', enabled: entry.enabled }
}

function endpointProblem(value: string): boolean {
  if (value.trim() === '') return false
  try {
    const url = new URL(value.trim())
    return url.protocol !== 'http:' && url.protocol !== 'https:'
  } catch {
    return true
  }
}

const ROLE_LABEL_KEYS = {
  assistant: 'contextRoleAssistantName',
  embedding: 'contextRoleEmbeddingName',
  decision: 'contextRoleDecisionName',
  extraction: 'contextRoleExtractionName',
} as const

const ROLE_HINT_KEYS = {
  assistant: 'contextRoleAssistantHint',
  embedding: 'contextRoleEmbeddingHint',
  decision: 'contextRoleDecisionHint',
  extraction: 'contextRoleExtractionHint',
} as const

const ROUTE_LABEL_KEYS = {
  role: 'contextRoleRouteRole',
  assistant: 'contextRoleRouteAssistant',
  main: 'contextRoleRouteMain',
  local: 'contextRoleRouteLocal',
  lexical: 'contextRoleRouteLexical',
  off: 'contextRoleRouteOff',
} as const

const EMBEDDING_STATE_KEYS = {
  idle: 'contextRoleEmbeddingStateIdle',
  downloading: 'contextRoleEmbeddingStateDownloading',
  loading: 'contextRoleEmbeddingStateLoading',
  ready: 'contextRoleEmbeddingStateReady',
  'model-unavailable': 'contextRoleEmbeddingStateModelUnavailable',
  'runtime-unavailable': 'contextRoleEmbeddingStateRuntimeUnavailable',
  failed: 'contextRoleEmbeddingStateFailed',
} as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function EmbeddingCard(props: {
  readonly embedding: AgentTeamContextRoleConfig['embedding']
  readonly t: ContextRoleSettingsProps['t']
  readonly retrying: boolean
  readonly onRetry: () => void
}) {
  const { embedding, t } = props
  const busy = embedding.state === 'downloading' || embedding.state === 'loading'
  return <div className={css.embeddingCard} data-embedding>
    <div className={css.cardHead}>
      <div className={css.rowText}>
        <div className={css.title}>{t('contextRoleEmbeddingModelTitle')}</div>
        <div className={css.desc}>{t('contextRoleEmbeddingModelHint')}</div>
      </div>
      <Button variant="outline" disabled={busy || props.retrying} onClick={props.onRetry} aria-label={t('contextRoleEmbeddingRetry')}>
        {busy || props.retrying ? t('contextRoleEmbeddingRetrying') : t('contextRoleEmbeddingRetry')}
      </Button>
    </div>
    <dl className={css.facts}>
      <div className={css.fact}><dt>{t('contextRoleEmbeddingModel')}</dt><dd>{embedding.modelId} · {embedding.dimension}d</dd></div>
      <div className={css.fact}><dt>{t('contextRoleEmbeddingState')}</dt><dd data-state={embedding.state} role="status">{t(EMBEDDING_STATE_KEYS[embedding.state])}</dd></div>
      {embedding.state === 'downloading'
        ? <div className={css.fact}>
            <dt>{t('contextRoleEmbeddingProgress')}</dt>
            <dd>{formatBytes(embedding.downloadedBytes)}{embedding.totalBytes === undefined ? '' : ` / ${formatBytes(embedding.totalBytes)}`}</dd>
          </div>
        : null}
      <div className={css.fact}><dt>{t('contextRoleEmbeddingDirectory')}</dt><dd className={css.mono}>{embedding.directory}</dd></div>
    </dl>
    {embedding.error === undefined ? null : <p className={css.notice} role="alert">{embedding.error}</p>}
  </div>
}

function RoleCard(props: {
  readonly entry: AgentTeamContextRoleView
  readonly t: ContextRoleSettingsProps['t']
  readonly save: ContextRoleSettingsInjected['save']
  readonly onSaved: (view: AgentTeamContextRoleConfig) => void
}) {
  const { entry, t, save } = props
  const [draft, setDraft] = useState<RoleDraft | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const current = draft ?? draftOf(entry)
  const endpointInvalid = endpointProblem(current.baseURL)
  const filled = current.baseURL.trim() !== ''
  const modelFilled = current.model.trim() !== ''
  const bothBlank = !filled && !modelFilled
  const halfFilled = filled !== modelFilled
  const dirty = draft !== undefined && (
    current.baseURL !== entry.baseURL
    || current.model !== entry.model
    || current.apiKey.trim() !== ''
    || current.enabled !== entry.enabled
  )

  const update = (patch: Partial<RoleDraft>): void => {
    const next = { ...current, ...patch }
    // A card with no endpoint and no model is not a configured role; keep the
    // switch honest instead of storing an enabled-but-empty entry.
    if (next.baseURL.trim() === '' && next.model.trim() === '') next.enabled = false
    setDraft(next)
  }

  const submit = async (apiKey?: string | null): Promise<void> => {
    if (saving) return
    setSaving(true)
    setNotice(null)
    try {
      const view = await save({
        role: entry.role,
        baseURL: current.baseURL.trim(),
        model: current.model.trim(),
        enabled: bothBlank ? false : current.enabled,
        ...(apiKey === undefined
          ? (current.apiKey.trim() === '' ? {} : { apiKey: current.apiKey.trim() })
          : { apiKey }),
      })
      setDraft(undefined)
      props.onSaved(view)
    } catch (error) {
      setNotice(t('contextRoleSaveFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }

  const disabled = saving
  return <div className={css.roleCard} data-role={entry.role}>
    <div className={css.cardHead}>
      <div className={css.rowText}>
        <div className={css.title}>{t(ROLE_LABEL_KEYS[entry.role])}</div>
        <div className={css.desc}>{t(ROLE_HINT_KEYS[entry.role])}</div>
      </div>
      <label className={css.enable}>
        <input
          type="checkbox"
          aria-label={t('contextRoleEnable', { role: t(ROLE_LABEL_KEYS[entry.role]) })}
          checked={current.enabled}
          disabled={disabled || bothBlank}
          onChange={(event) => { update({ enabled: event.target.checked }) }}
        />
        <span>{t('contextRoleEnableShort')}</span>
      </label>
    </div>
    <div className={css.fields}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('contextRoleEndpoint')}</span>
        <Input
          value={current.baseURL}
          disabled={disabled}
          placeholder={t('contextRoleEndpointPlaceholder')}
          aria-invalid={endpointInvalid || undefined}
          onChange={(event) => { update({ baseURL: event.target.value }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('contextRoleModelLabel')}</span>
        <Input
          value={current.model}
          disabled={disabled}
          placeholder={t('contextRoleModelPlaceholder')}
          onChange={(event) => { update({ model: event.target.value }) }}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('contextRoleApiKey')}</span>
        <Input
          type="password"
          value={current.apiKey}
          disabled={disabled}
          placeholder={entry.apiKeySet ? t('contextRoleApiKeyKeep') : t('contextRoleApiKeyHint')}
          autoComplete="off"
          onChange={(event) => { update({ apiKey: event.target.value }) }}
        />
      </label>
    </div>
    {bothBlank ? <p className={css.hint}>{t('contextRoleBlankHint')}</p> : null}
    {halfFilled ? <p className={css.notice}>{t('contextRolePairHint')}</p> : null}
    {endpointInvalid ? <p className={css.notice}>{t('contextRoleEndpointInvalid')}</p> : null}
    {notice === null ? null : <p className={css.notice} role="alert">{notice}</p>}
    <div className={css.cardFoot}>
      <span className={css.route} data-source={entry.route.source}>
        {t('contextRoleRoute', {
          source: t(ROUTE_LABEL_KEYS[entry.route.source]),
          model: entry.route.model === '' ? '—' : entry.route.model,
        })}
      </span>
      {entry.circuit === 'closed' ? null : <span className={css.circuit}>{t('contextRoleCircuit', { state: entry.circuit })}</span>}
      {entry.p50 === undefined ? null : <span className={css.latency}>{t('contextRoleLatency', { p50: Math.round(entry.p50), p95: Math.round(entry.p95 ?? entry.p50) })}</span>}
      <span className={css.footSpacer} />
      {entry.apiKeySet
        ? <Button variant="outline" disabled={disabled} onClick={() => { void submit(null) }}>{t('contextRoleClearKey')}</Button>
        : null}
      <Button
        variant="primary"
        disabled={disabled || !dirty || halfFilled || endpointInvalid}
        onClick={() => { void submit(undefined) }}
      >
        {saving ? t('contextRoleSaving') : t('contextRoleSave')}
      </Button>
    </div>
  </div>
}

export function ContextRoleSettingsSection(props: ContextRoleSettingsProps) {
  const { t } = props
  const [view, setView] = useState<AgentTeamContextRoleConfig | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let alive = true
    props.read().then((next) => {
      if (!alive) return
      setView(next)
      setLoadError(null)
    }).catch((error: unknown) => {
      if (!alive) return
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { alive = false }
  }, [props.read])

  // The built-in model reports its own progress; poll only while it is moving
  // so a ready or failed page stays quiet.
  useEffect(() => {
    if (view === undefined) return
    const state = view.embedding.state
    if (state !== 'downloading' && state !== 'loading') return
    const timer = setTimeout(() => {
      props.read().then(setView).catch(() => undefined)
    }, 2_000)
    return () => { clearTimeout(timer) }
  }, [view, props.read])

  const retryEmbedding = async (): Promise<void> => {
    setRetrying(true)
    try {
      setView(await props.retryEmbedding())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setRetrying(false)
    }
  }

  const header = <>
    <h2 className={css.heading}>{t('contextRolesTitle')}</h2>
    <p className={css.intro}>{t('contextRolesIntro')}</p>
  </>

  if (loadError !== null) {
    return <div className={css.section}>
      {header}
      <p className={css.state} role="alert">{t('contextRolesLoadFailed', { message: loadError })}</p>
      <div><Button variant="outline" onClick={() => { setLoadError(null); setView(undefined) }}>{t('retry')}</Button></div>
    </div>
  }

  if (view === undefined) {
    return <div className={css.section}>
      {header}
      <p className={css.state} role="status">{t('contextRolesLoading')}</p>
    </div>
  }

  return <div className={css.section}>
    {header}
    <p className={css.hint}>{t('contextRolesFallbackHint', {
      main: view.mainModel === undefined ? '—' : `${view.mainModel.provider}/${view.mainModel.model}`,
    })}</p>
    <div className={css.cards}>
      {view.roles.map(entry => <RoleCard key={entry.role} entry={entry} t={t} save={props.save} onSaved={setView} />)}
    </div>
    <EmbeddingCard embedding={view.embedding} t={t} retrying={retrying} onRetry={() => { void retryEmbedding() }} />
  </div>
}
