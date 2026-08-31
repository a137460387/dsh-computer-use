import { describe, expect, it } from 'vitest'
import { CircuitBreakerError, FailureDetector, hammingDistance } from '../../src/security/circuit-breaker.ts'

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0)
    expect(hammingDistance('0123456789abcdef', '0123456789abcdef')).toBe(0)
  })

  it('counts single-bit differences', () => {
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1)
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1)
  })

  it('counts nibble and full-width differences', () => {
    expect(hammingDistance('f000000000000000', '0000000000000000')).toBe(4)
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64)
  })

  it('is symmetric', () => {
    expect(hammingDistance('0123456789abcdef', 'fedcba9876543210'))
      .toBe(hammingDistance('fedcba9876543210', '0123456789abcdef'))
  })
})

describe('FailureDetector', () => {
  const UNCHANGED = '0000000000000000'
  /** 5 set bits — exactly at the threshold used below. */
  const THRESHOLD_EDGE = '000000000000001f'
  /** 6 set bits — one bit past the threshold. */
  const CHANGED = '000000000000003f'

  it('does not count the baseline observation', () => {
    const detector = new FailureDetector(1, 5)
    expect(() => detector.observe(UNCHANGED)).not.toThrow()
    expect(detector.isTripped).toBe(false)
  })

  it('ignores unchanged frames without a pending action', () => {
    const detector = new FailureDetector(2, 5)
    detector.observe(UNCHANGED)
    detector.observe(UNCHANGED)
    detector.observe(UNCHANGED)
    expect(detector.isTripped).toBe(false)
  })

  it('trips after enough consecutive no-change actions', () => {
    const detector = new FailureDetector(2, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    detector.observe(UNCHANGED)
    expect(detector.isTripped).toBe(false)
    detector.noteAction()
    expect(() => detector.observe(UNCHANGED)).toThrow(CircuitBreakerError)
    expect(detector.isTripped).toBe(true)
  })

  it('counts a frame within the similarity ceiling as unchanged', () => {
    const detector = new FailureDetector(1, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    expect(() => detector.observe(THRESHOLD_EDGE)).toThrow(CircuitBreakerError)
  })

  it('resets the counter on a visibly changed frame', () => {
    const detector = new FailureDetector(2, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    detector.observe(UNCHANGED)
    detector.noteAction()
    detector.observe(CHANGED)
    expect(detector.isTripped).toBe(false)
    detector.noteAction()
    expect(() => detector.observe(CHANGED)).not.toThrow()
  })

  it('releases a tripped breaker when the screen changes', () => {
    const detector = new FailureDetector(1, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    expect(() => detector.observe(UNCHANGED)).toThrow(CircuitBreakerError)
    expect(() => detector.assertCanAct()).toThrow(CircuitBreakerError)
    detector.noteAction()
    detector.observe(CHANGED)
    expect(detector.isTripped).toBe(false)
    expect(() => detector.assertCanAct()).not.toThrow()
  })

  it('assertCanAct refuses while tripped', () => {
    const detector = new FailureDetector(1, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    expect(() => detector.observe(UNCHANGED)).toThrow(CircuitBreakerError)
    expect(() => detector.assertCanAct()).toThrow(/breaker is tripped/)
  })

  it('reset clears the counter, trip, and baseline', () => {
    const detector = new FailureDetector(1, 5)
    detector.observe(UNCHANGED)
    detector.noteAction()
    expect(() => detector.observe(UNCHANGED)).toThrow(CircuitBreakerError)
    detector.reset()
    expect(detector.isTripped).toBe(false)
    expect(() => detector.assertCanAct()).not.toThrow()
    // The next observation is a fresh baseline, not a no-change pair.
    expect(() => detector.observe(UNCHANGED)).not.toThrow()
  })

  it('exposes the no-change count for diagnostics without changing trip logic', () => {
    const detector = new FailureDetector(5, 5)
    expect(detector.consecutiveNoChange).toBe(0)
    detector.observe(UNCHANGED)
    detector.noteAction()
    detector.observe(UNCHANGED)
    expect(detector.consecutiveNoChange).toBe(1)
    detector.noteAction()
    detector.observe(CHANGED)
    expect(detector.consecutiveNoChange).toBe(0)
    detector.observe(UNCHANGED)
    detector.noteAction()
    detector.observe(UNCHANGED)
    detector.reset()
    expect(detector.consecutiveNoChange).toBe(0)
  })
})
