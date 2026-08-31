import { describe, expect, it } from 'vitest'
import { isHighRiskHotkey, isSameHotkey, normalizeHotkey } from '../../src/tools/shared.ts'

describe('normalizeHotkey', () => {
  it('lowercases and sorts keys into a canonical identity', () => {
    expect(normalizeHotkey(['Win', 'R'])).toBe('r+win')
    expect(normalizeHotkey(['r', 'win'])).toBe('r+win')
  })

  it('is independent of the emitted key order', () => {
    expect(normalizeHotkey(['ctrl', 'shift', 'esc']))
      .toBe(normalizeHotkey(['esc', 'ctrl', 'shift']))
  })
})

describe('isHighRiskHotkey', () => {
  it.each([
    ['alt', 'f4'],
    ['ctrl', 'shift', 'esc'],
    ['win', 'i'],
    ['win', 'l'],
    ['win', 'r'],
    ['win', 'x'],
  ])('escalates the system shortcut %j regardless of key order', (...keys) => {
    expect(isHighRiskHotkey(keys)).toBe(true)
    expect(isHighRiskHotkey([...keys].reverse())).toBe(true)
    expect(isHighRiskHotkey(keys.map(key => key.toUpperCase()))).toBe(true)
  })

  it('does not escalate ordinary application shortcuts', () => {
    expect(isHighRiskHotkey(['ctrl', 'c'])).toBe(false)
    expect(isHighRiskHotkey(['ctrl', 'v'])).toBe(false)
    expect(isHighRiskHotkey(['alt', 'tab'])).toBe(false)
    expect(isHighRiskHotkey(['f5'])).toBe(false)
  })

  it('does not escalate a superset of a system shortcut', () => {
    // win+r is high risk, but win+r+extra is a different combination.
    expect(isHighRiskHotkey(['win', 'r', 'shift'])).toBe(false)
  })
})

describe('isSameHotkey', () => {
  it('compares independent of key order and case', () => {
    expect(isSameHotkey(['u', 'ALT', 'Ctrl'], ['ctrl', 'alt', 'u'])).toBe(true)
  })

  it('rejects different combos and subset/superset pairs', () => {
    expect(isSameHotkey(['ctrl', 'alt'], ['ctrl', 'alt', 'u'])).toBe(false)
    expect(isSameHotkey(['ctrl', 'alt', 'u'], ['ctrl', 'alt'])).toBe(false)
    expect(isSameHotkey(['ctrl', 'alt', 'u'], ['ctrl', 'alt', 'i'])).toBe(false)
  })

  it('never matches an empty combination', () => {
    expect(isSameHotkey([], [])).toBe(false)
    expect(isSameHotkey([], ['ctrl'])).toBe(false)
  })
})
