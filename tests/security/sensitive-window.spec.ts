import { describe, expect, it } from 'vitest'
import { SensitiveWindowPolicy } from '../../src/security/sensitive-window.ts'
import { testConfig } from '../helpers.ts'

describe('SensitiveWindowPolicy', () => {
  it('matches the schema default patterns against typical manager titles', () => {
    const policy = new SensitiveWindowPolicy(
      testConfig().sensitiveWindowPatterns,
      testConfig().sensitiveWindowAllowlist,
    )
    expect(policy.match('1Password — vault')).toBe('1password')
    expect(policy.match('KeePass 2 — MyPasswords.kdbx')).toBe('keepass')
    expect(policy.match('Bitwarden')).toBe('bitwarden')
    expect(policy.match('工商银行个人网银')).toBe('网银')
    expect(policy.match('某密码管理器')).toBe('密码管理器')
    expect(policy.match('Visual Studio Code')).toBeUndefined()
  })

  it('matches case-insensitively with substring semantics', () => {
    const policy = new SensitiveWindowPolicy(['keepass'], [])
    expect(policy.match('KEEPASS.EXE window')).toBe('keepass')
    expect(policy.match('window with keepass inside')).toBe('keepass')
  })

  it('lets the allowlist win over the blocklist', () => {
    const policy = new SensitiveWindowPolicy(['1password'], ['1password setup guide'])
    expect(policy.match('1Password setup guide — browser')).toBeUndefined()
    expect(policy.match('1Password — vault')).toBe('1password')
  })

  it('reports the first matching pattern source', () => {
    const policy = new SensitiveWindowPolicy(['netbank', '网银'], [])
    expect(policy.match('NetBanking portal')).toBe('netbank')
  })

  it('fails loud on an uncompilable pattern', () => {
    expect(() => new SensitiveWindowPolicy(['[unclosed'], [])).toThrow()
  })

  it('fails loud on empty entries', () => {
    expect(() => new SensitiveWindowPolicy([''], [])).toThrow(/sensitiveWindowPatterns/)
    expect(() => new SensitiveWindowPolicy([], [''])).toThrow(/sensitiveWindowAllowlist/)
  })

  it('never matches when both lists are empty', () => {
    const policy = new SensitiveWindowPolicy([], [])
    expect(policy.match('anything at all')).toBeUndefined()
  })
})
