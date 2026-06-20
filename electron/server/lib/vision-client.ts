/**
 * Vision client — sends an image + focused prompt to Anthropic or OpenAI
 * and returns a style-only description suitable for appending to image
 * generation prompts as a style_tag.
 *
 * Scope is narrow on purpose: this isn't a general vision dispatcher, it's
 * the engine behind "Extract Style from Reference Image". Subject matter is
 * explicitly ignored; callers that want a caption should use a different
 * endpoint.
 *
 * Auto-downscales input to 1024 px on the long side via sharp. Vision
 * pricing scales with image size, and style cues read fine at 1024 px —
 * higher-res inputs mostly raise cost without meaningful accuracy gain.
 */
import { existsSync } from 'fs'
import sharp from 'sharp'

// Vision-capable model ids we've actually tested with the style-analysis
// prompt below. Unknown models fall back to claude-sonnet-4-6 — keeps the
// caller honest without failing hard on a typo. If you add a model here,
// verify it accepts image inputs in its current API shape.
export const VISION_CAPABLE_MODELS = new Set<string>([
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022',
  'claude-3-opus-20240229',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-5',
])

export function isVisionCapable(modelId: string | undefined | null): boolean {
  if (!modelId) return false
  return VISION_CAPABLE_MODELS.has(modelId)
}

/** Models the B-Roll tagger can safely send an image to. DeepSeek and the
 * reasoning-only OpenAI models are intentionally excluded: they are text-only
 * in the providers currently registered by Story Studio. */
export function isBrollVisionModelSupported(modelId: string | undefined | null): boolean {
  if (!modelId) return false
  if (modelId.startsWith('lmstudio:')) return true
  const model = modelId.toLowerCase()
  return model === 'gpt-4o'
    || model.startsWith('gpt-4o-')
    || model === 'gpt-4-turbo'
    || model.startsWith('gpt-4-turbo-')
    || model === 'gpt-4.1'
    || model.startsWith('gpt-4.1-')
    || model === 'gpt-5'
    || model.startsWith('gpt-5-')
}

/** Pick the best vision-capable model from a caller's preference + sane default. */
export function resolveVisionModel(preferred?: string | null): string {
  if (preferred && isVisionCapable(preferred)) return preferred
  return 'claude-sonnet-4-6'
}

const STYLE_PROMPT = `Analyze this image's visual style for use as an image-generation style tag.

Return 2–4 sentences describing ONLY the following aspects — do NOT describe the subject, characters, or scene content:
- Art medium (illustration, photography, 3D render, painting, etc.)
- Palette (specific colour families, saturation level)
- Lighting (direction, softness, temperature, time of day if relevant)
- Texture (brushwork, grain, cleanliness, detail density)
- Composition style (flat, depth, framing tendencies, camera feel)
- Overall mood / atmosphere

Output as a single flowing paragraph suitable for appending "in this style" to image generation prompts. No bullet points. No preamble like "This image has…" or "The style is…" — just the description itself.`

// B-Roll auto-tag prompt: returns a short flat list of lowercase tags
// suitable for filtering / theming a stock-footage library. Tags should
// describe SUBJECT MATTER + SETTING + MOOD — what a human curator would
// hand-tag the clip with. Strict JSON output so the parser doesn't have
// to handle prose. v1.0.89+.
const TAGS_PROMPT = `Look at this single frame from a video B-Roll clip. Output 3-7 short tags that describe what the frame shows, suitable for filtering a stock-footage library.

Tags should describe a mix of:
- SUBJECT: what is in the frame (people, nature element, object, building, etc.)
- SETTING: where the frame appears to be (indoors, outdoors, city, forest, ocean, sunrise, etc.)
- MOOD: what the frame feels like (peaceful, dramatic, contemplative, hopeful, etc.)

Rules:
- Each tag is 1-2 words, lowercase, no punctuation.
- No duplicates.
- No generic filler like "video" / "footage" / "clip" / "scene".
- 3-7 tags total. Pick the most descriptive ones, not exhaustive ones.

Output STRICT JSON only — a single array of strings. No preamble, no fenced block, no commentary.

Example output:
["sunrise","ocean","calm","golden hour","horizon"]`

