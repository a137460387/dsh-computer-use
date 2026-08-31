/**
 * Sidecar refusal markers and their typed Node-side errors. The Python
 * sidecar prefixes marker-tagged diagnostics on two policy refusals; the
 * provider parses them into these errors so tool consumers and audit can
 * react to the exact reason instead of pattern-matching message prose.
 * @module dsh-computer-use/security/refusals
 */

/** Diagnostics prefix the sidecar uses when an action is refused by pause. */
export const PAUSED_MARKER = '[dsh-cu-paused]'

/** Diagnostics prefix the sidecar uses when a capture hits a sensitive window. */
export const SENSITIVE_WINDOW_MARKER = '[dsh-cu-sensitive-window]'

/** An action tool was refused because desktop control is paused. */
export class PausedRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PausedRefusal'
  }
}

/** Machine-readable facts of one sensitive-window capture refusal. */
export interface SensitiveWindowFacts {
  /** Foreground window title that matched (screen content never crosses the wire). */
  readonly windowTitle: string
  /** The configured pattern source that fired. */
  readonly pattern: string
}

/** A screenshot was refused because the foreground window is sensitive. */
export class SensitiveWindowRefusal extends Error {
  constructor(readonly facts: SensitiveWindowFacts, message: string) {
    super(message)
    this.name = 'SensitiveWindowRefusal'
  }
}

/**
 * Parse the sidecar's sensitive-window facts payload from a refusal text.
 * @param text - sidecar diagnostics beginning with {@link SENSITIVE_WINDOW_MARKER}.
 * @returns the facts, or undefined when the payload is absent or malformed.
 */
export function parseSensitiveWindowFacts(text: string): SensitiveWindowFacts | undefined {
  if (!text.startsWith(SENSITIVE_WINDOW_MARKER)) return undefined
  const payload = text.slice(SENSITIVE_WINDOW_MARKER.length).trim()
  try {
    const parsed = JSON.parse(payload) as { windowTitle?: unknown; pattern?: unknown }
    if (typeof parsed.windowTitle === 'string' && typeof parsed.pattern === 'string') {
      return { windowTitle: parsed.windowTitle, pattern: parsed.pattern }
    }
  } catch {
    // Malformed payloads fall through to undefined; the caller still
    // surfaces the raw text, so nothing is swallowed silently.
  }
  return undefined
}

/** Human label for one hotkey combination, keeping the configured order. */
export function hotkeyLabel(keys: readonly string[]): string {
  return keys.length === 0 ? '(no takeover hotkey configured)' : keys.map(key => key.toLowerCase()).join('+')
}
