/**
 * Readiness checklist: one structured snapshot over every subsystem a
 * desktop-control run depends on — sidecar connection and tool surface,
 * auto-approval quota, the no-change breaker, the audit sink, the
 * sensitive-window policy, the takeover monitor, and the per-session step
 * budget. This is an internal diagnostics surface (tool code, operator
 * scripts, the bundle's `readiness` wiring); the report is advisory and
 * never gates an action by itself.
 * @module dsh-computer-use/diagnostics/readiness
 */

import { describeAnswererQuota } from '../answerer.ts'
import type { ComputerUseConfig } from '../config.ts'
import type { AuditWriteHealth } from '../security/auditor.ts'
import { hotkeyLabel } from '../security/refusals.ts'

/** One checklist verdict. */
export type ReadinessStatus = 'pass' | 'fail' | 'unknown'

/** Identity of one checklist item. */
export type ReadinessCheckId =
  | 'sidecar-connection'
  | 'sidecar-tool-surface'
  | 'approval-quota'
  | 'no-change-breaker'
  | 'audit-writable'
  | 'sensitive-window-rules'
  | 'takeover-monitor'
  | 'step-budget'

/** One checklist row: the item, its verdict, and a short human reason. */
export interface ReadinessCheckItem {
  readonly id: ReadinessCheckId
  readonly status: ReadinessStatus
  readonly detail: string
}

/** The full checklist result. */
export interface ReadinessReport {
  /** When the snapshot was taken, milliseconds since the Unix epoch. */
  readonly checkedAtMs: number
  /** `fail` when any item fails; else `unknown` when any item is unknown; else `pass`. */
  readonly overall: ReadinessStatus
  readonly checks: readonly ReadinessCheckItem[]
}

/** Connection facts the MCP provider reports about the sidecar. */
export interface SidecarReadinessFacts {
  /** Whether an MCP handshake currently serves calls. */
  readonly connected: boolean
  /** Whether a start was ever attempted (the sidecar starts lazily). */
  readonly startedOnce: boolean
  /** Whether the provider was unloaded. */
  readonly disposed: boolean
  /** Sidecar version proven at the current handshake, when connected. */
  readonly serverVersion?: string
  /** Tool count enumerated at the current handshake, when connected. */
  readonly toolSurfaceSize?: number
  /** Tool count the handshake must prove before any call is served. */
  readonly requiredToolSurfaceSize: number
  /** The pause mirror currently pushed by the sidecar monitor. */
  readonly paused: boolean
  /** Whether the health-ping timer currently watches the connection. */
  readonly healthCheckActive: boolean
}

/** Everything the checklist reads; owners supply read-only views. */
export interface ReadinessInput {
  readonly config: Pick<
    ComputerUseConfig,
    | 'autoApprovalWindowMs'
    | 'autoApprovalMaxGrants'
    | 'maxSteps'
    | 'consecutiveFailureCount'
    | 'takeoverHotkey'
    | 'pauseOnUserInput'
  >
  /** Sidecar facts; absent when no provider is wired. */
  readonly sidecar?: SidecarReadinessFacts
  readonly breaker: { readonly isTripped: boolean; readonly consecutiveNoChange: number }
  readonly auditor: { writeHealth(): AuditWriteHealth }
  readonly sensitivePolicy: { readonly blocklistSize: number; readonly allowlistSize: number }
  /** Session scope for the quota and step-budget items; absent checks stay global. */
  readonly session?: { readonly id: string; readonly stepsUsed: number }
  /** Platform override for tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

/** Fold one item list into the report-level verdict. */
function overallOf(checks: readonly ReadinessCheckItem[]): ReadinessStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail'
  if (checks.some(check => check.status === 'unknown')) return 'unknown'
  return 'pass'
}

