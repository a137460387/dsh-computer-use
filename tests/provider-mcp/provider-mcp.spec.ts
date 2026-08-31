import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ObservationId } from '../../src/definition/index.ts'
import McpComputerUseProvider, {
  REQUIRED_SIDECAR_TOOLS,
  computerUseBinaryPath,
  resolveSidecarLaunch,
} from '../../src/provider-mcp/index.ts'
import { noOpAuditor, testConfig } from '../helpers.ts'

// existsSync is mocked module-wide so the missing-binary refusal is testable
// on a checkout where the packaged binary exists; the default implementation
// delegates to the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(((path: string) => actual.existsSync(path)) as typeof actual.existsSync),
  }
})

afterEach(() => { vi.useRealTimers() })

describe('computerUseBinaryPath', () => {
  it('resolves the platform-tagged binary under bin/', () => {
    const path = computerUseBinaryPath()
    expect(path.endsWith(join('bin', 'dsh-cu-server-win-x64.exe'))).toBe(true)
  })
})

describe('resolveSidecarLaunch', () => {
  it('uses the production binary when present and no mode is forced', () => {
    // The packaged binary exists in this checkout (built by scripts/build-python.py).
    const launch = resolveSidecarLaunch(testConfig())
    expect(launch.argv).toHaveLength(1)
    expect(launch.description).toContain('prod binary')
  })

  it('forces the dev Python source when serverMode is dev', () => {
    const launch = resolveSidecarLaunch(testConfig({ serverMode: 'dev', pythonCommand: 'python3' }))
    expect(launch.argv[0]).toBe('python3')
    expect(launch.argv[1]?.endsWith(join('src-python', 'main.py'))).toBe(true)
    expect(launch.description).toContain('dev script')
  })

  it('throws with guidance when prod is forced but the binary is missing', () => {
    vi.mocked(existsSync).mockReturnValueOnce(false)
    expect(() => resolveSidecarLaunch(testConfig({ serverMode: 'prod' })))
      .toThrow(/production sidecar binary is missing/)
  })
})

describe('McpComputerUseProvider observation freshness', () => {
  interface ObservationFacts {
    observationId: string
    path: string
    width: number
    height: number
    bytes: number
    dhash: string
    capturedAtMs: number
  }

  /** Reach the provider's private registration path for TTL testing. */
  function register(provider: McpComputerUseProvider, facts: ObservationFacts, data: Uint8Array): void {
    const internal = provider as unknown as {
      registerObservation(facts: ObservationFacts, data: Uint8Array): void
    }
    internal.registerObservation(facts, data)
  }

  function factsOf(capturedAtMs: number): ObservationFacts {
    return {
      observationId: 'obs-1', path: '/tmp/obs-1.jpg', width: 100, height: 80,
      bytes: 3, dhash: '0000000000000000', capturedAtMs,
    }
  }

  it('returns a fresh observation and expires it after the TTL', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const provider = new McpComputerUseProvider(ctx, testConfig({ observationTtlMs: 1000 }), noOpAuditor())

    const expired: string[] = []
    ctx.on('computer-use/observation-expired', event => expired.push(String(event.observationId)))

    register(provider, factsOf(Date.now()), new Uint8Array([1, 2, 3]))

    const fresh = await provider.getObservation(ObservationId('obs-1'))
    expect(fresh?.width).toBe(100)
    expect(fresh?.mediaType).toBe('image/jpeg')

    // Past the TTL the observation is refused and the expiry event fires.
    vi.advanceTimersByTime(1500)
    const stale = await provider.getObservation(ObservationId('obs-1'))
    expect(stale).toBeUndefined()
    expect(expired).toContain('obs-1')
  })

  it('returns undefined for an observation that was never captured', async () => {
    const ctx = new Context()
    const provider = new McpComputerUseProvider(ctx, testConfig(), noOpAuditor())
    await expect(provider.getObservation(ObservationId('never'))).resolves.toBeUndefined()
  })
})

describe('McpComputerUseProvider readiness facts', () => {
  it('names the nine-tool sidecar surface the handshake must prove', () => {
    expect(REQUIRED_SIDECAR_TOOLS).toHaveLength(9)
    expect([...REQUIRED_SIDECAR_TOOLS]).toEqual(expect.arrayContaining([
      'get_display_info', 'screen_shot', 'click_at', 'type_text', 'scroll',
      'hotkey', 'get_foreground_window', 'resume_actions', 'pause_actions',
    ]))
  })

  it('reports the lazy-start state before any service use', () => {
    const ctx = new Context()
    const provider = new McpComputerUseProvider(ctx, testConfig(), noOpAuditor())
    expect(provider.readinessFacts()).toEqual({
      connected: false,
      startedOnce: false,
      disposed: false,
      requiredToolSurfaceSize: 9,
      paused: false,
      healthCheckActive: false,
    })
  })

  it('reports a connected sidecar with its handshake facts', () => {
    const ctx = new Context()
    const provider = new McpComputerUseProvider(ctx, testConfig(), noOpAuditor())
    const internal = provider as unknown as {
      client: unknown
      serverVersion: string | undefined
      connectedToolCount: number | undefined
      healthTimer: NodeJS.Timeout | undefined
    }
    internal.client = {} // any client marks the connection live for diagnostics
    internal.serverVersion = '0.1.3'
    internal.connectedToolCount = 9
    internal.healthTimer = setTimeout(() => {}, 1000)

    const facts = provider.readinessFacts()
    expect(facts).toEqual({
      connected: true,
      startedOnce: false,
      disposed: false,
      requiredToolSurfaceSize: 9,
      paused: false,
      healthCheckActive: true,
      serverVersion: '0.1.3',
      toolSurfaceSize: 9,
    })
    clearTimeout(internal.healthTimer)
  })

  it('reports the paused mirror alongside the connection state', () => {
    const ctx = new Context()
    const provider = new McpComputerUseProvider(ctx, testConfig(), noOpAuditor())
    const internal = provider as unknown as { paused: boolean }
    internal.paused = true
    expect(provider.readinessFacts().paused).toBe(true)
  })
})
