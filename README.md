# dsh-computer-use

Desktop-level **Computer Use** (vision control) bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent sees the screen, decides the next operation with a vision model, and physically operates the desktop — screenshots, clicks, typing, scrolling, and hotkeys — through a Python MCP sidecar.

## Purpose

This plugin gives a DSH agent desktop control for targets that browser/DOM tools cannot reach (native applications, the OS shell of a window, anything rendered only as pixels). One host-plane bundle row provides:

- **Six model-facing tools** — `screen_shot`, `get_display_info`, `click_at`, `type_text`, `scroll`, `hotkey`.
- **A Python MCP sidecar** (`dsh-cu-server`) spawned through `ctx.subprocess`, speaking standard MCP JSON-RPC 2.0 over stdio. The sidecar owns all coordinate mathematics: the model emits pixels in *screenshot space*, and the sidecar maps them per-display with DPI awareness (Per-Monitor V2 on Windows, backing scale on macOS).
- **Vision analysis through `ctx.llm`** on deployment-configured routes — screenshots persist through `ctx.attachments` as durable image blocks; the plugin never manages API keys or raw HTTP calls.
- **A woven security layer** — tiered approval (medium-risk actions may auto-approve within a session window; high-risk always prompts), a danger-pattern filter on typed text, an ObservationId freshness gate, a no-change circuit breaker, per-session step ceilings, a window whitelist, and an append-only audit log with retention sweeps.

## Installation

From the directory where `dsh` is available, install the local checkout into the `web` profile:

```sh
dsh plugin --profile web add D:\code\Ai\fork\dsh-computer-use
```

`dsh plugin add` forwards to pnpm in the profile directory: it installs the `@modelcontextprotocol/sdk` dependency, links the `@deepseek-ai/*` peers through the dsh module fallback, and activates the bundle's `cordis.patch.yml` layer (the `computer-use` row).

### Sidecar binary

The provider prefers a production single-file binary at `bin/dsh-cu-server-<platform>.exe` and falls back to running the Python source (`python src-python/main.py`) when the binary is absent. Build the binary with PyInstaller:

```sh
pip install pyinstaller
pip install -r src-python/requirements.txt
pnpm run build:python        # = python scripts/build-python.py
```

The script cleans old artifacts, packages `src-python/main.py` into `bin/dsh-cu-server-win-x64.exe` (Windows) or `bin/dsh-cu-server-macos-<arch>` (macOS), and prints the SHA256 checksum. Force a mode with the `serverMode` config field (`dev` | `prod`) or the `DSH_CU_MODE` environment variable in a patch overlay.

## Configuration

The bundle ships **UNCONFIGURED on purpose**: the four model-route fields default to the empty string and the plugin refuses activation with copy-paste guidance until a deployment names its own routes. Configure them in the profile's `cordis.patch.yml` or the home-level `$DSH_HOME/cordis.patch.yml` — a later layer overrides the `computer-use` row by id (a patch **replaces the whole config**, so restate every key you need):

```yaml
- id: computer-use
  config:
    # ── Vision model routing (REQUIRED — fill in your own provider/model) ──
    # provider = a registered adapter route (an llm-pi-ai.providers key in
    # $DSH_HOME/settings.yaml); model = an id that route advertises.
    visionProvider: ''              # e.g. your vision-capable provider route
    visionModel: ''                 # must advertise image input
    changeDetectionProvider: ''     # same or cheaper route
    changeDetectionModel: ''        # cheap model deciding CHANGED/UNCHANGED

    # ── Loop bounds ──
    visionMaxOutputTokens: 2048     # output cap per vision call
    visionTimeoutMs: 120000         # deadline per vision call
    maxSteps: 30                    # per-session action ceiling
    stepDelayMs: 1500               # wait after each action

    # ── Capture ──
    screenshotMaxWidth: 1280        # width ceiling, aspect preserved
    screenshotQuality: 75           # JPEG quality 1-100

    # ── Safety ──
    observationTtlMs: 30000         # basedOnObservationId freshness window
    consecutiveFailureCount: 3      # no-change actions before the breaker trips
    similarityThreshold: 5          # dHash hamming ceiling for "unchanged"
    # dangerPatterns: [...]         # regex list; schema defaults block rm -rf,
                                    # format, shutdown, sudo, Remove-Item -Recurse…
    # allowedApps: []               # window whitelist; empty allows every window

    # ── Approval answerer ──
    autoApprovalWindowMs: 300000    # medium-risk auto-grant window
    autoApprovalMaxGrants: 50       # grant ceiling per window

    # ── Sidecar transport ──
    pythonCommand: python           # dev-mode interpreter
    # serverMode: !!js process.env.DSH_CU_MODE   # dev|prod; unset auto-detects
    processGraceMs: 5000            # terminate grace for the process tree
    rpcTimeoutMs: 60000             # per MCP request deadline
    healthCheckIntervalMs: 30000    # sidecar ping interval
    healthCheckTimeoutMs: 5000      # ping response deadline

    # ── Audit ──
    auditLogPath: !!js dshHomePath('logs/dsh-cu-audit.log')
    screenshotArchivePath: !!js dshHomePath('logs/dsh-cu-screenshots')
    auditRetentionDays: 7
```

