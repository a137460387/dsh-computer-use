/**
 * dsh-computer-use — desktop-level Computer Use (vision control) bundle for
 * DeepSeek Harness. One host-plane plugin provides the `computerUse` service
 * over a Python MCP sidecar, registers the model-facing action tools, and
 * weaves approval, audit, danger interception, and the no-change breaker
 * around every action. The bundle's substance is `cordis.patch.yml` (declared
 * by the `dsh.bundle.patch` manifest field) plus this plugin module; the
 * design decisions and verified harness contracts are in DEVELOPMENT_LOG.md.
 * @module dsh-computer-use
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ComputerUseConfig } from './src/config.ts'
import { collectReadiness } from './src/diagnostics/readiness.ts'
import McpComputerUseProvider from './src/provider-mcp/index.ts'
import { createAuditor } from './src/security/auditor.ts'
import { FailureDetector } from './src/security/circuit-breaker.ts'
import { DangerFilter } from './src/security/danger-filter.ts'
import { SensitiveWindowPolicy } from './src/security/sensitive-window.ts'
import { registerClickAt } from './src/tools/click-at.ts'
import { registerGetDisplayInfo } from './src/tools/get-display-info.ts'
import { registerHotkey } from './src/tools/hotkey.ts'
import { registerPeekCursor } from './src/tools/peek-cursor.ts'
import { registerResumeActions } from './src/tools/resume-actions.ts'
import { registerScreenShot } from './src/tools/screen-shot.ts'
import { stepCounter, type ToolDeps } from './src/tools/shared.ts'
import { registerScroll } from './src/tools/scroll.ts'
import { registerTypeText } from './src/tools/type-text.ts'
import { ChangeDetector } from './src/vision/change-detector.ts'
import { createVisionProvider } from './src/vision/vision-provider.ts'

export { Config } from './src/config.ts'
export type { ComputerUseConfig } from './src/config.ts'
export * from './src/definition/index.ts'
export * from './src/diagnostics/readiness.ts'

/** Stable Cordis plugin name. */
export const name = 'computer-use'

/**
 * Hard dependencies: the sidecar lifecycle rides `subprocess`, the consumer
 * tools register on `tools`, vision analysis streams through `llm`,
 * screenshots persist through `attachments`, and high-risk actions gate on
 * `approval`. All five ship in `@deepseek-ai/dsh-base`.
 */
export const inject = ['subprocess', 'tools', 'llm', 'attachments', 'approval']

/** Operating systems with a desktop-control backend. */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin']

/**
 * Refuse activation on platforms without a control backend. The refusal is a
 * load-time throw so the row fails loud instead of registering tools whose
 * every call would error.
 */
function assertPlatformSupported(): void {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    throw new Error(
      `dsh-computer-use: desktop control is not supported on ${process.platform}; `
      + 'only Windows and macOS have a backend (Linux and headless environments are refused)',
    )
  }
}

/** The route fields still empty in one configuration. */
function missingRoutes(config: ComputerUseConfig): string[] {
  const missing: string[] = []
  if (config.visionProvider === '') missing.push('visionProvider')
  if (config.visionModel === '') missing.push('visionModel')
  if (config.changeDetectionProvider === '') missing.push('changeDetectionProvider')
  if (config.changeDetectionModel === '') missing.push('changeDetectionModel')
  return missing
}

/** Refusal error carrying the exact patch a deployment adds to configure routes. */
function routesMissingError(missing: readonly string[]): Error {
  return new Error(
    `dsh-computer-use: model routes are not configured (${missing.join(', ')} empty). `
    + 'Configure them in the profile cordis.patch.yml or $DSH_HOME/cordis.patch.yml:\n'
    + '  - id: computer-use\n'
    + '    config:\n'
    + '      visionProvider: <provider route>          # e.g. an llm-pi-ai.providers settings key\n'
    + '      visionModel: <vision-capable model id>    # must advertise image input\n'
    + '      changeDetectionProvider: <provider route>\n'
    + '      changeDetectionModel: <cheap model id>',
  )
}

/**
 * Mount the computer-use capability: security layer, vision bridge, the
 * MCP-backed service provider, and the eight model-facing tools. Approval
 * decisions ride the tools' shared gate: medium risk may auto-grant
 * pre-dispatch (audited), everything else traverses the host approval seam.
 * The sidecar itself starts lazily at first service use, so mounting stays
 * cheap and binary resolution errors surface where they belong — first call.
 * @param ctx - host context carrying the injected services.
 * @param config - validated {@link ComputerUseConfig}.
 */
export function apply(ctx: Context, config: ComputerUseConfig): void {
  assertPlatformSupported()
  // Self-contained config fails loud at load: uncompilable sensitive-window
  // regexes never survive to the first screen_shot (construction validates).
  // The retained instance feeds the readiness checklist.
  const sensitivePolicy = new SensitiveWindowPolicy(config.sensitiveWindowPatterns, config.sensitiveWindowAllowlist)

  const auditor = createAuditor(ctx, config)
  const missing = missingRoutes(config)
  if (missing.length > 0) {
    auditor.recordLifecycle({ event: 'routes-missing', missing })
    throw routesMissingError(missing)
  }
  auditor.recordLifecycle({
    event: 'mounted',
    platform: process.platform,
    visionRoutesConfigured: true,
    visionRoute: `${config.visionProvider}/${config.visionModel}`,
    changeDetectionRoute: `${config.changeDetectionProvider}/${config.changeDetectionModel}`,
  })

  const dangerFilter = new DangerFilter(config.dangerPatterns)
  const breaker = new FailureDetector(config.consecutiveFailureCount, config.similarityThreshold)
  const vision = createVisionProvider(ctx, config)
  const changeDetector = new ChangeDetector(vision, config.similarityThreshold)

  // Direct construction (the ApprovalService precedent): ctx.plugin forwards
  // a single config argument, and the provider additionally needs the auditor.
  // The Service constructor self-registers and unloads with this fiber.
  const provider = new McpComputerUseProvider(ctx, config, auditor)

  // Internal diagnostics entry: tool code and operator scripts snapshot the
  // subsystem states on demand; the report never gates an action by itself.
  const readiness = (sessionId?: string) => collectReadiness({
    config,
    sidecar: provider.readinessFacts(),
    breaker,
    auditor,
    sensitivePolicy,
    ...sessionId !== undefined ? { session: { id: sessionId, stepsUsed: stepCounter.count(sessionId) } } : {},
  })

  const deps: ToolDeps = { config, dangerFilter, breaker, auditor, changeDetector, vision, readiness }

  registerScreenShot(ctx, deps)
  registerPeekCursor(ctx, deps)
  registerGetDisplayInfo(ctx, deps)
  registerClickAt(ctx, deps)
  registerTypeText(ctx, deps)
  registerScroll(ctx, deps)
  registerHotkey(ctx, deps)
  registerResumeActions(ctx)

  ctx.logger.info(
    `dsh-computer-use: mounted on ${process.platform} `
    + `(vision route ${config.visionProvider}/${config.visionModel}, `
    + `change-detection route ${config.changeDetectionProvider}/${config.changeDetectionModel})`,
  )
}
