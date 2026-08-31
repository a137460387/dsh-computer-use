import { afterEach, describe, expect, it, vi } from 'vitest'
import { consultAnswerer, describeAnswererQuota } from '../src/answerer.ts'
import { testConfig } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

let sessionSeq = 0

/** Fresh session id per use: grant windows are process-global state. */
function session(): string {
  sessionSeq += 1
  return `s${sessionSeq}`
}

describe('consultAnswerer', () => {
  it('auto-grants a medium-risk request inside the window', () => {
    expect(consultAnswerer(testConfig(), session(), 'medium')).toBe('auto')
  })

  it('delegates every high-risk request regardless of window state', () => {
    const config = testConfig()
    const id = session()
    expect(consultAnswerer(config, id, 'high')).toBe('delegate')
    expect(consultAnswerer(config, id, 'high')).toBe('delegate')
    // The high-risk look never consumed the session's medium quota.
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
  })

  it('enforces the grant ceiling and keeps it exhausted for the window', () => {
    const config = testConfig({ autoApprovalMaxGrants: 2 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    // Quota spent: this and every later request in the window delegates.
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')
  })

  it('tracks sessions independently', () => {
    const config = testConfig({ autoApprovalMaxGrants: 1 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')
    // A different session still has its own fresh quota.
    expect(consultAnswerer(config, session(), 'medium')).toBe('auto')
  })

  it('re-arms the quota after the window expires', () => {
    vi.useFakeTimers()
    const config = testConfig({ autoApprovalWindowMs: 1000, autoApprovalMaxGrants: 1 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')

    vi.advanceTimersByTime(1500)
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
  })
})

describe('describeAnswererQuota', () => {
  it('reports a fresh quota for a session without grant history', () => {
    const snapshot = describeAnswererQuota(testConfig(), session())
    expect(snapshot).toMatchObject({ state: 'fresh', grantsUsed: 0, grantCeiling: 50, windowMs: 300_000 })
    expect(snapshot.windowRemainingMs).toBeUndefined()
  })

  it('reports an active window with grants used, without consuming quota', () => {
    const config = testConfig({ autoApprovalMaxGrants: 5 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')

    const snapshot = describeAnswererQuota(config, id)
    expect(snapshot.state).toBe('active')
    expect(snapshot.grantsUsed).toBe(1)
    expect(snapshot.windowRemainingMs).toBeLessThanOrEqual(config.autoApprovalWindowMs)

    // Read-only: inspecting twice and then consulting again still auto-grants.
    expect(describeAnswererQuota(config, id).grantsUsed).toBe(1)
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(describeAnswererQuota(config, id).grantsUsed).toBe(2)
  })

  it('reports exhaustion once the ceiling is spent inside the window', () => {
    const config = testConfig({ autoApprovalMaxGrants: 1 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')

    const snapshot = describeAnswererQuota(config, id)
    expect(snapshot.state).toBe('exhausted')
    expect(snapshot.grantsUsed).toBe(1)
    expect(snapshot.grantCeiling).toBe(1)
  })

  it('reports the window re-armed after it expires', () => {
    vi.useFakeTimers()
    const config = testConfig({ autoApprovalWindowMs: 1000, autoApprovalMaxGrants: 1 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(describeAnswererQuota(config, id).state).toBe('exhausted')

    vi.advanceTimersByTime(1500)
    expect(describeAnswererQuota(config, id).state).toBe('fresh')
  })
})
