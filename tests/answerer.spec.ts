import { afterEach, describe, expect, it, vi } from 'vitest'
import { consultAnswerer } from '../src/answerer.ts'
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
