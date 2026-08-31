/**
 * Shared weaving for the model-facing computer-use tools: service access,
 * risk-tiered approval, the window whitelist, hotkey escalation, and the
 * per-session step ceiling. Security policy lives here so every tool applies
 * it identically.
 * @module dsh-computer-use/tools/shared
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { consultAnswerer, HIGH_RISK_MARKER, MEDIUM_RISK_MARKER } from '../answerer.ts'
import type { RiskTier } from '../answerer.ts'
import type { ComputerUseConfig } from '../config.ts'
import type { ComputerUseRuntime, ObservationId } from '../definition/index.ts'
import type { ReadinessReport } from '../diagnostics/readiness.ts'
import type { Auditor } from '../security/auditor.ts'
import type { FailureDetector } from '../security/circuit-breaker.ts'
import type { DangerFilter } from '../security/danger-filter.ts'
import type { ChangeDetector, HashedFrame } from '../vision/change-detector.ts'
import { runActionVerification, shouldVerify } from '../vision/verification.ts'
import type { VisionProvider } from '../vision/vision-provider.ts'

/** Everything the tool consumers share from the bundle wiring. */
export interface ToolDeps {
  readonly config: ComputerUseConfig
  readonly dangerFilter: DangerFilter
  readonly breaker: FailureDetector
  readonly auditor: Auditor
  readonly changeDetector: ChangeDetector
  /** Vision calls for post-action verification and zoom-crop refinement. */
  readonly vision: VisionProvider
  /** Readiness checklist snapshot; `sessionId` scopes the quota and budget items. */
  readonly readiness: (sessionId?: string) => ReadinessReport
  /** Last captured frame, the change detector's before-side input. */
  previousShot?: HashedFrame
  /** Observation identity of {@link previousShot}; the zoom-crop region basis. */
  previousShotId?: ObservationId
}

/** Resolve the computer-use service; the provider mounts it lazily. */
export function computerUse(ctx: Context): ComputerUseRuntime {
  const runtime = ctx.get('computerUse')
  if (runtime === undefined) {
    throw new Error('dsh-computer-use: the computerUse service is not mounted yet')
  }
  return runtime
}

export type { RiskTier }

/**
 * Gate one action on its risk tier. Medium requests first consult the
 * plugin's pre-dispatch answerer: inside the session's window/quota they are
 * granted WITHOUT traversing the approval seam and the grant is written to
 * the audit log; the host waterfall is structurally unreachable by this
 * plugin (never-approval sessions are rejected before dispatch, ask sessions
 * are answered by the host interactive answerer first), so no grant can be
 * delegated to it. Everything else (high risk, exhausted quota) goes to
 * `ctx.approval.request` with the tier marker embedded in the reason:
 * interactive sessions confirm there, while never-approval (Full access)
 * sessions reject deterministically — that rejection surfaces as
 * configuration guidance instead of a bare "rejected".
 * @param ctx - context carrying the approval service.
 * @param deps - bundle wiring carrying the policy and the audit sink.
 * @param exec - the tool execution being decided.
 * @param toolName - the tool the question is about.
 * @param tier - medium may be auto-granted pre-dispatch; high never is.
 * @param description - human-readable explanation for the prompt/audit.
 */
