import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { HIGH_RISK_MARKER } from '../../src/answerer.ts'
import type { PauseTransitionEvent } from '../../src/definition/index.ts'
import type {
  Auditor,
  ConfirmDeniedAuditRecord,
  ConfirmGrantedAuditRecord,
  ConfirmRequestedAuditRecord,
} from '../../src/security/auditor.ts'
import { ConfirmGate } from '../../src/security/confirm-gate.ts'
import { DangerFilter } from '../../src/security/danger-filter.ts'
import { registerHotkey } from '../../src/tools/hotkey.ts'
import { registerTypeText } from '../../src/tools/type-text.ts'
import type { ToolDeps } from '../../src/tools/shared.ts'
import { noOpAuditor, testConfig } from '../helpers.ts'

let execSeq = 0

/** Fresh session id per call: the answerer's grant windows are process-global. */
function execOf(): ToolExecution {
  execSeq += 1
  return { agent: { session: { id: `confirm-tools-${execSeq}` } } as unknown as Agent } as unknown as ToolExecution
}

/** Executable view of one registered tool definition. */
interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { schema: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: ToolExecution): Promise<Record<string, unknown>>
}

/** One bundle wiring with scripted sidecar/approval seams and captured tools. */
function toolHarness(configOverrides: Record<string, unknown> = {}) {
  const config = testConfig(configOverrides)
  let transitionHandler: ((event: PauseTransitionEvent) => void) | undefined
  const runtime = {
    hotkey: vi.fn().mockResolvedValue({ success: true, durationMs: 3 }),
    typeText: vi.fn().mockResolvedValue({ success: true, durationMs: 3 }),
    pauseActions: vi.fn().mockResolvedValue({ paused: true, transitionSeq: 1, durationMs: 1 }),
    armDangerToken: vi.fn().mockResolvedValue(undefined),
    getForegroundWindow: vi.fn().mockResolvedValue('notepad.exe'),
  }
  const registered: ToolDefinition[] = []
  const approvalRequest = vi.fn().mockResolvedValue('allowed-once')
  const ctx = {
    on: (_event: string, handler: (event: PauseTransitionEvent) => void) => {
      transitionHandler = handler
      return () => {}
    },
    get: (name: string) => (name === 'computerUse' ? runtime : undefined),
    tools: { register: (definition: ToolDefinition) => { registered.push(definition) } },
    approval: { request: approvalRequest },
  } as unknown as Context
  const requested: ConfirmRequestedAuditRecord[] = []
  const granted: ConfirmGrantedAuditRecord[] = []
  const denied: ConfirmDeniedAuditRecord[] = []
  const recordDanger = vi.fn()
  const recordAutoApproval = vi.fn()
  const auditor: Auditor = {
    ...noOpAuditor(),
    recordDanger,
    recordAutoApproval,
    recordConfirmRequested: record => { requested.push(record) },
    recordConfirmGranted: record => { granted.push(record) },
    recordConfirmDenied: record => { denied.push(record) },
  }
  const confirmGate = new ConfirmGate(ctx, config, auditor)
  const deps = {
    config,
    dangerFilter: new DangerFilter(config.dangerPatterns),
    breaker: { assertCanAct: vi.fn(), noteAction: vi.fn() },
    auditor,
    confirmGate,
    changeDetector: {},
    vision: {},
    readiness: () => { throw new Error('not used by hotkey/type_text') },
  } as unknown as ToolDeps
  registerHotkey(ctx, deps)
  registerTypeText(ctx, deps)
  return {
    config,
    runtime,
    approvalRequest,
    recordDanger,
    recordAutoApproval,
    requested,
    granted,
    denied,
    hotkey: registered[0] as unknown as RegisteredTool,
    typeText: registered[1] as unknown as RegisteredTool,
    emit: (event: PauseTransitionEvent) => { transitionHandler?.(event) },
  }
}

