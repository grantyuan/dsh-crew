/**
 * Preset-side compaction engine that honours the assistant role.
 *
 * The preset runs in an isolated compaction scope, so it cannot read the Host
 * role settings directly. The Host publishes one resolver through a
 * process-global symbol; with no resolver (or a disabled role) this engine is
 * the shipped Basic engine, and a failing assistant call falls back to it.
 * @module @grantyuan/dsh-crew/context/compaction-plugin
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  renderSummarizationInput,
  type SummarizationInputLike,
  type SummaryResultLike,
} from './assistant-engine.ts'

export interface TeamCompactionSummary {
  readonly text: string
  readonly provider: string
  readonly model: string
}

export type TeamCompactionSummarizer = (input: {
  readonly text: string
  readonly signal?: AbortSignal
}) => Promise<TeamCompactionSummary | undefined>

export type TeamCompactionSummarizeResolver = (agent: Agent) => TeamCompactionSummarizer | undefined

interface Registry {
  resolver?: TeamCompactionSummarizeResolver
}

// The Host and the preset can load the same package through different module
// instances (source vs. built lib), so module state would not be shared. A
// symbol on the global object is the only bridge they reliably share.
const REGISTRY_KEY = '__grantyuanDshCrewCompactionSummarizer'

function registry(): Registry {
  const holder = globalThis as unknown as Record<string, unknown>
  const existing = holder[REGISTRY_KEY]
  if (existing !== null && typeof existing === 'object') return existing as Registry
  const created: Registry = {}
  holder[REGISTRY_KEY] = created
  return created
}

/** Called by the Host once at startup; replacing it is intentional (profile reload). */
export function setTeamCompactionSummarizerResolver(resolver: TeamCompactionSummarizeResolver): void {
  registry().resolver = resolver
}

export function resetTeamCompactionSummarizerResolver(): void {
  delete registry().resolver
}

type EngineConfig = ConstructorParameters<typeof BasicCompactionEngine>[1]

/**
 * Try the configured assistant role, returning `undefined` when no resolver
 * applies, the role declines, or the call fails. Exported separately from the
 * engine so the routing rule is testable without a Cordis Context.
 */
export async function teamCompactionSummary(
  input: SummarizationInputLike,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResultLike | undefined> {
  const summarize = registry().resolver?.(agent)
  if (summarize === undefined) return undefined
  try {
    const result = await summarize({
      text: renderSummarizationInput(input),
      ...(signal === undefined ? {} : { signal }),
    })
    return result === undefined
      ? undefined
      : {
        summary: [{ type: 'text', text: result.text }],
        provider: result.provider,
        model: result.model,
      }
  } catch {
    // A failed assistant role must not lose compaction; use the shipped path.
    return undefined
  }
}

export class TeamCompactionEngine extends BasicCompactionEngine {
  constructor(ctx: Context, config: EngineConfig = {}) {
    super(ctx, config)
  }

  protected override async summarize(
    input: SummarizationInputLike,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResultLike> {
    const routed = await teamCompactionSummary(input, agent, signal)
    return routed === undefined ? super.summarize(input, agent, signal) : routed
  }
}

export default TeamCompactionEngine
