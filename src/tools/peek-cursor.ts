/**
 * `peek_cursor` tool (low risk, no approval): captures one desktop
 * observation with a synthetic cursor drawn at the intended click point. The
 * overlay marks where the agent plans to click WITHOUT moving the real OS
 * pointer — a trust/debugging aid for the second-round verification problem.
 * Preview frames deliberately stay out of the breaker and change-detection
 * state so the agent's observation loop keeps plain captures as its basis.
 * @module dsh-computer-use/tools/peek-cursor
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ObservationId } from '../definition/index.ts'
import type { ScreenShot } from '../definition/index.ts'
import { SensitiveWindowRefusal } from '../security/refusals.ts'
import { computerUse, type ToolDeps } from './shared.ts'
import { CONTROL_BOUNDARY } from './screen-shot.ts'

/**
 * Register `peek_cursor` on the tool registry.
 * @param ctx - host context carrying tools, the service, and attachments.
 * @param deps - shared security wiring.
 */
export function registerPeekCursor(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'peek_cursor',
    description: 'Preview a click target: capture a fresh screenshot with a synthetic cursor drawn at (x, y).'
      + ' The overlay never moves the real OS cursor; the subsequent click_at still performs the physical click.'
      + ' Coordinates are pixels of the referenced screenshot — pass its ObservationId as basedOnObservationId.'
      + ' The returned preview is itself a fresh observation: if you click afterwards, reference ITS ObservationId.'
      + CONTROL_BOUNDARY,
    parameters: {
      x: { type: 'number', required: true, description: 'Horizontal pixel of the intended click point.' },
      y: { type: 'number', required: true, description: 'Vertical pixel of the intended click point.' },
      screenshotWidth: { type: 'integer', required: true, description: 'Width of the screenshot the point came from.' },
      screenshotHeight: { type: 'integer', required: true, description: 'Height of the screenshot the point came from.' },
      basedOnObservationId: { type: 'string', description: 'ObservationId of the screenshot the point was read from.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          observationId: { type: 'string', required: true, description: 'Freshness identity of the preview frame.' },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], required: true },
          cursorOverlay: {
            type: 'object',
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
            },
            additionalProperties: false,
            required: true,
            description: 'The point where the synthetic cursor was drawn.',
          },
          attachment: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
            additionalProperties: false,
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const attachment: ImageAttachmentRef = {
          attachmentId: AttachmentId(value.attachment.attachmentId),
          mediaType: value.attachment.mediaType,
          bytes: value.attachment.bytes,
          width: value.attachment.width,
          height: value.attachment.height,
        }
        return [
          { type: 'image', attachment },
          {
            type: 'text',
            text: `Preview ${value.width}x${value.height}px with a synthetic cursor at`
              + ` (${value.cursorOverlay.x}, ${value.cursorOverlay.y}); the real OS cursor did not move.`
              + ` ObservationId "${value.observationId}" stays fresh for 30 seconds — reference it as`
              + ' basedOnObservationId on the click_at that follows.',
          },
        ]
      },
      presentationMeta: (_args, value) => ({
        width: value.width,
        height: value.height,
        observationId: value.observationId,
        cursorOverlay: value.cursorOverlay,
      }),
    },
    async execute(args, exec) {
      const runtime = computerUse(ctx)
      if (args.basedOnObservationId !== undefined) {
        const basis = await runtime.getObservation(ObservationId(args.basedOnObservationId))
        if (basis === undefined) {
          throw new Error(
            `dsh-computer-use: unknown or expired ObservationId "${args.basedOnObservationId}"; `
            + 'capture a fresh screenshot first and reference the id it returned',
          )
        }
        if (basis.width !== args.screenshotWidth || basis.height !== args.screenshotHeight) {
          throw new Error(
            `dsh-computer-use: peek_cursor basis mismatch — ObservationId "${args.basedOnObservationId}" is `
            + `${basis.width}x${basis.height} but the call declared a ${args.screenshotWidth}x${args.screenshotHeight} basis`,
          )
        }
      }

      let shot: ScreenShot
      try {
        shot = await runtime.screenShot({
          maxWidth: deps.config.screenshotMaxWidth,
          quality: deps.config.screenshotQuality,
          cursorPosition: { x: args.x, y: args.y },
        })
      } catch (error) {
        if (error instanceof SensitiveWindowRefusal) {
          deps.auditor.recordSensitiveWindow({
            ...exec.agent !== undefined ? { sessionId: String(exec.agent.session.id) } : {},
            windowTitle: error.facts.windowTitle,
            pattern: error.facts.pattern,
          })
        }
        throw error
      }

      const ref = await ctx.attachments.saveImage({
        data: shot.data,
        mediaType: 'image/jpeg',
        name: `cu-${shot.observationId}.jpg`,
      })
      return {
        observationId: String(shot.observationId),
        width: shot.width,
        height: shot.height,
        bytes: shot.data.byteLength,
        mediaType: 'image/jpeg' as const,
        cursorOverlay: shot.cursorOverlay ?? { x: args.x, y: args.y },
        attachment: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Preview click target', kind: 'fetch' }),
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: 'Click target previewed',
      content,
    }),
  }))
}
