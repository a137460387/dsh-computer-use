/**
 * Behavior audit: every action appends one JSON line to the deployment's
 * audit log (timestamp, session, action type, coordinates/detail, hashes,
 * outcome), high-risk danger blocks are logged separately, and a retention
 * sweep prunes log lines and archived screenshots older than the configured
 * window. Screenshot ARCHIVE bytes and breaker HASH fingerprints stay in
 * separate stores by design.
 * @module dsh-computer-use/security/auditor
 */

import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { RiskTier } from '../answerer.ts'
import type { ComputerUseConfig } from '../config.ts'
import type { AfterActionEvent, BeforeActionEvent } from '../definition/index.ts'

/** Extra audit facts for one danger-intercepted payload. */
export interface DangerAuditRecord {
  /** Session whose tool call carried the payload, when known. */
  readonly sessionId?: string
  /** The tool that refused the payload. */
  readonly toolName: string
  /** The danger pattern that fired. */
  readonly pattern: string
  /** Payload length in UTF-8 bytes (content itself stays out of the log). */
  readonly textBytes: number
}

/** Extra audit facts for one sensitive-window capture refusal. */
export interface SensitiveWindowAuditRecord {
  /** Session whose screen_shot was refused, when known. */
  readonly sessionId?: string
  /** Foreground window title that matched (screen content never logged). */
  readonly windowTitle: string
  /** The configured pattern source that fired. */
  readonly pattern: string
}

/** Extra audit facts for one pre-dispatch auto-approval grant. */
export interface AutoApprovalAuditRecord {
  /** Session whose action auto-granted. */
  readonly sessionId: string
  /** The tool that auto-granted. */
  readonly toolName: string
  /** Risk tier of the auto-granted action. */
  readonly tier: RiskTier
}

/** Extra audit facts for one post-action semantic verification verdict. */
export interface VerificationAuditRecord {
  /** Session whose action was verified, when known. */
  readonly sessionId?: string
  /** The tool whose action was verified. */
  readonly toolName: string
  /** The flash model's verdict on whether the intended effect happened. */
  readonly verdict: 'yes' | 'no' | 'uncertain'
  /** The model's one-line justification, when one survived parsing. */
  readonly reason?: string
  /** Whether the verdict triggered a zoom-crop click retry. */
  readonly retried: boolean
  /** Retry click point in crop pixels, present once a retry executed. */
  readonly retryX?: number
  /** Retry click point in crop pixels, present once a retry executed. */
  readonly retryY?: number
  /** Observation of the zoom crop the retry clicked on, when it executed. */
  readonly retryObservationId?: string
}

/** Health of the audit sink's most recent write attempt. */
export interface AuditWriteHealth {
  /** `ok`: last write landed; `error`: it failed; `none`: nothing written yet. */
  readonly status: 'ok' | 'error' | 'none'
  /** When the recorded attempt happened, absent for `none`. */
  readonly atMs?: number
  /** Failure diagnostics, present exactly for `error`. */
  readonly error?: string
}

/** Why desktop control paused or resumed. */
export type PauseReason = 'hotkey' | 'user-input' | 'manual'

/** Who terminated the sidecar process. */
export type SidecarExitTrigger = 'shutdown' | 'restart' | 'crash'

/** One lifecycle fact appended to the audit log (`lifecycle/<event>` lines). */
export type LifecycleEvent =
  | {
    readonly event: 'mounted'
    readonly platform: string
    readonly visionRoutesConfigured: boolean
    readonly visionRoute: string
    readonly changeDetectionRoute: string
  }
  | { readonly event: 'routes-missing'; readonly missing: readonly string[] }
  | { readonly event: 'sidecar-starting'; readonly mode: 'prod' | 'dev'; readonly description: string }
  | { readonly event: 'sidecar-connected'; readonly version: string }
  | {
    readonly event: 'sidecar-exited'
    readonly exitCode: number | null
    readonly signal: string | null
    readonly trigger: SidecarExitTrigger
  }
  | { readonly event: 'paused'; readonly reason: PauseReason }
  | { readonly event: 'resumed'; readonly reason: PauseReason }

