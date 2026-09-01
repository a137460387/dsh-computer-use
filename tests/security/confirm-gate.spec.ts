import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Auditor,
  ConfirmDeniedAuditRecord,
  ConfirmGrantedAuditRecord,
  ConfirmRequestedAuditRecord,
} from '../../src/security/auditor.ts'
import { ConfirmGate, assertConfirmGateViable, type ConfirmGuardRequest } from '../../src/security/confirm-gate.ts'
import type { PauseActionsResult, PauseTransitionEvent } from '../../src/definition/index.ts'
import { noOpAuditor, testConfig } from '../helpers.ts'

afterEach(() => { vi.useRealTimers() })

/** Sidecar stand-in the gate resolves through ctx.get('computerUse'). */
interface FakeRuntime {
  pauseActions: ReturnType<typeof vi.fn>
  armDangerToken: ReturnType<typeof vi.fn>
}

/** Captured confirm lines plus a drop-the-rest sink. */
function recordingAuditor(): {
  auditor: Auditor
  requested: ConfirmRequestedAuditRecord[]
  granted: ConfirmGrantedAuditRecord[]
  denied: ConfirmDeniedAuditRecord[]
} {
  const requested: ConfirmRequestedAuditRecord[] = []
  const granted: ConfirmGrantedAuditRecord[] = []
  const denied: ConfirmDeniedAuditRecord[] = []
  return {
    auditor: {
      ...noOpAuditor(),
      recordConfirmRequested: record => { requested.push(record) },
      recordConfirmGranted: record => { granted.push(record) },
      recordConfirmDenied: record => { denied.push(record) },
    },
    requested,
    granted,
    denied,
  }
}

/** One gate wired to a scripted runtime and a captured transition channel. */
function gateHarness(configOverrides: Record<string, unknown> = {}) {
  const config = testConfig({ irreversibleConfirm: true, ...configOverrides })
  const { auditor, requested, granted, denied } = recordingAuditor()
  let transitionHandler: ((event: PauseTransitionEvent) => void) | undefined
  const runtime: FakeRuntime = {
    pauseActions: vi.fn().mockResolvedValue({ paused: true, transitionSeq: 1, durationMs: 1 }),
    armDangerToken: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = {
    on: (_event: string, handler: (event: PauseTransitionEvent) => void) => {
      transitionHandler = handler
      return () => {}
    },
    get: (name: string) => (name === 'computerUse' ? runtime : undefined),
  } as unknown as Context
  const gate = new ConfirmGate(ctx, config, auditor)
  return {
    gate,
    runtime,
    requested,
    granted,
    denied,
    /** One sidecar pause-state push, as the provider re-broadcasts it. */
    emit(event: PauseTransitionEvent): void {
      transitionHandler?.(event)
    },
  }
}

const hotkeyRequest: ConfirmGuardRequest = {
  sessionId: 'sess-1',
  toolName: 'hotkey',
  source: 'hotkey-list',
  hotkey: 'delete+shift',
}

const dangerRequest: ConfirmGuardRequest = {
  sessionId: 'sess-1',
  toolName: 'type_text',
  source: 'danger-pattern',
  pattern: '\\brm\\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\\b',
  textBytes: 18,
}

/** Let queued microtasks (the pause ack, the requested line) settle. */
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve()
}

