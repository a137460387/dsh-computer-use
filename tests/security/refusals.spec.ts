import { describe, expect, it } from 'vitest'
import {
  PAUSED_MARKER,
  SENSITIVE_WINDOW_MARKER,
  PausedRefusal,
  SensitiveWindowRefusal,
  hotkeyLabel,
  parseSensitiveWindowFacts,
} from '../../src/security/refusals.ts'

describe('parseSensitiveWindowFacts', () => {
  it('extracts the title and pattern from a marker-prefixed payload', () => {
    const facts = parseSensitiveWindowFacts(
      `${SENSITIVE_WINDOW_MARKER} {"windowTitle":"KeePass 2","pattern":"keepass"}`,
    )
    expect(facts).toEqual({ windowTitle: 'KeePass 2', pattern: 'keepass' })
  })

  it('returns undefined for text without the marker', () => {
    expect(parseSensitiveWindowFacts('some other error')).toBeUndefined()
  })

  it('returns undefined for a malformed JSON payload', () => {
    expect(parseSensitiveWindowFacts(`${SENSITIVE_WINDOW_MARKER} not-json`)).toBeUndefined()
  })

  it('returns undefined when required fields are missing or mistyped', () => {
    expect(parseSensitiveWindowFacts(`${SENSITIVE_WINDOW_MARKER} {"windowTitle":"x"}`)).toBeUndefined()
    expect(parseSensitiveWindowFacts(`${SENSITIVE_WINDOW_MARKER} {"windowTitle":3,"pattern":"p"}`)).toBeUndefined()
  })
})

describe('refusal error classes', () => {
  it('carry their class identity for instanceof routing', () => {
    const paused = new PausedRefusal('paused')
    expect(paused).toBeInstanceOf(Error)
    expect(paused.name).toBe('PausedRefusal')

    const sensitive = new SensitiveWindowRefusal({ windowTitle: 't', pattern: 'p' }, 'refused')
    expect(sensitive.facts).toEqual({ windowTitle: 't', pattern: 'p' })
    expect(sensitive.name).toBe('SensitiveWindowRefusal')
  })

  it('keeps the markers stable for the Python sidecar contract', () => {
    expect(PAUSED_MARKER).toBe('[dsh-cu-paused]')
    expect(SENSITIVE_WINDOW_MARKER).toBe('[dsh-cu-sensitive-window]')
  })
})

describe('hotkeyLabel', () => {
  it('keeps the configured key order', () => {
    expect(hotkeyLabel(['ctrl', 'alt', 'u'])).toBe('ctrl+alt+u')
  })

  it('lowercases mixed-case keys', () => {
    expect(hotkeyLabel(['Ctrl', 'ALT', 'U'])).toBe('ctrl+alt+u')
  })

  it('labels an empty combo as unconfigured', () => {
    expect(hotkeyLabel([])).toBe('(no takeover hotkey configured)')
  })
})
