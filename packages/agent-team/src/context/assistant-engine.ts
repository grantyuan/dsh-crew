import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Structural copies of the engine's protected summarization seam. */
export interface SummarizationInputLike {
  readonly messages: readonly Message[]
}

export type SummaryResultLike = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)

export interface AssistantSummaryResult {
  readonly text: string
  readonly provider: string
  readonly model: string
}

export interface AssistantCompactionOptions {
  /** Route the digest through the configured `assistant` role; undefined falls back to the base engine. */
  readonly summarize: (input: { text: string; signal?: AbortSignal }) => Promise<AssistantSummaryResult | undefined>
}

type EngineConfig = ConstructorParameters<typeof BasicCompactionEngine>[1]

/**
 * Compaction engine that prefers the configured assistant role and falls back
 * to the shipped summarizer. A digest prepared earlier can be supplied at the
 * commit point so no model call is made there.
 */
export class AssistantCompactionEngine extends BasicCompactionEngine {
  private prepared: string | undefined

  constructor(ctx: Context, config: EngineConfig, private readonly options: AssistantCompactionOptions) {
    super(ctx, config)
  }

  /** Use a digest from the pending epoch exactly once. */
  usePreparedSummary(summary: string): void {
    this.prepared = summary
  }

  clearPreparedSummary(): void {
    this.prepared = undefined
  }

  protected override async summarize(
    input: SummarizationInputLike,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResultLike> {
    if (this.prepared !== undefined) {
      const text = this.prepared
      this.prepared = undefined
      return { summary: [{ type: 'text', text }], provider: 'prepared', model: 'epoch-cache' }
    }
    try {
      const result = await this.options.summarize({
        text: renderSummarizationInput(input),
        ...(signal === undefined ? {} : { signal }),
      })
      if (result !== undefined) {
        return {
          summary: [{ type: 'text', text: result.text }],
          provider: result.provider,
          model: result.model,
        }
      }
    } catch {
      // A failed assistant role must not lose compaction; fall through.
    }
    return super.summarize(input, agent, signal)
  }
}

/** Flatten the replayed prefix into the text handed to the assistant role. */
export function renderSummarizationInput(input: SummarizationInputLike): string {
  const lines: string[] = []
  for (const message of input.messages) {
    const role = (message as { role?: unknown }).role
    const content = (message as { content?: unknown }).content
    const text = Array.isArray(content)
      ? content.map(block => {
          if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            return (block as { text: string }).text
          }
          return JSON.stringify(block)
        }).join('\n')
      : typeof content === 'string' ? content : ''
    if (text.length > 0) lines.push(`${typeof role === 'string' ? role : 'message'}: ${text}`)
  }
  return lines.join('\n')
}
