/**
 * Service Provider: `ComputerUseRuntime` over a Python MCP sidecar.
 *
 * The sidecar is spawned through `ctx.subprocess` (never child_process) and
 * spoken to with standard MCP JSON-RPC over its stdio streams through a
 * transport this module owns. Screenshot bytes travel as archived files on the
 * host filesystem — only paths and metadata cross the wire. Every call
 * serializes through one queue (the sidecar is a single-instance executor),
 * observations expire after the configured TTL, a health ping watches the
 * connection, and teardown reaches full process-tree quiescence.
 *
 * Pause ownership: the sidecar's background monitor (takeover hotkey,
 * user-input detection) is the source of truth; every pause/resume transition
 * is pushed here as a `notifications/dsh-cu/pause-state` notification the
 * transport intercepts before the MCP SDK (each carries the sidecar's
 * monotonic transition counter). This mirror drives the lifecycle audit,
 * re-broadcasts transitions on `computer-use/pause-transition`, and
 * re-engages the pause after any sidecar restart — under the `confirm`
 * reason while a confirm-gate wait is pending — so a crash never silently
 * unpauses desktop control.
 * @module dsh-computer-use/provider-mcp
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ComputerUseConfig } from '../config.ts'
import {
  ComputerUseRuntime,
  ObservationId,
} from '../definition/index.ts'
import type {
  ActionResult,
  ClickAtRequest,
  ComputerUseActionType,
  DisplayInfo,
  HotkeyRequest,
  PauseActionsResult,
  PauseRequestReason,
  ScreenShot,
  ScreenShotOptions,
  ScrollRequest,
  TypeTextRequest,
} from '../definition/index.ts'
import type { Auditor, PauseReason, SidecarExitTrigger } from '../security/auditor.ts'
import type { ConfirmGate } from '../security/confirm-gate.ts'
import {
  PAUSED_MARKER,
  PausedRefusal,
  SENSITIVE_WINDOW_MARKER,
  SensitiveWindowRefusal,
  hotkeyLabel,
  parseSensitiveWindowFacts,
} from '../security/refusals.ts'
import type { SidecarReadinessFacts } from '../diagnostics/readiness.ts'
import { normalizeHotkey } from '../tools/shared.ts'

/** Sidecar protocol version prefix this plugin is compatible with. */
const COMPATIBLE_SERVER_PREFIX = '0.1.'

/**
 * The sidecar tool surface every handshake must prove before any call is
 * served: the seven model-exposed actions plus the three internal tools
 * (`get_foreground_window` for the whitelist, `pause_actions` for the
 * pause re-hold after restarts, `arm_danger_token` for the confirm gate's
 * single-use backstop token).
 */
export const REQUIRED_SIDECAR_TOOLS = [
  'get_display_info',
  'screen_shot',
  'click_at',
  'type_text',
  'scroll',
  'hotkey',
  'get_foreground_window',
  'resume_actions',
  'pause_actions',
  'arm_danger_token',
] as const

/**
 * Plugin identity version reported during the MCP handshake.
 * Sync point: keep aligned with package.json `version` and
 * src-python/main.py `VERSION` (one release moves all three).
 */
const PLUGIN_VERSION = '0.1.4'

/** Diagnostic tail retained from sidecar stderr. */
const STDERR_DIAGNOSTIC_BYTES = 65_536

/** This package's root (the provider lives two directories below it). */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Method name of the sidecar's pause-state push notification. */
const PAUSE_STATE_NOTIFICATION = 'notifications/dsh-cu/pause-state'

/** One cached observation with its freshness timer. */
interface StoredObservation {
  readonly capturedAtMs: number
  readonly width: number
  readonly height: number
  readonly dhash: string
  readonly path: string
  readonly data: Uint8Array
  readonly expiryTimer: NodeJS.Timeout
}

/** Launch resolution for one sidecar start. */
export interface SidecarLaunch {
  /** argv for `ctx.subprocess.spawn`. */
  readonly argv: readonly string[]
  /** Resolved launch mode. */
  readonly mode: 'prod' | 'dev'
  /** Human-readable launch description for diagnostics. */
  readonly description: string
}

