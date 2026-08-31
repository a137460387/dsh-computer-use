/**
 * `scroll` tool (medium risk): scrolls the focused surface by wheel notches.
 * @module dsh-computer-use/tools/scroll
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ObservationId } from '../definition/index.ts'
import type { ScrollDirection } from '../definition/index.ts'
import {
  computerUse,
  requestApproval,
  sessionIdOf,
  stepCounter,
  whitelistTier,
  type ToolDeps,
} from './shared.ts'

/**
 * Register `scroll` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 * @param deps - shared security wiring.
 */
export function registerScroll(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'scroll',
    description: 'Scroll the focused desktop surface up/down/left/right by wheel notches.'
      + ' Capture a fresh screenshot after scrolling to see the new content.',
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
      amount: { type: 'integer', required: true, description: 'Wheel notches to scroll.' },
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
          ? `Scrolled ${args.direction} by ${args.amount} in ${Math.round(value.durationMs)} ms.`
          : `Scroll failed: ${value.message ?? 'unknown sidecar error'}`,
      }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      stepCounter.assert(sessionId, deps.config.maxSteps)
      deps.breaker.assertCanAct()
      const tier = await whitelistTier(ctx, deps, 'medium')
      await requestApproval(ctx, deps, exec, 'scroll', tier, `scroll ${args.direction} by ${args.amount} notches`)
      stepCounter.note(sessionId)
      deps.breaker.noteAction()
      const result = await computerUse(ctx).scroll({
        direction: args.direction as ScrollDirection,
        amount: args.amount,
        ...args.basedOnObservationId !== undefined ? { basedOnObservationId: ObservationId(args.basedOnObservationId) } : {},
      })
      if (!result.success) throw new Error(`dsh-computer-use: scroll refused: ${result.message ?? 'unknown sidecar error'}`)
      return {
        success: true,
        ...result.message !== undefined ? { message: result.message } : {},
        durationMs: result.durationMs,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Scroll ${args.direction} ×${args.amount}`, kind: 'execute' }),
  }))
}
