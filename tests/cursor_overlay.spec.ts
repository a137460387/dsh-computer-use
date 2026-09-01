/**
 * Parameter-passing tests for the synthetic cursor overlay: `peek_cursor`
 * forwards the intended point to the sidecar's screen_shot as
 * cursorPosition, and `click_at` archives a `-preview` intent frame before
 * the physical click. The runtime is mocked; the sidecar-side drawing is
 * covered by tests/python/test_cursor_overlay.py.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { registerClickAt } from '../src/tools/click-at.ts'
import { registerPeekCursor } from '../src/tools/peek-cursor.ts'
import type { ToolDeps } from '../src/tools/shared.ts'
import { testConfig } from './helpers.ts'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: ToolExecution): Promise<Record<string, unknown>>
}

let execSeq = 0

/** Fresh session id per execution: the answerer's grant windows are global. */
function execOf(): ToolExecution {
  execSeq += 1
  return { agent: { session: { id: `cursor-s${execSeq}` } } } as unknown as Agent as unknown as ToolExecution
}

/** One sidecar screenshot result as the provider would hand it to the tools. */
function shotOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observationId: 'obs-preview',
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/jpeg',
    width: 1280,
    height: 720,
    dhash: '0000000000000000',
    capturedAtMs: Date.now(),
    ...overrides,
  }
}

