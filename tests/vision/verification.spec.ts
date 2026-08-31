import { describe, expect, it } from 'vitest'
import { ObservationId } from '../../src/definition/index.ts'
import type { ActionResult, ScreenShot } from '../../src/definition/index.ts'
import {
  MIN_CROP_FRAME_PX,
  ZOOM_CROP_FACTOR,
  attemptZoomCropRetry,
  cropRectForPoint,
  runActionVerification,
  settle,
  shouldVerify,
} from '../../src/vision/verification.ts'
import type { TieredVerdict, VisionImage, VisionProvider } from '../../src/vision/vision-provider.ts'
import { testConfig } from '../helpers.ts'

const frame: VisionImage = { data: new Uint8Array([1, 2, 3]), width: 1280, height: 720 }

function shot(width: number, height: number, id = 'obs-after'): ScreenShot {
  return {
    observationId: ObservationId(id),
    data: new Uint8Array([9, 9]),
    mediaType: 'image/jpeg',
    width,
    height,
    dhash: '0000000000000000',
    capturedAtMs: 1_700_000_000_000,
  }
}

/** VisionProvider fake recording calls; per-method results are injectable. */
function fakeVision(overrides: {
  verdict?: TieredVerdict
  verifyThrows?: Error
  analysis?: { action: 'click' | 'observe'; x?: number; y?: number; reason: string }
  analyzeThrows?: Error
} = {}): VisionProvider & { verifyCalls: number; analyzeCalls: number; analyzePrompts: string[] } {
  const state = { verifyCalls: 0, analyzeCalls: 0, analyzePrompts: [] as string[] }
  return {
    get verifyCalls() { return state.verifyCalls },
    get analyzeCalls() { return state.analyzeCalls },
    get analyzePrompts() { return state.analyzePrompts },
    async analyzeScreenshot(_image, taskPrompt) {
      state.analyzeCalls += 1
      state.analyzePrompts.push(taskPrompt)
      if (overrides.analyzeThrows !== undefined) throw overrides.analyzeThrows
      return overrides.analysis ?? { action: 'click', x: 10, y: 12, reason: 'the button center' }
    },
    async detectChange() { return true },
    async verifyActionEffect() {
      state.verifyCalls += 1
      if (overrides.verifyThrows !== undefined) throw overrides.verifyThrows
      return overrides.verdict ?? { verdict: 'yes', reason: 'the dialog appeared' }
    },
  }
}

describe('shouldVerify', () => {
  it('never verifies when the mode is off', () => {
    expect(shouldVerify(testConfig({ actionVerification: 'off' }), () => 0)).toBe(false)
  })

  it('always verifies in always mode', () => {
    expect(shouldVerify(testConfig({ actionVerification: 'always' }), () => 0.99)).toBe(true)
  })

  it('samples by the configured rate in sampled mode', () => {
    const config = testConfig({ actionVerification: 'sampled', actionVerificationSampleRate: 0.25 })
    expect(shouldVerify(config, () => 0.1)).toBe(true)
    expect(shouldVerify(config, () => 0.25)).toBe(false)
    expect(shouldVerify(config, () => 0.9)).toBe(false)
  })

  it('defaults to off in the shipped configuration', () => {
    expect(testConfig().actionVerification).toBe('off')
    expect(shouldVerify(testConfig())).toBe(false)
  })
})