/** Append-only audit sink plus the danger, sensitive-window, and lifecycle channels. */
export interface Auditor {
  /** Log one danger interception as a high-risk event. */
  recordDanger(record: DangerAuditRecord): void
  /** Log one sensitive-window capture refusal as a high-risk event. */
  recordSensitiveWindow(record: SensitiveWindowAuditRecord): void
  /**
   * Log one pre-dispatch auto-approval grant; escalated requests need no
   * plugin line because the ApprovalService logs its own session events.
   */
  recordAutoApproval(record: AutoApprovalAuditRecord): void
  /** Log one post-action semantic verification verdict (advisory channel). */
  recordVerification(record: VerificationAuditRecord): void
  /** Log one lifecycle transition (mount, sidecar lifetime, pause/resume). */
  recordLifecycle(event: LifecycleEvent): void
  /** Run one retention sweep now; resolves when the pruning hits disk. */
  sweepRetention(): Promise<void>
  /** Health of the sink's most recent write attempt (readiness diagnostics). */
  writeHealth(): AuditWriteHealth
}

/**
 * Append-only audit file behind one serial queue: appends never interleave,
 * and the retention rewrite rides the same queue, so a sweep can never
 * overwrite an append that was queued around it.
 */
class AuditLog {
  private queue: Promise<unknown> = Promise.resolve()
  private dirEnsured = false
  private lastWrite: AuditWriteHealth = { status: 'none' }

  constructor(private readonly path: string) {}

  /** Health of the most recent queued write attempt. */
  writeHealth(): AuditWriteHealth {
    return this.lastWrite
  }

  /** Record one write attempt outcome; later attempts overwrite it. */
  noteWriteOutcome(error: unknown): void {
    this.lastWrite = error === undefined
      ? { status: 'ok', atMs: Date.now() }
      : { status: 'error', atMs: Date.now(), error: String(error) }
  }

  /** Queue one JSON line; a failed append never breaks the serial chain. */
  append(line: Record<string, unknown>): void {
    void this.enqueue(async () => {
      await this.ensureDir()
      await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8')
    }).then(
      () => this.noteWriteOutcome(undefined),
      (error: unknown) => {
        this.noteWriteOutcome(error)
        // Append I/O failures stay swallowed at the queue tail: the audit sink
        // must not surface an unhandled rejection into its host, and the chain
        // already continues past a rejected step. The write-health state above
        // is how readiness diagnostics observe the failure.
      },
    )
  }

