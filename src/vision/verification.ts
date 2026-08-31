/**
 * Post-action semantic verification and the zoom-crop click retry.
 *
 * Advisory orchestration the action tools run AFTER a successful dispatch:
 * the change-detection route (the deployment's cheap flash model) judges
 * whether the intended effect happened between the before/after frames
 * (`yes`/`no`/`uncertain`), and a `no`/`uncertain` verdict on `click_at`
 * may trigger exactly one zoom-crop retry — a magnified capture around the
 * target that the primary vision model relocalizes before a single re-click.
 * Both layers are gated by the `actionVerification` config (default `off`)
 * and never block, throw into, or re-approve the action they annotate.
 * @module dsh-computer-use/vision/verification
 */

import type { ComputerUseConfig } from '../config.ts'
import type { ActionResult, ScreenShot } from '../definition/index.ts'
import { zoomCropRefinementPrompt } from './vision-provider.ts'
import type { ActionEffectVerdict, VisionImage, VisionProvider } from './vision-provider.ts'

/** Determinism hook for the `sampled` mode; one draw per candidate action. */
export type VerificationRandom = () => number

/**
 * Whether one action is selected for semantic verification.
 * @param config - policy carrying the mode and the sample rate.
 * @param random - draw source override for tests; defaults to `Math.random`.
 * @returns true when this action must be verified.
 */
export function shouldVerify(
  config: Pick<ComputerUseConfig, 'actionVerification' | 'actionVerificationSampleRate'>,
  random: VerificationRandom = Math.random,
): boolean {
  if (config.actionVerification === 'always') return true
  if (config.actionVerification === 'sampled') return random() < config.actionVerificationSampleRate
  return false
}

/** Zoom applied to the target region: a quarter-span crop magnifies 4x. */
export const ZOOM_CROP_FACTOR = 4

/** Frames smaller than this have nothing meaningful to magnify. */
export const MIN_CROP_FRAME_PX = 16

/** One axis-aligned rectangle in screenshot pixels. */
export interface CropRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The zoom-crop rectangle around one intended click point, clamped so the
 * point stays inside the crop.
 * @param x - horizontal pixel of the intended point.
 * @param y - vertical pixel of the intended point.
 * @param frameWidth - width of the frame the point came from.
 * @param frameHeight - height of the frame the point came from.
 * @param zoom - magnification factor; defaults to {@link ZOOM_CROP_FACTOR}.
 * @returns the crop rectangle, or undefined when the frame is too small.
 */
export function cropRectForPoint(
  x: number,
  y: number,
  frameWidth: number,
  frameHeight: number,
  zoom: number = ZOOM_CROP_FACTOR,
): CropRect | undefined {
  if (frameWidth < MIN_CROP_FRAME_PX || frameHeight < MIN_CROP_FRAME_PX) return undefined
  const spanWidth = Math.max(1, Math.round(frameWidth / zoom))
  const spanHeight = Math.max(1, Math.round(frameHeight / zoom))
  const left = Math.min(Math.max(Math.round(x - spanWidth / 2), 0), frameWidth - spanWidth)
  const top = Math.min(Math.max(Math.round(y - spanHeight / 2), 0), frameHeight - spanHeight)
  return { x: left, y: top, width: spanWidth, height: spanHeight }
}