describe('cropRectForPoint', () => {
  it('centers a quarter-span crop on an interior point', () => {
    const rect = cropRectForPoint(640, 360, 1280, 720)
    expect(rect).toEqual({ x: 480, y: 270, width: 320, height: 180 })
  })

  it('clamps edge points while keeping the point inside the crop', () => {
    const right = cropRectForPoint(1279, 360, 1280, 720)
    expect(right).toEqual({ x: 960, y: 270, width: 320, height: 180 })
    expect(right!.x + right!.width).toBe(1280)

    const corner = cropRectForPoint(0, 0, 1280, 720)
    expect(corner).toEqual({ x: 0, y: 0, width: 320, height: 180 })
  })

  it('refuses frames too small to magnify', () => {
    expect(cropRectForPoint(5, 5, MIN_CROP_FRAME_PX - 1, 720)).toBeUndefined()
    expect(cropRectForPoint(5, 5, 1280, MIN_CROP_FRAME_PX - 1)).toBeUndefined()
  })

  it('honors a custom zoom factor', () => {
    const rect = cropRectForPoint(640, 360, 1280, 720, 2)
    expect(rect?.width).toBe(640)
    expect(rect?.height).toBe(360)
  })

  it('uses the documented default zoom', () => {
    expect(ZOOM_CROP_FACTOR).toBe(4)
  })
})

describe('settle', () => {
  it('resolves immediately for a non-positive wait', async () => {
    await expect(settle(0)).resolves.toBeUndefined()
  })

  it('rejects once the signal aborts', async () => {
    const controller = new AbortController()
    const pending = settle(60_000, controller.signal)
    controller.abort(new Error('aborted by test'))
    await expect(pending).rejects.toThrow('aborted by test')
  })

  it('rejects immediately on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(settle(10, controller.signal)).rejects.toThrow()
  })
})

describe('runActionVerification', () => {
  it('settles, captures, and returns the model verdict', async () => {
    const vision = fakeVision({ verdict: { verdict: 'no', reason: 'nothing moved' } })
    const calls: string[] = []
    const verdict = await runActionVerification({
      vision,
      settleMs: 25,
      before: frame,
      actionDescription: 'click at (10, 10)',
      captureAfter: async () => { calls.push('capture'); return shot(1280, 720) },
      sleep: async (ms) => { calls.push(`sleep:${ms}`) },
    })
    expect(verdict).toEqual({ verdict: 'no', reason: 'nothing moved' })
    expect(calls).toEqual(['sleep:25', 'capture'])
    expect(vision.verifyCalls).toBe(1)
  })

  it('passes the producing tier through when the provider reports one', async () => {
    const vision = fakeVision({ verdict: { verdict: 'yes', reason: 'the dialog appeared', tier: 'pro' } })
    const verdict = await runActionVerification({
      vision,
      settleMs: 0,
      before: frame,
      actionDescription: 'click at (10, 10)',
      captureAfter: async () => shot(1280, 720),
      sleep: async () => {},
    })
    expect(verdict).toEqual({ verdict: 'yes', reason: 'the dialog appeared', tier: 'pro' })
  })

  it('skips the model when the frame size changed and reports uncertain', async () => {
    const vision = fakeVision()
    const verdict = await runActionVerification({
      vision,
      settleMs: 0,
      before: frame,
      actionDescription: 'scroll down',
      captureAfter: async () => shot(1024, 720),
      sleep: async () => {},
    })
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('frame size changed')
    expect(verdict.tier).toBeUndefined()
    expect(vision.verifyCalls).toBe(0)
  })

  it('degrades a capture failure to uncertain instead of throwing', async () => {
    const verdict = await runActionVerification({
      vision: fakeVision(),
      settleMs: 0,
      before: frame,
      actionDescription: 'click',
      captureAfter: async () => { throw new Error('[dsh-cu-paused] paused') },
      sleep: async () => {},
    })
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('paused')
  })

  it('degrades an abort during settle to uncertain', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const verdict = await runActionVerification({
      vision: fakeVision(),
      settleMs: 50,
      before: frame,
      actionDescription: 'click',
      captureAfter: async () => shot(1280, 720),
      signal: controller.signal,
    })
    expect(verdict.verdict).toBe('uncertain')
  })
})

