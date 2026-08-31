/**
 * `click_at` tool (medium risk): clicks one screenshot-space point after
 * approval gating; the sidecar owns the DPI-aware per-display mapping.
 * Optionally runs the advisory post-action semantic verification and, on a
 * `no`/`uncertain` verdict, exactly one zoom-crop retry (both gated by the
 * `actionVerification` config, default off).
 * @module dsh-computer-use/tools/click-at
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ObservationId } from '../definition/index.ts'
import {
  attemptZoomCropRetry,
  runActionVerification,
  shouldVerify,
} from '../vision/verification.ts'
import {
  computerUse,
  requestApproval,
  sessionIdOf,
  stepCounter,
  whitelistTier,
  type ToolDeps,
} from './shared.ts'

/**
 * Register `click_at` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 * @param deps - shared security wiring.
 */
export function registerClickAt(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'click_at',
    description: 'Click a point given in screenshot pixels from the most recent screen_shot.'
      + ' Always pass the ObservationId you are acting on as basedOnObservationId;'
      + ' stale references (>30 s) are refused. Do NOT convert coordinates yourself —'
      + ' the desktop sidecar maps them to the right display with DPI awareness.',
    parameters: {
      x: { type: 'number', required: true, description: 'Horizontal pixel in the referenced screenshot.' },
      y: { type: 'number', required: true, description: 'Vertical pixel in the referenced screenshot.' },
      screenshotWidth: { type: 'integer', required: true, description: 'Width of the screenshot the point came from.' },
      screenshotHeight: { type: 'integer', required: true, description: 'Height of the screenshot the point came from.' },
      basedOnObservationId: { type: 'string', description: 'ObservationId of the screenshot being acted on.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', required: true },
          message: { type: 'string' },
          durationMs: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: value.success
          ? `Clicked (${args.x}, ${args.y}) in ${Math.round(value.durationMs)} ms.`
          : `Click failed: ${value.message ?? 'unknown sidecar error'}`,
      }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      stepCounter.assert(sessionId, deps.config.maxSteps)
      deps.breaker.assertCanAct()
      const tier = await whitelistTier(ctx, deps, 'medium')
      await requestApproval(ctx, deps, exec, 'click_at', tier, `click at (${args.x}, ${args.y}) on a ${args.screenshotWidth}x${args.screenshotHeight} screenshot`)
      stepCounter.note(sessionId)
      deps.breaker.noteAction()
      if (deps.config.clickPreview) {
        // Intent frame: archive the current screen with a synthetic cursor on
        // the click point, so the audit trail holds both the intended point
        // and (after the click) its result. Best-effort on purpose — the
        // capture's own guards (sensitive windows, pause) already ran, and a
        // failed preview must never block an approved click.
        try {
          await computerUse(ctx).screenShot({
            maxWidth: deps.config.screenshotMaxWidth,
            quality: deps.config.screenshotQuality,
            cursorPosition: { x: args.x, y: args.y },
            archiveSuffix: '-preview',
          })
        } catch (error) {
          ctx.logger.warn(`dsh-computer-use: pre-click preview failed (${String(error)}); clicking without it`)
        }
      }
      const result = await computerUse(ctx).clickAt({
        x: args.x,
        y: args.y,
        screenshotWidth: args.screenshotWidth,
        screenshotHeight: args.screenshotHeight,
        ...args.basedOnObservationId !== undefined ? { basedOnObservationId: ObservationId(args.basedOnObservationId) } : {},
      })
      if (!result.success) throw new Error(`dsh-computer-use: click refused: ${result.message ?? 'unknown sidecar error'}`)

      // Advisory post-action verification (default off): the flash route
      // judges before/after frames, and a no/uncertain verdict may trigger
      // exactly one zoom-crop retry. The click already executed; nothing
      // below may block or re-approve it — failures degrade into the note.
      const baseline = deps.previousShot
      const basisId = deps.previousShotId
      let note: string | undefined
      if (
        shouldVerify(deps.config)
        && baseline !== undefined
        && basisId !== undefined
        && baseline.width === args.screenshotWidth
        && baseline.height === args.screenshotHeight
      ) {
        const verdict = await runActionVerification({
          vision: deps.vision,
          settleMs: deps.config.actionVerificationSettleMs,
          before: { data: baseline.data, width: baseline.width, height: baseline.height },
          actionDescription: `click at (${args.x}, ${args.y})`,
          captureAfter: () => computerUse(ctx).screenShot({
            maxWidth: deps.config.screenshotMaxWidth,
            quality: deps.config.screenshotQuality,
          }),
          signal: exec.signal,
        })

        let retried = false
        let retryX: number | undefined
        let retryY: number | undefined
        let retryObservationId: string | undefined
        if (verdict.verdict !== 'yes') {
          const retry = await attemptZoomCropRetry({
            vision: deps.vision,
            point: { x: args.x, y: args.y },
            frameWidth: baseline.width,
            frameHeight: baseline.height,
            captureCrop: rect => computerUse(ctx).screenShot({
              maxWidth: deps.config.screenshotMaxWidth,
              quality: deps.config.screenshotQuality,
              region: rect,
              regionOfObservationId: basisId,
            }),
            reclick: (x, y, crop) => computerUse(ctx).clickAt({
              x,
              y,
              screenshotWidth: crop.width,
              screenshotHeight: crop.height,
              basedOnObservationId: crop.observationId,
            }),
            signal: exec.signal,
          })
          retried = retry.attempted
          if (retry.attempted && retry.refined !== undefined) {
            retryX = retry.refined.x
            retryY = retry.refined.y
            retryObservationId = retry.retryObservationId
            note = ` Semantic verification: ${verdict.verdict} (${verdict.reason}).`
              + ` Zoom-crop retry clicked (${retry.refined.x}, ${retry.refined.y}) in the crop;`
              + ' the intended effect is still unconfirmed — capture a fresh screenshot to inspect.'
          } else {
            const why = retry.retryError ?? retry.skippedReason ?? 'unknown retry failure'
            note = ` Semantic verification: ${verdict.verdict} (${verdict.reason}). Zoom-crop retry not executed: ${why}.`
          }
        } else {
          note = ` Semantic verification confirmed the effect (${verdict.reason}).`
        }

        deps.auditor.recordVerification({
          sessionId,
          toolName: 'click_at',
          verdict: verdict.verdict,
          reason: verdict.reason,
          ...verdict.tier !== undefined ? { modelTier: verdict.tier } : {},
          retried,
          ...retryX !== undefined ? { retryX } : {},
          ...retryY !== undefined ? { retryY } : {},
          ...retryObservationId !== undefined ? { retryObservationId } : {},
        })
      }

      return {
        success: true,
        ...result.message !== undefined || note !== undefined
          ? { message: `${result.message ?? ''}${note ?? ''}`.trim() }
          : {},
        durationMs: result.durationMs,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Click (${args.x}, ${args.y})`,
      kind: 'execute',
      rawInput: { screenshotWidth: args.screenshotWidth, screenshotHeight: args.screenshotHeight },
    }),
  }))
}
