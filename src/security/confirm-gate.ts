/**
 * Physical confirmation gate for irreversible actions. When
 * {@link ComputerUseConfig.irreversibleConfirm} is on, an action hitting the
 * irreversible hotkey list or the danger patterns neither traverses the host
 * approval seam (whose medium auto-grant would bypass any human, and whose
 * never-approval branch would swallow the wait outright) nor hard-refuses:
 * the gate pauses desktop control with the `confirm` reason and waits for
 * the user to physically press the takeover hotkey. A `hotkey`-reason resume
 * releases the action; a `manual` resume (`resume_actions`) is a denial; a
 * generous timeout closes the wait as a denial but keeps desktop control
 * paused — nothing resumes or retries on its own.
 *
 * Confirmation identity rides the sidecar's monotonic pause-transition
 * counter: a resume only confirms when its counter strictly exceeds the
 * counter acked at this wait's pause, so key presses predating the gate
 * (including a resume that lands while the pause RPC is still in flight)
 * never count.
 * @module dsh-computer-use/security/confirm-gate
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ComputerUseConfig } from '../config.ts'
import type { PauseActionsResult, PauseTransitionEvent } from '../definition/index.ts'
import { computerUse } from '../tools/shared.ts'
import type { Auditor, ConfirmDenialReason, ConfirmSource } from './auditor.ts'
import { hotkeyLabel } from './refusals.ts'

/** One irreversible action asking for physical confirmation. */
export interface ConfirmGuardRequest {
  /** Session whose tool call hit the gate. */
  readonly sessionId: string
  /** The tool whose action hit the gate. */
  readonly toolName: 'hotkey' | 'type_text'
  /** Which trigger set fired. */
  readonly source: ConfirmSource
  /** Normalized combo identity; present exactly for hotkey-list triggers. */
  readonly hotkey?: string
  /** Danger pattern source text; present exactly for danger-pattern triggers. */
  readonly pattern?: string
  /** Payload length in UTF-8 bytes; present exactly for danger-pattern triggers. */
  readonly textBytes?: number
  /** Turn-cancellation signal of the tool execution, when one exists. */
  readonly signal?: AbortSignal
}

/** Release granted by one confirmation wait. */
export interface ConfirmGrant {
  /**
   * Single-use sidecar danger-backstop token; present exactly for
   * danger-pattern grants. The caller hands it to the typed action so the
   * sidecar's aligned backstop lets exactly that payload through.
   */
  readonly dangerToken?: string
}

/** Internal wait outcome: the release or one denial reason. */
type ConfirmOutcome = 'granted' | ConfirmDenialReason

/** One in-flight confirmation wait. */
interface PendingConfirm {
  readonly request: ConfirmGuardRequest
  readonly startedAtMs: number
  /** Transition counter a confirming resume must strictly exceed. */
  ackSeq: number | undefined
  /** Resume observed before the ack; reconsidered once the ack lands. */
  deferredResume: { readonly reason: string; readonly transitionSeq: number } | undefined
  settled: boolean
  resolve: ((outcome: ConfirmOutcome) => void) | undefined
  timeoutTimer: NodeJS.Timeout | undefined
  onAbort: (() => void) | undefined
}

/**
 * Refuse enabling the confirm gate where its physical confirm signal cannot
 * exist: the takeover monitor only runs on Windows, and an empty takeover
 * hotkey has no press to confirm with. Fails loud at activation instead of
 * degrading into a permanent denial at runtime.
 * @param config - validated deployment policy.
 * @param platform - host platform; tests pass their own.
 */
export function assertConfirmGateViable(
  config: Pick<ComputerUseConfig, 'irreversibleConfirm' | 'takeoverHotkey'>,
  platform: NodeJS.Platform,
): void {
  if (!config.irreversibleConfirm) return
  if (platform === 'darwin') {
    throw new Error(
      'dsh-computer-use: irreversibleConfirm is unavailable on macOS — the confirm signal is a takeover-hotkey '
      + 'press, and the sidecar pause monitor only runs on Windows; disable irreversibleConfirm',
    )
  }
  if (config.takeoverHotkey.length === 0) {
    throw new Error(
      'dsh-computer-use: irreversibleConfirm requires a takeover hotkey — the physical confirm signal; '
      + 'configure takeoverHotkey (default ctrl+alt+u) or disable irreversibleConfirm',
    )
  }
}

/**
 * The confirm gate. One wait may be in flight at a time (the paused desktop
 * is shared, and a second pending confirm would make the confirm gesture
 * ambiguous); a second gated call while one waits is refused outright.
 */
