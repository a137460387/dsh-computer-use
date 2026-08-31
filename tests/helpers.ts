import { Config } from '../src/config.ts'
import type { ComputerUseConfig } from '../src/config.ts'
import type { Auditor } from '../src/security/auditor.ts'

/**
 * Build a validated {@link ComputerUseConfig} for tests. Schemastery fills the
 * schema defaults for any omitted field; the cast is required because the
 * loader schema's static input type is the full config while tests supply only
 * the fields under test.
 */
export function testConfig(overrides: Record<string, unknown> = {}): ComputerUseConfig {
  return new Config({
    visionProvider: 'vp',
    visionModel: 'vm',
    changeDetectionProvider: 'cp',
    changeDetectionModel: 'cm',
    auditLogPath: 'audit.log',
    screenshotArchivePath: 'shots',
    ...overrides,
  } as unknown as ComputerUseConfig)
}

/** An audit sink that drops everything, for provider tests exercising other seams. */
export function noOpAuditor(): Auditor {
  return {
    recordDanger: () => {},
    recordSensitiveWindow: () => {},
    recordLifecycle: () => {},
  }
}
