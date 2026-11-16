/**
 * The carried Member system prompt: what a context renewal (reset), a model
 * rollover, and a checkpoint return reuse from the retiring generation.
 *
 * Every fresh Member generation re-assembles its system prompt from the live
 * registry, and that assembly is not byte-stable across generations: sections
 * contributed by plugins and MCP servers come and go with the process state
 * between two generations, so the rebuilt prompt differs from the retired one
 * and the provider prefix cache behind the old prompt is voided on the very
 * first request of the new Session. The renewal paths therefore capture the
 * retired generation's effective prompt — the surviving head `system/message`
 * surface text, everything the requests carried before the first user message
 * — and the fresh generation freezes its assembly to that captured text.
 *
 * The capture is evidence, never a rebuild: the text is read back verbatim
 * (one carried section, `interpolate: false`), so the new Session's first
 * request shares the retired generation's prompt prefix byte for byte. The
 * freeze lives on the fresh generation's agent scope until the next prompt
 * swap (`MemberRuntime` releases it on any live tool-policy, role-paragraph,
 * or section-drop re-apply) or until the generation itself retires — the next
 * renewal then captures the carried text again, keeping every later
 * generation byte-stable too.
 * @module @grantyuan/dsh-crew/member-prompt-carry
 */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Section name the carried prompt registers under during the freeze. Namespaced
 * like the shipped team sections so it cannot collide with any harness-owned,
 * preset-owned, or MCP-contributed name; protected against section drops (see
 * `PROTECTED_PROMPT_SECTIONS`).
 */
export const CARRIED_PROMPT_SECTION_NAME = 'team:carried-system-prompt'

/** Text blocks of one system message event, joined the way one node stores them. */
function systemTextOf(event: SessionEvent<'system/message'>): string {
  const content = event.data.message.content
  const [block] = content
  return content.length === 0 ? '' : block?.type === 'text' ? block.text : ''
}

/**
 * The carried prompt of one live Session: the surviving head `system/message`
 * texts in surface order, up to the first non-system message. Reads through
 * the Session's own surface fold (`surface.nodes`), so resumed, seeded, and
 * compacted generations all report exactly what their requests carried.
 * `undefined` when the Session never committed a head prompt — a Member that
 * has not run a model step yet has nothing to carry.
 */
export function carriedSystemPromptOfSession(session: Session): string | undefined {
  const texts: string[] = []
  for (const seq of session.surface.nodes) {
    // `nodes` are event identities (SessionSeq); snapshotEvents takes log
    // offsets. Re-entering through the validating constructor keeps the two
    // number domains explicit (the seq = log.length contiguity contract).
    const event = session.snapshotEvents(SessionLogOffset(seq), SessionLogOffset(seq + 1))[0]
    if (event === undefined) break
    if (event.type !== 'system/message') break
    texts.push(systemTextOf(event))
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * The carried prompt of one stored Session, folded from its own events: the
 * surface is rebuilt by applying every message event's `surfaceOp` (append,
 * replace-range), then read like the live fold. Crash recovery captures
 * through this path — the retiring generation is long disposed, and only its
 * log survives. A seeded generation's head node lives in its inherited
 * prefix, which its own events exclude; callers capture from the seed events
 * instead (see {@link carriedSystemPromptFromSeed}).
 */
export function carriedSystemPromptFromEvents(events: readonly SessionEvent[]): string | undefined {
  const surface: SessionSeq[] = []
  const bySeq = new Map<SessionSeq, SessionEvent>()
  for (const event of events) {
    if (event.surfaceOp === undefined) continue
    bySeq.set(event.seq, event)
    if (event.surfaceOp === 'append') {
      surface.push(event.seq)
      continue
    }
    const { startSeq, endSeq } = event.surfaceOp
    const start = surface.indexOf(startSeq)
    const end = surface.indexOf(endSeq)
    // A replace naming nodes this prefix does not hold cannot be folded from a
    // partial log (a seeded generation's own events never see its inherited
    // nodes); fail closed to no carry instead of guessing a surface.
    if (start < 0 || end < start) return undefined
    surface.splice(start, end - start + 1, event.seq)
  }
  const texts: string[] = []
  for (const seq of surface) {
    const event = bySeq.get(seq)
    if (event === undefined || event.type !== 'system/message') break
    texts.push(systemTextOf(event))
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * The carried prompt of one seed prefix: the checkpoint return's inherited
 * events are a contiguous log prefix, so the head prompt is read in log order
 * — the same rule the live fold applies to the surface.
 */
export function carriedSystemPromptFromSeed(seed: readonly SessionEvent[]): string | undefined {
  const texts: string[] = []
  for (const event of seed) {
    if (event.type !== 'system/message') break
    texts.push(systemTextOf(event))
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}
