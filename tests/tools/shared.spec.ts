import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { HIGH_RISK_MARKER, MEDIUM_RISK_MARKER } from '../../src/answerer.ts'
import { isHighRiskHotkey, isSameHotkey, normalizeHotkey, requestApproval, type ToolDeps } from '../../src/tools/shared.ts'
import { testConfig } from '../helpers.ts'

describe('normalizeHotkey', () => {
  it('lowercases and sorts keys into a canonical identity', () => {
    expect(normalizeHotkey(['Win', 'R'])).toBe('r+win')
    expect(normalizeHotkey(['r', 'win'])).toBe('r+win')
  })

  it('is independent of the emitted key order', () => {
    expect(normalizeHotkey(['ctrl', 'shift', 'esc']))
      .toBe(normalizeHotkey(['esc', 'ctrl', 'shift']))
  })
})

describe('isHighRiskHotkey', () => {
  it.each([
    ['alt', 'f4'],
    ['ctrl', 'shift', 'esc'],
    ['win', 'i'],
    ['win', 'l'],
    ['win', 'r'],
    ['win', 'x'],
  ])('escalates the system shortcut %j regardless of key order', (...keys) => {
    expect(isHighRiskHotkey(keys)).toBe(true)
    expect(isHighRiskHotkey([...keys].reverse())).toBe(true)
    expect(isHighRiskHotkey(keys.map(key => key.toUpperCase()))).toBe(true)
  })

  it('does not escalate ordinary application shortcuts', () => {
    expect(isHighRiskHotkey(['ctrl', 'c'])).toBe(false)
    expect(isHighRiskHotkey(['ctrl', 'v'])).toBe(false)
    expect(isHighRiskHotkey(['alt', 'tab'])).toBe(false)
    expect(isHighRiskHotkey(['f5'])).toBe(false)
  })

  it('does not escalate a superset of a system shortcut', () => {
    // win+r is high risk, but win+r+extra is a different combination.
    expect(isHighRiskHotkey(['win', 'r', 'shift'])).toBe(false)
  })
})

describe('isSameHotkey', () => {
  it('compares independent of key order and case', () => {
    expect(isSameHotkey(['u', 'ALT', 'Ctrl'], ['ctrl', 'alt', 'u'])).toBe(true)
  })

  it('rejects different combos and subset/superset pairs', () => {
    expect(isSameHotkey(['ctrl', 'alt'], ['ctrl', 'alt', 'u'])).toBe(false)
    expect(isSameHotkey(['ctrl', 'alt', 'u'], ['ctrl', 'alt'])).toBe(false)
    expect(isSameHotkey(['ctrl', 'alt', 'u'], ['ctrl', 'alt', 'i'])).toBe(false)
  })

  it('never matches an empty combination', () => {
    expect(isSameHotkey([], [])).toBe(false)
    expect(isSameHotkey([], ['ctrl'])).toBe(false)
  })
})

let approvalSeq = 0

/** Fresh session id per use: the answerer's grant windows are process-global. */
function session(): string {
  approvalSeq += 1
  return `approval-s${approvalSeq}`
}

function execOf(sessionId: string): ToolExecution {
  return { agent: { session: { id: sessionId } } as unknown as Agent } as unknown as ToolExecution
}

/** A context whose approval seam resolves with the scripted outcome. */
function ctxApproving(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') {
  const request = vi.fn().mockResolvedValue(outcome)
  const ctx = { approval: { request } } as unknown as Context
  return { ctx, request }
}

function depsOf(overrides: Record<string, unknown> = {}): ToolDeps {
  return {
    config: testConfig(overrides),
    dangerFilter: {},
    breaker: {},
    auditor: {
      recordDanger: vi.fn(),
      recordSensitiveWindow: vi.fn(),
      recordAutoApproval: vi.fn(),
      recordLifecycle: vi.fn(),
      sweepRetention: vi.fn(),
    },
    changeDetector: {},
  } as unknown as ToolDeps
}

describe('requestApproval', () => {
  it('auto-grants an in-quota medium request without consulting the seam', async () => {
    const { ctx, request } = ctxApproving('allowed-once')
    const deps = depsOf()
    const sessionId = session()

    await expect(requestApproval(ctx, deps, execOf(sessionId), 'click_at', 'medium', 'click (1, 2)'))
      .resolves.toBeUndefined()

    expect(request).not.toHaveBeenCalled()
    expect(deps.auditor.recordAutoApproval).toHaveBeenCalledWith({
      sessionId, toolName: 'click_at', tier: 'medium',
    })
  })

  it('consults the seam with the medium marker once the quota is exhausted', async () => {
    const { ctx, request } = ctxApproving('allowed-once')
    const deps = depsOf({ autoApprovalMaxGrants: 1 })
    const exec = execOf(session())

    await requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (1, 2)')
    await expect(requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (3, 4)'))
      .resolves.toBeUndefined()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0].reason).toBe(`${MEDIUM_RISK_MARKER} click (3, 4)`)
    expect(deps.auditor.recordAutoApproval).toHaveBeenCalledTimes(1)
  })

  it('always consults the seam for high risk, marker included', async () => {
    const { ctx, request } = ctxApproving('allowed-once')
    const deps = depsOf()

    await expect(requestApproval(ctx, deps, execOf(session()), 'hotkey', 'high', 'press r+win'))
      .resolves.toBeUndefined()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0].reason).toBe(`${HIGH_RISK_MARKER} press r+win`)
    expect(deps.auditor.recordAutoApproval).not.toHaveBeenCalled()
  })

  it('fails closed with never-mode guidance when the seam rejects', async () => {
    const { ctx } = ctxApproving('rejected')
    const deps = depsOf()

    await expect(requestApproval(ctx, deps, execOf(session()), 'hotkey', 'high', 'press r+win')).rejects.toThrow(
      /needs interactive approval \(tier=high\).*never-approval \(Full access\).*Workspace Write/s,
    )
  })

  it('fails closed with never-mode guidance when no answerer is available', async () => {
    const { ctx, request } = ctxApproving('unavailable')
    const deps = depsOf({ autoApprovalMaxGrants: 1 })
    const exec = execOf(session())

    // First grant consumes the quota; the second request reaches the seam.
    await requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (1, 2)')
    await expect(requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (3, 4)')).rejects.toThrow(
      /needs interactive approval \(tier=medium\).*never-approval \(Full access\).*Workspace Write/s,
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('surfaces cancellations as their own error', async () => {
    const { ctx } = ctxApproving('cancelled')
    const deps = depsOf()

    await expect(requestApproval(ctx, deps, execOf(session()), 'hotkey', 'high', 'press r+win'))
      .rejects.toThrow(/approval was cancelled/)
  })

  it('refuses an execution without an agent', async () => {
    const { ctx } = ctxApproving('allowed-once')
    const deps = depsOf()
    const exec = {} as unknown as ToolExecution

    await expect(requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (1, 2)'))
      .rejects.toThrow(/agent-scoped execution/)
  })
})
