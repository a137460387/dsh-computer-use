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
import { Config, type ComputerUseConfig } from './src/config.ts'

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
 * Mount the computer-use capability.
 *
 * Phase 2 completes the wiring this entry point owns:
 * - `src/provider-mcp` provides `ctx.computerUse` (sidecar spawn through
 *   `ctx.subprocess`, standard MCP JSON-RPC over its stdio, version
 *   handshake, health check, serialized execution);
 * - `src/tools` registers `screen_shot`, `get_display_info`, `click_at`,
 *   `type_text`, `scroll`, `hotkey` on `ctx.tools`;
 * - `src/security` attaches the auditor, danger filter, and breaker;
 * - `src/vision` mounts the VisionProvider over `ctx.llm`/`ctx.attachments`;
 * - `src/answerer` registers the session-scoped approval answerer.
 * @param ctx - host context carrying the injected services.
 * @param config - validated {@link ComputerUseConfig}.
 */
export function apply(ctx: Context, config: ComputerUseConfig): void {
  assertPlatformSupported()
  // TODO(Phase 2): mount provider-mcp here; it provides `computerUse` and
  // owns the sidecar process tree for this fiber's lifetime.
  // TODO(Phase 2): register the six model-facing tools after the service.
  // TODO(Phase 2): attach security (auditor/danger-filter/breaker), the
  // vision bridge, and the approval answerer.
  ctx.logger.info(
    `dsh-computer-use: skeleton mounted on ${process.platform} `
    + `(vision route ${config.visionProvider}/${config.visionModel}, `
    + `change-detection route ${config.changeDetectionProvider}/${config.changeDetectionModel})`,
  )
}
