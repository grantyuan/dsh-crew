/**
 * Prompts for an assistant endpoint or the Agent main model taking over a
 * context role.
 *
 * A general model is more capable but also more likely to answer
 * conversationally, so these prompts state the role explicitly, repeat the
 * output contract, and forbid extra commentary. They are maintained apart
 * from `small-model.ts` on purpose: editing one family must not silently
 * change the other.
 * @module @grantyuan/dsh-crew/context/prompts/general-model
 */

import type { ContextRolePromptSpec, ContextRoleTask } from './types.ts'

const CONTRACT = 'You are not talking to the end user. The main assistant owns the conversation and will consume only your JSON object. Do not add explanations, apologies, or follow-up questions. Return exactly one JSON object.'

export const GENERAL_MODEL_PROMPTS: Readonly<Record<ContextRoleTask, ContextRolePromptSpec>> = {
  classify: {
    system: `${CONTRACT} Compare the new memory unit with each older candidate. Choose "update" when the new unit supersedes stale values, "refute" when it contradicts a claim, and "none" when they can coexist. Prefer "none" when evidence is weak. Schema: {"relation":"none"|"update"|"refute","target":string|null,"confidence":number}.`,
    maxTokens: 220,
    temperature: 0,
  },
  enrich: {
    system: `${CONTRACT} Extract retrieval facets from one memory unit: subjects, topics, roles, and an optional normalized time range. Preserve the source language and exact identifiers. Never invent a date, person, path, or decision. Schema: {"subjects":string[],"topics":string[],"roles":string[],"time":{"start":string|null,"end":string|null}|null,"confidence":number}.`,
    maxTokens: 320,
    temperature: 0,
  },
  summarize: {
    system: `${CONTRACT} Compress the provided conversation region for future retrieval. Preserve decisions, commitments, open loops, exact identifiers, file paths, commands, and error codes. Remove greetings, repetition, and raw tool noise. Schema: {"summary":string,"decisions":string[],"commitments":string[],"openLoops":string[]}.`,
    maxTokens: 700,
    temperature: 0,
  },
  conflict: {
    system: `${CONTRACT} Decide whether two memory statements conflict. Use "supersedes" only when the newer statement replaces the older value, "supports" when they agree, and "unrelated" otherwise. Be conservative: when the time order or subject is unclear, return "unrelated". Schema: {"relation":"supersedes"|"supports"|"unrelated","confidence":number,"reason":string}.`,
    maxTokens: 220,
    temperature: 0,
  },
  commitment: {
    system: `${CONTRACT} Extract explicit promises and decisions from one memory unit. Every item must quote the exact source substring that supports it; omit anything you cannot quote verbatim. Do not upgrade suggestions into commitments. Schema: {"commitments":[{"text":string,"quote":string}],"decisions":[{"text":string,"quote":string}]}.`,
    maxTokens: 380,
    temperature: 0,
  },
}
