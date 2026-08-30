/**
 * Service Definition of the computer-use capability seam (`ctx.computerUse`):
 * display enumeration, screenshot observations, and DPI-aware input actions
 * executed by a desktop sidecar. Coordinate mathematics, DPI mapping, and the
 * physical input calls belong to the provider's sidecar; consumers pass
 * screenshot-space coordinates plus the screenshot dimensions and never
 * transform them. The MCP-based provider lives in `src/provider-mcp`; the
 * model-facing tools in `src/tools` are the consumers.
 * @module dsh-computer-use/definition
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * One screenshot observation. Service-issued (a fresh id per
 * {@link ComputerUseRuntime.screenShot}); actions reference it through
 * `basedOnObservationId` so the provider can prove the coordinate basis is
 * still fresh before acting on the physical screen.
 */
export type ObservationId = Branded<'ObservationId'>

/**
 * Brand a string as an {@link ObservationId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ObservationId(id: string): ObservationId {
  return id as ObservationId
}

/** One display's axis-aligned bounds in physical system coordinates. */
export interface DisplayBounds {
  /** Left edge in physical pixels, relative to the virtual-screen origin. */
  readonly x: number
  /** Top edge in physical pixels, relative to the virtual-screen origin. */
  readonly y: number
  /** Width in physical pixels. */
  readonly width: number
  /** Height in physical pixels. */
  readonly height: number
}

/** One attached display as the sidecar's operating system reports it. */
export interface DisplayInfo {
  /** Sidecar-assigned display identifier. */
  readonly id: string
  /** Physical pixel bounds inside the virtual screen. */
  readonly bounds: DisplayBounds
  /** Per-display scale factor (DPI awareness); 1.0 is unscaled. */
  readonly scaleFactor: number
  /** Whether this display is the operating system's primary. */
  readonly isPrimary: boolean
}

/** Optional capture controls for one screenshot. */
export interface ScreenShotOptions {
  /** Width ceiling in pixels; the sidecar preserves aspect below it. */
  readonly maxWidth?: number
  /** JPEG quality from 1 through 100. */
  readonly quality?: number
  /** Crop window in full-screen screenshot pixel coordinates. */
  readonly region?: DisplayBounds
}

/** One captured screenshot observation. */
export interface ScreenShot {
  /** Freshness identity subsequent actions reference. */
  readonly observationId: ObservationId
  /** Encoded image bytes (JPEG). */
  readonly data: Uint8Array
  /** Encoding of {@link data}. */
  readonly mediaType: 'image/jpeg'
  /** Encoded width in pixels — the coordinate basis for VLM output. */
  readonly width: number
  /** Encoded height in pixels — the coordinate basis for VLM output. */
  readonly height: number
  /**
   * 64-bit difference hash (16 hex chars) of the frame, the breaker's
   * change fingerprint; screenshots archive separately from it.
   */
  readonly dhash: string
  /** Capture timestamp, milliseconds since the Unix epoch. */
  readonly capturedAtMs: number
}

/** Outcome of one executed input action. */
export interface ActionResult {
  /** Whether the sidecar performed the action. */
  readonly success: boolean
  /** Human-readable diagnostics when the action was refused or failed. */
  readonly message?: string
  /** Sidecar-side execution time in milliseconds. */
  readonly durationMs: number
}

/** One click in screenshot-space coordinates. */
export interface ClickAtRequest {
  /** Horizontal pixel in the referenced screenshot. */
  readonly x: number
  /** Vertical pixel in the referenced screenshot. */
  readonly y: number
  /** Width of the screenshot the coordinates came from. */
  readonly screenshotWidth: number
  /** Height of the screenshot the coordinates came from. */
  readonly screenshotHeight: number
  /** Freshness proof; the sidecar rejects references older than the TTL. */
  readonly basedOnObservationId?: ObservationId
}

/** One text entry action. */
export interface TypeTextRequest {
  /** Text to type. */
  readonly text: string
  /** Freshness proof; the sidecar rejects references older than the TTL. */
  readonly basedOnObservationId?: ObservationId
}

/** Scroll direction vocabulary. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

/** One scroll action. */
export interface ScrollRequest {
  /** Scroll direction. */
  readonly direction: ScrollDirection
  /** Scroll amount in wheel notches. */
  readonly amount: number
  /** Freshness proof; the sidecar rejects references older than the TTL. */
  readonly basedOnObservationId?: ObservationId
}

/** One keyboard-combination action. */
export interface HotkeyRequest {
  /** Keys pressed together, e.g. `['ctrl', 'c']`. */
  readonly keys: readonly string[]
  /** Freshness proof; the sidecar rejects references older than the TTL. */
  readonly basedOnObservationId?: ObservationId
}

/** Every action type reported through the seam's events and audit. */
export type ComputerUseActionType =
  | 'screen_shot'
  | 'click_at'
  | 'type_text'
  | 'scroll'
  | 'hotkey'

