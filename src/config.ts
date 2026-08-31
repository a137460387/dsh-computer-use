/**
 * Deployment policy for the computer-use bundle: every value that can vary
 * between deployments (model routes, loop bounds, breaker thresholds, danger
 * patterns, subprocess transport, audit retention) is a validated Config field
 * changeable from cordis.patch.yml or a later patch layer.
 * @module dsh-computer-use/config
 */

import z from '@deepseek-ai/schemastery'

/** Maximum delay accepted by the harness timer service, mirrored for timer-bounded fields. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The computer-use plugin configuration.
 *
 * Model routes are provider+model pairs exactly as `ctx.llm` resolves them:
 * the provider is a registered adapter route (a `settings.yaml`
 * `llm-pi-ai.providers` key in this deployment), the model an id that route
 * advertises. The bundle ships UNCONFIGURED: every route field defaults to
 * the empty string and the plugin refuses activation with configuration
 * guidance until a deployment names its own routes in a later patch layer.
 */
export interface ComputerUseConfig {
  /** Provider route owning the primary vision model; empty until configured. */
  readonly visionProvider: string
  /** Model id that analyzes screenshots and emits coordinates; empty until configured. */
  readonly visionModel: string
  /** Provider route owning the change-detection model; empty until configured. */
  readonly changeDetectionProvider: string
  /** Cheap model id that decides whether the screen changed; empty until configured. */
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
  /**
   * Takeover hotkey (pyautogui-style key names): pressing it toggles the
   * sidecar's paused state, refusing the four action tools until resumed.
   * An empty array disables the hotkey (resume via `resume_actions` only).
   */
  readonly takeoverHotkey: string[]
  /** Whether user cursor movement or key presses pause desktop control. */
  readonly pauseOnUserInput: boolean
  /**
   * Grace in milliseconds after each action ends during which user-input
   * detection stays off, so late-arriving synthetic input never counts.
   */
  readonly userInputGraceMs: number
  /**
   * Foreground-window title regexes that refuse screenshot capture outright
   * (password managers, online banking, ...); matched case-insensitively.
   */
  readonly sensitiveWindowPatterns: string[]
  /** Title regexes beating {@link sensitiveWindowPatterns} (explicit carve-outs). */
  readonly sensitiveWindowAllowlist: string[]
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
  /** Answerer's auto-approval window in milliseconds for medium-risk actions. */
  readonly autoApprovalWindowMs: number
  /** Answerer's auto-approval grant ceiling within one window. */
  readonly autoApprovalMaxGrants: number
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
 * The four route fields default empty on purpose: the plugin fails loud with
 * configuration guidance instead of riding an arbitrary route.
 */
export const Config: z<ComputerUseConfig> = z.object({
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
  changeDetectionProvider: z.string().default(''),
  changeDetectionModel: z.string().default(''),
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
  takeoverHotkey: z.array(String).default(['ctrl', 'alt', 'u']),
  pauseOnUserInput: z.boolean().default(true),
  userInputGraceMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(250),
  sensitiveWindowPatterns: z.array(String).default([
    '1password',
    'keepass',
    'bitwarden',
    'lastpass',
    'netbank',
    'online banking',
    '网银',
    '密码管理器',
    'password manager',
  ]),
  sensitiveWindowAllowlist: z.array(String).default([]),
  autoApprovalWindowMs: z.number().step(1).min(1000).max(MAX_TIMER_DELAY_MS).default(300_000),
  autoApprovalMaxGrants: z.number().step(1).min(1).default(50),
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
