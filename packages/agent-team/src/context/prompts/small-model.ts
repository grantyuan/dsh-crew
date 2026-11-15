/**
 * Prompts for a dedicated small context model.
 *
 * These assume a compact model: one short instruction, one JSON object, an
 * explicit field whitelist, and `{}` on failure. They are never used when the
 * assistant endpoint or the Agent main model takes over the role; that path
 * uses `general-model.ts` instead.
 * @module @grantyuan/dsh-crew/context/prompts/small-model
 */

import type { ContextRolePromptSpec, ContextRoleTask } from './types.ts'

const JSON_ONLY = 'Return exactly one JSON object. No markdown, no prose, no extra keys. If unsure, return {}.'

export const SMALL_MODEL_PROMPTS: Readonly<Record<ContextRoleTask, ContextRolePromptSpec>> = {
  classify: {
    system: `You compare a new memory unit with older candidate units. Decide whether the new unit replaces, refutes, or is unrelated to each candidate. Use "update" when the new unit supersedes stale details, "refute" when it contradicts a claim, and "none" otherwise. ${JSON_ONLY} Schema: {"relation":"none"|"update"|"refute","target":string|null,"confidence":number}.`,
    maxTokens: 160,
    temperature: 0,
  },
  enrich: {
    system: `You extract retrieval facets from one memory unit. Preserve the original language and exact identifiers. Do not invent dates, people, paths, or decisions. ${JSON_ONLY} Schema: {"subjects":string[],"topics":string[],"roles":string[],"time":{"start":string|null,"end":string|null}|null,"confidence":number}.`,
    maxTokens: 220,
    temperature: 0,
  },
  summarize: {
    system: `You compress a region of a working conversation. Keep decisions, commitments, open loops, exact identifiers, file paths, commands, and error codes. Drop greetings and repetition. ${JSON_ONLY} Schema: {"summary":string,"decisions":string[],"commitments":string[],"openLoops":string[]}.`,
    maxTokens: 420,
    temperature: 0,
  },
  conflict: {
    system: `You decide whether two memory statements conflict. Report "supersedes" only when the newer statement replaces the older value, "supports" when they agree, and "unrelated" otherwise. ${JSON_ONLY} Schema: {"relation":"supersedes"|"supports"|"unrelated","confidence":number,"reason":string}.`,
    maxTokens: 160,
    temperature: 0,
  },
  commitment: {
    system: `You extract explicit promises and decisions from one memory unit. Each item must quote the exact source substring that supports it; omit anything you cannot quote. ${JSON_ONLY} Schema: {"commitments":[{"text":string,"quote":string}],"decisions":[{"text":string,"quote":string}]}.`,
    maxTokens: 260,
    temperature: 0,
  },
}