describe('model-visible tool schema stays byte-identical', () => {
  // These three surfaces are what the model sees. The confirm gate must not
  // touch any of them — the assertions record the pre-gate shape verbatim.
  it('hotkey keeps its exact description, parameters, and output schema', () => {
    const harness = toolHarness({ irreversibleConfirm: true })
    expect(harness.hotkey.description).toBe(
      'Press one key combination (e.g. ["ctrl","c"], ["alt","tab"]) in the desktop. System-level shortcuts '
      + '(win+r, win+i, win+x, win+l, alt+f4, ctrl+shift+esc) always require interactive confirmation and '
      + 'are refused outright in never-approval sessions.',
    )
    expect(harness.hotkey.parameters).toEqual({
      type: 'object',
      properties: {
        keys: { type: 'array', description: 'Keys pressed together, e.g. ["ctrl", "c"].', items: { type: 'string' } },
        basedOnObservationId: { type: 'string', description: 'ObservationId of the screenshot being acted on.' },
      },
      required: ['keys'],
    })
    expect(harness.hotkey.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        durationMs: { type: 'number' },
      },
      required: ['success', 'durationMs'],
    })
  })

  it('type_text keeps its exact description, parameters, and output schema', () => {
    const harness = toolHarness({ irreversibleConfirm: true })
    expect(harness.typeText.description).toBe(
      'Type text into the focused desktop window. Destructive command payloads (rm -rf, format, shutdown, '
      + 'sudo, and similar) are blocked outright. Focus the target field first (e.g. with click_at) before typing.',
    )
    expect(harness.typeText.parameters).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        basedOnObservationId: { type: 'string', description: 'ObservationId of the screenshot being acted on.' },
      },
      required: ['text'],
    })
    expect(harness.typeText.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        durationMs: { type: 'number' },
        chars: { type: 'integer' },
      },
      required: ['success', 'durationMs', 'chars'],
    })
  })
})

describe('hotkey tool with irreversibleConfirm OFF (default behavior)', () => {
  it('routes shift+delete through the tier approval path, not the gate', async () => {
    const harness = toolHarness()

    const result = await harness.hotkey.execute({ keys: ['shift', 'delete'] }, execOf())

    expect(result.success).toBe(true)
    // Quota-fresh medium action auto-grants pre-dispatch, exactly as before.
    expect(harness.recordAutoApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'hotkey', tier: 'medium' }))
    expect(harness.approvalRequest).not.toHaveBeenCalled()
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
    expect(harness.runtime.hotkey).toHaveBeenCalledWith(expect.objectContaining({ keys: ['shift', 'delete'] }))
  })

  it('routes the del alias spelling through the tier path while the gate is off', async () => {
    const harness = toolHarness()

    const result = await harness.hotkey.execute({ keys: ['shift', 'del'] }, execOf())

    expect(result.success).toBe(true)
    expect(harness.recordAutoApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'hotkey', tier: 'medium' }))
    expect(harness.approvalRequest).not.toHaveBeenCalled()
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
  })

  it('keeps alt+f4 on the high-risk approval seam (never absorbed by the gate list)', async () => {
    const harness = toolHarness()

    await harness.hotkey.execute({ keys: ['alt', 'f4'] }, execOf())

    expect(harness.approvalRequest).toHaveBeenCalledTimes(1)
    expect(harness.approvalRequest.mock.calls[0]?.[0].reason).toBe(`${HIGH_RISK_MARKER} press alt+f4`)
    expect(harness.recordAutoApproval).not.toHaveBeenCalled()
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
  })
})

describe('hotkey tool with irreversibleConfirm ON', () => {
  it('gates shift+delete on the physical confirm, skipping whitelist and approval', async () => {
    // A configured whitelist would escalate off-list combos through
    // getForegroundWindow; the gate path must never consult it.
    const harness = toolHarness({ irreversibleConfirm: true, allowedApps: ['notepad.exe'] })

    const pending = harness.hotkey.execute({ keys: ['shift', 'delete'] }, execOf())
    void pending.catch(() => {})
    await vi.waitFor(() => { expect(harness.runtime.pauseActions).toHaveBeenCalledWith('confirm') })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    const result = await pending
    expect(result.success).toBe(true)
    expect(harness.approvalRequest).not.toHaveBeenCalled()
    expect(harness.runtime.getForegroundWindow).not.toHaveBeenCalled()
    expect(harness.recordAutoApproval).not.toHaveBeenCalled()
    expect(harness.runtime.hotkey).toHaveBeenCalledTimes(1)
    expect(harness.requested).toHaveLength(1)
    expect(harness.requested[0]).toMatchObject({ toolName: 'hotkey', source: 'hotkey-list', hotkey: 'delete+shift' })
    expect(harness.granted).toHaveLength(1)
  })

  it('gates the del alias spelling exactly like delete — no silent bypass', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const pending = harness.hotkey.execute({ keys: ['shift', 'del'] }, execOf())
    void pending.catch(() => {})
    await vi.waitFor(() => { expect(harness.runtime.pauseActions).toHaveBeenCalledWith('confirm') })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    const result = await pending
    expect(result.success).toBe(true)
    // The alias spelling took the confirm path, not quota auto-approval.
    expect(harness.approvalRequest).not.toHaveBeenCalled()
    expect(harness.recordAutoApproval).not.toHaveBeenCalled()
    expect(harness.runtime.hotkey).toHaveBeenCalledTimes(1)
    expect(harness.requested).toHaveLength(1)
    // The audit line records the emitted spelling, normalized for order/case.
    expect(harness.requested[0]).toMatchObject({ toolName: 'hotkey', source: 'hotkey-list', hotkey: 'del+shift' })
    expect(harness.granted).toHaveLength(1)
  })

  it('leaves ordinary combos on the default medium path', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const result = await harness.hotkey.execute({ keys: ['ctrl', 'c'] }, execOf())

    expect(result.success).toBe(true)
    expect(harness.recordAutoApproval).toHaveBeenCalledWith(expect.objectContaining({ tier: 'medium' }))
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
    expect(harness.requested).toHaveLength(0)
  })

  it('refuses a second irreversible combo while one waits for confirmation', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const first = harness.hotkey.execute({ keys: ['shift', 'delete'] }, execOf())
    void first.catch(() => {})
    await vi.waitFor(() => { expect(harness.runtime.pauseActions).toHaveBeenCalledTimes(1) })

    await expect(harness.hotkey.execute({ keys: ['shift', 'delete'] }, execOf()))
      .rejects.toThrow(/another irreversible action is already waiting/)
    expect(harness.denied).toHaveLength(1)
    expect(harness.denied[0]).toMatchObject({ reason: 'busy' })

    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })
    await first
  })
})