/** Cancellable settle wait; rejects once `signal` aborts. */
export function settle(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('verification aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('verification aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Everything one verification run needs; injected for testability. */
export interface RunVerificationOptions {
  readonly vision: VisionProvider
  /** UI settle wait before the after-capture. */
  readonly settleMs: number
  /** The pre-action frame (the agent's last plain capture). */
  readonly before: VisionImage
  /** Sanitized summary of the executed action, for the model prompt. */
  readonly actionDescription: string
  /** Capture the post-action frame. */
  readonly captureAfter: () => Promise<ScreenShot>
  readonly signal?: AbortSignal
  /** Settle implementation override for tests; defaults to {@link settle}. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Run one post-action semantic verification. Never throws: every degraded
 * path returns an `uncertain` verdict carrying its reason.
 * @param opts - verification inputs.
 * @returns the flash model's verdict (or the degraded substitute).
 */
export async function runActionVerification(opts: RunVerificationOptions): Promise<ActionEffectVerdict> {
  const sleep = opts.sleep ?? settle
  try {
    await sleep(opts.settleMs, opts.signal)
    const after = await opts.captureAfter()
    if (after.width !== opts.before.width || after.height !== opts.before.height) {
      return {
        verdict: 'uncertain',
        reason: `frame size changed (${opts.before.width}x${opts.before.height} → ${after.width}x${after.height}); cannot diff`,
      }
    }
    return await opts.vision.verifyActionEffect(opts.before, after, opts.actionDescription, opts.signal)
  } catch (error) {
    return { verdict: 'uncertain', reason: `verification unavailable: ${String(error)}` }
  }
}

/** Structured outcome of one zoom-crop retry attempt. */
export interface ZoomCropRetryOutcome {
  /** Whether a retry click was physically executed. */
  readonly attempted: boolean
  /** Why the attempt stopped before refinement completed, when it did. */
  readonly skippedReason?: string
  /** Refined point in CROP pixels, present once refinement succeeded. */
  readonly refined?: { readonly x: number; readonly y: number }
  /** The vision model's refinement rationale. */
  readonly refinementReason?: string
  /** The retry click's outcome, present once it executed. */
  readonly retryResult?: ActionResult
  /** Observation of the zoom crop the retry clicked on, when it executed. */
  readonly retryObservationId?: string
  /** Why the retry click did not execute after a successful refinement. */
  readonly retryError?: string
}

/** Everything one zoom-crop retry needs; injected for testability. */
export interface ZoomCropRetryOptions {
  readonly vision: VisionProvider
  /** The intended point, in the frame's pixels. */
  readonly point: { readonly x: number; readonly y: number }
  /** Dimensions of the frame the point came from. */
  readonly frameWidth: number
  readonly frameHeight: number
  /** Capture the zoom crop; the rectangle is in frame pixels. */
  readonly captureCrop: (rect: CropRect) => Promise<ScreenShot>
  /** Execute the retry click with crop-space coordinates on the crop basis. */
  readonly reclick: (x: number, y: number, crop: ScreenShot) => Promise<ActionResult>
  readonly signal?: AbortSignal
}

/**
 * Attempt exactly one zoom-crop click retry: magnify the region around the
 * intended point, let the primary vision model relocalize the control inside
 * the crop, and re-click once on that basis. Never throws — every failure
 * degrades into the outcome's reason fields.
 * @param opts - retry inputs.
 * @returns the structured attempt outcome.
 */
export async function attemptZoomCropRetry(opts: ZoomCropRetryOptions): Promise<ZoomCropRetryOutcome> {
  const rect = cropRectForPoint(opts.point.x, opts.point.y, opts.frameWidth, opts.frameHeight)
  if (rect === undefined) {
    return { attempted: false, skippedReason: `frame too small for a zoom crop (<${MIN_CROP_FRAME_PX}px)` }
  }

  let crop: ScreenShot
  try {
    crop = await opts.captureCrop(rect)
  } catch (error) {
    return { attempted: false, skippedReason: `zoom-crop capture failed: ${String(error)}` }
  }

  // The intended point expressed in the crop's own pixels.
  const cropX = Math.round((opts.point.x - rect.x) * crop.width / rect.width)
  const cropY = Math.round((opts.point.y - rect.y) * crop.height / rect.height)

  let refined: { x: number; y: number; reason: string }
  try {
    const analysis = await opts.vision.analyzeScreenshot(
      { data: crop.data, width: crop.width, height: crop.height },
      zoomCropRefinementPrompt(cropX, cropY),
      opts.signal,
    )
    if (analysis.action !== 'click' || analysis.x === undefined || analysis.y === undefined) {
      return {
        attempted: false,
        skippedReason: `refinement declined (the vision model answered "${analysis.action}" instead of a click)`,
      }
    }
    refined = { x: analysis.x, y: analysis.y, reason: analysis.reason }
  } catch (error) {
    return { attempted: false, skippedReason: `zoom-crop refinement failed: ${String(error)}` }
  }

  try {
    const retryResult = await opts.reclick(refined.x, refined.y, crop)
    return {
      attempted: true,
      refined: { x: refined.x, y: refined.y },
      refinementReason: refined.reason,
      retryResult,
      retryObservationId: String(crop.observationId),
    }
  } catch (error) {
    return {
      attempted: false,
      refined: { x: refined.x, y: refined.y },
      refinementReason: refined.reason,
      retryError: String(error),
    }
  }
}