export class ConfirmGate {
  private pending: PendingConfirm | undefined

  /**
   * Mount one gate and subscribe it to the sidecar's pause transitions.
   * @param ctx - host context carrying the event stream and the service.
   * @param config - validated deployment policy (gate switch, timeout, hotkey label).
   * @param auditor - audit sink for the confirm/* lines.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ComputerUseConfig,
    private readonly auditor: Auditor,
  ) {
    ctx.on('computer-use/pause-transition', event => this.onTransition(event))
  }

  /** Whether one confirmation wait is in flight (the pause re-hold fact). */
  get hasPendingConfirm(): boolean {
    return this.pending !== undefined
  }

  /**
   * Gate one irreversible action on physical confirmation: pause desktop
   * control with the `confirm` reason, wait for the takeover hotkey, and
   * either release the action (arming the sidecar danger token for
   * danger-pattern grants) or throw with the denial audited. Desktop control
   * stays paused through every denial — the caller's later `resume_actions`
   * is the only way back, deliberately.
   * @param request - the gated action's identity and trigger facts.
   * @returns the grant; `dangerToken` present exactly for danger-pattern sources.
   * @throws with an audited denial line and a model-readable reason.
   */
  async guard(request: ConfirmGuardRequest): Promise<ConfirmGrant> {
    if (!this.config.irreversibleConfirm) {
      throw new Error('dsh-computer-use: the confirm gate is disabled (irreversibleConfirm is off)')
    }
    if (request.signal?.aborted === true) {
      this.auditor.recordConfirmDenied({ ...this.triggerFacts(request), reason: 'cancelled', waitMs: 0 })
      throw new Error(this.denialMessage('cancelled', request))
    }
    if (this.pending !== undefined) {
      this.auditor.recordConfirmDenied({ ...this.triggerFacts(request), reason: 'busy', waitMs: 0 })
      throw new Error(this.denialMessage('busy', request))
    }

    const pending: PendingConfirm = {
      request,
      startedAtMs: Date.now(),
      ackSeq: undefined,
      deferredResume: undefined,
      settled: false,
      resolve: undefined,
      timeoutTimer: undefined,
      onAbort: undefined,
    }
    this.pending = pending
    try {
      let pause: PauseActionsResult
      try {
        pause = await computerUse(this.ctx).pauseActions('confirm')
      } catch (error) {
        this.auditor.recordConfirmDenied({
          ...this.triggerFacts(request),
          reason: 'pause-failed',
          waitMs: Date.now() - pending.startedAtMs,
        })
        throw new Error(
          `dsh-computer-use: the confirm gate could not pause desktop control for ${request.toolName}: `
          + `${String(error)} — the irreversible action was NOT performed`,
        )
      }
      // The pause(confirm) notification arms ackSeq on arrival; the response
      // counter covers the already-paused no-op, which emits no notification.
      pending.ackSeq ??= pause.transitionSeq
      this.auditor.recordConfirmRequested(this.triggerFacts(request))

      const outcome = await new Promise<ConfirmOutcome>((resolve) => {
        pending.resolve = resolve
        pending.timeoutTimer = setTimeout(() => this.settle(pending, 'timeout'), this.config.confirmTimeoutMs)
        pending.timeoutTimer.unref()
        if (request.signal !== undefined) {
          pending.onAbort = () => this.settle(pending, 'cancelled')
          request.signal.addEventListener('abort', pending.onAbort, { once: true })
        }
        // A resume that raced the pause RPC was parked; judge it against the
        // ack now that the ack exists.
        const deferred = pending.deferredResume
        if (deferred !== undefined) {
          pending.deferredResume = undefined
          this.considerResume(pending, deferred.reason, deferred.transitionSeq)
        }
      })

      const waitMs = Date.now() - pending.startedAtMs
      if (outcome !== 'granted') {
        this.auditor.recordConfirmDenied({ ...this.triggerFacts(request), reason: outcome, waitMs })
        throw new Error(this.denialMessage(outcome, request))
      }

      let grant: ConfirmGrant
      try {
        grant = await this.completeGrant(request)
      } catch (error) {
        this.auditor.recordConfirmDenied({
          ...this.triggerFacts(request),
          reason: 'arm-failed',
          waitMs: Date.now() - pending.startedAtMs,
        })
        throw error
      }
      this.auditor.recordConfirmGranted({
        ...this.triggerFacts(request),
        waitMs,
        dangerTokenArmed: grant.dangerToken !== undefined,
      })
      return grant
    } finally {
      this.teardown(pending)
    }
  }