describe('type_text tool with irreversibleConfirm OFF (default behavior)', () => {
  it('hard-blocks a danger payload byte-identically: audit line, throw, no dispatch', async () => {
    const harness = toolHarness()

    await expect(harness.typeText.execute({ text: 'sudo rm -rf /' }, execOf()))
      .rejects.toThrow(/matches a danger pattern/)

    expect(harness.recordDanger).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'type_text',
      pattern: '\\brm\\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\\b',
      textBytes: 13,
    }))
    expect(harness.runtime.typeText).not.toHaveBeenCalled()
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
  })
})

describe('type_text tool with irreversibleConfirm ON', () => {
  it('waits for the physical confirm and releases the payload with an armed single-use token', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const pending = harness.typeText.execute({ text: 'sudo rm -rf /' }, execOf())
    void pending.catch(() => {})
    await vi.waitFor(() => { expect(harness.runtime.pauseActions).toHaveBeenCalledWith('confirm') })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'hotkey', transitionSeq: 2 })

    const result = await pending
    expect(result.success).toBe(true)
    // The grant armed exactly one token and the typed call carries it.
    expect(harness.runtime.armDangerToken).toHaveBeenCalledTimes(1)
    const token = harness.runtime.armDangerToken.mock.calls[0]?.[0] as string
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(harness.runtime.typeText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'sudo rm -rf /',
      dangerToken: token,
    }))
    // No hard-block line: the confirm path replaced the refusal.
    expect(harness.recordDanger).not.toHaveBeenCalled()
    expect(harness.granted).toHaveLength(1)
    expect(harness.granted[0]).toMatchObject({ dangerTokenArmed: true })
  })

  it('keeps clean payloads on the default approval path without a token', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const result = await harness.typeText.execute({ text: 'hello world' }, execOf())

    expect(result.success).toBe(true)
    expect(harness.recordAutoApproval).toHaveBeenCalledWith(expect.objectContaining({ tier: 'medium' }))
    expect(harness.runtime.pauseActions).not.toHaveBeenCalled()
    expect(harness.runtime.armDangerToken).not.toHaveBeenCalled()
    const callArgs = harness.runtime.typeText.mock.calls[0]?.[0] as Record<string, unknown>
    expect('dangerToken' in callArgs).toBe(false)
  })

  it('treats the model self-rescue as a denial and never types the payload', async () => {
    const harness = toolHarness({ irreversibleConfirm: true })

    const pending = harness.typeText.execute({ text: 'sudo rm -rf /' }, execOf())
    void pending.catch(() => {})
    await vi.waitFor(() => { expect(harness.runtime.pauseActions).toHaveBeenCalledTimes(1) })
    harness.emit({ paused: true, reason: 'confirm', transitionSeq: 1 })
    harness.emit({ paused: false, reason: 'manual', transitionSeq: 2 })

    await expect(pending).rejects.toThrow(/resume_actions instead of the physical takeover hotkey/)
    expect(harness.runtime.typeText).not.toHaveBeenCalled()
    expect(harness.runtime.armDangerToken).not.toHaveBeenCalled()
    expect(harness.denied[0]).toMatchObject({ reason: 'self-rescue', toolName: 'type_text' })
  })
})
