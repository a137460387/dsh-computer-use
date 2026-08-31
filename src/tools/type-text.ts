/**
 * `type_text` tool: types text after the danger filter (mis-fire backstop,
 * blocks force-fully and bypasses every auto-approval path) and approval
 * gating. The sidecar carries an aligned backstop of its own.
 * @module dsh-computer-use/tools/type-text
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ObservationId } from '../definition/index.ts'
import {
  computerUse,
  maybeVerifyAction,
  requestApproval,
  sessionIdOf,
  stepCounter,
  whitelistTier,
  type ToolDeps,
} from './shared.ts'

/**
 * Register `type_text` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 * @param deps - shared security wiring.
 */
export function registerTypeText(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'type_text',
    description: 'Type text into the focused desktop window. Destructive command payloads'
      + ' (rm -rf, format, shutdown, sudo, and similar) are blocked outright. Focus the target'
      + ' field first (e.g. with click_at) before typing.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
      basedOnObservationId: { type: 'string', description: 'ObservationId of the screenshot being acted on.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', required: true },
          message: { type: 'string' },
          durationMs: { type: 'number', required: true },
          chars: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `Typed ${value.chars} characters in ${Math.round(value.durationMs)} ms.`
          : `Typing failed: ${value.message ?? 'unknown sidecar error'}`,
      }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      stepCounter.assert(sessionId, deps.config.maxSteps)

      // Danger interception: force-block, high-risk audit record, and NO
      // auto-approval path — this precedes the approval gate on purpose.
      const danger = deps.dangerFilter.check(args.text)
      if (danger !== undefined) {
        deps.auditor.recordDanger({
          sessionId,
          toolName: 'type_text',
          pattern: danger.pattern,
          textBytes: Buffer.byteLength(args.text, 'utf8'),
        })
        throw new Error(
          'dsh-computer-use: type_text blocked — the payload matches a danger pattern '
          + 'and is never typed; rephrase the task or ask the user to do it manually',
        )
      }

      deps.breaker.assertCanAct()
      const tier = await whitelistTier(ctx, deps, 'medium')
      await requestApproval(ctx, deps, exec, 'type_text', tier, `type ${args.text.length} characters into the focused window`)
      stepCounter.note(sessionId)
      deps.breaker.noteAction()
      const result = await computerUse(ctx).typeText({
        text: args.text,
        ...args.basedOnObservationId !== undefined ? { basedOnObservationId: ObservationId(args.basedOnObservationId) } : {},
      })
      if (!result.success) throw new Error(`dsh-computer-use: typing refused: ${result.message ?? 'unknown sidecar error'}`)
      const note = await maybeVerifyAction(ctx, deps, exec, 'type_text', `type ${args.text.length} characters into the focused window`)
      return {
        success: true,
        ...result.message !== undefined || note !== undefined
          ? { message: `${result.message ?? ''}${note ?? ''}`.trim() }
          : {},
        durationMs: result.durationMs,
        chars: args.text.length,
      }
    },
    presentCall: (args) => {
      const preview = args.text.length > 60 ? `${args.text.slice(0, 60)}…` : args.text
      return { card: 'generic', title: `Type "${preview}"`, kind: 'execute' }
    },
  }))
}
