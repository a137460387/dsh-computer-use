import { describe, expect, it } from 'vitest'
import { VisionRouter } from '../../src/vision/router.ts'
import { testConfig } from '../helpers.ts'

function router(overrides: Record<string, unknown> = {}): VisionRouter {
  return new VisionRouter(testConfig(overrides))
}

describe('VisionRouter defaults', () => {
  it('keeps analysis on the pro (vision) route', () => {
    expect(router().decide('analysis')).toEqual({
      purpose: 'analysis',
      tier: 'pro',
      route: { provider: 'vp', model: 'vm' },
      overridden: false,
    })
  })

  it('keeps change detection on the flash route', () => {
    expect(router().decide('change-detection')).toEqual({
      purpose: 'change-detection',
      tier: 'flash',
      route: { provider: 'cp', model: 'cm' },
      overridden: false,
    })
  })

  it('keeps verification on the flash route', () => {
    expect(router().decide('verification')).toEqual({
      purpose: 'verification',
      tier: 'flash',
      route: { provider: 'cp', model: 'cm' },
      overridden: false,
    })
  })

  it('ships the cost-preserving tier defaults in the schema', () => {
    const config = testConfig()
    expect(config.analysisTier).toBe('pro')
    expect(config.changeDetectionTier).toBe('flash')
    expect(config.verificationTier).toBe('flash')
  })
})

describe('VisionRouter configured reassignment', () => {
  it('sends analysis to the flash route when configured', () => {
    const decision = router({ analysisTier: 'flash' }).decide('analysis')
    expect(decision.tier).toBe('flash')
    expect(decision.route).toEqual({ provider: 'cp', model: 'cm' })
    expect(decision.overridden).toBe(false)
  })

  it('sends change detection to the pro route when configured', () => {
    const decision = router({ changeDetectionTier: 'pro' }).decide('change-detection')
    expect(decision.tier).toBe('pro')
    expect(decision.route).toEqual({ provider: 'vp', model: 'vm' })
  })

  it('sends verification to the pro route when configured', () => {
    const decision = router({ verificationTier: 'pro' }).decide('verification')
    expect(decision.tier).toBe('pro')
    expect(decision.route).toEqual({ provider: 'vp', model: 'vm' })
  })

  it('routes each purpose independently', () => {
    const one = router({ verificationTier: 'pro' })
    expect(one.decide('verification').tier).toBe('pro')
    expect(one.decide('change-detection').tier).toBe('flash')
    expect(one.decide('analysis').tier).toBe('pro')
  })
})

describe('VisionRouter explicit override', () => {
  it('lets an explicit tier bypass the configured mapping', () => {
    const decision = router().decide('verification', 'pro')
    expect(decision).toEqual({
      purpose: 'verification',
      tier: 'pro',
      route: { provider: 'vp', model: 'vm' },
      overridden: true,
    })
  })

  it('lets an explicit flash tier demote analysis for diagnostics', () => {
    const decision = router().decide('analysis', 'flash')
    expect(decision.tier).toBe('flash')
    expect(decision.route).toEqual({ provider: 'cp', model: 'cm' })
    expect(decision.overridden).toBe(true)
  })

  it('beats a conflicting configured tier', () => {
    const decision = router({ analysisTier: 'pro' }).decide('analysis', 'flash')
    expect(decision.tier).toBe('flash')
    expect(decision.overridden).toBe(true)
  })
})
