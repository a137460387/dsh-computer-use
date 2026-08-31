import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createVisionProvider } from '../../src/vision/vision-provider.ts'
import type { VisionImage } from '../../src/vision/vision-provider.ts'
import { testConfig } from '../helpers.ts'

const image: VisionImage = { data: new Uint8Array([1, 2, 3]), width: 640, height: 480 }

/** Fake ctx capturing saved images and the options of the last stream call. */
function fakeCtx(chunks: StreamChunk[]): {
  ctx: Context
  saved: SaveImageAttachment[]
  options: () => GenerateOptions | undefined
} {
  const saved: SaveImageAttachment[] = []
  let counter = 0
  let lastOptions: GenerateOptions | undefined
  const ctx = {
    attachments: {
      async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        saved.push(input)
        counter += 1
        return {
          attachmentId: AttachmentId(`att-${counter}`), mediaType: 'image/jpeg',
          bytes: input.data.byteLength, width: 640, height: 480,
        }
      },
    },
    llm: {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        lastOptions = options
        return (async function* () { for (const chunk of chunks) yield chunk })()
      },
    },
  } as unknown as Context
  return { ctx, saved, options: () => lastOptions }
}

/** Stream chunks delivering one text block then a stop finish. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('createVisionProvider.analyzeScreenshot', () => {
  it('parses a click decision and validates coordinates against the frame', async () => {
    const { ctx, saved, options } = fakeCtx(textChunks('{"action":"click","x":10,"y":20,"reason":"the button"}'))
    const provider = createVisionProvider(ctx, testConfig())

    const analysis = await provider.analyzeScreenshot(image, 'open the app')

    expect(analysis).toMatchObject({ action: 'click', x: 10, y: 20, reason: 'the button' })
    expect(saved).toHaveLength(1)
    expect(options()?.provider).toBe('vp')
    expect(options()?.model).toBe('vm')
  })

  it('parses a done decision without coordinates', async () => {
    const { ctx } = fakeCtx(textChunks('{"action":"done","reason":"task complete"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 'finish'))
      .resolves.toMatchObject({ action: 'done', reason: 'task complete' })
  })

  it('rejects an unknown action', async () => {
    const { ctx } = fakeCtx(textChunks('{"action":"fly","reason":"x"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/unknown action/)
  })

  it('rejects a decision missing its reason', async () => {
    const { ctx } = fakeCtx(textChunks('{"action":"done"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/reason/)
  })

  it('rejects coordinates outside the screenshot', async () => {
    const { ctx } = fakeCtx(textChunks('{"action":"click","x":9999,"y":5,"reason":"r"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/outside screenshot width/)
  })

  it('rejects a click missing coordinates', async () => {
    const { ctx } = fakeCtx(textChunks('{"action":"click","reason":"r"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/missing coordinates/)
  })

  it('rejects output without a JSON object', async () => {
    const { ctx } = fakeCtx(textChunks('no json here'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/no JSON object/)
  })

  it('surfaces an error finish as a thrown failure', async () => {
    const chunks: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    ]
    const { ctx } = fakeCtx(chunks)
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/boom/)
  })

  it('rejects a truncated (max-tokens) response', async () => {
    const chunks: StreamChunk[] = [{ type: 'finish', reason: { kind: 'max-tokens' } }]
    const { ctx } = fakeCtx(chunks)
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.analyzeScreenshot(image, 't')).rejects.toThrow(/truncated/)
  })
})

describe('createVisionProvider.detectChange', () => {
  it('persists both frames and returns true on CHANGED', async () => {
    const { ctx, saved, options } = fakeCtx(textChunks('CHANGED'))
    const provider = createVisionProvider(ctx, testConfig())

    await expect(provider.detectChange(image, image)).resolves.toBe(true)
    expect(saved).toHaveLength(2)
    expect(options()?.provider).toBe('cp')
    expect(options()?.model).toBe('cm')
  })

  it('returns false on UNCHANGED', async () => {
    const { ctx } = fakeCtx(textChunks('UNCHANGED'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.detectChange(image, image)).resolves.toBe(false)
  })

  it('returns false when the answer is ambiguous', async () => {
    const { ctx } = fakeCtx(textChunks('CHANGED and also UNCHANGED'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.detectChange(image, image)).resolves.toBe(false)
  })
})

describe('createVisionProvider.verifyActionEffect', () => {
  it('parses a yes verdict on the change-detection route and persists both frames', async () => {
    const { ctx, saved, options } = fakeCtx(textChunks('{"verdict":"yes","reason":"the dialog appeared"}'))
    const provider = createVisionProvider(ctx, testConfig())

    await expect(provider.verifyActionEffect(image, image, 'click at (10, 10)'))
      .resolves.toEqual({ verdict: 'yes', reason: 'the dialog appeared' })
    expect(saved).toHaveLength(2)
    expect(options()?.provider).toBe('cp')
    expect(options()?.model).toBe('cm')
  })

  it('parses no and uncertain verdicts', async () => {
    const { ctx } = fakeCtx(textChunks('{"verdict":"no","reason":"nothing moved"}'))
    const provider = createVisionProvider(ctx, testConfig())
    await expect(provider.verifyActionEffect(image, image, 'hotkey ctrl+c'))
      .resolves.toEqual({ verdict: 'no', reason: 'nothing moved' })
  })

  it('degrades an unknown verdict to uncertain instead of throwing', async () => {
    const { ctx } = fakeCtx(textChunks('{"verdict":"maybe","reason":"x"}'))
    const provider = createVisionProvider(ctx, testConfig())
    const verdict = await provider.verifyActionEffect(image, image, 'scroll down')
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('unknown verdict')
  })

  it('degrades a verdict missing its reason to uncertain', async () => {
    const { ctx } = fakeCtx(textChunks('{"verdict":"yes"}'))
    const provider = createVisionProvider(ctx, testConfig())
    const verdict = await provider.verifyActionEffect(image, image, 'click')
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('reason')
  })

  it('degrades output without a JSON object to uncertain', async () => {
    const { ctx } = fakeCtx(textChunks('looks fine to me'))
    const provider = createVisionProvider(ctx, testConfig())
    const verdict = await provider.verifyActionEffect(image, image, 'click')
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('no JSON object')
  })

  it('degrades an error finish to uncertain instead of throwing', async () => {
    const chunks: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'route down', code: 'X' } } },
    ]
    const { ctx } = fakeCtx(chunks)
    const provider = createVisionProvider(ctx, testConfig())
    const verdict = await provider.verifyActionEffect(image, image, 'click')
    expect(verdict.verdict).toBe('uncertain')
    expect(verdict.reason).toContain('route down')
  })
})