/** Facts announced before one action reaches the sidecar. */
export interface BeforeActionEvent {
  /** The action about to run. */
  readonly action: ComputerUseActionType
  /** Session the action belongs to, when the consumer knows it. */
  readonly sessionId?: Branded<'SessionId'>
  /** Observation the action bases on, when it has one. */
  readonly observationId?: ObservationId
  /** Sanitized action summary (coordinates, direction, keys, char count). */
  readonly detail?: string
  /** Event timestamp, milliseconds since the Unix epoch. */
  readonly atMs: number
}

/** Facts announced after one action settles. */
export interface AfterActionEvent {
  /** The action that ran. */
  readonly action: ComputerUseActionType
  /** Session the action belonged to, when the consumer knows it. */
  readonly sessionId?: Branded<'SessionId'>
  /** Sidecar outcome. */
  readonly success: boolean
  /** Sidecar-side execution time in milliseconds. */
  readonly durationMs: number
  /** Observation the action based on, when it had one. */
  readonly observationId?: ObservationId
  /** Sanitized action summary (coordinates, direction, keys, char count). */
  readonly detail?: string
  /** Perceptual hash of the frame before the action, when the auditor computed one. */
  readonly beforeHash?: string
  /** Perceptual hash of the frame after the action, when the auditor computed one. */
  readonly afterHash?: string
  /** Event timestamp, milliseconds since the Unix epoch. */
  readonly atMs: number
}

/** Facts announced when an observation outlives its freshness window. */
export interface ObservationExpiredEvent {
  /** The expired observation. */
  readonly observationId: ObservationId
  /** Expiry timestamp, milliseconds since the Unix epoch. */
  readonly expiredAtMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    computerUse: ComputerUseRuntime
  }

  interface Events {
    /**
     * Announce one action before it reaches the sidecar. Listeners observe;
     * policy decisions belong to the tool consumers, not this event.
     * @param event - the pending action facts.
     * @mode parallel
     */
    'computer-use/before-action'(this: ComputerUseRuntime, event: BeforeActionEvent): void
    /**
     * Announce one action's settled outcome, including the auditor's frame
     * hashes when computed.
     * @param event - the completed action facts.
     * @mode parallel
     */
    'computer-use/after-action'(this: ComputerUseRuntime, event: AfterActionEvent): void
    /**
     * Announce that an observation left its freshness window; later actions
     * referencing it are refused.
     * @param event - the expiry facts.
     * @mode parallel
     */
    'computer-use/observation-expired'(this: ComputerUseRuntime, event: ObservationExpiredEvent): void
  }
}

/**
 * Abstract computer-use service. Subclass, implement every method, and load
 * the subclass as a plugin — it registers as `ctx.computerUse`.
 *
 * Implementations must honor these semantics:
 * - All coordinates arriving at the service are screenshot-space pixels plus
 *   the screenshot's dimensions; the provider's sidecar owns the two-stage
 *   mapping to physical, per-display DPI-aware coordinates.
 * - Actions carrying a stale or unknown `basedOnObservationId` are refused,
 *   never executed on guesswork.
 * - Calls serialize: the sidecar is a single-instance executor, so the
 *   provider queues concurrent callers instead of interleaving them.
 */
export abstract class ComputerUseRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'computerUse')
  }

  /**
   * The sidecar's protocol version, verified against this plugin's
   * compatibility range during activation.
   * @returns the sidecar version string.
   */
  abstract version(): Promise<string>

  /**
   * Every display the sidecar can act on, in the operating system's order.
   * @returns display metadata with physical bounds and per-display scale.
   */
  abstract getDisplayInfo(): Promise<DisplayInfo[]>

  /**
   * Capture one screenshot observation.
   * @param options - optional capture controls.
   * @returns the encoded frame plus its observation identity and dimensions.
   */
  abstract screenShot(options?: ScreenShotOptions): Promise<ScreenShot>

  /**
   * Click one screenshot-space point; the sidecar maps it to the physical
   * display under it.
   * @param request - coordinates, screenshot basis, and freshness reference.
   * @returns the action outcome.
   */
  abstract clickAt(request: ClickAtRequest): Promise<ActionResult>

  /**
   * Type text into the focused window.
   * @param request - text and freshness reference.
   * @returns the action outcome.
   */
  abstract typeText(request: TypeTextRequest): Promise<ActionResult>

  /**
   * Scroll the focused surface.
   * @param request - direction, amount, and freshness reference.
   * @returns the action outcome.
   */
  abstract scroll(request: ScrollRequest): Promise<ActionResult>

  /**
   * Press one key combination.
   * @param request - keys and freshness reference.
   * @returns the action outcome.
   */
  abstract hotkey(request: HotkeyRequest): Promise<ActionResult>

  /**
   * Read back one still-fresh observation without recapturing.
   * @param observationId - the observation to re-read.
   * @returns the cached screenshot, or undefined once it expired.
   */
  abstract getObservation(observationId: ObservationId): Promise<ScreenShot | undefined>

  /**
   * Name of the foreground window's owning process, for whitelist policy.
   * @returns the foreground process name (basename, no path).
   */
  abstract getForegroundWindow(): Promise<string>
}

export default ComputerUseRuntime
