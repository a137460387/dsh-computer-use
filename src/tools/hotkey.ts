/**
 * `hotkey` tool: presses one key combination. System shortcuts (run dialog,
 * settings, task manager, session lock, window close) escalate to high risk
 * and always require interactive confirmation.
 * @module dsh-computer-use/tools/hotkey
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ObservationId } from '../definition/index.ts'
import {
  computerUse,
  isHighRiskHotkey,
  isSameHotkey,
  maybeVerifyAction,
  normalizeHotkey,
  requestApproval,
  sessionIdOf,
  stepCounter,
  whitelistTier,
  type ToolDeps,
} from './shared.ts'

/**
 * Register `hotkey` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 * @param deps - shared security wiring.
 */
export function registerHotkey(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'hotkey',
    description: 'Press one key combination (e.g. ["ctrl","c"], ["alt","tab"]) in the desktop.'
      + ' System-level shortcuts (win+r, win+i, win+x, win+l, alt+f4, ctrl+shift+esc) always'
      + ' require interactive confirmation and are refused outright in never-approval sessions.',
    parameters: {
      keys: { type: 'array', items: { type: 'string' }, required: true, description: 'Keys pressed together, e.g. ["ctrl", "c"].' },
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
          ? `Pressed ${args.keys.join('+')} in ${Math.round(value.durationMs)} ms.`
          : `Hotkey failed: ${value.message ?? 'unknown sidecar error'}`,
      }],
    },
    async execute(args, exec) {
      if (args.keys.length === 0) throw new Error('dsh-computer-use: hotkey needs at least one key')
      const sessionId = sessionIdOf(exec)
      stepCounter.assert(sessionId, deps.config.maxSteps)
      deps.breaker.assertCanAct()
      // The takeover combo itself escalates: the model must not toggle the
      // pause state without explicit interactive confirmation.
      const baseTier = isHighRiskHotkey(args.keys) || isSameHotkey(args.keys, deps.config.takeoverHotkey)
        ? 'high'
        : 'medium'
      const tier = await whitelistTier(ctx, deps, baseTier)
      await requestApproval(ctx, deps, exec, 'hotkey', tier, `press ${normalizeHotkey(args.keys)}`)
      stepCounter.note(sessionId)
      deps.breaker.noteAction()
      const result = await computerUse(ctx).hotkey({
        keys: args.keys,
        ...args.basedOnObservationId !== undefined ? { basedOnObservationId: ObservationId(args.basedOnObservationId) } : {},
      })
      if (!result.success) throw new Error(`dsh-computer-use: hotkey refused: ${result.message ?? 'unknown sidecar error'}`)
      const note = await maybeVerifyAction(ctx, deps, exec, 'hotkey', `press ${normalizeHotkey(args.keys)}`)
      return {
        success: true,
        ...result.message !== undefined || note !== undefined
          ? { message: `${result.message ?? ''}${note ?? ''}`.trim() }
          : {},
        durationMs: result.durationMs,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Press ${normalizeHotkey(args.keys)}`, kind: 'execute' }),
  }))
}
