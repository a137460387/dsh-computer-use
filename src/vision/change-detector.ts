/**
 * Post-action change detection with a token-saving fast path: dHash
 * fingerprints decide clear cases for free, and the change-detection model is
 * consulted only for the ambiguous zone between "identical" and "clearly
 * different" (spec §3.2/§3.5).
 * @module dsh-computer-use/vision/change-detector
 */

import { hammingDistance } from '../security/circuit-breaker.ts'
import type { VisionImage, VisionProvider } from './vision-provider.ts'

/** One frame plus its sidecar-computed fingerprint. */
export interface HashedFrame extends VisionImage {
  /** 64-bit dHash (16 hex chars) from the sidecar. */
  readonly dhash: string
}

/**
 * Change detector over the vision provider. The similarity ceiling comes from
 * the same Config field as the breaker, keeping both "unchanged" definitions
 * aligned.
 */
export class ChangeDetector {
  /**
   * @param vision - provider for the ambiguous-zone model call.
   * @param similarityThreshold - hamming ceiling (inclusive) for "unchanged".
   */
  constructor(
    private readonly vision: VisionProvider,
    private readonly similarityThreshold: number,
  ) {}

  /**
   * Whether the screen changed between two frames.
   * @param before - pre-action frame with fingerprint.
   * @param after - post-action frame with fingerprint.
   * @param signal - caller cancellation.
   * @returns true when the screen changed meaningfully.
   */
  async detect(before: HashedFrame, after: HashedFrame, signal?: AbortSignal): Promise<boolean> {
    const distance = hammingDistance(before.dhash, after.dhash)
    if (distance === 0) return false
    if (distance > this.similarityThreshold) return true
    return this.vision.detectChange(before, after, signal)
  }
}
