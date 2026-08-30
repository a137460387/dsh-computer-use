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
  DisplayInfo,
  HotkeyRequest,
  ScreenShot,
  ScreenShotOptions,
  ScrollRequest,
  TypeTextRequest,
} from '../definition/index.ts'

/** Sidecar protocol version prefix this plugin is compatible with. */
const COMPATIBLE_SERVER_PREFIX = '0.1.'

/** Diagnostic tail retained from sidecar stderr. */
const STDERR_DIAGNOSTIC_BYTES = 65_536

/** This package's root (the provider lives two directories below it). */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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
 * @returns argv and a diagnostic description.
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
    return { argv: [binary], description: `prod binary ${binary}` }
  }
  const script = join(PACKAGE_ROOT, 'src-python', 'main.py')
  if (!existsSync(script)) {
    throw new Error(`dsh-computer-use: the dev sidecar script is missing at ${script}`)
  }
  return { argv: [config.pythonCommand, script], description: `dev script ${config.pythonCommand} ${script}` }
}

/**
 * MCP Transport bridged onto a `ctx.subprocess` handle: newline-delimited
 * JSON-RPC written to the child's stdin, parsed from its stdout. The
 * subprocess seam owns the process lifetime; this transport owns only the
 * protocol framing over its streams.
 */
class SidecarTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

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
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
        } catch (error) {
          this.onerror?.(new Error(`dsh-computer-use: sidecar sent an unparseable line: ${String(error)}`))
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
 * validated {@link ComputerUseConfig}; the sidecar starts lazily at first use.
 */
export default class McpComputerUseProvider extends ComputerUseRuntime {
  private readonly config: ComputerUseConfig
  private handle: SubprocessHandle | undefined
  private client: Client | undefined
  private transport: SidecarTransport | undefined
  private starting: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly observations = new Map<string, StoredObservation>()
  private healthTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(ctx: Context, config: ComputerUseConfig) {
    super(ctx)
    this.config = config
    ctx.effect(() => {
      return async () => {
        this.disposed = true
        if (this.healthTimer !== undefined) clearInterval(this.healthTimer)
        for (const observation of this.observations.values()) clearTimeout(observation.expiryTimer)
        this.observations.clear()
        const client = this.client
        const handle = this.handle
        this.client = undefined
        this.handle = undefined
        if (client !== undefined) await client.close().catch(() => {})
        if (handle !== undefined) {
          handle.terminate()
          await handle.waitForExit()
        }
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
    const launch = resolveSidecarLaunch(this.config)
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
        // the sidecar's archive directory and freshness window are deployment facts.
        DSH_CU_SCREENSHOT_DIR: this.config.screenshotArchivePath,
        DSH_CU_OBSERVATION_TTL_MS: String(this.config.observationTtlMs),
        PYTHONIOENCODING: 'utf-8',
      },
    })
    this.handle = handle
    // A crashed sidecar must not drag the harness down: mark the connection
    // dead and surface the exit facts on the next call; teardown owns the rest.
    void handle.done.then((outcome) => {
      if (this.handle === handle) {
        this.ctx.logger.warn(
          `dsh-computer-use: sidecar exited (exitCode ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
        )
        this.client = undefined
        this.transport = undefined
        this.handle = undefined
        this.stopHealthCheck()
      }
    }, () => {})

    const transport = new SidecarTransport(handle)
    const client = new Client(
      { name: 'dsh-computer-use', version: '0.1.0' },
      { capabilities: {} },
    )
    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = undefined
        this.transport = undefined
        this.stopHealthCheck()
      }
    }
    try {
      await client.connect(transport)
    } catch (error) {
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
      await client.close()
      handle.terminate()
      await handle.waitForExit()
      this.handle = undefined
      throw new Error(
        `dsh-computer-use: sidecar version "${server?.version ?? 'unknown'}" is incompatible `
        + `(expected ${COMPATIBLE_SERVER_PREFIX}*)`,
      )
    }

    // Prove the expected tool surface before serving any call.
    const tools = await client.listTools()
    const names = new Set(tools.tools.map(tool => tool.name))
    for (const required of ['get_display_info', 'screen_shot', 'click_at', 'type_text', 'scroll', 'hotkey', 'get_foreground_window']) {
      if (!names.has(required)) {
        await client.close()
        handle.terminate()
        await handle.waitForExit()
        this.handle = undefined
        throw new Error(`dsh-computer-use: sidecar does not advertise the "${required}" tool`)
      }
    }

    this.client = client
    this.transport = transport
    this.startHealthCheck()
    this.ctx.logger.info(`dsh-computer-use: sidecar connected (${server.name} v${server.version})`)
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
    this.handle = undefined
    this.stopHealthCheck()
    if (client !== undefined) await client.close().catch(() => {})
    if (handle !== undefined) {
      handle.terminate()
      await handle.waitForExit()
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
      throw new Error(`dsh-computer-use: sidecar refused ${name}: ${text || 'no diagnostics'}`)
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T
    const first = result.content?.[0]
    if (first !== undefined && typeof first === 'object' && first !== null && 'text' in first) {
      return JSON.parse(String((first as { text: unknown }).text)) as T
    }
    throw new Error(`dsh-computer-use: sidecar returned no usable content for ${name}`)
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

  /** Refuse stale or unknown observation references with a clear reason. */
  private assertObservationFresh(id: ObservationId | undefined): void {
    if (id === undefined) return
    const stored = this.observations.get(id)
    if (stored === undefined) {
      throw new Error(
        `dsh-computer-use: unknown or expired ObservationId "${id}"; `
        + 'call screen_shot first and reference the id it returned',
      )
    }
    const ageMs = Date.now() - stored.capturedAtMs
    if (ageMs > this.config.observationTtlMs) {
      this.expireObservation(id)
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
      }
    })
  }

  clickAt(request: ClickAtRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId)
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
      this.assertObservationFresh(request.basedOnObservationId)
      return this.runAction('type_text', request.basedOnObservationId, `chars=${request.text.length}`, () => this.callSidecar<ActionResult>('type_text', {
        text: request.text,
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  scroll(request: ScrollRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId)
      return this.runAction('scroll', request.basedOnObservationId, `direction=${request.direction} amount=${request.amount}`, () => this.callSidecar<ActionResult>('scroll', {
        direction: request.direction,
        amount: request.amount,
        ...request.basedOnObservationId !== undefined ? { basedOnObservationId: request.basedOnObservationId } : {},
      }))
    })
  }

  hotkey(request: HotkeyRequest): Promise<ActionResult> {
    return this.enqueue(async () => {
      this.assertObservationFresh(request.basedOnObservationId)
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
