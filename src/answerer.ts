/**
 * Session-scoped approval answerer: the official ApprovalService grants only
 * one-shot `allowed-once` semantics with no memory, so "session-level
 * confirmation-free" medium-risk behavior is implemented here as a temporary
 * in-memory state machine over the `approval/request` waterfall.
 *
 * Risk-tier contract (both ends owned by this plugin): tool consumers mark
 * every approval reason with a tier marker. Medium-risk requests may be
 * auto-granted inside a per-session window/counter; high-risk requests ALWAYS
 * fall through `next()` to the interactive answerer (UI prompt), regardless
 * of window state — the markers make that bypass structural, and a missing
 * interactive answerer then fails closed per the approval seam. Every ask and
 * outcome is durably logged by the ApprovalService itself (`approval/asked` +
 * `approval/decided` session events), so auto-grants stay audited.
 * @module dsh-computer-use/answerer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ComputerUseConfig } from './config.ts'

/** Reason prefix for actions the window/counter may auto-grant. */
export const MEDIUM_RISK_MARKER = '[dsh-computer-use tier=medium]'

/** Reason prefix for actions that must reach the interactive answerer. */
export const HIGH_RISK_MARKER = '[dsh-computer-use tier=high]'

/** One session's grant window state. */
interface GrantState {
  /** Window start, milliseconds since the Unix epoch. */
  readonly windowStartMs: number
  /** Grants consumed inside the window. */
  readonly grants: number
}

/**
 * Register the answerer on the approval waterfall.
 * @param ctx - host context carrying the approval event stream.
 * @param config - validated policy (window length and grant ceiling).
 * @returns the registration disposer; state dies with the fiber.
 */
export function registerAnswerer(ctx: Context, config: ComputerUseConfig): () => void {
  const states = new Map<string, GrantState>()
  return ctx.on('approval/request', (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => {
    const reason = req.reason ?? ''
    // High tier and foreign requests delegate: high tier MUST reach the
    // interactive answerer (fail closed without one); other tools' approvals
    // are none of this state machine's business.
    if (!reason.startsWith(MEDIUM_RISK_MARKER)) return next()

    const sessionId = String(req.agent.session.id)
    const nowMs = Date.now()
    let state = states.get(sessionId)
    if (state === undefined || nowMs - state.windowStartMs >= config.autoApprovalWindowMs) {
      state = { windowStartMs: nowMs, grants: 0 }
    }
    if (state.grants >= config.autoApprovalMaxGrants) {
      // Quota spent: keep the exhausted state so the rest of this window
      // surfaces interactively; deleting it would re-arm a fresh quota and
      // defeat the ceiling. The window-expiry branch above re-arms it later.
      states.set(sessionId, state)
      return next()
    }
    states.set(sessionId, { windowStartMs: state.windowStartMs, grants: state.grants + 1 })
    return Promise.resolve('allowed-once' as const)
  })
}
