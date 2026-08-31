import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, name } from '../index.ts'
import { testConfig } from './helpers.ts'

describe('bundle entry', () => {
  it('exports a stable plugin name', () => {
    expect(name).toBe('computer-use')
  })

  it('refuses activation while any model route is empty', () => {
    const ctx = new Context()
    expect(() => apply(ctx, testConfig({ visionModel: '' })))
      .toThrow(/model routes are not configured.*visionModel/)
  })

  it('names every missing route in the refusal', () => {
    const ctx = new Context()
    expect(() => apply(ctx, testConfig({
      visionProvider: '', visionModel: '', changeDetectionProvider: '', changeDetectionModel: '',
    }))).toThrow(/visionProvider, visionModel, changeDetectionProvider, changeDetectionModel/)
  })
})
