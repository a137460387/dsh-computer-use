import { describe, expect, it } from 'vitest'
import { collectReadiness } from '../../src/diagnostics/readiness.ts'
import type { ReadinessInput, SidecarReadinessFacts } from '../../src/diagnostics/readiness.ts'
import { consultAnswerer } from '../../src/answerer.ts'
import { SensitiveWindowPolicy } from '../../src/security/sensitive-window.ts'
import { testConfig } from '../helpers.ts'

let sessionSeq = 0

/** Fresh session id per use: grant windows are process-global state. */
function session(): string {
  sessionSeq += 1
  return `readiness-s${sessionSeq}`
}

function connectedSidecar(overrides: Partial<SidecarReadinessFacts> = {}): SidecarReadinessFacts {
  return {
    connected: true,
    startedOnce: true,
    disposed: false,
    serverVersion: '0.1.3',
    toolSurfaceSize: 9,
    requiredToolSurfaceSize: 9,
    paused: false,
    healthCheckActive: true,
    ...overrides,
  }
}

function inputOf(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    config: testConfig(),
    sidecar: connectedSidecar(),
    breaker: { isTripped: false, consecutiveNoChange: 0 },
    auditor: { writeHealth: () => ({ status: 'ok', atMs: 1_700_000_000_000 }) },
    sensitivePolicy: new SensitiveWindowPolicy(['keepass'], []),
    platform: 'win32',
    ...overrides,
  }
}

function itemOf(report: ReturnType<typeof collectReadiness>, id: string) {
  const item = report.checks.find(check => check.id === id)
  if (item === undefined) throw new Error(`expected checklist item "${id}"`)
  return item
}

