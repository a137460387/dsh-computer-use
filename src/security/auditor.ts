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
  /** Log one lifecycle transition (mount, sidecar lifetime, pause/resume). */
  recordLifecycle(event: LifecycleEvent): void
}

/** One append behind a serial queue so concurrent events never interleave. */
class AuditLog {
  private queue: Promise<unknown> = Promise.resolve()
  private dirEnsured = false

  constructor(private readonly path: string) {}

  append(line: Record<string, unknown>): void {
    this.queue = this.queue.then(async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true })
        this.dirEnsured = true
      }
      await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8')
    }, () => {})
  }
}

/**
 * Mount the auditor: event listeners for both action phases, the danger
 * channel, and one startup retention sweep. All registrations unwind with the
 * mounting fiber.
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

  void sweepRetention(ctx, config)

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
    recordLifecycle(event: LifecycleEvent): void {
      const { event: name, ...facts } = event
      log.append({
        kind: `lifecycle/${name}`,
        timestamp: new Date().toISOString(),
        ...facts,
      })
    },
  }
}

/** Prune audit lines and archived screenshots past the retention window. */
async function sweepRetention(ctx: Context, config: ComputerUseConfig): Promise<void> {
  const cutoffMs = Date.now() - config.auditRetentionDays * 86_400_000
  try {
    const raw = await readFile(config.auditLogPath, 'utf8')
    const kept = raw.split('\n').filter((line) => {
      if (line.trim() === '') return false
      try {
        const record = JSON.parse(line) as { timestamp?: unknown }
        if (typeof record.timestamp !== 'string') return true
        return new Date(record.timestamp).getTime() >= cutoffMs
      } catch {
        // Unparseable legacy lines stay — deletion is not the remedy.
        return true
      }
    })
    await writeFile(config.auditLogPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn(`dsh-computer-use: audit retention sweep failed: ${String(error)}`)
    }
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
