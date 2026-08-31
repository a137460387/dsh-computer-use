import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, name } from '../index.ts'
import { testConfig } from './helpers.ts'

// apply() mounts the auditor before the route check (the routes-missing
// refusal is itself audited), so refusal tests need throwaway log paths.
const workRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-entry-'))
afterAll(async () => { await rm(workRoot, { recursive: true, force: true }) })

function refusalConfig(overrides: Record<string, unknown> = {}) {
  return testConfig({
    auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`),
    screenshotArchivePath: join(workRoot, `shots-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  })
}

describe('bundle entry', () => {
  it('exports a stable plugin name', () => {
    expect(name).toBe('computer-use')
  })

  it('refuses activation while any model route is empty', () => {
    const ctx = new Context()
    expect(() => apply(ctx, refusalConfig({ visionModel: '' })))
      .toThrow(/model routes are not configured.*visionModel/)
  })

  it('names every missing route in the refusal', () => {
    const ctx = new Context()
    expect(() => apply(ctx, refusalConfig({
      visionProvider: '', visionModel: '', changeDetectionProvider: '', changeDetectionModel: '',
    }))).toThrow(/visionProvider, visionModel, changeDetectionProvider, changeDetectionModel/)
  })

  it('refuses activation on an uncompilable sensitive-window pattern', () => {
    const ctx = new Context()
    expect(() => apply(ctx, refusalConfig({ sensitiveWindowPatterns: ['[unclosed'] })))
      .toThrow()
  })
})