Key facts:

- **Vision routes are provider+model pairs**, exactly as `ctx.llm` resolves them. The primary route must advertise image input; the change-detection route can be any cheap text+image model. Keys are resolved by the owning adapter — this plugin never sees them.
- `dangerPatterns` is a mis-fire backstop, not a security boundary; the sidecar carries an aligned backstop of its own.
- `allowedApps` turns any action against a non-whitelisted foreground window into a high-risk (interactive-confirmation) action; lookup failures fail closed to high risk as well.

## Known Limitations

- **Windows Session 0 cannot control the desktop.** A harness running as a background service (NSSM, Task Scheduler, a Windows service) lives in session 0, which structurally cannot see or drive the interactive desktop: screen capture returns a disconnected fallback display, `BitBlt` grabs fail, and synthetic input never reaches the user's session. The sidecar detects this at startup (`ProcessIdToSessionId` vs `WTSGetActiveConsoleSessionId`) and refuses to start with the remedy instead of serving doomed captures. **Run DSH from a desktop terminal (a logged-in interactive session) for computer use to work**; do not attempt cross-session injection (`CreateProcessAsUser` and similar) — that is privilege escalation outside this plugin's boundary.
- **macOS screenshots cover the primary display only** (pyautogui capture behavior); multi-display macOS setups get primary-display coordinates. macOS also requires Screen Recording permission for the terminal running DSH, and non-ASCII typing is refused until a clipboard backend lands.
- **Linux and headless environments are refused at load time** — there is no control backend.
- **Danger-pattern interception is regex-based** and can be spelled around; it exists to stop mis-fires, not adversaries.
- The sidecar is a **single-instance executor**: concurrent tool calls serialize behind one queue.
- The production binary is large (~90 MiB single-file PyInstaller bundle) and platform-specific; build it on the platform that runs it.

## Model Experience

### What the model sees

Six host-plane tools, visible to every session of the profile the bundle is installed into:

| Tool | Risk | What it returns |
|---|---|---|
| `screen_shot` | low (no approval) | The screenshot as an image block plus `observationId`, dimensions, and whether the screen changed since the previous capture |
| `get_display_info` | low (no approval) | Per-display bounds, DPI scale factor, primary flag |
| `click_at` | medium | Success + duration; coordinates stay in screenshot space, the sidecar maps them |
| `type_text` | medium | Success + char count; danger payloads are blocked before approval |
| `scroll` | medium | Success + duration |
| `hotkey` | medium; system shortcuts escalate to high | Success + duration |

The expected loop: `screen_shot` → decide from the returned image → one action tool carrying `basedOnObservationId` (the ObservationId of the screenshot being acted on, valid 30 s) → `screen_shot` again to observe the outcome. Tool descriptions instruct the model to never convert coordinates itself and to prefer browser/DOM tools when the target is a web page.

### Guards the model runs into

- **Stale or unknown `basedOnObservationId`** references are refused with guidance to capture a fresh screenshot.
- **System hotkeys** (`win+r`, `win+i`, `win+x`, `win+l`, `alt+f4`, `ctrl+shift+esc`) always prompt the user interactively, even inside an auto-approval window.
- **The no-change breaker** pauses the run after consecutive actions whose surrounding frames are perceptually identical (dHash distance within the similarity ceiling), asking for user intervention.
- **The step ceiling** stops a session after `maxSteps` actions.

### Token effect

Each `screen_shot` result contributes one image attachment (downscaled below `screenshotMaxWidth`, JPEG at `screenshotQuality`) to the session context; vision analysis and change detection run as sideband `ctx.llm` calls on the configured routes and do not consume the agent loop's context beyond their tool-result summaries.

## Development

```sh
pnpm install            # links @deepseek-ai/* peers to ../deepseek-harness via pnpm.overrides
npx tsc --noEmit        # strict type check (source-launch: dsh loads .ts directly)
pnpm test               # vitest unit tests (security/vision/definition logic)
pnpm run build:python   # PyInstaller single-file sidecar into bin/
python tests/dev-mcp-smoke.py   # stdio protocol smoke against the Python source
```

Design decisions and verified harness contracts are recorded in [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md).
