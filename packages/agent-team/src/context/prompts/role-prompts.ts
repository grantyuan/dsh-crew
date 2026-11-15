/**
 * Prompt dispatcher for functional context roles.
 *
 * The route resolver returns a `promptProfile`; this module is the only place
 * that turns it into text. Dedicated endpoints use the small-model table,
 * while the configured assistant endpoint or the Agent main model use the
 * general table. The two tables are never mixed.
 * @module @grantyuan/dsh-crew/context/prompts/role-prompts
 */

import type { ContextModelRole } from '../role-models.ts'
import { GENERAL_MODEL_PROMPTS } from './general-model.ts'
import { SMALL_MODEL_PROMPTS } from './small-model.ts'
import type { ContextRolePrompt, ContextRolePromptProfile, ContextRoleTask } from './types.ts'

export { CONTEXT_ROLE_TASKS, type ContextRolePrompt, type ContextRolePromptProfile, type ContextRoleTask } from './types.ts'

export interface BuildContextRolePromptInput {
  readonly role: ContextModelRole
  readonly task: ContextRoleTask
  readonly profile: Exclude<ContextRolePromptProfile, never>
  readonly payload: unknown
}

/** Serialize the payload without letting a hostile value break the prompt. */
function renderPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? 'null'
  } catch {
    return '"[unserializable input]"'
  }
}

/**
 * Build one role prompt. The role name is injected only for the general
 * profile, so a fallback model is explicitly told which Team role it serves.
 */
export function buildContextRolePrompt(input: BuildContextRolePromptInput): ContextRolePrompt {
  if (input.role === 'embedding') {
    throw new Error('embedding roles use the embedding endpoint, not a chat prompt')
  }
  const spec = input.profile === 'small'
    ? SMALL_MODEL_PROMPTS[input.task]
    : GENERAL_MODEL_PROMPTS[input.task]
  if (spec === undefined) throw new Error(`unknown context role task '${input.task}'`)
  const roleDeclaration = input.profile === 'general'
    ? `You are serving the Team's "${input.role}" context role.\n\n`
    : ''
  return {
    system: `${roleDeclaration}${spec.system}`,
    messages: [{ role: 'user', content: renderPayload(input.payload) }],
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
  }
}
