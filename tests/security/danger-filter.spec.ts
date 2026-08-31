import { describe, expect, it } from 'vitest'
import { DangerFilter } from '../../src/security/danger-filter.ts'
import { testConfig } from '../helpers.ts'

/** Schema-default danger patterns, the deployment ships with. */
const defaults = testConfig().dangerPatterns

describe('DangerFilter', () => {
  it('compiles the schema-default pattern set', () => {
    expect(() => new DangerFilter(defaults)).not.toThrow()
  })

  it.each([
    'rm -rf /',
    'rm -fr /home/user',
    'rm --recursive folder',
    'del /f important.txt',
    'rmdir /s c:\\temp',
    'format c:',
    'Remove-Item C:\\data -Recurse',
    'Format-Volume -DriveLetter D',
    'sudo rm something',
    'shutdown /s /t 0',
    'reboot now',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
  ])('blocks the default danger payload %j', (text) => {
    const filter = new DangerFilter(defaults)
    expect(filter.check(text)).toBeDefined()
  })

  it('matches case-insensitively', () => {
    const filter = new DangerFilter(defaults)
    expect(filter.check('RM -RF /')).toBeDefined()
    expect(filter.check('SUDO apt install')).toBeDefined()
  })

  it.each([
    'hello world',
    'rm file.txt',
    'please delete this paragraph',
    'pseudo science',
    'the format of this document',
    'shutting down the application gracefully',
  ])('passes the clean payload %j', (text) => {
    const filter = new DangerFilter(defaults)
    expect(filter.check(text)).toBeUndefined()
  })

  it('reports the configured pattern source that fired', () => {
    const filter = new DangerFilter(['\\bsudo\\b', '\\breboot\\b'])
    const match = filter.check('please reboot')
    expect(match?.pattern).toBe('\\breboot\\b')
  })

  it('returns the first matching pattern in configuration order', () => {
    const filter = new DangerFilter(['\\bsudo\\b', '\\breboot\\b'])
    const match = filter.check('sudo reboot')
    expect(match?.pattern).toBe('\\bsudo\\b')
  })

  it('passes everything with an empty pattern set', () => {
    const filter = new DangerFilter([])
    expect(filter.check('rm -rf /')).toBeUndefined()
  })

  it('fails loud at construction on an invalid pattern', () => {
    expect(() => new DangerFilter(['('])).toThrow()
  })
})
