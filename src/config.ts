/**
 * Deployment policy for the computer-use bundle: every value that can vary
 * between deployments (model routes, loop bounds, breaker thresholds, danger
 * patterns, subprocess transport, audit retention) is a validated Config field
 * changeable from cordis.patch.yml or a later patch layer.
 * @module dsh-computer-use/config
 */

import z from '@deepseek-ai/schemastery'

/** Maximum delay accepted by the harness timer service, mirrored for timer-bounded fields. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The computer-use plugin configuration.
 *
 * Model routes are provider+model pairs exactly as `ctx.llm` resolves them:
 * the provider is a registered adapter route (a `settings.yaml`
 * `llm-pi-ai.providers` key in this deployment), the model an id that route
 * advertises. Both fields of a pair are required together; there is no
 * ambient "current model" lookup for auxiliary calls.
 */
export interface ComputerUseConfig {
  /** Provider route owning the primary vision model. */
  readonly visionProvider: string
  /** Model id that analyzes screenshots and emits coordinates. */
  readonly visionModel: string
  /** Provider route owning the change-detection model. */
  readonly changeDetectionProvider: string
  /** Cheap model id that decides whether the screen changed after an action. */
  readonly changeDetectionModel: string
  /** Output-token cap for one vision analysis call. */
  readonly visionMaxOutputTokens: number
  /** End-to-end deadline in milliseconds for one vision model call. */
  readonly visionTimeoutMs: number
  /** Agent-loop step ceiling before the run stops and asks the user. */
  readonly maxSteps: number
  /** Wait in milliseconds after each action before the next screenshot. */
  readonly stepDelayMs: number
  /** Screenshot width ceiling in pixels, aligned with VLM input budgets. */
  readonly screenshotMaxWidth: number
  /** JPEG quality (1-100) for screenshot compression. */
  readonly screenshotQuality: number
  /** Freshness window in milliseconds for a `basedOnObservationId` reference. */
  readonly observationTtlMs: number
  /** Consecutive no-screen-change actions that trip the breaker. */
  readonly consecutiveFailureCount: number
  /** dHash hamming-distance ceiling below which two frames count as unchanged. */
  readonly similarityThreshold: number
  /**
   * Danger-interception regular expressions applied to `type_text` content.
   * This layer is a mis-fire backstop, not a reliable security boundary.
   */
  readonly dangerPatterns: string[]
  /** Optional window whitelist; empty allows every window. */
  readonly allowedApps: string[]
  /** Python executable used by the dev-mode sidecar launch. */
  readonly pythonCommand: string
  /** Forced sidecar launch mode; unset auto-detects the built binary. */
  readonly serverMode?: 'dev' | 'prod'
  /** Termination grace in milliseconds for the sidecar process tree. */
  readonly processGraceMs: number
  /** Per MCP request deadline in milliseconds. */
  readonly rpcTimeoutMs: number
  /** Interval in milliseconds between sidecar health pings. */
  readonly healthCheckIntervalMs: number
  /** Health-ping response deadline in milliseconds. */
  readonly healthCheckTimeoutMs: number
  /** Append-only audit log path under the Harness home. */
  readonly auditLogPath: string
  /** Screenshot archive directory, stored apart from breaker hash fingerprints. */
  readonly screenshotArchivePath: string
  /** Audit and archive retention in days. */
  readonly auditRetentionDays: number
}

/**
 * Loader schema for {@link ComputerUseConfig}. Deployment-specific values the
 * bundle patch states live beside it; everything with a sensible universal
 * default carries one here, so a user override replaces only what it names.
 */
export const Config: z<ComputerUseConfig> = z.object({
  visionProvider: z.string().required(),
  visionModel: z.string().required(),
  changeDetectionProvider: z.string().required(),
  changeDetectionModel: z.string().required(),
  visionMaxOutputTokens: z.number().step(1).min(1).default(2048),
  visionTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxSteps: z.number().step(1).min(1).default(30),
  stepDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(1500),
  screenshotMaxWidth: z.number().step(1).min(256).default(1280),
  screenshotQuality: z.number().step(1).min(1).max(100).default(75),
  observationTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  consecutiveFailureCount: z.number().step(1).min(1).default(3),
  similarityThreshold: z.number().step(1).min(0).default(5),
  dangerPatterns: z.array(String).default([
    // rm -rf / rm -fr variants and recursive rm
    '\\brm\\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\\b',
    '\\brm\\s+--recursive\\b',
    // Windows destructive file commands
    '\\bdel\\s+/[a-z]*f\\b',
    '\\brmdir\\s+/s\\b',
    '\\bformat\\s+[a-z]:',
    'Remove-Item\\b.*-Recurse',
    'Format-Volume',
    // privilege escalation and power control
    '\\bsudo\\b',
    '\\bshutdown\\b',
    '\\breboot\\b',
    // disk destruction
    '\\bmkfs\\b',
    '\\bdd\\b.*\\bof=/dev/',
  ]),
  allowedApps: z.array(String).default([]),
  pythonCommand: z.string().default('python'),
  serverMode: z.union(['dev', 'prod'] as const),
  processGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5000),
  rpcTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  healthCheckIntervalMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(30_000),
  healthCheckTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5000),
  auditLogPath: z.string().required(),
  screenshotArchivePath: z.string().required(),
  auditRetentionDays: z.number().step(1).min(1).default(7),
})
