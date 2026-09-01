import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../../src/config.ts'
import {
  ComputerUseRuntime,
  ObservationId,
} from '../../src/definition/index.ts'
import type {
  ActionResult,
  ClickAtRequest,
  DisplayInfo,
  HotkeyRequest,
  PauseActionsResult,
  PauseRequestReason,
  ScreenShot,
  ScreenShotOptions,
  ScrollRequest,
  TypeTextRequest,
} from '../../src/definition/index.ts'
import { testConfig } from '../helpers.ts'

/** Concrete subclass so the abstract Service Definition can be instantiated. */
class TestRuntime extends ComputerUseRuntime {
  version(): Promise<string> { return Promise.resolve('0.1.1') }
  getDisplayInfo(): Promise<DisplayInfo[]> { return Promise.resolve([]) }
  screenShot(_options?: ScreenShotOptions): Promise<ScreenShot> {
    return Promise.reject(new Error('not implemented'))
  }
  clickAt(_request: ClickAtRequest): Promise<ActionResult> {
    return Promise.reject(new Error('not implemented'))
  }
  typeText(_request: TypeTextRequest): Promise<ActionResult> {
    return Promise.reject(new Error('not implemented'))
  }
  scroll(_request: ScrollRequest): Promise<ActionResult> {
    return Promise.reject(new Error('not implemented'))
  }
  hotkey(_request: HotkeyRequest): Promise<ActionResult> {
    return Promise.reject(new Error('not implemented'))
  }
  getObservation(): Promise<ScreenShot | undefined> { return Promise.resolve(undefined) }
  getForegroundWindow(): Promise<string> { return Promise.resolve('') }
  resumeActions(): Promise<ActionResult> {
    return Promise.reject(new Error('not implemented'))
  }
  pauseActions(_reason: PauseRequestReason): Promise<PauseActionsResult> {
    return Promise.reject(new Error('not implemented'))
  }
  armDangerToken(_token: string): Promise<void> {
    return Promise.reject(new Error('not implemented'))
  }
}

describe('ObservationId', () => {
  it('brands a string without altering its value', () => {
    const id = ObservationId('abc123')
    expect(String(id)).toBe('abc123')
  })
})

describe('ComputerUseRuntime', () => {
  it('registers under the computerUse service name', () => {
    const ctx = new Context()
    const runtime = new TestRuntime(ctx)
    expect(runtime.name).toBe('computerUse')
    // ctx.get returns the service through the context proxy; assert the
    // registered instance is this runtime by identity of its name and type.
    expect(ctx.get('computerUse')).toBeInstanceOf(TestRuntime)
    expect(ctx.get('computerUse')?.name).toBe(runtime.name)
  })
})

describe('Config schema', () => {
  it('fills universal defaults and keeps required paths', () => {
    const config = testConfig({ auditLogPath: 'a.log', screenshotArchivePath: 'shots' })
    expect(config.observationTtlMs).toBe(30_000)
    expect(config.similarityThreshold).toBe(5)
    expect(config.consecutiveFailureCount).toBe(3)
    expect(config.maxSteps).toBe(30)
    expect(config.visionProvider).toBe('vp')
    expect(config.dangerPatterns.length).toBeGreaterThan(0)
  })

  it('defaults the takeover and sensitive-window policy', () => {
    const config = testConfig()
    expect(config.takeoverHotkey).toEqual(['ctrl', 'alt', 'u'])
    expect(config.pauseOnUserInput).toBe(true)
    expect(config.userInputGraceMs).toBe(250)
    expect(config.monitorStartupGraceMs).toBe(500)
    expect(config.sensitiveWindowPatterns).toEqual(expect.arrayContaining(['keepass', '1password', '网银']))
    expect(config.sensitiveWindowAllowlist).toEqual([])
  })

  it('ships the confirm gate off with a generous hour-scale wait backstop', () => {
    const config = testConfig()
    expect(config.irreversibleConfirm).toBe(false)
    expect(config.confirmTimeoutMs).toBe(28_800_000)
  })

  it('rejects a confirm timeout below the one-second floor', () => {
    expect(() => testConfig({ confirmTimeoutMs: 999 })).toThrow()
  })

  it('rejects a missing required path', () => {
    expect(() => new Config({} as never)).toThrow()
  })

  it('rejects an invalid serverMode', () => {
    expect(() => testConfig({ serverMode: 'staging' })).toThrow()
  })
})
