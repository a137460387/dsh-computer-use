/**
 * Vision model integration: screenshot analysis and change detection through
 * the harness's unified `ctx.llm` service on deployment-configured routes.
 *
 * Image delivery contract: screenshot bytes ALWAYS persist through
 * `ctx.attachments.saveImage()` first and reach the model as durable
 * `ImageBlock` attachment references — never inline base64 in messages
 * (the session-title-llm auxiliary-call precedent, adapted for images).
 * @module dsh-computer-use/vision/vision-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ComputerUseConfig } from '../config.ts'

/** One raster for vision calls: encoded bytes plus their coordinate basis. */
export interface VisionImage {
  /** JPEG bytes. */
  readonly data: Uint8Array
  /** Pixel width of the encoded frame. */
  readonly width: number
  /** Pixel height of the encoded frame. */
  readonly height: number
}

/** Structured decision emitted by the primary vision model. */
export interface ScreenAnalysis {
  /** The decided next operation. */
  readonly action: 'click' | 'type' | 'scroll' | 'hotkey' | 'observe' | 'done'
  /** Horizontal pixel in the analyzed screenshot, for click. */
  readonly x?: number
  /** Vertical pixel in the analyzed screenshot, for click. */
  readonly y?: number
  /** Text payload, for type. */
  readonly text?: string
  /** Key combination, for hotkey. */
  readonly keys?: readonly string[]
  /** Why — mandatory, audited with every decision. */
  readonly reason: string
}

/** Vision calls over the harness LLM seam. */
export interface VisionProvider {
  /**
   * Analyze one screenshot and return the structured next action.
   * @param image - the frame to analyze.
   * @param taskPrompt - what the model should accomplish on this screen.
   * @param signal - caller cancellation.
   * @returns the validated structured decision.
   */
  analyzeScreenshot(image: VisionImage, taskPrompt: string, signal?: AbortSignal): Promise<ScreenAnalysis>

  /**
   * Decide whether the screen changed meaningfully between two frames.
   * @param before - the pre-action frame.
   * @param after - the post-action frame.
   * @param signal - caller cancellation.
   * @returns true when the screen changed.
   */
  detectChange(before: VisionImage, after: VisionImage, signal?: AbortSignal): Promise<boolean>
}

/** Capability-owned timeout reason code for auxiliary vision requests. */
export const VISION_TIMEOUT_CODE = 'COMPUTER_USE_VISION_TIMEOUT'

const ANALYSIS_SYSTEM_PROMPT = [
  'You are the vision engine of a desktop computer-use system.',
  'You receive one screenshot and a task; decide exactly one next operation.',
  'Reply with ONLY one JSON object, no Markdown fences, no extra text:',
  '{"action":"click"|"type"|"scroll"|"hotkey"|"observe"|"done","x":<int>,"y":<int>,"text":"...","keys":["..."],"reason":"..."}',
  '- Coordinates are pixels in THIS screenshot (origin top-left).',
  '- "click" needs x and y; "type" needs text; "hotkey" needs keys; "scroll" needs no extra fields;',
  '  "observe" means look again next step; "done" means the task is complete.',
  '- "reason" is mandatory and must name the UI element or state you acted on.',
].join('\n')

const CHANGE_SYSTEM_PROMPT = [
  'You compare two desktop screenshots: BEFORE and AFTER one action.',
  'Ignore cursor position, blinking carets, and clock changes.',
  'Reply with exactly one word: CHANGED or UNCHANGED.',
].join('\n')

/** Persist one frame and return its durable attachment reference. */
async function persistImage(ctx: Context, image: VisionImage, name: string): Promise<ImageAttachmentRef> {
  const ref = await ctx.attachments.saveImage({ data: image.data, mediaType: 'image/jpeg', name })
  return ref
}

/** One user message carrying persisted images plus prompt text. */
function visionMessage(refs: readonly ImageAttachmentRef[], text: string): Message {
  return createUserMessage({
    content: [
      ...refs.map((attachment): { type: 'image'; attachment: ImageAttachmentRef } => ({ type: 'image', attachment })),
      { type: 'text', text },
    ],
    source: { kind: 'plugin', plugin: 'dsh-computer-use' },
  })
}

