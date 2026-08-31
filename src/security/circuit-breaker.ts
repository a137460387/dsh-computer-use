/**
 * No-change circuit breaker: consecutive actions whose surrounding frames are
 * perceptually identical pause the run for user intervention. Similarity uses
 * the sidecar's 64-bit dHash fingerprints with a hamming-distance ceiling —
 * exact hashes (MD5/SHA) would trip on cursor blinks and anti-aliasing noise.
 * @module dsh-computer-use/security/circuit-breaker
 */

/** The breaker tripped: further actions are refused until the screen changes. */
export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitBreakerError'
  }
}

/**
 * Bit distance between two 16-hex-char dHash fingerprints.
 * @param left - one 64-bit hash in hex.
 * @param right - another 64-bit hash in hex.
 * @returns how many bits differ (0..64).
 */
export function hammingDistance(left: string, right: string): number {
  const xor = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let bits = 0
  let value = xor
  while (value > 0n) {
    value &= value - 1n
    bits += 1
  }
  return bits
}

/**
 * State machine over action/observation interleavings:
 * `action → next screenshot` pairs whose frames stay within the similarity
 * ceiling count as no-change; enough consecutive no-change pairs trip the
 * breaker; the first visibly changed frame releases it.
 */
export class FailureDetector {
  private lastHash: string | undefined
  private actionPending = false
  private consecutive = 0
  private tripped = false

  /**
   * @param maxConsecutive - no-change action count that trips the breaker.
   * @param similarityThreshold - hamming ceiling (inclusive) for "unchanged".
   */
  constructor(
    private readonly maxConsecutive: number,
    private readonly similarityThreshold: number,
  ) {}

  /** Whether the breaker currently refuses actions. */
  get isTripped(): boolean {
    return this.tripped
  }

  /** Consecutive no-change actions counted so far (readiness diagnostics). */
  get consecutiveNoChange(): number {
    return this.consecutive
  }

  /** Mark that one action will run before the next observation. */
  noteAction(): void {
    this.actionPending = true
  }

  /**
   * Feed one fresh frame fingerprint. When it follows a pending action and
   * stays within the similarity ceiling of the previous frame, the no-change
   * counter grows; a visibly changed frame resets it and releases a trip.
   * @param hash - the new frame's dHash.
   * @throws CircuitBreakerError the moment the no-change ceiling is reached.
   */
  observe(hash: string): void {
    const previous = this.lastHash
    this.lastHash = hash
    if (previous !== undefined) {
      const changed = hammingDistance(hash, previous) > this.similarityThreshold
      if (changed) {
        this.consecutive = 0
        this.tripped = false
      } else if (this.actionPending) {
        this.consecutive += 1
      }
    }
    this.actionPending = false
    if (this.consecutive >= this.maxConsecutive) {
      this.tripped = true
      throw new CircuitBreakerError(
        `dsh-computer-use: ${this.consecutive} consecutive actions produced no visible screen change `
        + `(dHash distance within ${this.similarityThreshold}); pausing for user intervention — `
        + 'inspect the target application, then capture a fresh screenshot to resume',
      )
    }
  }

  /** Refuse when tripped; actions consult this before touching the sidecar. */
  assertCanAct(): void {
    if (this.tripped) {
      throw new CircuitBreakerError(
        'dsh-computer-use: the no-change breaker is tripped; capture a screenshot of a changed '
        + 'screen (or ask the user to intervene) before issuing more actions',
      )
    }
  }

  /** Manual reset (e.g. after the user confirms the target state). */
  reset(): void {
    this.consecutive = 0
    this.tripped = false
    this.actionPending = false
    this.lastHash = undefined
  }
}