describe('collectReadiness', () => {
  it('reports every subsystem passing on a healthy win32 run', () => {
    const report = collectReadiness(inputOf({ session: { id: session(), stepsUsed: 2 } }), 1_700_000_000_000)

    expect(report.overall).toBe('pass')
    expect(report.checkedAtMs).toBe(1_700_000_000_000)
    expect(report.checks.map(check => check.id)).toEqual([
      'sidecar-connection',
      'sidecar-tool-surface',
      'approval-quota',
      'no-change-breaker',
      'audit-writable',
      'sensitive-window-rules',
      'takeover-monitor',
      'step-budget',
    ])
    expect(report.checks.every(check => check.status === 'pass')).toBe(true)
    expect(itemOf(report, 'sidecar-connection').detail).toContain('v0.1.3')
    expect(itemOf(report, 'step-budget').detail).toContain('28/30')
  })

  it('omits the step-budget item without a session scope', () => {
    const report = collectReadiness(inputOf())
    expect(report.checks.map(check => check.id)).not.toContain('step-budget')
  })

  it('reports the lazy-start state before any sidecar use as unknown', () => {
    const report = collectReadiness(inputOf({
      sidecar: {
        connected: false,
        startedOnce: false,
        disposed: false,
        requiredToolSurfaceSize: 9,
        paused: false,
        healthCheckActive: false,
      },
    }))
    expect(itemOf(report, 'sidecar-connection').status).toBe('unknown')
    expect(itemOf(report, 'sidecar-connection').detail).toContain('lazily')
    expect(itemOf(report, 'sidecar-tool-surface').status).toBe('unknown')
    expect(itemOf(report, 'takeover-monitor').status).toBe('unknown')
    expect(report.overall).toBe('unknown')
  })

  it('fails the connection item after a previous start attempt without a connection', () => {
    const report = collectReadiness(inputOf({
      sidecar: {
        connected: false,
        startedOnce: true,
        disposed: false,
        requiredToolSurfaceSize: 9,
        paused: false,
        healthCheckActive: false,
      },
    }))
    expect(itemOf(report, 'sidecar-connection').status).toBe('fail')
    expect(report.overall).toBe('fail')
  })

  it('fails when the provider is disposed', () => {
    const report = collectReadiness(inputOf({
      sidecar: connectedSidecar({ connected: false, disposed: true, healthCheckActive: false }),
    }))
    expect(itemOf(report, 'sidecar-connection').status).toBe('fail')
    expect(itemOf(report, 'sidecar-connection').detail).toContain('disposed')
  })

  it('fails a short tool surface', () => {
    const report = collectReadiness(inputOf({ sidecar: connectedSidecar({ toolSurfaceSize: 7 }) }))
    expect(itemOf(report, 'sidecar-tool-surface').status).toBe('fail')
    expect(itemOf(report, 'sidecar-tool-surface').detail).toContain('7')
  })

  it('treats an absent provider as unknown sidecar state', () => {
    const input = inputOf()
    delete (input as { sidecar?: SidecarReadinessFacts }).sidecar
    const report = collectReadiness(input)
    expect(itemOf(report, 'sidecar-connection').status).toBe('unknown')
    expect(itemOf(report, 'sidecar-tool-surface').status).toBe('unknown')
  })

  it('fails an exhausted auto-approval quota with the remedy window', () => {
    const config = testConfig({ autoApprovalMaxGrants: 2, autoApprovalWindowMs: 300_000 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')
    expect(consultAnswerer(config, id, 'medium')).toBe('delegate')

    const report = collectReadiness(inputOf({ config, session: { id, stepsUsed: 0 } }), Date.now())
    const quota = itemOf(report, 'approval-quota')
    expect(quota.status).toBe('fail')
    expect(quota.detail).toContain('2/2')
    expect(quota.detail).toContain('never-approval')
    expect(report.overall).toBe('fail')
  })

  it('reports an active quota with grants used and remaining window', () => {
    const config = testConfig({ autoApprovalMaxGrants: 5 })
    const id = session()
    expect(consultAnswerer(config, id, 'medium')).toBe('auto')

    const quota = itemOf(collectReadiness(inputOf({ config, session: { id, stepsUsed: 0 } })), 'approval-quota')
    expect(quota.status).toBe('pass')
    expect(quota.detail).toContain('1/5')
  })

  it('reports a fresh quota for a session without grant history', () => {
    const quota = itemOf(collectReadiness(inputOf({ session: { id: session(), stepsUsed: 0 } })), 'approval-quota')
    expect(quota.status).toBe('pass')
    expect(quota.detail).toContain('fresh quota')
  })

  it('asks for a session id when checking the quota globally', () => {
    const quota = itemOf(collectReadiness(inputOf()), 'approval-quota')
    expect(quota.status).toBe('unknown')
    expect(quota.detail).toContain('session id')
  })

  it('fails a tripped breaker and names the no-change count', () => {
    const report = collectReadiness(inputOf({ breaker: { isTripped: true, consecutiveNoChange: 3 } }))
    const breaker = itemOf(report, 'no-change-breaker')
    expect(breaker.status).toBe('fail')
    expect(breaker.detail).toContain('3 consecutive')
  })

  it('reports a partial no-change count while armed', () => {
    const breaker = itemOf(collectReadiness(inputOf({ breaker: { isTripped: false, consecutiveNoChange: 2 } })), 'no-change-breaker')
    expect(breaker.status).toBe('pass')
    expect(breaker.detail).toContain('2 no-change')
  })

  it('fails when the last audit write errored', () => {
    const report = collectReadiness(inputOf({
      auditor: { writeHealth: () => ({ status: 'error', atMs: 1, error: 'ENOSPC: no space left' }) },
    }))
    const audit = itemOf(report, 'audit-writable')
    expect(audit.status).toBe('fail')
    expect(audit.detail).toContain('ENOSPC')
  })

  it('reports unknown before any audit write landed', () => {
    const audit = itemOf(collectReadiness(inputOf({ auditor: { writeHealth: () => ({ status: 'none' }) } })), 'audit-writable')
    expect(audit.status).toBe('unknown')
  })

  it('reports the compiled sensitive-window policy sizes', () => {
    const rules = itemOf(
      collectReadiness(inputOf({ sensitivePolicy: new SensitiveWindowPolicy(['keepass', '网银'], ['test']) })),
      'sensitive-window-rules',
    )
    expect(rules.status).toBe('pass')
    expect(rules.detail).toContain('2 blocklist / 1 allowlist')
  })

  it('notes an intentionally empty blocklist as disabled refusal', () => {
    const rules = itemOf(
      collectReadiness(inputOf({ sensitivePolicy: new SensitiveWindowPolicy([], []) })),
      'sensitive-window-rules',
    )
    expect(rules.status).toBe('pass')
    expect(rules.detail).toContain('disabled by configuration')
  })

  it('reports the macOS capture gate as unknown (fail-open platform fact)', () => {
    const report = collectReadiness(inputOf({ platform: 'darwin' }))
    expect(itemOf(report, 'sensitive-window-rules').status).toBe('unknown')
    expect(itemOf(report, 'takeover-monitor').status).toBe('unknown')
  })

  it('reports monitoring disabled by configuration as pass', () => {
    const monitor = itemOf(
      collectReadiness(inputOf({ config: testConfig({ takeoverHotkey: [], pauseOnUserInput: false }) })),
      'takeover-monitor',
    )
    expect(monitor.status).toBe('pass')
    expect(monitor.detail).toContain('disabled by configuration')
  })

  it('surfaces the pause mirror in the monitor detail', () => {
    const monitor = itemOf(collectReadiness(inputOf({ sidecar: connectedSidecar({ paused: true }) })), 'takeover-monitor')
    expect(monitor.status).toBe('pass')
    expect(monitor.detail).toContain('paused')
  })

  it('fails a session that spent its step budget', () => {
    const report = collectReadiness(inputOf({ session: { id: session(), stepsUsed: 30 } }))
    const budget = itemOf(report, 'step-budget')
    expect(budget.status).toBe('fail')
    expect(budget.detail).toContain('30-action ceiling')
    expect(report.overall).toBe('fail')
  })

  it('rolls up unknown above pass and fail above both', () => {
    expect(collectReadiness(inputOf({ auditor: { writeHealth: () => ({ status: 'none' }) } })).overall).toBe('unknown')
    expect(collectReadiness(inputOf({ breaker: { isTripped: true, consecutiveNoChange: 3 } })).overall).toBe('fail')
    expect(collectReadiness(inputOf({ session: { id: session(), stepsUsed: 0 } })).overall).toBe('pass')
  })
})
