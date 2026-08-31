import { describe, expect, it } from 'vitest'
import { ChangeDetector } from '../../src/vision/change-detector.ts'
import type { HashedFrame } from '../../src/vision/change-detector.ts'
import type { VisionProvider } from '../../src/vision/vision-provider.ts'

function frame(dhash: string): HashedFrame {
  return { data: new Uint8Array([1, 2, 3]), width: 100, height: 80, dhash }
}

function fakeVision(result: boolean): VisionProvider & { calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    async analyzeScreenshot() { throw new Error('not used') },
    async detectChange() { calls += 1; return result },
    async verifyActionEffect() { return { verdict: 'uncertain', reason: 'not used' } },
  }
}

describe('ChangeDetector', () => {
  it('returns false for identical hashes without consulting the model', async () => {
    const vision = fakeVision(true)
    const detector = new ChangeDetector(vision, 5)
    await expect(detector.detect(frame('0000000000000000'), frame('0000000000000000'))).resolves.toBe(false)
    expect(vision.calls()).toBe(0)
  })

  it('returns true for hashes beyond the similarity ceiling without the model', async () => {
    const vision = fakeVision(false)
    const detector = new ChangeDetector(vision, 5)
    // 6 set bits — above the ceiling of 5.
    await expect(detector.detect(frame('0000000000000000'), frame('000000000000003f'))).resolves.toBe(true)
    expect(vision.calls()).toBe(0)
  })

  it('delegates the ambiguous zone to the change-detection model', async () => {
    const vision = fakeVision(true)
    const detector = new ChangeDetector(vision, 5)
    // 3 set bits — within the ceiling, ambiguous.
    await expect(detector.detect(frame('0000000000000000'), frame('0000000000000007'))).resolves.toBe(true)
    expect(vision.calls()).toBe(1)
  })

  it('returns the model verdict unchanged in the ambiguous zone', async () => {
    const vision = fakeVision(false)
    const detector = new ChangeDetector(vision, 5)
    await expect(detector.detect(frame('0000000000000000'), frame('0000000000000007'))).resolves.toBe(false)
    expect(vision.calls()).toBe(1)
  })

  it('treats the threshold itself as ambiguous (inclusive ceiling)', async () => {
    const vision = fakeVision(false)
    const detector = new ChangeDetector(vision, 5)
    // Exactly 5 set bits — at the ceiling, so delegated to the model.
    await expect(detector.detect(frame('0000000000000000'), frame('000000000000001f'))).resolves.toBe(false)
    expect(vision.calls()).toBe(1)
  })
})
