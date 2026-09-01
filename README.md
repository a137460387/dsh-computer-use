# dsh-computer-use

Desktop-level **Computer Use** (vision control) bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent sees the screen, decides the next operation with a vision model, and physically operates the desktop — screenshots, clicks, typing, scrolling, and hotkeys — through a Python MCP sidecar.

## Purpose

This plugin gives a DSH agent desktop control for targets that browser/DOM tools cannot reach (native applications, the OS shell of a window, anything rendered only as pixels). One host-plane bundle row provides:

- **Eight model-facing tools** — `screen_shot`, `peek_cursor`, `get_display_info`, `click_at`, `type_text`, `scroll`, `hotkey`, `resume_actions`.
- **A Python MCP sidecar** (`dsh-cu-server`) spawned through `ctx.subprocess`, speaking standard MCP JSON-RPC 2.0 over stdio. The sidecar owns all coordinate mathematics: the model emits pixels in *screenshot space*, and the sidecar maps them per-display with DPI awareness (Per-Monitor V2 on Windows, backing scale on macOS).
- **Vision analysis through `ctx.llm`** on deployment-configured routes — screenshots persist through `ctx.attachments` as durable image blocks; the plugin never manages API keys or raw HTTP calls.
- **A woven security layer** — tiered approval (medium-risk actions auto-approve pre-dispatch within a session window/quota, audited; high-risk always needs interactive confirmation), a danger-pattern filter on typed text, an ObservationId freshness gate, a no-change circuit breaker, per-session step ceilings, a window whitelist, and an append-only audit log with retention sweeps — approval and freshness refusals write dedicated audit lines, and a failed audit write warns through the host logger.
- **User takeover detection** — a takeover hotkey (default `ctrl+alt+u`) and any user mouse/keyboard activity pause the four action tools until resumed; the pause state is audited and survives sidecar restarts.
- **Sensitive-window capture refusal** — screenshots are refused before any pixel is captured when the foreground window title matches a deployment blocklist (password managers, online banking, ...); nothing is archived, persisted, or sent to a model.
- **Synthetic cursor overlay** — `peek_cursor` previews where a click will land by drawing a translucent cyan arrow (never the real OS pointer) into a fresh capture, and every `click_at` archives a `-preview` intent frame before the physical click, so the audit trail holds both the intended point and its outcome.

## Installation

Clone or place the repository into any local directory of your choice, then from the directory where `dsh` is available, install the local checkout into the `web` profile (substitute your actual path):