/** Platform binary tag, e.g. `win-x64` or `macos-arm64`. */
function platformTag(): { tag: string; extension: string } {
  if (process.platform === 'win32') return { tag: `win-${process.arch}`, extension: '.exe' }
  if (process.platform === 'darwin') return { tag: `macos-${process.arch}`, extension: '' }
  throw new Error(`dsh-computer-use: no sidecar binary naming for ${process.platform}`)
}

/**
 * Lazily resolve the production sidecar binary path. Existence is checked
 * here (first use), never at plugin load: a missing binary is a first-call
 * error with acquisition guidance, not a load failure.
 * @returns the absolute binary path, whether or not it exists.
 */
export function computerUseBinaryPath(): string {
  const { tag, extension } = platformTag()
  return join(PACKAGE_ROOT, 'bin', `dsh-cu-server-${tag}${extension}`)
}

/**
 * Resolve the sidecar launch for one start. Mode selection: an explicit
 * `serverMode` wins; otherwise the production binary is used when present and
 * the Python source otherwise (development fallback).
 * @param config - validated deployment policy.
 * @returns argv, mode, and a diagnostic description.
 * @throws when a forced mode is unavailable, with acquisition guidance.
 */
export function resolveSidecarLaunch(config: ComputerUseConfig): SidecarLaunch {
  const binary = computerUseBinaryPath()
  const binaryExists = existsSync(binary)
  const mode = config.serverMode ?? (binaryExists ? 'prod' : 'dev')
  if (mode === 'prod') {
    if (!binaryExists) {
      throw new Error(
        `dsh-computer-use: the production sidecar binary is missing at ${binary}; `
        + 'build it with `pnpm run build:python` (PyInstaller) or download the matching '
        + 'dsh-cu-server release asset into bin/ — or set DSH_CU_MODE=dev to run the Python source',
      )
    }
    return { argv: [binary], mode, description: `prod binary ${binary}` }
  }
  const script = join(PACKAGE_ROOT, 'src-python', 'main.py')
  if (!existsSync(script)) {
    throw new Error(`dsh-computer-use: the dev sidecar script is missing at ${script}`)
  }
  return { argv: [config.pythonCommand, script], mode, description: `dev script ${config.pythonCommand} ${script}` }
}

/** A plugin-namespaced sidecar notification intercepted before the MCP SDK. */
interface SidecarNotificationMessage {
  readonly method: string
  readonly params?: unknown
}

/** Whether one parsed line is a plugin-namespaced sidecar notification. */
function isSidecarNotification(message: unknown): message is SidecarNotificationMessage {
  return typeof message === 'object' && message !== null
    && typeof (message as { method?: unknown }).method === 'string'
    && (message as { method: string }).method.startsWith('notifications/dsh-cu/')
}

/**
 * MCP Transport bridged onto a `ctx.subprocess` handle: newline-delimited
 * JSON-RPC written to the child's stdin, parsed from its stdout. The
 * subprocess seam owns the process lifetime; this transport owns only the
 * protocol framing over its streams. Lines carrying `notifications/dsh-cu/*`
 * go to {@link onSidecarNotification} instead of the MCP SDK.
 */
class SidecarTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** One intercepted plugin-namespaced notification. */
  onSidecarNotification?: (message: SidecarNotificationMessage) => void

  private buffer = ''
  private closed = false

  constructor(private readonly handle: SubprocessHandle) {}

  async start(): Promise<void> {
    const stdout = this.handle.stdout
    if (stdout === undefined) throw new Error('dsh-computer-use: sidecar stdout is not piped')
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let separator = this.buffer.indexOf('\n')
      while (separator >= 0) {
        const line = this.buffer.slice(0, separator).trim()
        this.buffer = this.buffer.slice(separator + 1)
        separator = this.buffer.indexOf('\n')
        if (line === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          this.onerror?.(new Error(`dsh-computer-use: sidecar sent an unparseable line: ${String(error)}`))
          continue
        }
        if (isSidecarNotification(parsed)) {
          this.onSidecarNotification?.(parsed)
        } else {
          this.onmessage?.(parsed as JSONRPCMessage)
        }
      }
    })
    stdout.on('close', () => {
      if (!this.closed) {
        this.closed = true
        this.onclose?.()
      }
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.handle.stdin
    if (stdin === undefined || this.closed) {
      return Promise.reject(new Error('dsh-computer-use: sidecar stdin is unavailable'))
    }
    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) reject(error)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.handle.stdin?.end()
    this.onclose?.()
  }
}

