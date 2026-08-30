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
import { registerAnswerer } from './src/answerer.ts'
import type { ComputerUseConfig } from './src/config.ts'
import McpComputerUseProvider from './src/provider-mcp/index.ts'
import { createAuditor } from './src/security/auditor.ts'
import { FailureDetector } from './src/security/circuit-breaker.ts'
import { DangerFilter } from './src/security/danger-filter.ts'
import { registerClickAt } from './src/tools/click-at.ts'
import { registerGetDisplayInfo } from './src/tools/get-display-info.ts'
import { registerHotkey } from './src/tools/hotkey.ts'
import { registerScreenShot } from './src/tools/screen-shot.ts'
import type { ToolDeps } from './src/tools/shared.ts'
import { registerScroll } from './src/tools/scroll.ts'
import { registerTypeText } from './src/tools/type-text.ts'
import { ChangeDetector } from './src/vision/change-detector.ts'
import { createVisionProvider } from './src/vision/vision-provider.ts'

export { Config } from './src/config.ts'
export type { ComputerUseConfig } from './src/config.ts'
export * from './src/definition/index.ts'

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

/**
 * Refuse activation while the model routes are unconfigured. The bundle ships
 * with empty route fields on purpose; the error carries the exact patch a
 * deployment adds to configure them.
 * @param config - validated configuration with possibly-empty routes.
 */
function assertRoutesConfigured(config: ComputerUseConfig): void {
  const missing: string[] = []
  if (config.visionProvider === '') missing.push('visionProvider')
  if (config.visionModel === '') missing.push('visionModel')
  if (config.changeDetectionProvider === '') missing.push('changeDetectionProvider')
  if (config.changeDetectionModel === '') missing.push('changeDetectionModel')
  if (missing.length === 0) return
  throw new Error(
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
 * Mount the computer-use capability: security layer, vision bridge, approval
 * answerer, the MCP-backed service provider, and the six model-facing tools.
 * The sidecar itself starts lazily at first service use, so mounting stays
 * cheap and binary resolution errors surface where they belong — first call.
 * @param ctx - host context carrying the injected services.
 * @param config - validated {@link ComputerUseConfig}.
 */
export function apply(ctx: Context, config: ComputerUseConfig): void {
  assertPlatformSupported()
  assertRoutesConfigured(config)

  const dangerFilter = new DangerFilter(config.dangerPatterns)
  const breaker = new FailureDetector(config.consecutiveFailureCount, config.similarityThreshold)
  const auditor = createAuditor(ctx, config)
  const vision = createVisionProvider(ctx, config)
  const changeDetector = new ChangeDetector(vision, config.similarityThreshold)
  const deps: ToolDeps = { config, dangerFilter, breaker, auditor, changeDetector }

  registerAnswerer(ctx, config)
  void ctx.plugin(McpComputerUseProvider, config)

  registerScreenShot(ctx, deps)
  registerGetDisplayInfo(ctx, deps)
  registerClickAt(ctx, deps)
  registerTypeText(ctx, deps)
  registerScroll(ctx, deps)
  registerHotkey(ctx, deps)

  ctx.logger.info(
    `dsh-computer-use: mounted on ${process.platform} `
    + `(vision route ${config.visionProvider}/${config.visionModel}, `
    + `change-detection route ${config.changeDetectionProvider}/${config.changeDetectionModel})`,
  )
}
