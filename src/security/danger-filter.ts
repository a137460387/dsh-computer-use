/**
 * Danger interception for typed text: deployment-configured regular
 * expressions matched against `type_text` payloads before approval or
 * execution. This layer is a mis-fire backstop, NOT a reliable security
 * boundary — a determined payload can always be spelled around regexes. The
 * sidecar carries an aligned backstop of its own.
 * @module dsh-computer-use/security/danger-filter
 */

/** One danger match: the configured pattern that fired. */
export interface DangerMatch {
  /** Source pattern text (the config entry, not the compiled form). */
  readonly pattern: string
}

/** Compiled danger patterns with their source texts for audit. */
export class DangerFilter {
  private readonly compiled: ReadonlyArray<{ pattern: string; regex: RegExp }>

  /**
   * Compile one deployment pattern set.
   * @param patterns - regular-expression sources from Config.
   * @throws when a pattern does not compile (fail loud at mount).
   */
  constructor(patterns: readonly string[]) {
    this.compiled = patterns.map(pattern => ({ pattern, regex: new RegExp(pattern, 'iu') }))
  }

  /**
   * The first danger pattern contained in `text`, when any matches.
   * @param text - typed text about to be executed.
   * @returns the match facts, or undefined for clean text.
   */
  check(text: string): DangerMatch | undefined {
    for (const entry of this.compiled) {
      if (entry.regex.test(text)) return { pattern: entry.pattern }
    }
    return undefined
  }
}