/** Typed sidecar `tools/call` results this provider consumes. */
interface SidecarScreenShotResult {
  observationId: string
  path: string
  width: number
  height: number
  bytes: number
  dhash: string
  capturedAtMs: number
  /** Present exactly when the capture drew a synthetic cursor overlay. */
  cursorOverlay?: { x: number; y: number }
  /** Present exactly for zoom-crop captures: the sub-rectangle in full-capture pixels. */
  captureRegion?: { x: number; y: number; width: number; height: number }
}

/**
 * Structural view of one MCP `tools/call` result. The SDK's generic return
 * type leaves content untyped without a result schema; this provider reads
 * `structuredContent` (or the first text block) and validates downstream.
 */
interface McpToolResultShape {
  readonly isError?: boolean
  readonly content?: readonly unknown[]
  readonly structuredContent?: unknown
}

/**
 * The MCP-backed computer-use service. Mounted by the bundle entry with the
 * validated {@link ComputerUseConfig}, the bundle auditor, and the confirm
 * gate whose pending wait steers the restart pause re-hold; the sidecar
 * starts lazily at first use.
 */
export default class McpComputerUseProvider extends ComputerUseRuntime {
  private readonly config: ComputerUseConfig
  private readonly auditor: Auditor
  /** Confirm gate consulting the pause re-hold; absent keeps the pre-gate hold. */
  private readonly confirmGate: ConfirmGate | undefined
  private handle: SubprocessHandle | undefined
  private client: Client | undefined
  private transport: SidecarTransport | undefined
  private starting: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly observations = new Map<string, StoredObservation>()
  private healthTimer: NodeJS.Timeout | undefined
  private disposed = false
  /** Pause mirror of the sidecar's state, driven by push notifications. */
  private paused = false
  /** Attribution for the next sidecar exit; defaults to the crash reading. */
  private exitTrigger: SidecarExitTrigger = 'crash'
  /** Whether a sidecar start was ever attempted (readiness diagnostics). */
  private everStarted = false
  /** Version proven at the current handshake (readiness diagnostics). */
  private serverVersion: string | undefined
  /** Tool count enumerated at the current handshake (readiness diagnostics). */
  private connectedToolCount: number | undefined

  constructor(ctx: Context, config: ComputerUseConfig, auditor: Auditor, confirmGate?: ConfirmGate) {
    super(ctx)
    this.config = config
    this.auditor = auditor
    this.confirmGate = confirmGate
    ctx.effect(() => {
      return async () => {
        this.disposed = true
        if (this.healthTimer !== undefined) clearInterval(this.healthTimer)
        for (const observation of this.observations.values()) clearTimeout(observation.expiryTimer)
        this.observations.clear()
        const client = this.client
        const handle = this.handle
        this.client = undefined
        if (client !== undefined) await client.close().catch(() => {})
        if (handle !== undefined) {
          this.exitTrigger = 'shutdown'
          handle.terminate()
          await handle.waitForExit()
        }
        this.handle = undefined
      }
    })
  }

  // ── sidecar lifecycle ──────────────────────────────────────────────────────

  /** Ensure a connected sidecar; starts it lazily on first use. */
  private async ensureSidecar(): Promise<Client> {
    if (this.disposed) throw new Error('dsh-computer-use: the provider is disposed')
    if (this.client !== undefined) return this.client
    this.starting ??= this.startSidecar().finally(() => { this.starting = undefined })
    await this.starting
    if (this.client === undefined) throw new Error('dsh-computer-use: sidecar startup did not produce a client')
    return this.client
  }

