/**
 * Sensitive-window policy: case-insensitive title regexes that refuse
 * screenshot capture, with an allowlist beating the blocklist. Runtime
 * enforcement lives in the sidecar (the check must run BEFORE any pixel is
 * captured); this module is the reference semantics and the load-time
 * validator — constructing it fails loud on an uncompilable pattern, so a
 * bad deployment regex never survives to the first screen_shot.
 * @module dsh-computer-use/security/sensitive-window
 */

/** Compiled sensitive-window policy (blocklist plus take-priority allowlist). */
export class SensitiveWindowPolicy {
  private readonly blocked: ReadonlyArray<{ pattern: string; regex: RegExp }>
  private readonly allowed: readonly RegExp[]

  /**
   * Compile one deployment policy.
   * @param patterns - blocklist regex sources from Config.
   * @param allowlist - allowlist regex sources from Config.
   * @throws when an entry is empty or does not compile (fail loud at mount).
   */
  constructor(patterns: readonly string[], allowlist: readonly string[]) {
    this.blocked = patterns.map((pattern) => {
      if (pattern === '') throw new Error('dsh-computer-use: sensitiveWindowPatterns entries must not be empty')
      return { pattern, regex: new RegExp(pattern, 'i') }
    })
    this.allowed = allowlist.map((entry) => {
      if (entry === '') throw new Error('dsh-computer-use: sensitiveWindowAllowlist entries must not be empty')
      return new RegExp(entry, 'i')
    })
  }

  /** Number of compiled blocklist patterns (readiness diagnostics). */
  get blocklistSize(): number {
    return this.blocked.length
  }

  /** Number of compiled allowlist patterns (readiness diagnostics). */
  get allowlistSize(): number {
    return this.allowed.length
  }

  /**
   * The blocking pattern source for one window title, or undefined when the
   * title is allowed (allowlist wins) or matches nothing.
   * @param title - foreground window title reported by the sidecar.
   * @returns the fired pattern source, when capture must be refused.
   */
  match(title: string): string | undefined {
    if (this.allowed.some(regex => regex.test(title))) return undefined
    const hit = this.blocked.find(entry => entry.regex.test(title))
    return hit?.pattern
  }
}
