import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAuditor } from '../../src/security/auditor.ts'
import { testConfig } from '../helpers.ts'

const workRoot = await mkdtemp(join(tmpdir(), 'dsh-cu-audit-'))
afterAll(async () => { await rm(workRoot, { recursive: true, force: true }) })

/** Wait until the audit file holds at least `count` JSON lines. */
async function waitForLines(path: string, count: number): Promise<Record<string, unknown>[]> {
  return vi.waitFor(async () => {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.length).toBeGreaterThanOrEqual(count)
    return lines
  }, { timeout: 5000, interval: 25 })
}

describe('createAuditor', () => {
  it('appends an action/before line for the before-action event', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    createAuditor(ctx, config)

    ctx.emit('computer-use/before-action', { action: 'click_at', detail: 'x=10 y=20', atMs: Date.now() })

    const lines = await waitForLines(config.auditLogPath, 1)
    expect(lines[0]).toMatchObject({ kind: 'action/before', actionType: 'click_at', detail: 'x=10 y=20' })
    expect(lines[0]?.timestamp).toEqual(expect.any(String))
  })

  it('appends an action/after line carrying outcome, hashes, and duration', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    createAuditor(ctx, config)

    ctx.emit('computer-use/after-action', {
      action: 'type_text', success: true, durationMs: 42,
      beforeHash: 'aa', afterHash: 'bb', atMs: Date.now(),
    })

    const lines = await waitForLines(config.auditLogPath, 1)
    expect(lines[0]).toMatchObject({
      kind: 'action/after', actionType: 'type_text', success: true,
      durationMs: 42, beforeHash: 'aa', afterHash: 'bb',
    })
  })

  it('omits absent optional fields instead of logging undefined', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    createAuditor(ctx, config)

    ctx.emit('computer-use/before-action', { action: 'screen_shot', atMs: Date.now() })

    const lines = await waitForLines(config.auditLogPath, 1)
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['actionType', 'kind', 'timestamp'])
  })

  it('records a danger interception as a high-severity line without the payload', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    const auditor = createAuditor(ctx, config)

    auditor.recordDanger({ sessionId: 'sess-1', toolName: 'type_text', pattern: '\\bsudo\\b', textBytes: 12 })

    const lines = await waitForLines(config.auditLogPath, 1)
    expect(lines[0]).toMatchObject({
      kind: 'danger/blocked', severity: 'high', toolName: 'type_text',
      pattern: '\\bsudo\\b', textBytes: 12, sessionId: 'sess-1',
    })
  })

  it('records a sensitive-window refusal with the title but no screen content', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    const auditor = createAuditor(ctx, config)

    auditor.recordSensitiveWindow({ sessionId: 'sess-1', windowTitle: 'KeePass 2', pattern: 'keepass' })

    const lines = await waitForLines(config.auditLogPath, 1)
    expect(lines[0]).toMatchObject({
      kind: 'danger/sensitive-window', severity: 'high',
      windowTitle: 'KeePass 2', pattern: 'keepass', sessionId: 'sess-1',
    })
  })

  it('records lifecycle lines keyed by event name', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    const auditor = createAuditor(ctx, config)

    auditor.recordLifecycle({
      event: 'mounted', platform: 'win32', visionRoutesConfigured: true,
      visionRoute: 'vp/vm', changeDetectionRoute: 'cp/cm',
    })
    auditor.recordLifecycle({ event: 'routes-missing', missing: ['visionModel'] })
    auditor.recordLifecycle({ event: 'sidecar-starting', mode: 'prod', description: 'prod binary x' })
    auditor.recordLifecycle({ event: 'sidecar-connected', version: '0.1.1' })
    auditor.recordLifecycle({ event: 'sidecar-exited', exitCode: 0, signal: null, trigger: 'shutdown' })
    auditor.recordLifecycle({ event: 'paused', reason: 'hotkey' })
    auditor.recordLifecycle({ event: 'resumed', reason: 'user-input' })

    const lines = await waitForLines(config.auditLogPath, 7)
    expect(lines.map(line => line.kind)).toEqual([
      'lifecycle/mounted',
      'lifecycle/routes-missing',
      'lifecycle/sidecar-starting',
      'lifecycle/sidecar-connected',
      'lifecycle/sidecar-exited',
      'lifecycle/paused',
      'lifecycle/resumed',
    ])
    expect(lines[0]).toMatchObject({ platform: 'win32', visionRoutesConfigured: true, visionRoute: 'vp/vm' })
    expect(lines[1]).toMatchObject({ missing: ['visionModel'] })
    expect(lines[4]).toMatchObject({ exitCode: 0, signal: null, trigger: 'shutdown' })
    expect(lines[5]).toMatchObject({ reason: 'hotkey' })
    expect(lines[6]).toMatchObject({ reason: 'user-input' })
  })

  it('serializes concurrent appends into one line per event', async () => {
    const ctx = new Context()
    const config = testConfig({ auditLogPath: join(workRoot, `audit-${Math.random().toString(36).slice(2)}.log`) })
    createAuditor(ctx, config)

    for (let index = 0; index < 10; index += 1) {
      ctx.emit('computer-use/before-action', { action: 'scroll', detail: `i=${index}`, atMs: Date.now() })
    }

    const lines = await waitForLines(config.auditLogPath, 10)
    expect(lines).toHaveLength(10)
    expect(lines.every(line => line.kind === 'action/before')).toBe(true)
  })

  it('prunes audit lines older than the retention window at startup', async () => {
    const ctx = new Context()
    const auditLogPath = join(workRoot, `prune-${Math.random().toString(36).slice(2)}.log`)
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const fresh = new Date().toISOString()
    await writeFile(auditLogPath, [
      JSON.stringify({ kind: 'action/before', timestamp: old, actionType: 'click_at' }),
      JSON.stringify({ kind: 'action/before', timestamp: fresh, actionType: 'scroll' }),
    ].join('\n') + '\n', 'utf8')

    const config = testConfig({ auditLogPath })
    createAuditor(ctx, config)

    const lines = await vi.waitFor(async () => {
      const raw = await readFile(auditLogPath, 'utf8')
      const parsed = raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(parsed).toHaveLength(1)
      return parsed
    }, { timeout: 5000, interval: 25 })
    expect(lines[0]).toMatchObject({ actionType: 'scroll' })
  })

  it('prunes archived screenshots older than the retention window at startup', async () => {
    const { mkdir, utimes, readdir } = await import('node:fs/promises')
    const ctx = new Context()
    const screenshotArchivePath = join(workRoot, `shots-${Math.random().toString(36).slice(2)}`)
    await mkdir(screenshotArchivePath, { recursive: true })

    const oldShot = join(screenshotArchivePath, 'old.jpg')
    const freshShot = join(screenshotArchivePath, 'fresh.jpg')
    const notImage = join(screenshotArchivePath, 'keep.txt')
    await writeFile(oldShot, 'old')
    await writeFile(freshShot, 'fresh')
    await writeFile(notImage, 'not an image')
    // Backdate the old shot past the retention window.
    const oldDate = new Date(Date.now() - 30 * 86_400_000)
    await utimes(oldShot, oldDate, oldDate)

    const config = testConfig({ screenshotArchivePath })
    createAuditor(ctx, config)

    await vi.waitFor(async () => {
      const entries = await readdir(screenshotArchivePath)
      expect(entries).not.toContain('old.jpg')
      expect(entries).toContain('fresh.jpg')
      expect(entries).toContain('keep.txt')
    }, { timeout: 5000, interval: 25 })
  })
})