  /** One sidecar pause transition; resumes judge against the acked counter. */
  private onTransition(event: PauseTransitionEvent): void {
    const pending = this.pending
    if (pending === undefined || pending.settled) return
    if (event.paused) {
      // Our pause(confirm) transition — and the confirm re-hold after a
      // sidecar restart — (re-)arms the comparison baseline.
      if (event.reason === 'confirm') pending.ackSeq = event.transitionSeq
      return
    }
    if (pending.ackSeq === undefined) {
      // A resume ahead of the pause ack: park it; the ack reconsideration
      // decides whether it predates this wait's pause.
      pending.deferredResume = { reason: event.reason, transitionSeq: event.transitionSeq }
      return
    }
    this.considerResume(pending, event.reason, event.transitionSeq)
  }

  /** Judge one post-ack resume: strict counter ordering, then the reason. */
  private considerResume(pending: PendingConfirm, reason: string, transitionSeq: number): void {
    if (pending.settled || pending.ackSeq === undefined) return
    if (transitionSeq <= pending.ackSeq) return
    this.settle(pending, reason === 'hotkey' ? 'granted' : 'self-rescue')
  }

  /** Arm the single-use sidecar token for danger-pattern releases. */
  private async completeGrant(request: ConfirmGuardRequest): Promise<ConfirmGrant> {
    if (request.source !== 'danger-pattern') return {}
    const dangerToken = randomBytes(16).toString('hex')
    try {
      await computerUse(this.ctx).armDangerToken(dangerToken)
    } catch (error) {
      throw new Error(
        `dsh-computer-use: ${request.toolName} was physically confirmed but the sidecar danger token could `
        + `not be armed: ${String(error)} — the irreversible action was NOT performed`,
      )
    }
    return { dangerToken }
  }

  /** Resolve the wait exactly once. */
  private settle(pending: PendingConfirm, outcome: ConfirmOutcome): void {
    if (pending.settled) return
    pending.settled = true
    pending.resolve?.(outcome)
  }

  /** Release the slot and every watcher of one finished wait. */
  private teardown(pending: PendingConfirm): void {
    if (this.pending === pending) this.pending = undefined
    if (pending.timeoutTimer !== undefined) clearTimeout(pending.timeoutTimer)
    if (pending.onAbort !== undefined) pending.request.signal?.removeEventListener('abort', pending.onAbort)
  }

  /** The audit identity shared by all three confirm lines. */
  private triggerFacts(request: ConfirmGuardRequest): {
    sessionId: string
    toolName: 'hotkey' | 'type_text'
    source: ConfirmSource
    hotkey?: string
    pattern?: string
    textBytes?: number
  } {
    return {
      sessionId: request.sessionId,
      toolName: request.toolName,
      source: request.source,
      ...request.hotkey !== undefined ? { hotkey: request.hotkey } : {},
      ...request.pattern !== undefined ? { pattern: request.pattern } : {},
      ...request.textBytes !== undefined ? { textBytes: request.textBytes } : {},
    }
  }

  /** Model-readable denial text; every variant says the action did NOT run. */
  private denialMessage(reason: ConfirmDenialReason, request: ConfirmGuardRequest): string {
    const label = hotkeyLabel(this.config.takeoverHotkey)
    const action = `the irreversible ${request.toolName} action`
    switch (reason) {
      case 'busy':
        return `dsh-computer-use: ${action} was refused — another irreversible action is already waiting for `
          + `physical confirmation; press the takeover hotkey (${label}) to confirm it, or call resume_actions `
          + 'to abandon it, then retry'
      case 'timeout':
        return `dsh-computer-use: ${action} was NOT performed — no one pressed the takeover hotkey (${label}) `
          + `within ${this.config.confirmTimeoutMs} ms. Desktop control stays paused; call resume_actions to `
          + 'continue with other work'
      case 'self-rescue':
        return `dsh-computer-use: ${action} was NOT performed — desktop control was resumed through `
          + `resume_actions instead of the physical takeover hotkey (${label}); a confirm needs the hotkey press`
      case 'cancelled':
        return `dsh-computer-use: ${action} was NOT performed — its confirmation was cancelled with the `
          + 'session. Desktop control stays paused; call resume_actions to continue'
      case 'pause-failed':
      case 'arm-failed':
        // These throw their own detailed errors at the failure site.
        return `dsh-computer-use: ${action} was refused (${reason})`
      default:
        assertNever(reason, 'confirm denial reason')
    }
  }
}
