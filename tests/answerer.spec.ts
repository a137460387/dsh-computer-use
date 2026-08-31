import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { HIGH_RISK_MARKER, MEDIUM_RISK_MARKER, registerAnswerer } from '../src/answerer.ts'
import { testConfig } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

function agentOf(sessionId: string): Agent {
  return { session: { id: sessionId } } as unknown as Agent
}

function requestOf(sessionId: string, marker: string): ApprovalRequestEvent {
  return { agent: agentOf(sessionId), toolName: 'click_at', reason: `${marker} do a thing` }
}

/**
 * Drive the approval waterfall with a sentinel interactive answerer as the
 * innermost fallback, so delegation through `next()` is observable. No scoped
 * `this` is passed, so every registered listener participates.
 */
function ask(ctx: Context, req: ApprovalRequestEvent): Promise<ApprovalOutcome> {
  return ctx.waterfall('approval/request', req, () => Promise.resolve('unavailable' as const))
}

describe('registerAnswerer', () => {
  it('auto-grants a medium-risk request inside the window', async () => {
    const ctx = new Context()
    registerAnswerer(ctx, testConfig())
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
  })

  it('delegates a high-risk request to the interactive answerer', async () => {
    const ctx = new Context()
    registerAnswerer(ctx, testConfig())
    await expect(ask(ctx, requestOf('s1', HIGH_RISK_MARKER))).resolves.toBe('unavailable')
  })

  it('delegates requests without the plugin marker', async () => {
    const ctx = new Context()
    registerAnswerer(ctx, testConfig())
    await expect(ask(ctx, requestOf('s1', '[some-other-tool]'))).resolves.toBe('unavailable')
  })

  it('enforces the grant ceiling and keeps it exhausted for the window', async () => {
    const ctx = new Context()
    registerAnswerer(ctx, testConfig({ autoApprovalMaxGrants: 2 }))

    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
    // Quota spent: this and every later request in the window delegates.
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('unavailable')
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('unavailable')
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('unavailable')
  })

  it('tracks sessions independently', async () => {
    const ctx = new Context()
    registerAnswerer(ctx, testConfig({ autoApprovalMaxGrants: 1 }))

    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('unavailable')
    // A different session still has its own fresh quota.
    await expect(ask(ctx, requestOf('s2', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
  })

  it('re-arms the quota after the window expires', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    registerAnswerer(ctx, testConfig({ autoApprovalWindowMs: 1000, autoApprovalMaxGrants: 1 }))

    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('unavailable')

    vi.advanceTimersByTime(1500)
    await expect(ask(ctx, requestOf('s1', MEDIUM_RISK_MARKER))).resolves.toBe('allowed-once')
  })
})