describe('attemptZoomCropRetry', () => {
  function retryOptions(vision: VisionProvider, overrides: {
    captureCrop?: (rect: { x: number; y: number; width: number; height: number }) => Promise<ScreenShot>
    reclick?: (x: number, y: number, crop: ScreenShot) => Promise<ActionResult>
  } = {}) {
    const crops: Array<{ x: number; y: number; width: number; height: number }> = []
    const clicks: Array<{ x: number; y: number; basis: string }> = []
    return {
      crops,
      clicks,
      opts: {
        vision,
        point: { x: 640, y: 360 },
        frameWidth: 1280,
        frameHeight: 720,
        captureCrop: overrides.captureCrop ?? (async (rect) => {
          crops.push(rect)
          return shot(rect.width, rect.height, 'crop-1')
        }),
        reclick: overrides.reclick ?? (async (x, y, crop) => {
          clicks.push({ x, y, basis: String(crop.observationId) })
          return { success: true, durationMs: 7 }
        }),
      },
    }
  }

  it('captures the crop, refines in crop pixels, and re-clicks once on the crop basis', async () => {
    const { opts, crops, clicks } = retryOptions(fakeVision({
      analysis: { action: 'click', x: 161, y: 92, reason: 'centered on the button' },
    }))
    const outcome = await attemptZoomCropRetry(opts)

    expect(crops).toEqual([{ x: 480, y: 270, width: 320, height: 180 }])
    expect(clicks).toEqual([{ x: 161, y: 92, basis: 'crop-1' }])
    expect(outcome).toMatchObject({
      attempted: true,
      refined: { x: 161, y: 92 },
      retryObservationId: 'crop-1',
      retryResult: { success: true, durationMs: 7 },
    })
    expect(outcome.refinementReason).toBe('centered on the button')
  })

  it('maps the intended point into crop pixels for the refinement prompt', async () => {
    // The crop is 320x180 at (480, 270); the point (640, 360) sits at (160, 90) inside it.
    const vision = fakeVision()
    const { opts } = retryOptions(vision)
    const outcome = await attemptZoomCropRetry(opts)
    expect(outcome.attempted).toBe(true)
    expect(vision.analyzePrompts).toHaveLength(1)
    expect(vision.analyzePrompts[0]).toContain('(160, 90)')
  })

  it('stops without a retry when the frame is too small to crop', async () => {
    const { opts } = retryOptions(fakeVision())
    const outcome = await attemptZoomCropRetry({ ...opts, frameWidth: 8, frameHeight: 8, point: { x: 4, y: 4 } })
    expect(outcome.attempted).toBe(false)
    expect(outcome.skippedReason).toContain('too small')
  })

  it('reports a failed crop capture instead of throwing', async () => {
    const { opts } = retryOptions(fakeVision(), {
      captureCrop: async () => { throw new Error('basis observation expired') },
    })
    const outcome = await attemptZoomCropRetry(opts)
    expect(outcome.attempted).toBe(false)
    expect(outcome.skippedReason).toContain('basis observation expired')
  })

  it('stops when the vision model declines to refine', async () => {
    const { opts, clicks } = retryOptions(fakeVision({
      analysis: { action: 'observe', reason: 'no control there' },
    }))
    const outcome = await attemptZoomCropRetry(opts)
    expect(outcome.attempted).toBe(false)
    expect(outcome.skippedReason).toContain('observe')
    expect(clicks).toHaveLength(0)
  })

  it('reports a refinement failure instead of throwing', async () => {
    const { opts } = retryOptions(fakeVision({ analyzeThrows: new Error('vision timeout') }))
    const outcome = await attemptZoomCropRetry(opts)
    expect(outcome.attempted).toBe(false)
    expect(outcome.skippedReason).toContain('vision timeout')
  })

  it('keeps the refined point when the retry click itself is refused', async () => {
    const { opts } = retryOptions(fakeVision(), {
      reclick: async () => { throw new Error('[dsh-cu-paused] desktop control is paused') },
    })
    const outcome = await attemptZoomCropRetry(opts)
    expect(outcome.attempted).toBe(false)
    expect(outcome.refined).toEqual({ x: 10, y: 12 })
    expect(outcome.retryError).toContain('paused')
  })
})
