import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { HIGH_RISK_MARKER, MEDIUM_RISK_MARKER } from '../../src/answerer.ts'
import { StepCounter, isHighRiskHotkey, isSameHotkey, maybeVerifyAction, normalizeHotkey, requestApproval, type ToolDeps } from '../../src/tools/shared.ts'
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
      recordAnswerRefusal: vi.fn(),
      recordActionRefusal: vi.fn(),
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
    expect(deps.auditor.recordAnswerRefusal).not.toHaveBeenCalled()
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
    expect(deps.auditor.recordAnswerRefusal).not.toHaveBeenCalled()
  })

  it('fails closed with never-mode guidance when the seam rejects', async () => {
    const { ctx } = ctxApproving('rejected')
    const deps = depsOf()
    const sessionId = session()

    await expect(requestApproval(ctx, deps, execOf(sessionId), 'hotkey', 'high', 'press r+win')).rejects.toThrow(
      /needs interactive approval \(tier=high\).*never-approval \(Full access\).*Workspace Write/s,
    )
    expect(deps.auditor.recordAnswerRefusal).toHaveBeenCalledWith({
      sessionId, toolName: 'hotkey', tier: 'high', outcome: 'rejected',
    })
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
    expect(deps.auditor.recordAnswerRefusal).toHaveBeenCalledTimes(1)
    expect(deps.auditor.recordAnswerRefusal).toHaveBeenCalledWith({
      sessionId: String(exec.agent?.session.id), toolName: 'click_at', tier: 'medium', outcome: 'unavailable',
    })
  })

  it('surfaces cancellations as their own error', async () => {
    const { ctx } = ctxApproving('cancelled')
    const deps = depsOf()
    const sessionId = session()

    await expect(requestApproval(ctx, deps, execOf(sessionId), 'hotkey', 'high', 'press r+win'))
      .rejects.toThrow(/approval was cancelled/)
    expect(deps.auditor.recordAnswerRefusal).toHaveBeenCalledWith({
      sessionId, toolName: 'hotkey', tier: 'high', outcome: 'cancelled',
    })
  })

  it('refuses an execution without an agent', async () => {
    const { ctx } = ctxApproving('allowed-once')
    const deps = depsOf()
    const exec = {} as unknown as ToolExecution

    await expect(requestApproval(ctx, deps, exec, 'click_at', 'medium', 'click (1, 2)'))
      .rejects.toThrow(/agent-scoped execution/)
  })
})

describe('StepCounter.count', () => {
  it('reports zero for an unseen session and tracks noted actions', () => {
    const counter = new StepCounter()
    expect(counter.count('fresh-session')).toBe(0)
    counter.note('fresh-session')
    counter.note('fresh_session')
    counter.note('fresh_session')
    expect(counter.count('fresh_session')).toBe(2)
    expect(counter.count('another')).toBe(0)
  })
})

describe('maybeVerifyAction', () => {
  /** A context whose computerUse service serves the scripted after-capture. */
  function verifyCtx(after: Record<string, unknown>): Context {
    const runtime = { screenShot: vi.fn().mockResolvedValue(after) }
    return { get: (name: string) => (name === 'computerUse' ? runtime : undefined) } as unknown as Context
  }

  it('records the verification verdict with the basis observationId', async () => {
    const ctx = verifyCtx({ observationId: 'obs-after', data: new Uint8Array([4, 5, 6]), width: 1280, height: 720 })
    const base = depsOf({ actionVerification: 'always', actionVerificationSettleMs: 0 })
    const recordVerification = vi.fn()
    const deps = {
      ...base,
      auditor: { ...base.auditor, recordVerification },
      vision: { verifyActionEffect: vi.fn().mockResolvedValue({ verdict: 'yes', reason: 'text appeared', tier: 'flash' }) },
      previousShot: { data: new Uint8Array([1, 2, 3]), width: 1280, height: 720, dhash: '0000000000000000' },
      previousShotId: 'obs-base',
    } as unknown as ToolDeps

    const note = await maybeVerifyAction(ctx, deps, execOf(session()), 'type_text', 'type 5 characters into the focused window')

    expect(note).toContain('Semantic verification confirmed the effect')
    expect(recordVerification).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'type_text',
      observationId: 'obs-base',
      verdict: 'yes',
      retried: false,
    }))
  })
})