function sidecarConnectionItem(facts: SidecarReadinessFacts | undefined): ReadinessCheckItem {
  if (facts === undefined) {
    return { id: 'sidecar-connection', status: 'unknown', detail: 'no provider wired; sidecar state unavailable' }
  }
  if (facts.disposed) {
    return { id: 'sidecar-connection', status: 'fail', detail: 'the provider is disposed; the plugin must remount' }
  }
  if (facts.connected) {
    return {
      id: 'sidecar-connection',
      status: 'pass',
      detail: `connected${facts.serverVersion !== undefined ? ` (v${facts.serverVersion})` : ''}`
        + `${facts.healthCheckActive ? ', health ping active' : ', health ping inactive'}`,
    }
  }
  if (facts.startedOnce) {
    return {
      id: 'sidecar-connection',
      status: 'fail',
      detail: 'not connected after a previous start attempt (exit or handshake failure); the next service call retries',
    }
  }
  return {
    id: 'sidecar-connection',
    status: 'unknown',
    detail: 'not started yet; the sidecar starts lazily on first service use',
  }
}

function toolSurfaceItem(facts: SidecarReadinessFacts | undefined): ReadinessCheckItem {
  if (facts === undefined || !facts.connected) {
    return {
      id: 'sidecar-tool-surface',
      status: 'unknown',
      detail: 'the tool surface is proven at handshake; the sidecar is not connected',
    }
  }
  if (facts.toolSurfaceSize === undefined) {
    return { id: 'sidecar-tool-surface', status: 'unknown', detail: 'connected, but the handshake tool count is not recorded' }
  }
  if (facts.toolSurfaceSize < facts.requiredToolSurfaceSize) {
    return {
      id: 'sidecar-tool-surface',
      status: 'fail',
      detail: `sidecar advertises ${facts.toolSurfaceSize} tools, ${facts.requiredToolSurfaceSize} required`,
    }
  }
  return {
    id: 'sidecar-tool-surface',
    status: 'pass',
    detail: `${facts.requiredToolSurfaceSize} required sidecar tools verified at handshake`,
  }
}

function approvalQuotaItem(
  config: ReadinessInput['config'],
  session: ReadinessInput['session'],
  nowMs: number,
): ReadinessCheckItem {
  if (session === undefined) {
    return {
      id: 'approval-quota',
      status: 'unknown',
      detail: 'pass a session id to check its medium-risk auto-approval quota',
    }
  }
  const quota = describeAnswererQuota(config, session.id, nowMs)
  if (quota.state === 'exhausted') {
    return {
      id: 'approval-quota',
      status: 'fail',
      detail: `auto-approval quota exhausted (${quota.grantsUsed}/${quota.grantCeiling} grants used); medium-risk `
        + `actions need interactive approval for ~${Math.ceil((quota.windowRemainingMs ?? 0) / 1000)}s, and `
        + 'never-approval (Full access) sessions refuse them',
    }
  }
  if (quota.state === 'active') {
    return {
      id: 'approval-quota',
      status: 'pass',
      detail: `${quota.grantsUsed}/${quota.grantCeiling} auto-approval grants used; window expires in `
        + `~${Math.ceil((quota.windowRemainingMs ?? 0) / 1000)}s`,
    }
  }
  return {
    id: 'approval-quota',
    status: 'pass',
    detail: `fresh quota: ${quota.grantCeiling} medium-risk auto-approvals available in a ${Math.round(quota.windowMs / 1000)}s window`,
  }
}

function breakerItem(
  config: ReadinessInput['config'],
  breaker: ReadinessInput['breaker'],
): ReadinessCheckItem {
  if (breaker.isTripped) {
    return {
      id: 'no-change-breaker',
      status: 'fail',
      detail: `tripped after ${breaker.consecutiveNoChange} consecutive no-change actions; actions are refused `
        + 'until a visibly changed screen is captured',
    }
  }
  const counted = breaker.consecutiveNoChange
  return {
    id: 'no-change-breaker',
    status: 'pass',
    detail: counted > 0
      ? `armed (${counted} no-change action(s) counted; trips at ${config.consecutiveFailureCount})`
      : `armed (trips at ${config.consecutiveFailureCount} consecutive no-change actions)`,
  }
}