  /**
   * Rewrite the file as one queued step. Appends queued before the rewrite
   * land in the rewritten content; appends queued after it land untouched.
   * @param keep - per-line predicate; blank lines are dropped regardless.
   * @returns resolves when the rewrite hits disk; rejects on I/O failure.
   */
  compact(keep: (rawLine: string) => boolean): Promise<void> {
    return this.enqueue(async () => {
      let raw: string
      try {
        raw = await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const kept = raw.split('\n').filter(rawLine => rawLine.trim() !== '' && keep(rawLine))
      await writeFile(this.path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    }).then(
      () => this.noteWriteOutcome(undefined),
      (error: unknown) => {
        this.noteWriteOutcome(error)
        throw error
      },
    )
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    await mkdir(dirname(this.path), { recursive: true })
    this.dirEnsured = true
  }

  /** Chain one step behind the queue; later steps survive a rejected step. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run: Promise<void> = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Mount the auditor: event listeners for both action phases, the danger
 * channel, and one startup retention sweep serialized behind the append
 * queue (it can never overwrite a line queued at mount). All registrations
 * unwind with the mounting fiber.
 * @param ctx - host context carrying the event stream.
 * @param config - validated deployment policy (paths and retention).
 * @returns the danger channel.
 */
export function createAuditor(ctx: Context, config: ComputerUseConfig): Auditor {
  const log = new AuditLog(config.auditLogPath)

  ctx.on('computer-use/before-action', (event: BeforeActionEvent) => {
    log.append({
      kind: 'action/before',
      timestamp: new Date(event.atMs).toISOString(),
      ...event.sessionId !== undefined ? { sessionId: event.sessionId } : {},
      actionType: event.action,
      ...event.observationId !== undefined ? { observationId: event.observationId } : {},
      ...event.detail !== undefined ? { detail: event.detail } : {},
    })
  })

  ctx.on('computer-use/after-action', (event: AfterActionEvent) => {
    log.append({
      kind: 'action/after',
      timestamp: new Date(event.atMs).toISOString(),
      ...event.sessionId !== undefined ? { sessionId: event.sessionId } : {},
      actionType: event.action,
      success: event.success,
      durationMs: event.durationMs,
      ...event.observationId !== undefined ? { observationId: event.observationId } : {},
      ...event.detail !== undefined ? { detail: event.detail } : {},
      ...event.beforeHash !== undefined ? { beforeHash: event.beforeHash } : {},
      ...event.afterHash !== undefined ? { afterHash: event.afterHash } : {},
    })
  })

  void runRetentionSweep(ctx, config, log)

  return {
    recordDanger(record: DangerAuditRecord): void {
      log.append({
        kind: 'danger/blocked',
        severity: 'high',
        timestamp: new Date().toISOString(),
        ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
        toolName: record.toolName,
        pattern: record.pattern,
        textBytes: record.textBytes,
      })
    },
    recordSensitiveWindow(record: SensitiveWindowAuditRecord): void {
      log.append({
        kind: 'danger/sensitive-window',
        severity: 'high',
        timestamp: new Date().toISOString(),
        ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
        windowTitle: record.windowTitle,
        pattern: record.pattern,
      })
    },
    recordAutoApproval(record: AutoApprovalAuditRecord): void {
      log.append({
        kind: 'answer/auto-allowed',
        timestamp: new Date().toISOString(),
        sessionId: record.sessionId,
        toolName: record.toolName,
        tier: record.tier,
      })
    },
    recordVerification(record: VerificationAuditRecord): void {
      log.append({
        kind: 'verification/result',
        timestamp: new Date().toISOString(),
        ...record.sessionId !== undefined ? { sessionId: record.sessionId } : {},
        toolName: record.toolName,
        verdict: record.verdict,
        ...record.reason !== undefined ? { reason: record.reason } : {},
        retried: record.retried,
        ...record.retryX !== undefined ? { retryX: record.retryX } : {},
        ...record.retryY !== undefined ? { retryY: record.retryY } : {},
        ...record.retryObservationId !== undefined ? { retryObservationId: record.retryObservationId } : {},
      })
    },
    recordLifecycle(event: LifecycleEvent): void {
      const { event: name, ...facts } = event
      log.append({
        kind: `lifecycle/${name}`,
        timestamp: new Date().toISOString(),
        ...facts,
      })
    },
    sweepRetention: () => runRetentionSweep(ctx, config, log),
    writeHealth: () => log.writeHealth(),
  }
}

/** Prune audit lines and archived screenshots past the retention window. */
async function runRetentionSweep(ctx: Context, config: ComputerUseConfig, log: AuditLog): Promise<void> {
  const cutoffMs = Date.now() - config.auditRetentionDays * 86_400_000
  try {
    // The rewrite rides the append queue: an audit line queued before this
    // sweep is part of the rewritten content, and one queued after it lands
    // untouched, so the startup sweep can never drop a mount-time line.
    await log.compact((rawLine) => {
      try {
        const record = JSON.parse(rawLine) as { timestamp?: unknown }
        if (typeof record.timestamp !== 'string') return true
        return new Date(record.timestamp).getTime() >= cutoffMs
      } catch {
        // Unparseable legacy lines stay — deletion is not the remedy.
        return true
      }
    })
  } catch (error) {
    ctx.logger.warn(`dsh-computer-use: audit retention sweep failed: ${String(error)}`)
  }
  try {
    const entries = await readdir(config.screenshotArchivePath)
    await Promise.all(entries.map(async (entry) => {
      if (!entry.endsWith('.jpg')) return
      const path = join(config.screenshotArchivePath, entry)
      const facts = await stat(path)
      if (facts.mtimeMs < cutoffMs) await unlink(path)
    }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`dsh-computer-use: screenshot retention sweep failed: ${String(error)}`)
    }
  }
}
