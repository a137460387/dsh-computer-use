/**
 * Session-scoped approval answerer: the host ApprovalService grants only
 * one-shot `allowed-once` semantics with no memory, and the host decides
 * never-approval sessions BEFORE dispatching the `approval/request`
 * waterfall while its interactive answerer answers ask sessions ahead of any
 * plugin listener — a registered waterfall listener is therefore never the
 * one that grants medium-risk auto-approval. The grant is a PRE-DISPATCH
 * decision instead: `requestApproval` consults this state machine before
 * calling `ctx.approval.request`, and only requests that do not auto-grant
 * traverse the approval seam.
 *
 * Risk-tier contract (both ends owned by this plugin): tool consumers mark
 * every escalated approval reason with a tier marker. Medium-risk requests
 * may be auto-granted inside a per-session window/counter; high-risk requests
 * ALWAYS traverse the seam, where interactive sessions confirm them and
 * never-approval sessions fail closed. The ApprovalService durably logs the
 * escalated asks (`approval/asked` + `approval/decided` session events);
 * auto-grants stay audited through the plugin's `answer/auto-allowed` audit
 * line.
 * @module dsh-computer-use/answerer
 */

import type { ComputerUseConfig } from './config.ts'

/** Reason prefix for actions the window/counter may auto-grant. */
export const MEDIUM_RISK_MARKER = '[dsh-computer-use tier=medium]'

/** Reason prefix for actions that must traverse the approval seam. */
export const HIGH_RISK_MARKER = '[dsh-computer-use tier=high]'

/** Risk tier for one approval decision. */
export type RiskTier = 'medium' | 'high'

/** Pre-dispatch answerer verdict for one request. */
export type AnswererVerdict = 'auto' | 'delegate'

/** One session's grant window state. */
interface GrantState {
  /** Window start, milliseconds since the Unix epoch. */
  readonly windowStartMs: number
  /** Grants consumed inside the window. */
  readonly grants: number
}

/** Per-session grant windows; state lives for the process. */
const states = new Map<string, GrantState>()

/**
 * Decide whether one request may proceed without traversing the approval
 * seam. High risk always delegates; medium risk auto-grants inside the
 * session's window until the grant ceiling is spent, then delegates for the
 * rest of that window.
 * @param config - policy carrying the window length and grant ceiling.
 * @param sessionId - session the request belongs to.
 * @param tier - risk tier of the pending action.
 * @returns `'auto'` when the request may skip the seam, `'delegate'` when it
 * must go through `ctx.approval.request`.
 */
export function consultAnswerer(
  config: Pick<ComputerUseConfig, 'autoApprovalWindowMs' | 'autoApprovalMaxGrants'>,
  sessionId: string,
  tier: RiskTier,
): AnswererVerdict {
  if (tier === 'high') return 'delegate'
  const nowMs = Date.now()
  let state = states.get(sessionId)
  if (state === undefined || nowMs - state.windowStartMs >= config.autoApprovalWindowMs) {
    state = { windowStartMs: nowMs, grants: 0 }
  }
  if (state.grants >= config.autoApprovalMaxGrants) {
    // Quota spent: keep the exhausted state so the rest of this window
    // delegates; deleting it would re-arm a fresh quota and defeat the
    // ceiling. The window-expiry branch above re-arms it later.
    states.set(sessionId, state)
    return 'delegate'
  }
  states.set(sessionId, { windowStartMs: state.windowStartMs, grants: state.grants + 1 })
  return 'auto'
}