// Companion prompt to STYLE_PROMPT: focuses on WHAT the subject looks like
// rather than HOW it's drawn. Used by /analyze-character so the user can
// upload a reference image and bootstrap a rigid appearance description
// the LLM will then reuse verbatim across every scene prompt for that
// character — the single biggest continuity lever for image generation.
const CHARACTER_PROMPT = `Analyze the main subject of this image and produce a rigid character description for re-use in image-generation prompts.

Describe ONLY the subject's appearance — NOT the lighting, medium, brushwork, palette, or scene context (those belong in a separate style tag). Cover, in order:
- Species / type (human, animal, creature, etc.)
- Distinct anatomy (proportions, body shape, notable features — wing shape, antenna length, ear shape, build, etc.)
- Colour markings (exact colours of body parts, patterns, eye colour, etc.)
- Clothing or accessories (if any)
- Pose / framing tendency (typical angle, e.g. "always shown in side profile" — only if clear from the image)

Output as 2–4 sentences as one flowing paragraph. Start directly with the subject — no preamble. End with "Same proportions and markings every scene." so the downstream LLM treats it as a hard constraint.

If you cannot clearly identify a single subject (empty scene, ambiguous composition), respond with the literal string: NO_CLEAR_SUBJECT`

export interface AnalyzeStyleInput {
  imagePath: string
  /** v1.0.235+ — model + apiKey are resolved internally by `analyzeStyle`
   *  (kie.ai Claude → GPT-4o fallback). Left optional for the private
   *  `callAnthropic`/`callOpenAi` helpers and back-compat callers/tests. */
  model?: string
  apiKey?: string
  /** SDK base-URL override — used to point the Anthropic SDK at kie.ai's
   *  `/claude` endpoint for vision (vs Anthropic direct, now retired). */
  baseURL?: string
  /** Optional extra hint: "illustration" biases the prompt toward illustration-specific vocabulary. */
  focus?: string | null
  /** What to extract:
   *   'style'     → palette / medium / lighting (default, original behaviour)
   *   'character' → subject appearance / anatomy / colour markings, for the
   *                 character primitive's description field.
   *   'tags'      → short flat list of subject/setting/mood tags for B-Roll
   *                 library filtering. Result is a JSON array (caller parses).
   */
  mode?: 'style' | 'character' | 'tags'
}

export interface AnalyzeStyleResult {
  style_text: string
  model_used: string
}

async function downscaleToBuffer(imagePath: string, maxSide = 1024): Promise<{ buffer: Buffer; mime: string }> {
  const img = sharp(imagePath, { failOn: 'none' })
  const meta = await img.metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  // Only downscale if we're actually bigger than the target; no point
  // round-tripping a 512-px reference through re-encoding.
  const needsResize = Math.max(w, h) > maxSide
  const processed = needsResize
    ? img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    : img
  // JPEG at 85% is a good cost/accuracy balance for vision: imperceptibly
  // different from PNG for style cues, ~5× smaller payload.
  const buffer = await processed.jpeg({ quality: 85 }).toBuffer()
  return { buffer, mime: 'image/jpeg' }
}

async function callAnthropic(input: AnalyzeStyleInput, imageBuffer: Buffer, mime: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  })
  const basePrompt =
    input.mode === 'character' ? CHARACTER_PROMPT :
    input.mode === 'tags'      ? TAGS_PROMPT      :
    STYLE_PROMPT
  const userPrompt = input.focus ? `${basePrompt}\n\nFocus hint: ${input.focus}` : basePrompt
  const resp = await client.messages.create({
    model: input.model!,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime as any, data: imageBuffer.toString('base64') } },
        { type: 'text', text: userPrompt },
      ],
    }],
  })
  const textBlock = resp.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('Anthropic vision returned no text')
  return textBlock.text.trim()
}