function auditItem(auditor: ReadinessInput['auditor']): ReadinessCheckItem {
  const health = auditor.writeHealth()
  if (health.status === 'error') {
    return { id: 'audit-writable', status: 'fail', detail: `the last audit write failed: ${health.error ?? 'unknown error'}` }
  }
  if (health.status === 'none') {
    return { id: 'audit-writable', status: 'unknown', detail: 'no audit write recorded yet' }
  }
  return {
    id: 'audit-writable',
    status: 'pass',
    detail: `last audit write landed at ${new Date(health.atMs ?? 0).toISOString()}`,
  }
}

function sensitiveRulesItem(
  policy: ReadinessInput['sensitivePolicy'],
  platform: NodeJS.Platform,
): ReadinessCheckItem {
  const sizes = `${policy.blocklistSize} blocklist / ${policy.allowlistSize} allowlist pattern(s) compiled`
  if (platform === 'darwin') {
    return {
      id: 'sensitive-window-rules',
      status: 'unknown',
      detail: `${sizes}, but macOS cannot read window titles — the capture gate is fail-open there`,
    }
  }
  if (policy.blocklistSize === 0) {
    return {
      id: 'sensitive-window-rules',
      status: 'pass',
      detail: `${sizes}; sensitive-capture refusal is disabled by configuration`,
    }
  }
  return {
    id: 'sensitive-window-rules',
    status: 'pass',
    detail: `${sizes}; the sidecar enforces them before any capture`,
  }
}

function monitorItem(
  config: ReadinessInput['config'],
  facts: SidecarReadinessFacts | undefined,
  platform: NodeJS.Platform,
): ReadinessCheckItem {
  const disabledByConfig = config.takeoverHotkey.length === 0 && !config.pauseOnUserInput
  if (disabledByConfig) {
    return {
      id: 'takeover-monitor',
      status: 'pass',
      detail: 'takeover monitoring disabled by configuration (no hotkey, user-input pause off)',
    }
  }
  if (platform === 'darwin') {
    return {
      id: 'takeover-monitor',
      status: 'unknown',
      detail: 'the monitor does not run on macOS; takeover hotkey and user-input pause are unavailable there',
    }
  }
  if (facts === undefined || !facts.connected) {
    return {
      id: 'takeover-monitor',
      status: 'unknown',
      detail: 'the monitor runs inside the sidecar; it is not connected',
    }
  }
  return {
    id: 'takeover-monitor',
    status: 'pass',
    detail: `monitor arms at sidecar startup (hotkey ${hotkeyLabel(config.takeoverHotkey)}, user-input pause `
      + `${config.pauseOnUserInput ? 'on' : 'off'}); desktop control is ${facts.paused ? 'paused' : 'running'}`,
  }
}

function stepBudgetItem(
  config: ReadinessInput['config'],
  session: ReadinessInput['session'],
): ReadinessCheckItem | undefined {
  if (session === undefined) return undefined
  const remaining = config.maxSteps - session.stepsUsed
  if (remaining <= 0) {
    return {
      id: 'step-budget',
      status: 'fail',
      detail: `the session reached its ${config.maxSteps}-action ceiling; further actions are refused`,
    }
  }
  return {
    id: 'step-budget',
    status: 'pass',
    detail: `${remaining}/${config.maxSteps} actions remaining for this session`,
  }
}

/**
 * Collect one readiness report from the owners' read-only views.
 * @param input - subsystem facts to fold into the checklist.
 * @param nowMs - clock override for tests; defaults to `Date.now()`.
 * @returns every item with a verdict and reason, plus the report-level rollup.
 */
export function collectReadiness(input: ReadinessInput, nowMs: number = Date.now()): ReadinessReport {
  const platform = input.platform ?? process.platform
  const checks: ReadinessCheckItem[] = [
    sidecarConnectionItem(input.sidecar),
    toolSurfaceItem(input.sidecar),
    approvalQuotaItem(input.config, input.session, nowMs),
    breakerItem(input.config, input.breaker),
    auditItem(input.auditor),
    sensitiveRulesItem(input.sensitivePolicy, platform),
    monitorItem(input.config, input.sidecar, platform),
  ]
  const budget = stepBudgetItem(input.config, input.session)
  if (budget !== undefined) checks.push(budget)
  return { checkedAtMs: nowMs, overall: overallOf(checks), checks }
}
