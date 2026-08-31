/**
 * `resume_actions` tool (low risk, no approval): resumes desktop control
 * after a pause. Pausing happens when the user presses the takeover hotkey
 * or touches mouse/keyboard outside an agent action; observation tools stay
 * available while paused, and the next action still goes through approval.
 * @module dsh-computer-use/tools/resume-actions
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computerUse } from './shared.ts'

/**
 * Register `resume_actions` on the tool registry.
 * @param ctx - host context carrying the tool registry and the service.
 */
export function registerResumeActions(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'resume_actions',
    description: 'Resume desktop control actions after a pause. Desktop control pauses when the user'
      + ' presses the takeover hotkey or moves the mouse / presses keys themselves. screen_shot and'
      + ' get_display_info stay available while paused; call this tool (or let the user press the'
      + ' takeover hotkey again) before issuing click_at/type_text/scroll/hotkey.',
    parameters: {},
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
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `${value.message ?? 'Resumed.'} (${Math.round(value.durationMs)} ms)`
          : `Resume failed: ${value.message ?? 'unknown sidecar error'}`,
      }],
    },
    async execute() {
      const result = await computerUse(ctx).resumeActions()
      if (!result.success) throw new Error(`dsh-computer-use: resume refused: ${result.message ?? 'unknown sidecar error'}`)
      return {
        success: true,
        ...result.message !== undefined ? { message: result.message } : {},
        durationMs: result.durationMs,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Resume desktop actions', kind: 'execute' }),
  }))
}