function harness(runtime: Record<string, unknown>): { ctx: Context; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = []
  const ctx = {
    get: (name: string) => (name === 'computerUse' ? runtime : undefined),
    tools: { register: (definition: RegisteredTool) => { registered.push(definition) } },
    attachments: {
      saveImage: vi.fn().mockResolvedValue({
        attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 3, width: 1280, height: 720,
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Context
  return { ctx, registered }
}

function depsOf(overrides: Record<string, unknown> = {}): ToolDeps {
  return {
    config: testConfig(overrides),
    dangerFilter: {},
    breaker: { assertCanAct: vi.fn(), noteAction: vi.fn(), observe: vi.fn() },
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

describe('peek_cursor', () => {
  it('draws the synthetic cursor through the sidecar screen_shot and reports overlay facts', async () => {
    const runtime = {
      screenShot: vi.fn().mockResolvedValue(shotOf({ cursorOverlay: { x: 100, y: 200 } })),
      getObservation: vi.fn().mockResolvedValue(shotOf({ observationId: 'obs-1' })),
    }
    const { ctx, registered } = harness(runtime)
    registerPeekCursor(ctx, depsOf())
    const tool = registered[0]
    expect(tool?.name).toBe('peek_cursor')

    const result = await tool!.execute({
      x: 100, y: 200, screenshotWidth: 1280, screenshotHeight: 720, basedOnObservationId: 'obs-1',
    }, execOf())

    expect(runtime.screenShot).toHaveBeenCalledWith({
      maxWidth: 1280,
      quality: 75,
      cursorPosition: { x: 100, y: 200 },
    })
    expect(result.cursorOverlay).toEqual({ x: 100, y: 200 })
    expect(result.observationId).toBe('obs-preview')
    expect(ctx.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({
      name: 'cu-obs-preview.jpg',
    }))
  })

  it('refuses an unknown or expired basis observation without capturing', async () => {
    const runtime = {
      screenShot: vi.fn(),
      getObservation: vi.fn().mockResolvedValue(undefined),
    }
    const { ctx, registered } = harness(runtime)
    registerPeekCursor(ctx, depsOf())

    await expect(registered[0]!.execute({
      x: 1, y: 2, screenshotWidth: 1280, screenshotHeight: 720, basedOnObservationId: 'stale',
    }, execOf())).rejects.toThrow(/unknown or expired ObservationId "stale"/)
    expect(runtime.screenShot).not.toHaveBeenCalled()
  })

  it('refuses a declared basis that mismatches the referenced observation', async () => {
    const runtime = {
      screenShot: vi.fn(),
      getObservation: vi.fn().mockResolvedValue(shotOf({ observationId: 'obs-1', width: 640, height: 360 })),
    }
    const { ctx, registered } = harness(runtime)
    registerPeekCursor(ctx, depsOf())

    await expect(registered[0]!.execute({
      x: 1, y: 2, screenshotWidth: 1280, screenshotHeight: 720, basedOnObservationId: 'obs-1',
    }, execOf())).rejects.toThrow(/basis mismatch/)
    expect(runtime.screenShot).not.toHaveBeenCalled()
  })
})

describe('click_at pre-click preview', () => {
  const clickArgs = { x: 10, y: 20, screenshotWidth: 1280, screenshotHeight: 720 }

  function previewRuntime(calls: string[]) {
    return {
      screenShot: vi.fn().mockImplementation(async () => {
        calls.push('preview')
        return shotOf({ cursorOverlay: { x: 10, y: 20 } })
      }),
      clickAt: vi.fn().mockImplementation(async () => {
        calls.push('click')
        return { success: true, durationMs: 4 }
      }),
    }
  }

  it('archives a -preview frame with the cursor before the physical click', async () => {
    const calls: string[] = []
    const runtime = previewRuntime(calls)
    const { ctx, registered } = harness(runtime)
    registerClickAt(ctx, depsOf())

    const result = await registered[0]!.execute(clickArgs, execOf())

    expect(runtime.screenShot).toHaveBeenCalledWith({
      maxWidth: 1280,
      quality: 75,
      cursorPosition: { x: 10, y: 20 },
      archiveSuffix: '-preview',
    })
    expect(calls).toEqual(['preview', 'click'])
    expect(runtime.clickAt).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 20 }))
    expect(result.success).toBe(true)
  })

  it('still clicks when the preview capture fails', async () => {
    const runtime = {
      screenShot: vi.fn().mockRejectedValue(new Error('capture blew up')),
      clickAt: vi.fn().mockResolvedValue({ success: true, durationMs: 3 }),
    }
    const { ctx, registered } = harness(runtime)
    registerClickAt(ctx, depsOf())

    const result = await registered[0]!.execute(clickArgs, execOf())

    expect(result.success).toBe(true)
    expect(runtime.clickAt).toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('pre-click preview failed'))
  })

  it('skips the preview when clickPreview is disabled', async () => {
    const calls: string[] = []
    const runtime = previewRuntime(calls)
    const { ctx, registered } = harness(runtime)
    registerClickAt(ctx, depsOf({ clickPreview: false }))

    await registered[0]!.execute(clickArgs, execOf())

    expect(runtime.screenShot).not.toHaveBeenCalled()
    expect(calls).toEqual(['click'])
  })
})

describe('click_at verification audit', () => {
  const clickArgs = { x: 10, y: 20, screenshotWidth: 1280, screenshotHeight: 720 }

  it('records the verification verdict with the basis observationId', async () => {
    const runtime = {
      screenShot: vi.fn().mockResolvedValue(shotOf()),
      clickAt: vi.fn().mockResolvedValue({ success: true, durationMs: 4 }),
    }
    const base = depsOf({ actionVerification: 'always', actionVerificationSettleMs: 0, clickPreview: false })
    const recordVerification = vi.fn()
    const deps = {
      ...base,
      auditor: { ...base.auditor, recordVerification },
      vision: { verifyActionEffect: vi.fn().mockResolvedValue({ verdict: 'yes', reason: 'button pressed', tier: 'flash' }) },
      previousShot: { data: new Uint8Array([1, 2, 3]), width: 1280, height: 720, dhash: '0000000000000000' },
      previousShotId: 'obs-base',
    } as unknown as ToolDeps
    const { ctx, registered } = harness(runtime)
    registerClickAt(ctx, deps)

    const result = await registered[0]!.execute(clickArgs, execOf())

    expect(result.success).toBe(true)
    expect(recordVerification).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'click_at',
      observationId: 'obs-base',
      verdict: 'yes',
      retried: false,
    }))
  })
})