```sh
dsh plugin --profile web add <path-to-dsh-computer-use>
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
    # Cost-tier routing over the two routes above: flash = change-detection
    # route, pro = vision route. Defaults preserve the fixed assignment
    # (analysis on pro, change detection and verification on flash).
    analysisTier: pro               # analyzeScreenshot (coordinate localization)
    changeDetectionTier: flash      # detectChange (screen-change judgement)
    verificationTier: flash         # verifyActionEffect (post-action verdicts)

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

    # ── User takeover ──
    # takeoverHotkey: [ctrl, alt, u]  # pauses/resumes the four action tools;
                                      # empty list disables the hotkey
    # pauseOnUserInput: true          # user cursor movement / key presses pause
    # userInputGraceMs: 250           # post-action grace before input detection
    # monitorStartupGraceMs: 500      # startup grace discarding input detections

    # ── Sensitive windows ──
    # sensitiveWindowPatterns: [...]  # title regexes refusing capture; schema
                                      # defaults cover 1password, keepass,
                                      # bitwarden, lastpass, netbank, 网银…
    # sensitiveWindowAllowlist: []    # title regexes beating the blocklist

    # ── Approval answerer (pre-dispatch) ──
    autoApprovalWindowMs: 300000    # medium-risk auto-grant window
    autoApprovalMaxGrants: 50       # grant ceiling per window, then interactive

    # ── Post-action verification (advisory, default off) ──
    actionVerification: 'off'       # off | sampled | always
    actionVerificationSampleRate: 0.1   # fraction verified in 'sampled' mode
    actionVerificationSettleMs: 300     # UI settle wait before the after-capture

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
- **Vision calls route by purpose.** Each call purpose picks a cost tier — `analysisTier` (screenshot analysis and coordinate localization), `changeDetectionTier` (screen-change judgement), `verificationTier` (post-action effect verdicts) — and each tier rides one of the two routes: `flash` the change-detection route, `pro` the vision route. Defaults keep analysis on `pro` and both judgement calls on `flash`; moving a purpose to a different tier is an explicit deployment choice. The tier that produced a verification verdict is recorded as `modelTier` on its `verification/result` audit line.
- `dangerPatterns` is a mis-fire backstop, not a security boundary; the sidecar carries an aligned backstop of its own.
- `allowedApps` turns any action against a non-whitelisted foreground window into a high-risk (interactive-confirmation) action; lookup failures fail closed to high risk as well.
- **Approval semantics are a plugin pre-dispatch decision.** Medium-risk actions consult the plugin's answerer BEFORE the host approval seam: inside the session's `autoApprovalWindowMs` / `autoApprovalMaxGrants` quota they auto-grant (each grant writes an `answer/auto-allowed` audit line), so unattended sessions run without prompting. Everything else — high risk, or a medium request after the quota is spent — goes to `ctx.approval.request`: interactive (`ask`) sessions confirm there, while never-approval sessions (the Web UI "Full access" default) reject deterministically, and the tool surfaces that as configuration guidance (switch to Workspace Write) instead of a bare rejection. High-risk actions under Full access are fail-closed by design. Every seam refusal writes an `answer/refused` audit line (session, tool, tier, outcome), mirroring the `answer/auto-allowed` grant line.
- **Takeover semantics**: while desktop control is paused, `click_at`/`type_text`/`scroll`/`hotkey` are refused with recovery guidance; `screen_shot`, `get_display_info`, and `resume_actions` stay available. Resume by pressing the takeover hotkey again or calling `resume_actions`. The pause state is pushed to the plugin as an MCP notification, audited (`lifecycle/paused`, `lifecycle/resumed`), and re-engaged automatically if the sidecar restarts.
- **Sensitive-window semantics**: the sidecar checks the foreground window title BEFORE capturing; a hit refuses the screenshot without archiving, persisting, or model-sending any pixels, and writes a `danger/sensitive-window` audit line (title logged, screen content never).
- **Post-action verification is advisory and off by default.** With `actionVerification` set to `sampled`/`always`, the verification tier's route (default the change-detection route) judges the before/after frames around each executed action (`yes`/`no`/`uncertain` + reason); the verdict annotates the tool result message and writes a `verification/result` audit line (with the producing tier as `modelTier`). A `no`/`uncertain` verdict on `click_at` triggers exactly one zoom-crop retry: a magnified capture around the target that the analysis tier's route (default the vision route) relocalizes (`analyzeScreenshot`) before a single re-click on the crop basis. Verification never blocks, re-approves, or throws into the action it annotates; retries stay inside the approved click (one extra physical click, audited) and report "still unconfirmed" honestly instead of claiming success. The internal readiness checklist (`collectReadiness`, exported for diagnostics) snapshots sidecar connection/tool surface, approval quota, breaker, audit sink, sensitive-window rules, takeover monitor, and step budget on demand.

## Troubleshooting

Documented failure modes with a cause and a remedy, collected here by symptom; inherent constraints without a remedy stay under Known Limitations.

### Refused at startup or load

- **Windows: the sidecar refuses to start when DSH runs as a background service (Session 0).** A harness running as a background service (NSSM, Task Scheduler, a Windows service) lives in session 0, which structurally cannot see or drive the interactive desktop: screen capture returns a disconnected fallback display, `BitBlt` grabs fail, and synthetic input never reaches the user's session. The sidecar detects this at startup (`ProcessIdToSessionId` vs `WTSGetActiveConsoleSessionId`) and refuses to start with the remedy instead of serving doomed captures. **Run DSH from a desktop terminal (a logged-in interactive session) for computer use to work**; do not attempt cross-session injection (`CreateProcessAsUser` and similar) — that is privilege escalation outside this plugin's boundary.
- **Linux and headless environments are refused at load time** — there is no control backend.

### Configuration and permissions

- **The plugin refuses activation with copy-paste guidance.** The bundle ships UNCONFIGURED on purpose: the four model-route fields (`visionProvider`, `visionModel`, `changeDetectionProvider`, `changeDetectionModel`) default to the empty string and the plugin refuses activation until a deployment names its own routes. Fill them in the profile's `cordis.patch.yml` or the home-level `$DSH_HOME/cordis.patch.yml` (see Configuration).
- **macOS: capture needs Screen Recording permission.** macOS requires Screen Recording permission for the terminal running DSH.

### Sidecar mode

- **The sidecar runs from the Python source instead of the production binary.** The provider prefers a production single-file binary at `bin/dsh-cu-server-<platform>.exe` and falls back to running the Python source (`python src-python/main.py`) when the binary is absent. If you expected the production binary, build it (see Sidecar binary) or force a mode with the `serverMode` config field (`dev` | `prod`) or the `DSH_CU_MODE` environment variable in a patch overlay.

### Approval and pause refusals

- **Actions are refused in a never-approval ("Full access") session.** High-risk actions — and medium-risk ones after the auto-approval quota is spent — require interactive confirmation; the host rejects never-approval sessions deterministically, and the tool surfaces that as configuration guidance (switch the session to Workspace Write) instead of a bare rejection. High-risk actions under Full access are fail-closed by design.
- **An approved action is refused after clicking "allow".** A high-risk action's interactive approval is NOT an in-flight window: moving the mouse to click "allow" pauses desktop control, and the approved action is then refused until resumed (takeover hotkey again or `resume_actions`).

### Audit log

- **Audit lines fail to land (disk full, permissions, blocked path).** A failed write never breaks the action flow: the sink warns once per failure episode through the host logger (`dsh-computer-use: audit write failed …`) and notes when writes recover (`dsh-computer-use: audit writes recovered …`); between the two messages the audit trail has a gap. The sink's write health stays visible to the internal readiness checklist. Free the disk or fix the `auditLogPath` location to close the gap.

## Known Limitations

- **macOS screenshots cover the primary display only** (pyautogui capture behavior); multi-display macOS setups get primary-display coordinates. Non-ASCII typing is refused until a clipboard backend lands.
- **Danger-pattern interception is regex-based** and can be spelled around; it exists to stop mis-fires, not adversaries.
- The sidecar is a **single-instance executor**: concurrent tool calls serialize behind one queue.
- The production binary is large (~90 MiB single-file PyInstaller bundle) and platform-specific; build it on the platform that runs it.
- **No session isolation — one physical cursor.** Windows exposes a single interactive session: two parallel Computer Use runs (or the user working beside the agent) share one cursor and one foreground window and WILL collide. Synthetic-cursor / per-session isolation is a research item and not implemented; run one desktop-control session at a time.
- **Sensitive-window detection matches window TITLES, not pixels.** OCR-level detection of sensitive fields (a password box rendered inside an ordinary window) is not implemented; an untitled or generically titled sensitive window is not caught. The takeover hotkey is polling-based (`GetAsyncKeyState`), not a registered system hotkey, and is only active while the sidecar runs.
- **The takeover hotkey is detected by a 50 ms poll.** The monitor samples `GetAsyncKeyState` every 50 ms, so a synthetic key press held for less than one poll interval (below ~100 ms) can fall between two samples and be missed; hold the combo for at least 100 ms when triggering the takeover programmatically.
- **pause-on-user-input cannot tell automation from the user.** Detection watches real OS input events, so input injected by ANY automation counts as the user taking over and pauses the action tools — including the agent's OWN out-of-band automation (driving the UI through a shell tool like PowerShell UIAutomation instead of the computer-use tools), test drivers, other Computer Use sessions, and macro tools. Automated verification of this plugin must submit the task, then observe passively with zero input until the run finishes.
- **Pause monitoring and the sensitive-window gate are Windows-only** (pure ctypes; no new dependencies). On macOS the monitor does not run (the takeover hotkey and user-input pause are unavailable; `resume_actions` still works) and the capture gate cannot read window titles, so capture is fail-open there.
- **Zoom-crop retries ride one extra physical click.** A retried click stays inside the original approval (one logical action, one step) and is only reachable when verification ran, so it inherits verification's gating (`actionVerification`, default off). The retry's intent frame is its `verification/result` audit line plus the crop observation, not a `-preview` capture.
- **Zoom-crop captures are Windows-only this release.** On macOS the sidecar refuses region captures fail-closed (its capture covers the primary display and the crop-to-physical mapping is unverified there); verification still runs, only the retry is skipped.
- Design tensions recorded during development (kept deliberately, see DEVELOPMENT_LOG.md): the ObservationId TTL clock includes approval wait time; the no-change breaker counts actions refused after approval; `visionProvider.analyzeScreenshot` has one OPTIONAL production call site — the zoom-crop refinement, reachable only when `actionVerification` samples the click (default off); with verification off, the main agent model still locates targets itself. Seam-refused calls are audited (`answer/refused`) and TTL-expired or unknown-reference refusals are audited (`action/refused`); the remaining audit gap is sidecar-level action refusals (paused control, or a reference the sidecar's own freshness check rejects), which leave only an `action/after` line with `success: false` and no refusal reason.

## Model Experience

### What the model sees

Eight host-plane tools, visible to every session of the profile the bundle is installed into:

| Tool | Risk | What it returns |
|---|---|---|
| `screen_shot` | low (no approval) | The screenshot as an image block plus `observationId`, dimensions, and whether the screen changed since the previous capture; refused outright when the foreground window matches a sensitive pattern |
| `peek_cursor` | low (no approval) | A fresh capture with a synthetic cursor drawn at the intended click point (the real OS cursor never moves) plus its own `observationId` for the click that follows |
| `get_display_info` | low (no approval) | Per-display bounds, DPI scale factor, primary flag |
| `click_at` | medium | Success + duration; coordinates stay in screenshot space, the sidecar maps them; archives a `-preview` frame with the synthetic cursor before the physical click |
| `type_text` | medium | Success + char count; danger payloads are blocked before approval |
| `scroll` | medium | Success + duration |
| `hotkey` | medium; system shortcuts and the takeover combo escalate to high | Success + duration |
| `resume_actions` | low (no approval) | Whether desktop control was paused and is now resumed |

The expected loop: `screen_shot` → decide from the returned image → one action tool carrying `basedOnObservationId` (the ObservationId of the screenshot being acted on, valid 30 s) → `screen_shot` again to observe the outcome. Tool descriptions instruct the model to never convert coordinates itself and to prefer browser/DOM tools when the target is a web page.

### Guards the model runs into

- **Stale or unknown `basedOnObservationId`** references are refused with guidance to capture a fresh screenshot; each refusal writes an `action/refused` audit line (action, reference, reason, and the age/TTL facts when the reference expired).
- **User takeover pauses actions.** The takeover hotkey (default `ctrl+alt+u`) or any user mouse/keyboard activity outside an in-flight action pauses the four action tools; they refuse with recovery guidance until the hotkey is pressed again or `resume_actions` is called. Observations stay available while paused.
- **Sensitive windows refuse capture** before any pixel is grabbed (title blocklist, allowlist beats it); the refusal names the matched pattern and the allowlist escape hatch.
- **Medium-risk actions auto-approve inside the session quota** — a pre-dispatch decision before the host approval seam, each grant leaving an `answer/auto-allowed` audit line. Once the quota is spent, medium requests need interactive confirmation like high-risk ones, and never-approval (Full access) sessions refuse them with configuration guidance.
- **System hotkeys** (`win+r`, `win+i`, `win+x`, `win+l`, `alt+f4`, `ctrl+shift+esc`) always require interactive confirmation, even inside an auto-approval window; never-approval sessions refuse them outright.
- **The no-change breaker** pauses the run after consecutive actions whose surrounding frames are perceptually identical (dHash distance within the similarity ceiling), asking for user intervention.
- **The step ceiling** stops a session after `maxSteps` actions.
- **Verification notes in action results.** When `actionVerification` is on, action results may carry a semantic-verification sentence ("confirmed the effect", "uncertain… retry clicked (x, y)… still unconfirmed"); a retry never changes `success` (the physical click ran) — read the note and capture a fresh screenshot to inspect.

### Token effect

Each `screen_shot` result contributes one image attachment (downscaled below `screenshotMaxWidth`, JPEG at `screenshotQuality`) to the session context; vision analysis and change detection run as sideband `ctx.llm` calls on the configured routes and do not consume the agent loop's context beyond their tool-result summaries.

## Development

```sh
pnpm install            # links @deepseek-ai/* peers to ../deepseek-harness via pnpm.overrides
npx tsc --noEmit        # strict type check (source-launch: dsh loads .ts directly)
pnpm test               # vitest unit tests (security/vision/definition logic)
python -m unittest discover -s tests/python -v   # sidecar state-machine unit tests
pnpm run build:python   # PyInstaller single-file sidecar into bin/
python tests/dev-mcp-smoke.py   # stdio protocol smoke against the Python source
```

Design decisions and verified harness contracts are recorded in [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md).