describe('ConfirmGate.guard', () => {
  it('refuses to run while irreversibleConfirm is off', async () => {
    const harness = gateHarness({ irreversibleConfirm: false })
    await expect(harness.gate.guard(hotkeyRequest)).rejects.toThrow(/confirm gate is disabled/)
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
  })

  it('pauses with the confirm reason and releases on a post-ack hotkey resume', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => {
      expect(harness.runtime.pauseActions).toHaveBeenCalledWith('confirm')
      expect(harness.requested).toHaveLength(1)
    })
    expect(harness.gate.hasPendingConfirm).toBe(true)
    expect(harness.requested[0]).toEqual({
      sessionId: 'sess-1', toolName: 'hotkey', source: 'hotkey-list', hotkey: 'delete+shift',
    })

    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    await expect(pending).resolves.toEqual({})
    expect(harness.gate.hasPendingConfirm).toBe(false)
    expect(harness.granted).toHaveLength(1)
    expect(harness.granted[0]).toMatchObject({
      sessionId: 'sess-1', toolName: 'hotkey', source: 'hotkey-list', dangerTokenArmed: false,
    })
    expect(harness.granted[0]?.waitMs).toBeGreaterThanOrEqual(0)
    expect(harness.denied).toHaveLength(0)
    expect(harness.runtime.armDangerToken).not.toHaveBeenCalled()
  })

  it('arms a single-use sidecar token for danger-pattern grants and audits its facts', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(dangerRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    // The requested line carries the pattern and the byte count, never the text.
    expect(harness.requested[0]).toEqual({
      sessionId: 'sess-1',
      toolName: 'type_text',
      source: 'danger-pattern',
      pattern: dangerRequest.pattern,
      textBytes: 18,
    })

    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    const grant = await pending
    expect(grant.dangerToken).toMatch(/^[0-9a-f]{32}$/)
    expect(harness.runtime.armDangerToken).toHaveBeenCalledWith(grant.dangerToken)
    expect(harness.granted[0]).toMatchObject({ source: 'danger-pattern', dangerTokenArmed: true })
  })

  it('treats a manual resume as a denial, not a release', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'manual', transitionSeq: 2 })

    await expect(pending).rejects.toThrow(/resume_actions instead of the physical takeover hotkey/)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ reason: 'self-rescue', toolName: 'hotkey' })
    expect(harness.granted).toHaveLength(0)
  })

  it('ignores a resume that raced the pause RPC and waits for a later press', async () => {
    // The pause RPC is held in flight; a hotkey resume lands before the ack.
    let resolvePause: ((result: PauseActionsResult) => void) | undefined
    const harness = gateHarness()
    harness.runtime.pauseActions.mockReturnValue(new Promise<PauseActionsResult>((resolve) => {
      resolvePause = resolve
    }))

    const pending = harness.gate.guard(hotkeyRequest)
    await flush()
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    // The ack reports counter 3: the sidecar re-paused after that resume.
    resolvePause?.({ paused: true, transitionSeq: 3, durationMs: 1 })
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    await flush()
    // The parked resume predates the ack (2 <= 3): nothing granted yet.
    expect(harness.granted).toHaveLength(0)

    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 4 })
    await expect(pending).resolves.toEqual({})
    expect(harness.granted).toHaveLength(1)
  })

  it('ignores a resume whose counter is not strictly past the ack', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 5 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 5 })
    await flush()
    expect(harness.granted).toHaveLength(0)

    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 6 })
    await expect(pending).resolves.toEqual({})
    expect(harness.granted).toHaveLength(1)
  })

  it('acks from the pause response when the sidecar was already paused', async () => {
    // No pause(confirm) notification ever arrives: the pause was a no-op.
    const harness = gateHarness()
    harness.runtime.pauseActions.mockResolvedValue({ paused: false, transitionSeq: 7, durationMs: 1 })

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 8 })

    await expect(pending).resolves.toEqual({})
    expect(harness.granted).toHaveLength(1)
  })

  it('re-arms the comparison baseline when a restart re-holds the confirm pause', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })
    await expect(pending).resolves.toEqual({})

    // A fresh wait acked on the stale sidecar counter (9); the sidecar
    // restarts and re-holds under `confirm` with a fresh counter (1). The
    // baseline must re-arm from the re-hold event, or the fresh press (2)
    // could never exceed the stale ack.
    harness.runtime.pauseActions.mockResolvedValue({ paused: true, transitionSeq: 9, durationMs: 1 })
    const second = harness.gate.guard({ ...hotkeyRequest, sessionId: 'sess-2' })
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(2) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })
    await expect(second).resolves.toEqual({})
    expect(harness.granted).toHaveLength(2)
  })

  it('refuses a second gated call while one wait is in flight', async () => {
    const harness = gateHarness()

    const first = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })

    await expect(harness.gate.guard({ ...dangerRequest, sessionId: 'sess-2' }))
      .rejects.toThrow(/another irreversible action is already waiting/)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ sessionId: 'sess-2', reason: 'busy', waitMs: 0 })
    expect(harness.requested).toHaveLength(1)

    // Finishing the first wait frees the slot for the next gated call.
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })
    await first
    const third = harness.gate.guard(dangerRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(2) })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 3 })
    await third
  })

  it('closes on the timeout backstop without resuming desktop control (T2a)', async () => {
    vi.useFakeTimers()
    const harness = gateHarness({ confirmTimeoutMs: 5000 })

    const pending = harness.gate.guard(hotkeyRequest)
    // The timeout fires inside the timer advance; keep the rejection handled
    // until the assertion below attaches.
    void pending.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.requested).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)

    await expect(pending).rejects.toThrow(/NOT performed.*no one pressed the takeover hotkey.*stays paused.*resume_actions/s)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ reason: 'timeout' })
    expect(harness.denied[0]?.waitMs).toBeGreaterThanOrEqual(5000)
    expect(harness.granted).toHaveLength(0)
    // The slot is free again; nothing auto-resumed (the fake runtime has no
    // resume path to call — the pause simply stays held).
    expect(harness.gate.hasPendingConfirm).toBe(false)
  })

  it('closes as a denial when the session turn is cancelled', async () => {
    const harness = gateHarness()
    const controller = new AbortController()

    const pending = harness.gate.guard({ ...hotkeyRequest, signal: controller.signal })
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled with the session/)
    expect(harness.denied[0]).toMatchObject({ reason: 'cancelled' })
  })

  it('refuses an already-cancelled execution before pausing anything', async () => {
    const harness = gateHarness()
    const controller = new AbortController()
    controller.abort()

    await expect(harness.gate.guard({ ...hotkeyRequest, signal: controller.signal }))
      .rejects.toThrow(/cancelled with the session/)
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
    expect(harness.denied[0]).toMatchObject({ reason: 'cancelled', waitMs: 0 })
  })

  it('fails closed and audits pause-failed when the pause RPC cannot land', async () => {
    const harness = gateHarness()
    harness.runtime.pauseActions.mockRejectedValue(new Error('sidecar gone'))

    await expect(harness.gate.guard(hotkeyRequest))
      .rejects.toThrow(/could not pause desktop control.*sidecar gone.*NOT performed/s)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ reason: 'pause-failed' })
    expect(harness.requested).toHaveLength(0)
  })

  it('fails closed and audits arm-failed when the confirmed token cannot be armed', async () => {
    const harness = gateHarness()
    harness.runtime.armDangerToken.mockRejectedValue(new Error('sidecar gone'))

    const pending = harness.gate.guard(dangerRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    await expect(pending).rejects.toThrow(/danger token could not be armed.*NOT performed/s)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ reason: 'arm-failed' })
    expect(harness.granted).toHaveLength(0)
  })

  it('ignores pause transitions after the wait settled', async () => {
    const harness = gateHarness()

    const pending = harness.gate.guard(hotkeyRequest)
    await vi.waitFor(() => { expect(harness.requested).toHaveLength(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })
    await pending

    // Late noise from the sidecar must not resurrect the settled wait.
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 3 })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 4 })
    expect(harness.granted).toHaveLength(1)
    expect(harness.gate.hasPendingConfirm).toBe(false)
  })
})

describe('assertConfirmGateViable', () => {
  const enabled = testConfig({ irreversibleConfirm: true })

  it('passes a disabled gate everywhere, even without a confirm signal', () => {
    expect(() => assertConfirmGateViable(testConfig({ irreversibleConfirm: false, takeoverHotkey: [] }), 'darwin')).not.toThrow()
  })

  it('refuses enabling on macOS where the takeover monitor cannot run', () => {
    expect(() => assertConfirmGateViable(enabled, 'darwin'))
      .toThrow(/irreversibleConfirm is unavailable on macOS.*disable irreversibleConfirm/s)
  })

  it('refuses enabling with an empty takeover hotkey', () => {
    expect(() => assertConfirmGateViable(testConfig({ irreversibleConfirm: true, takeoverHotkey: [] }), 'win32'))
      .toThrow(/requires a takeover hotkey.*ctrl\+alt\+u.*disable irreversibleConfirm/s)
  })

  it('accepts an enabled gate with a hotkey on Windows', () => {
    expect(() => assertConfirmGateViable(enabled, 'win32')).not.toThrow()
  })
})
