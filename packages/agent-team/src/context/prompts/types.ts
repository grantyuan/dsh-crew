/**
 * Shared prompt types for functional context roles.
 *
 * The two prompt tables (`small-model.ts` and `general-model.ts`) are kept
 * deliberately separate: a dedicated small model gets terse, schema-bound
 * instructions, while an assistant or main model taking over the role gets a
 * longer role declaration and the same output contract. Nothing else is
 * shared beyond these types.
 * @module @grantyuan/dsh-crew/context/prompts/types
 */

export const CONTEXT_ROLE_TASKS = ['classify', 'enrich', 'summarize', 'conflict', 'commitment'] as const

export type ContextRoleTask = (typeof CONTEXT_ROLE_TASKS)[number]

export type ContextRolePromptProfile = 'small' | 'general'

export interface ContextRolePromptSpec {
  readonly system: string
  readonly maxTokens: number
  readonly temperature: number
}

export interface ContextRolePrompt {
  readonly system: string
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[]
  readonly maxTokens: number
  readonly temperature: number
}