async function callOpenAi(input: AnalyzeStyleInput, imageBuffer: Buffer, mime: string): Promise<string> {
  const { default: OpenAI } = await import('openai')
  const { isCompletionTokensModel } = await import('../providers/text/openai.js')
  const client = new OpenAI({ apiKey: input.apiKey })
  const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`
  const basePrompt =
    input.mode === 'character' ? CHARACTER_PROMPT :
    input.mode === 'tags'      ? TAGS_PROMPT      :
    STYLE_PROMPT
  const userPrompt = input.focus ? `${basePrompt}\n\nFocus hint: ${input.focus}` : basePrompt
  // gpt-5 + reasoning models reject `max_tokens` and require the newer
  // `max_completion_tokens` field. Pick the right one per model family.
  const tokenField = isCompletionTokensModel(input.model!)
    ? { max_completion_tokens: 400 }
    : { max_tokens: 400 }
  const resp = await client.chat.completions.create({
    model: input.model!,
    ...tokenField,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: userPrompt },
      ],
    }],
  })
  const text = resp.choices[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI vision returned no text')
  return text.trim()
}

/** True when a vision-capable key exists at the app level. v1.0.248 — kie.ai
 *  was removed as a text/vision provider (its Claude endpoint was blocked);
 *  vision now uses OpenAI GPT-4o (documented image support). */
export async function visionKeyAvailable(): Promise<boolean> {
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const openai = await getApiKey('openai').catch(() => '')
  return !!openai
}

/** v1.0.406 — drive a local LM Studio vision model (e.g. Llava / Qwen-VL /
 *  Gemma-VL) for the same image-analysis prompts. Free + offline. Reuses the
 *  lmstudio text provider, which packs `images` into the OpenAI multimodal
 *  content array. The "apiKey" slot carries the LM Studio base URL. */
async function callLmStudioVision(model: string, buffer: Buffer, mime: string, input: AnalyzeStyleInput): Promise<string> {
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const baseUrl = await getApiKey('lmstudio').catch(() => '')
  if (!baseUrl) {
    throw new Error('No LM Studio URL configured for local vision tagging. Set it in Settings → Local Models → LM Studio, then load a vision-capable model.')
  }
  const { registry } = await import('../providers/registry.js')
  const provider = registry.getTextProvider('lmstudio')
  if (!provider) throw new Error('LM Studio provider not registered')
  const basePrompt =
    input.mode === 'character' ? CHARACTER_PROMPT :
    input.mode === 'tags'      ? TAGS_PROMPT      :
    STYLE_PROMPT
  const userPrompt = input.focus ? `${basePrompt}\n\nFocus hint: ${input.focus}` : basePrompt
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  const text = await provider.callText({
    model,
    system: '',
    userMessage: userPrompt,
    apiKey: baseUrl,
    images: [dataUrl],
  } as any)
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('LM Studio vision returned no text — is the loaded model vision-capable (e.g. Llava, Qwen-VL)?')
  }
  return text.trim()
}

/**
 * Analyse a reference image. Default is OpenAI GPT-4o vision; the caller can
 * pick another route via `input.model`:
 *   - supported GPT vision model → OpenAI vision (uses the OpenAI key)
 *   - 'lmstudio:<slug>'         → a LOCAL LM Studio vision model (free)
 * An absent model defaults to gpt-4o for legacy callers. An explicit text-only
 * or unknown model fails clearly instead of silently spending OpenAI credit.
 */
export async function analyzeStyle(input: AnalyzeStyleInput): Promise<AnalyzeStyleResult> {
  if (!input.imagePath || !existsSync(input.imagePath)) {
    throw new Error(`Reference image not found: ${input.imagePath}`)
  }
  const requested = (input.model || '').trim()
  const { buffer, mime } = await downscaleToBuffer(input.imagePath)

  // Local LM Studio vision — no OpenAI key needed.
  if (requested.startsWith('lmstudio:')) {
    const text = await callLmStudioVision(requested, buffer, mime, input)
    return { style_text: text, model_used: requested }
  }

  if (requested && !isBrollVisionModelSupported(requested)) {
    const detail = requested.startsWith('deepseek')
      ? 'DeepSeek models are text-only and cannot inspect B-Roll images or video frames.'
      : `Model "${requested}" is not configured for image input.`
    throw new Error(`${detail} Pick a vision-capable OpenAI or LM Studio model.`)
  }

  // OpenAI vision. No explicit selection preserves the historical GPT-4o
  // default used by character/style analysis callers.
  const { getApiKey } = await import('../services/app-secrets-store.js')
  const openaiKey = await getApiKey('openai').catch(() => '')
  if (!openaiKey) {
    throw new Error('No vision-capable API key configured. Add an OpenAI key in Settings → API Keys, or pick a local LM Studio vision model.')
  }
  const model = requested || 'gpt-4o'
  const text = await callOpenAi({ ...input, model, apiKey: openaiKey }, buffer, mime)
  return { style_text: text, model_used: model }
}
