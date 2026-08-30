/**
 * `get_display_info` tool (low risk, no approval): enumerates the attached
 * displays with physical bounds and per-display scale factors — orientation
 * facts for the model before it reasons about coordinates.
 * @module dsh-computer-use/tools/get-display-info
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computerUse, type ToolDeps } from './shared.ts'

/**
 * Register `get_display_info` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 * @param deps - shared wiring (unused by this read-only tool; kept for symmetry).
 */
export function registerGetDisplayInfo(ctx: Context, deps: ToolDeps): void {
  void deps
  ctx.tools.register(defineTool({
    name: 'get_display_info',
    description: 'List every attached display with its bounds, DPI scale factor, and primary flag.'
      + ' Read-only orientation; coordinates you emit elsewhere stay in screenshot space.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          displays: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                bounds: {
                  type: 'object',
                  properties: {
                    x: { type: 'integer', required: true },
                    y: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                  additionalProperties: false,
                  required: true,
                },
                scaleFactor: { type: 'number', required: true },
                isPrimary: { type: 'boolean', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.displays.map(display =>
          `display ${display.id}: ${display.bounds.width}x${display.bounds.height} at `
          + `(${display.bounds.x},${display.bounds.y}), scale ${display.scaleFactor}`
          + `${display.isPrimary ? ', primary' : ''}`)
          .join('\n') || 'no displays reported',
      }],
    },
    async execute() {
      const displays = await computerUse(ctx).getDisplayInfo()
      return { displays }
    },
    presentCall: () => ({ card: 'generic', title: 'List displays', kind: 'read' }),
  }))
}