export async function requestApproval(
  ctx: Context,
  deps: ToolDeps,
  exec: ToolExecution,
  toolName: string,
  tier: RiskTier,
  description: string,
): Promise<void> {
  if (exec.agent === undefined) {
    throw new Error(`dsh-computer-use: ${toolName} needs an agent-scoped execution for approval decisions`)
  }
  const sessionId = String(exec.agent.session.id)
  if (consultAnswerer(deps.config, sessionId, tier) === 'auto') {
    deps.auditor.recordAutoApproval({ sessionId, toolName, tier })
    return
  }
  const marker = tier === 'high' ? HIGH_RISK_MARKER : MEDIUM_RISK_MARKER
  const outcome = await ctx.approval.request({
    agent: exec.agent,
    toolName,
    ...exec.callId !== undefined ? { callId: exec.callId } : {},
    reason: `${marker} ${description}`,
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once':
      return
    case 'rejected':
    case 'unavailable':
      throw new Error(
        `dsh-computer-use: ${toolName} needs interactive approval (tier=${tier}) but none was granted; `
        + 'never-approval (Full access) sessions refuse it without prompting — '
        + 'switch the session to Workspace Write and retry',
      )
    case 'cancelled':
      throw new Error(`dsh-computer-use: ${toolName} approval was cancelled`)
    default:
      assertNever(outcome, 'approval outcome')
  }
}

/** Canonical hotkey identity: lowercase keys joined in sorted order. */
export function normalizeHotkey(keys: readonly string[]): string {
  return [...keys].map(key => key.toLowerCase()).sort().join('+')
}

/**
 * Whether two key combinations are the same hotkey (order/case independent).
 * @param keys - one combination.
 * @param other - the combination to compare against.
 * @returns true when both describe the identical key set.
 */
export function isSameHotkey(keys: readonly string[], other: readonly string[]): boolean {
  return keys.length > 0 && keys.length === other.length && normalizeHotkey(keys) === normalizeHotkey(other)
}

/**
 * System-shortcut combinations that always escalate to high risk: they drive
 * the operating system itself (run dialogs, settings, task manager, session
 * lock, window close), outside any application the task targets. This set is
 * a security invariant — fixed, not deployment-configurable. Entries are
 * stored in {@link normalizeHotkey} canonical form, so the comparison is
 * independent of the key order the model happens to emit.
 */
const HIGH_RISK_HOTKEYS: ReadonlySet<string> = new Set([
  ['alt', 'f4'],
  ['ctrl', 'shift', 'esc'],
  ['win', 'i'],
  ['win', 'l'],
  ['win', 'r'],
  ['win', 'x'],
].map(keys => normalizeHotkey(keys)))

/** Whether one key combination escalates to high risk. */
export function isHighRiskHotkey(keys: readonly string[]): boolean {
  return HIGH_RISK_HOTKEYS.has(normalizeHotkey(keys))
}

/**
 * Window-whitelist escalation: with a configured `allowedApps` list, an
 * action whose foreground process is not whitelisted becomes high risk
 * (interactive confirmation). A foreground lookup failure fails closed to
 * high risk as well.
 * @param ctx - context carrying the computer-use service.
 * @param deps - bundle wiring with the whitelist config.
 * @param baseTier - the tier before whitelist policy.
 * @returns the effective tier.
 */
export async function whitelistTier(ctx: Context, deps: ToolDeps, baseTier: RiskTier): Promise<RiskTier> {
  const allowed = deps.config.allowedApps
  if (allowed.length === 0) return baseTier
  try {
    const foreground = await computerUse(ctx).getForegroundWindow()
    const normalized = foreground.toLowerCase()
    const hit = allowed.some(entry => normalized.includes(entry.toLowerCase()))
    return hit ? baseTier : 'high'
  } catch {
    return 'high'
  }
}

/**
 * Run the advisory post-action semantic verification for one executed
 * non-click action, when the deployment mode samples it and a baseline
 * frame exists. Appends nothing to the approval or step accounting — the
 * action already ran; this only annotates its result and audits the verdict.
 * @param ctx - context carrying the computer-use service.
 * @param deps - bundle wiring with the verification config, vision, and audit sink.
 * @param exec - the tool execution being annotated (session and cancellation).
 * @param toolName - the tool whose action ran.
 * @param actionDescription - sanitized summary of the action for the model prompt.
 * @returns the message note to append to the tool result, or undefined when skipped.
 */
export async function maybeVerifyAction(
  ctx: Context,
  deps: ToolDeps,
  exec: ToolExecution,
  toolName: 'type_text' | 'scroll' | 'hotkey',
  actionDescription: string,
): Promise<string | undefined> {
  const baseline = deps.previousShot
  if (!shouldVerify(deps.config) || baseline === undefined) return undefined
  const verdict = await runActionVerification({
    vision: deps.vision,
    settleMs: deps.config.actionVerificationSettleMs,
    before: { data: baseline.data, width: baseline.width, height: baseline.height },
    actionDescription,
    captureAfter: () => computerUse(ctx).screenShot({
      maxWidth: deps.config.screenshotMaxWidth,
      quality: deps.config.screenshotQuality,
    }),
    signal: exec.signal,
  })
  deps.auditor.recordVerification({
    ...exec.agent !== undefined ? { sessionId: String(exec.agent.session.id) } : {},
    toolName,
    verdict: verdict.verdict,
    reason: verdict.reason,
    retried: false,
  })
  return verdict.verdict === 'yes'
    ? ` Semantic verification confirmed the effect (${verdict.reason}).`
    : ` Semantic verification: ${verdict.verdict} (${verdict.reason}). Capture a fresh screenshot to inspect.`
}

/** Per-session action counter enforcing the `maxSteps` ceiling. */
export class StepCounter {
  private readonly counts = new Map<string, number>()

  /** Refuse once a session spent its action budget. */
  assert(sessionId: string, maxSteps: number): void {
    const used = this.counts.get(sessionId) ?? 0
    if (used >= maxSteps) {
      throw new Error(
        `dsh-computer-use: this session reached its ${maxSteps}-action ceiling; `
        + 'stop and let the user inspect the screen before continuing',
      )
    }
  }

  /** Count one executed action against the session. */
  note(sessionId: string): void {
    this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1)
  }

  /** Actions counted against one session so far (readiness diagnostics). */
  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0
  }
}

/** Shared per-session step budget owned by the bundle wiring. */
export const stepCounter = new StepCounter()

/** Tool-visible session id of one execution. */
export function sessionIdOf(exec: ToolExecution): string {
  if (exec.agent === undefined) {
    throw new Error('dsh-computer-use: this tool needs an agent-scoped execution to track its session')
  }
  return String(exec.agent.session.id)
}
