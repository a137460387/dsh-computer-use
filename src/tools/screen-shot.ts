/**
 * `screen_shot` tool (low risk, no approval): captures one desktop
 * observation, runs the breaker and change detection, persists the frame
 * through the attachment store, and returns it to the model as an image
 * block plus the freshness identity.
 * @module dsh-computer-use/tools/screen-shot
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ScreenShot } from '../definition/index.ts'
import { SensitiveWindowRefusal } from '../security/refusals.ts'
import { computerUse, type ToolDeps } from './shared.ts'

/** Boundary guidance shared by every computer-use tool description. */
export const CONTROL_BOUNDARY = ' Prefer browser/DOM-based tools when the target is a web page; '
  + 'use this desktop-control tool only for native applications or when DOM access is unavailable.'

/**
 * Register `screen_shot` on the tool registry.
 * @param ctx - host context carrying tools, the service, and attachments.
 * @param deps - shared security and vision wiring.
 */
export function registerScreenShot(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'screen_shot',
    description: 'Capture a screenshot of the desktop and return the image with a fresh ObservationId.'
      + ' The ObservationId stays valid for 30 seconds; pass it as basedOnObservationId to the'
      + ' click_at/type_text/scroll/hotkey tools so they act on the screen you actually saw.'
      + CONTROL_BOUNDARY,
    parameters: {
      maxWidth: { type: 'integer', description: 'Width ceiling in pixels; omit for the deployment default.' },
      quality: { type: 'integer', description: 'JPEG quality 1-100; omit for the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          observationId: { type: 'string', required: true, description: 'Freshness identity for subsequent actions.' },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], required: true },
          screenChanged: { type: 'boolean', required: true, description: 'Whether the screen changed since the previous capture.' },
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
            text: `Screenshot ${value.width}x${value.height}px captured. ObservationId "${value.observationId}" stays fresh for 30 seconds`
              + ` (screen ${value.screenChanged ? 'changed' : 'unchanged'} since the previous capture).`
              + ' Reference it as basedOnObservationId on the next action.',
          },
        ]
      },
      presentationMeta: (_args, value) => ({ width: value.width, height: value.height, observationId: value.observationId }),
    },
    async execute(args, exec) {
      const runtime = computerUse(ctx)
      let shot: ScreenShot
      try {
        shot = await runtime.screenShot({
          maxWidth: args.maxWidth ?? deps.config.screenshotMaxWidth,
          quality: args.quality ?? deps.config.screenshotQuality,
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

      // Change detection against the previous frame, token-saving fast paths first.
      let screenChanged = true
      const previous = deps.previousShot
      if (previous !== undefined) {
        try {
          screenChanged = await deps.changeDetector.detect(
            previous,
            { data: shot.data, width: shot.width, height: shot.height, dhash: shot.dhash },
            exec.signal,
          )
        } catch {
          screenChanged = true
        }
      }
      deps.previousShot = { data: shot.data, width: shot.width, height: shot.height, dhash: shot.dhash }

      // Breaker accounting for any action that ran before this capture; the
      // trip throws and pauses the run for user intervention.
      deps.breaker.observe(shot.dhash)

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
        screenChanged,
        attachment: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Capture screenshot', kind: 'fetch' }),
    presentResult: (_args, { content }) => ({
      card: 'generic',
      title: 'Screenshot captured',
      content,
    }),
  }))
}