/** One auxiliary call through `ctx.llm`, assembled to text blocks. */
async function streamToText(
  ctx: Context,
  config: ComputerUseConfig,
  route: { provider: string; model: string },
  system: string,
  messages: Message[],
  signal: AbortSignal | undefined,
): Promise<string> {
  using callDeadline = deadline(signal, config.visionTimeoutMs, VISION_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.visionMaxOutputTokens,
    signal: callDeadline.signal,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`dsh-computer-use vision call failed: ${finish.failure.message}`)
  }
  if (finish.kind === 'tool-calls') {
    throw new Error('dsh-computer-use: vision model unexpectedly requested a tool')
  }
  if (finish.kind === 'max-tokens') {
    throw new Error('dsh-computer-use: vision model output was truncated (maxTokens); retry or raise visionMaxOutputTokens')
  }
  const blocks = assembler.blocks()
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Extract the first balanced JSON object from model output. */
function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`dsh-computer-use: vision model produced no JSON object: ${text.slice(0, 200)}`)
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const parsed: unknown = JSON.parse(text.slice(start, index + 1))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
        throw new Error('dsh-computer-use: vision model JSON is not an object')
      }
    }
  }
  throw new Error('dsh-computer-use: vision model JSON object was not terminated')
}

const ANALYSIS_ACTIONS = new Set(['click', 'type', 'scroll', 'hotkey', 'observe', 'done'])

/** Read one unknown parsed field as a finite number, or undefined when absent. */
function asOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`dsh-computer-use: vision model field "${field}" is not a finite number`)
  }
  return value
}

/** Validate one parsed decision into the closed ScreenAnalysis shape. */
function toScreenAnalysis(raw: Record<string, unknown>, image: VisionImage): ScreenAnalysis {
  const action = raw.action
  if (typeof action !== 'string' || !ANALYSIS_ACTIONS.has(action)) {
    throw new Error(`dsh-computer-use: vision model returned unknown action ${JSON.stringify(action)}`)
  }
  const reason = raw.reason
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('dsh-computer-use: vision model decision is missing its reason')
  }
  const analysis: ScreenAnalysis = { action: action as ScreenAnalysis['action'], reason }
  const x = asOptionalNumber(raw.x, 'x')
  if (x !== undefined) {
    if (x < 0 || x > image.width) throw new Error(`dsh-computer-use: x=${x} outside screenshot width ${image.width}`)
    Object.assign(analysis, { x: Math.round(x) })
  }
  const y = asOptionalNumber(raw.y, 'y')
  if (y !== undefined) {
    if (y < 0 || y > image.height) throw new Error(`dsh-computer-use: y=${y} outside screenshot height ${image.height}`)
    Object.assign(analysis, { y: Math.round(y) })
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string') throw new Error('dsh-computer-use: vision model text is not a string')
    Object.assign(analysis, { text: raw.text })
  }
  if (raw.keys !== undefined) {
    if (!Array.isArray(raw.keys) || raw.keys.some(key => typeof key !== 'string')) {
      throw new Error('dsh-computer-use: vision model keys are not a string array')
    }
    Object.assign(analysis, { keys: raw.keys as string[] })
  }
  if (action === 'click' && (analysis.x === undefined || analysis.y === undefined)) {
    throw new Error('dsh-computer-use: click decision is missing coordinates')
  }
  return analysis
}

/**
 * Build the deployment's VisionProvider over `ctx.llm` and `ctx.attachments`.
 * @param ctx - context carrying the LLM and attachment services.
 * @param config - validated policy (routes, token cap, deadline).
 * @returns the provider; routes resolve per call, so late settings edits apply.
 */
export function createVisionProvider(ctx: Context, config: ComputerUseConfig): VisionProvider {
  return {
    async analyzeScreenshot(image, taskPrompt, signal) {
      const ref = await persistImage(ctx, image, 'cu-vision-analysis.jpg')
      const text = await streamToText(
        ctx,
        config,
        { provider: config.visionProvider, model: config.visionModel },
        ANALYSIS_SYSTEM_PROMPT,
        [visionMessage([ref], `Screenshot: ${image.width}x${image.height}px.\nTask: ${taskPrompt}`)],
        signal,
      )
      return toScreenAnalysis(extractJsonObject(text), image)
    },

    async detectChange(before, after, signal) {
      const [beforeRef, afterRef] = await Promise.all([
        persistImage(ctx, before, 'cu-vision-before.jpg'),
        persistImage(ctx, after, 'cu-vision-after.jpg'),
      ])
      const text = await streamToText(
        ctx,
        config,
        { provider: config.changeDetectionProvider, model: config.changeDetectionModel },
        CHANGE_SYSTEM_PROMPT,
        [visionMessage([beforeRef, afterRef], 'Did the screen change meaningfully between these two screenshots?')],
        signal,
      )
      return /\bCHANGED\b/i.test(text) && !/\bUNCHANGED\b/i.test(text)
    },
  }
}