  private async startSidecar(): Promise<void> {
    this.everStarted = true
    const launch = resolveSidecarLaunch(this.config)
    this.auditor.recordLifecycle({ event: 'sidecar-starting', mode: launch.mode, description: launch.description })
    this.ctx.logger.info(`dsh-computer-use: starting sidecar (${launch.description})`)
    const handle = this.ctx.subprocess.spawn({
      argv: launch.argv,
      cwd: PACKAGE_ROOT,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: STDERR_DIAGNOSTIC_BYTES },
      },
      graceMs: this.config.processGraceMs,
      env: {
        ...scrubbedParentEnv(),
        // Deliberate DSH_* opt-ins over the scrubbed base (subprocess contract):
        // the sidecar's archive directory, freshness window, and takeover policy
        // are deployment facts.
        DSH_CU_SCREENSHOT_DIR: this.config.screenshotArchivePath,
        DSH_CU_OBSERVATION_TTL_MS: String(this.config.observationTtlMs),
        DSH_CU_TAKEOVER_HOTKEY: normalizeHotkey(this.config.takeoverHotkey),
        DSH_CU_PAUSE_ON_USER_INPUT: this.config.pauseOnUserInput ? '1' : '0',
        DSH_CU_USER_INPUT_GRACE_MS: String(this.config.userInputGraceMs),
        DSH_CU_MONITOR_STARTUP_GRACE_MS: String(this.config.monitorStartupGraceMs),
        DSH_CU_SENSITIVE_WINDOW_PATTERNS: JSON.stringify(this.config.sensitiveWindowPatterns),
        DSH_CU_SENSITIVE_WINDOW_ALLOWLIST: JSON.stringify(this.config.sensitiveWindowAllowlist),
        PYTHONIOENCODING: 'utf-8',
      },
    })
    this.handle = handle
    // A crashed sidecar must not drag the harness down: mark the connection
    // dead and surface the exit facts on the next call; teardown owns the rest.
    void handle.done.then((outcome) => {
      if (this.handle === handle) {
        const trigger = this.exitTrigger
        this.exitTrigger = 'crash'
        this.auditor.recordLifecycle({
          event: 'sidecar-exited',
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          trigger,
        })
        this.ctx.logger.warn(
          `dsh-computer-use: sidecar exited (exitCode ${String(outcome.exitCode)}, `
          + `signal ${String(outcome.signal)}, trigger ${trigger})`,
        )
        this.client = undefined
        this.transport = undefined
        this.handle = undefined
        this.serverVersion = undefined
        this.connectedToolCount = undefined
        this.stopHealthCheck()
      }
    }, () => {})

    const transport = new SidecarTransport(handle)
    transport.onSidecarNotification = message => this.handleSidecarNotification(message)
    const client = new Client(
      { name: 'dsh-computer-use', version: PLUGIN_VERSION },
      { capabilities: {} },
    )
    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = undefined
        this.transport = undefined
        this.serverVersion = undefined
        this.connectedToolCount = undefined
        this.stopHealthCheck()
      }
    }
    try {
      await client.connect(transport)
    } catch (error) {
      this.exitTrigger = 'shutdown'
      handle.terminate()
      await handle.waitForExit()
      this.handle = undefined
      const stderrTail = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      throw new Error(
        `dsh-computer-use: MCP handshake failed: ${String(error)}`
        + `${stderrTail === '' ? '' : ` — sidecar: ${stderrTail.slice(-500)}`}`,
      )
    }

    const server = client.getServerVersion()
    if (server === undefined || !server.version.startsWith(COMPATIBLE_SERVER_PREFIX)) {
      this.exitTrigger = 'shutdown'
      await client.close()
      handle.terminate()
      await handle.waitForExit()
      this.handle = undefined
      throw new Error(
        `dsh-computer-use: sidecar version "${server?.version ?? 'unknown'}" is incompatible `
        + `(expected ${COMPATIBLE_SERVER_PREFIX}*)`,
      )
    }
    this.auditor.recordLifecycle({ event: 'sidecar-connected', version: server.version })

    // Prove the expected tool surface before serving any call.
    const tools = await client.listTools()
    const names = new Set(tools.tools.map(tool => tool.name))
    for (const required of REQUIRED_SIDECAR_TOOLS) {
      if (!names.has(required)) {
        this.exitTrigger = 'shutdown'
        await client.close()
        handle.terminate()
        await handle.waitForExit()
        this.handle = undefined
        throw new Error(`dsh-computer-use: sidecar does not advertise the "${required}" tool`)
      }
    }

    // A reconnecting sidecar starts unpaused; re-engage the user's pause so a
    // crash or health restart never silently unpauses desktop control. A
    // pending confirm wait re-holds under its own reason: the confirm signal
    // (a takeover-hotkey resume) must stay meaningful across the restart.
    if (this.paused) {
      const reholdReason = this.confirmGate?.hasPendingConfirm === true ? 'confirm' : 'manual'
      const rehold = await client.callTool({ name: 'pause_actions', arguments: { reason: reholdReason } }, undefined, {
        timeout: this.config.rpcTimeoutMs,
      }) as McpToolResultShape
      if (rehold.isError === true) {
        this.exitTrigger = 'shutdown'
        await client.close()
        handle.terminate()
        await handle.waitForExit()
        this.handle = undefined
        throw new Error('dsh-computer-use: could not re-engage the pause state after a sidecar restart')
      }
    }

    this.client = client
    this.transport = transport
    this.serverVersion = server.version
    this.connectedToolCount = tools.tools.length
    this.startHealthCheck()
    this.ctx.logger.info(`dsh-computer-use: sidecar connected (${server.name} v${server.version})`)
  }

  /** One intercepted sidecar notification; pause transitions drive the mirror. */
  private handleSidecarNotification(message: SidecarNotificationMessage): void {
    if (message.method !== PAUSE_STATE_NOTIFICATION) return
    const params = message.params
    if (typeof params !== 'object' || params === null) return
    const { paused, reason, transitionSeq } = params as { paused?: unknown; reason?: unknown; transitionSeq?: unknown }
    if (typeof paused !== 'boolean' || paused === this.paused) return
    this.paused = paused
    const safeReason: PauseReason = reason === 'hotkey' || reason === 'user-input' || reason === 'manual' || reason === 'confirm'
      ? reason
      : 'manual'
    // A malformed counter degrades to -1: the confirm gate compares resume
    // counters strictly above its ack, so -1 never confirms (fail closed).
    const safeSeq = typeof transitionSeq === 'number' && Number.isFinite(transitionSeq) ? transitionSeq : -1
    this.auditor.recordLifecycle({ event: paused ? 'paused' : 'resumed', reason: safeReason })
    this.ctx.emit('computer-use/pause-transition', { paused, reason: safeReason, transitionSeq: safeSeq })
    this.ctx.logger.info(`dsh-computer-use: desktop control ${paused ? 'paused' : 'resumed'} (${safeReason})`)
  }

  private startHealthCheck(): void {
    this.stopHealthCheck()
    this.healthTimer = setInterval(() => {
      const client = this.client
      if (client === undefined) return
      const ping: Promise<unknown> = client.ping()
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('health ping timed out')), this.config.healthCheckTimeoutMs).unref()
      })
      void Promise.race([ping, timeout]).then(undefined, (error: unknown) => {
        this.ctx.logger.warn(`dsh-computer-use: health check failed (${String(error)}); restarting sidecar on next use`)
        void this.restartSidecar()
      })
    }, this.config.healthCheckIntervalMs)
    this.healthTimer.unref()
  }

  private stopHealthCheck(): void {
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer)
    this.healthTimer = undefined
  }

  private async restartSidecar(): Promise<void> {
    const client = this.client
    const handle = this.handle
    this.client = undefined
    this.transport = undefined
    this.serverVersion = undefined
    this.connectedToolCount = undefined
    this.stopHealthCheck()
    if (client !== undefined) await client.close().catch(() => {})
    if (handle !== undefined) {
      this.exitTrigger = 'restart'
      handle.terminate()
      await handle.waitForExit()
    }
    this.handle = undefined
  }

  // ── readiness diagnostics ──────────────────────────────────────────────────

  /**
   * Read-only connection facts for the readiness checklist. Never touches
   * the sidecar: an unstarted provider reports its lazy-start state instead
   * of spawning a process for a diagnostics call.
   * @returns the current sidecar facts snapshot.
   */
  readinessFacts(): SidecarReadinessFacts {
    const connected = this.client !== undefined
    return {
      connected,
      startedOnce: this.everStarted,
      disposed: this.disposed,
      requiredToolSurfaceSize: REQUIRED_SIDECAR_TOOLS.length,
      paused: this.paused,
      healthCheckActive: this.healthTimer !== undefined,
      ...connected && this.serverVersion !== undefined ? { serverVersion: this.serverVersion } : {},
      ...connected && this.connectedToolCount !== undefined ? { toolSurfaceSize: this.connectedToolCount } : {},
    }
  }

  // ── serialized sidecar calls ───────────────────────────────────────────────

  /** Run one sidecar call behind the single-instance queue. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** One `tools/call` round trip returning the sidecar's structured content. */
  private async callSidecar<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.ensureSidecar()
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: this.config.rpcTimeoutMs,
      resetTimeoutOnProgress: true,
    }) as McpToolResultShape
    if (result.isError === true) {
      const text = (result.content ?? [])
        .map((block: unknown): string => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
        .join('\n')
      throw this.refusalError(name, text)
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T
    const first = result.content?.[0]
    if (first !== undefined && typeof first === 'object' && first !== null && 'text' in first) {
      return JSON.parse(String((first as { text: unknown }).text)) as T
    }
    throw new Error(`dsh-computer-use: sidecar returned no usable content for ${name}`)
  }

  /** Typed error for one sidecar refusal, annotated with recovery guidance. */
  private refusalError(name: string, text: string): Error {
    if (text.startsWith(PAUSED_MARKER)) {
      return new PausedRefusal(
        `dsh-computer-use: ${name} refused — desktop control is paused (the user took over); `
        + `press the takeover hotkey (${hotkeyLabel(this.config.takeoverHotkey)}) again or call `
        + 'resume_actions to resume',
      )
    }
    if (text.startsWith(SENSITIVE_WINDOW_MARKER)) {
      const facts = parseSensitiveWindowFacts(text)
      if (facts !== undefined) {
        return new SensitiveWindowRefusal(
          facts,
          `dsh-computer-use: ${name} refused — the foreground window "${facts.windowTitle}" matches `
          + `sensitive pattern "${facts.pattern}"; no image was captured, persisted, or sent to any model. `
          + 'Switch to another window or add this title to sensitiveWindowAllowlist',
        )
      }
      return new Error(`dsh-computer-use: ${name} refused on a sensitive window: ${text}`)
    }
    return new Error(`dsh-computer-use: sidecar refused ${name}: ${text || 'no diagnostics'}`)
  }

  // ── observations ───────────────────────────────────────────────────────────

  private registerObservation(facts: SidecarScreenShotResult, data: Uint8Array): void {
    const expiryTimer = setTimeout(() => this.expireObservation(facts.observationId), this.config.observationTtlMs)
    expiryTimer.unref()
    this.observations.set(facts.observationId, {
      capturedAtMs: facts.capturedAtMs,
      width: facts.width,
      height: facts.height,
      dhash: facts.dhash,
      path: facts.path,
      data,
      expiryTimer,
    })
  }

  private expireObservation(id: string): void {
    const stored = this.observations.get(id)
    if (stored === undefined) return
    clearTimeout(stored.expiryTimer)
    this.observations.delete(id)
    this.ctx.emit('computer-use/observation-expired', {
      observationId: ObservationId(id),
      expiredAtMs: Date.now(),
    })
  }

  /**
   * Refuse stale or unknown observation references with a clear reason;
   * every refusal writes an `action/refused` audit line, since the refused
   * action never reaches the before/after events.
   * @param id - the observation reference to check, when the action has one.
   * @param action - the action being gated, named on the refusal line.
   */
  private assertObservationFresh(id: ObservationId | undefined, action: ComputerUseActionType): void {
    if (id === undefined) return
    const stored = this.observations.get(id)
    if (stored === undefined) {
      this.auditor.recordActionRefusal({ actionType: action, observationId: String(id), reason: 'unknown' })
      throw new Error(
        `dsh-computer-use: unknown or expired ObservationId "${id}"; `
        + 'call screen_shot first and reference the id it returned',
      )
    }
    const ageMs = Date.now() - stored.capturedAtMs
    if (ageMs > this.config.observationTtlMs) {
      this.expireObservation(id)
      this.auditor.recordActionRefusal({
        actionType: action,
        observationId: String(id),
        reason: 'expired',
        ageMs,
        ttlMs: this.config.observationTtlMs,
      })
      throw new Error(
        `dsh-computer-use: ObservationId "${id}" expired (${Math.round(ageMs)} ms old; `
        + `freshness window ${this.config.observationTtlMs} ms); capture a fresh screenshot first`,
      )
    }
  }

  // ── ComputerUseRuntime ─────────────────────────────────────────────────────

  async version(): Promise<string> {
    const client = await this.ensureSidecar()
    return client.getServerVersion()?.version ?? 'unknown'
  }

  getDisplayInfo(): Promise<DisplayInfo[]> {
    return this.enqueue(async () => {
      const result = await this.callSidecar<{ displays: DisplayInfo[] }>('get_display_info', {})
      return result.displays
    })
  }

  screenShot(options?: ScreenShotOptions): Promise<ScreenShot> {
    return this.enqueue(async () => {
      const startedAtMs = Date.now()
      this.ctx.emit('computer-use/before-action', { action: 'screen_shot', atMs: startedAtMs })
      const args: Record<string, unknown> = {}
      if (options?.maxWidth !== undefined) args.maxWidth = options.maxWidth
      if (options?.quality !== undefined) args.quality = options.quality
      if (options?.region !== undefined) args.region = options.region
      if (options?.regionOfObservationId !== undefined) args.regionOfObservationId = options.regionOfObservationId
      if (options?.cursorPosition !== undefined) args.cursorPosition = options.cursorPosition
      if (options?.archiveSuffix !== undefined) args.archiveSuffix = options.archiveSuffix
      const facts = await this.callSidecar<SidecarScreenShotResult>('screen_shot', args)
      const data = new Uint8Array(await readFile(facts.path))
      this.registerObservation(facts, data)
      this.ctx.emit('computer-use/after-action', {
        action: 'screen_shot',
        success: true,
        durationMs: Date.now() - startedAtMs,
        observationId: ObservationId(facts.observationId),
        atMs: Date.now(),
      })
      return {
        observationId: ObservationId(facts.observationId),
        data,
        mediaType: 'image/jpeg',
        width: facts.width,
        height: facts.height,
        dhash: facts.dhash,
        capturedAtMs: facts.capturedAtMs,
        ...facts.cursorOverlay !== undefined ? { cursorOverlay: facts.cursorOverlay } : {},
        ...facts.captureRegion !== undefined ? { captureRegion: facts.captureRegion } : {},
      }
    })
  }

  clickAt(request: ClickAtRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId, 'click_at')
      return this.runAction('click_at', request.basedOnObservationId, `x=${request.x} y=${request.y} basis=${request.screenshotWidth}x${request.screenshotHeight}`, () => this.callSidecar<ActionResult>('click_at', {
        x: request.x,
        y: request.y,
        screenshotWidth: request.screenshotWidth,
        screenshotHeight: request.screenshotHeight,
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  typeText(request: TypeTextRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId, 'type_text')
      return this.runAction('type_text', request.basedOnObservationId, `chars=${request.text.length}`, () => this.callSidecar<ActionResult>('type_text', {
        text: request.text,
        ...request.dangerToken !== undefined ? { dangerToken: request.dangerToken } : {},
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  scroll(request: ScrollRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId, 'scroll')
      return this.runAction('scroll', request.basedOnObservationId, `direction=${request.direction} amount=${request.amount}`, () => this.callSidecar<ActionResult>('scroll', {
        direction: request.direction,
        amount: request.amount,
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  hotkey(request: HotkeyRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId, 'hotkey')
      return this.runAction('hotkey', request.basedOnObservationId, `keys=${request.keys.join('+')}`, () => this.callSidecar<ActionResult>('hotkey', {
        keys: [...request.keys],
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  async getObservation(observationId: ObservationId): Promise<ScreenShot | undefined> {
    const stored = this.observations.get(observationId)
    if (stored === undefined) return undefined
    if (Date.now() - stored.capturedAtMs > this.config.observationTtlMs) {
      this.expireObservation(observationId)
      return undefined
    }
    return {
      observationId,
      data: stored.data,
      mediaType: 'image/jpeg',
      width: stored.width,
      height: stored.height,
      dhash: stored.dhash,
      capturedAtMs: stored.capturedAtMs,
    }
  }

  getForegroundWindow(): Promise<string> {
    return this.enqueue(async () => {
      const result = await this.callSidecar<{ name: string }>('get_foreground_window', {})
      return result.name
    })
  }

  resumeActions(): Promise<ActionResult> {
    return this.enqueue(async () => {
      const result = await this.callSidecar<{ success: boolean; resumed: boolean; durationMs: number }>('resume_actions', {})
      return {
        success: true,
        message: result.resumed === true
          ? 'desktop control resumed; action tools are available again'
          : 'desktop control was not paused',
        durationMs: result.durationMs,
      }
    })
  }

  pauseActions(reason: PauseRequestReason): Promise<PauseActionsResult> {
    return this.enqueue(async () => {
      const result = await this.callSidecar<{ success: boolean; paused?: unknown; transitionSeq?: unknown; durationMs: number }>(
        'pause_actions',
        { reason },
      )
      if (typeof result.transitionSeq !== 'number' || !Number.isFinite(result.transitionSeq)) {
        throw new Error('dsh-computer-use: sidecar pause_actions response lacks a usable transitionSeq protocol field')
      }
      return { paused: result.paused === true, transitionSeq: result.transitionSeq, durationMs: result.durationMs }
    })
  }

  armDangerToken(token: string): Promise<void> {
    return this.enqueue(async () => {
      await this.callSidecar<{ success: boolean }>('arm_danger_token', { token })
    })
  }

  /** Wrap one mutating action in before/after events with a common shape. */
  private async runAction(
    action: 'click_at' | 'type_text' | 'scroll' | 'hotkey',
    observationId: ObservationId | undefined,
    detail: string,
    perform: () => Promise<ActionResult>,
  ): Promise<ActionResult> {
    const startedAtMs = Date.now()
    this.ctx.emit('computer-use/before-action', {
      action,
      ...observationId !== undefined ? { observationId } : {},
      detail,
      atMs: startedAtMs,
    })
    try {
      const result = await perform()
      this.ctx.emit('computer-use/after-action', {
        action,
        success: result.success,
        durationMs: result.durationMs,
        ...observationId !== undefined ? { observationId } : {},
        detail,
        atMs: Date.now(),
      })
      return result
    } catch (error) {
      this.ctx.emit('computer-use/after-action', {
        action,
        success: false,
        durationMs: Date.now() - startedAtMs,
        ...observationId !== undefined ? { observationId } : {},
        detail,
        atMs: Date.now(),
      })
      throw error
    }
  }
}
