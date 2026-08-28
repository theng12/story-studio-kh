/**
 * Fish Audio S2 expression markup — the "expressive script" sidecar.
 *
 * Fish S2 takes inline performance tags right in the narration text, e.g.
 * `[whispering] Don't let them hear you.` or open-domain `[dead tired]`. This
 * service runs an LLM pass that inserts those tags into a copy of the episode
 * narration, stores the result per section in a sidecar JSON, and lets the
 * Audio Generator swap the tagged text in at render time (Fish S2-Pro only).
 *
 * The sidecar is keyed by section slug so the REAL narration always stays the
 * authoritative source of section structure — we only override the spoken text.
 *
 * Docs: https://fish.audio/blog/fish-audio-s2-fine-grained-ai-voice-control-at-the-word-level/
 */

import fs from 'fs/promises'
import path from 'path'
import { callAiWithRetry } from '../lib/ai-client.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { Job } from '../models/types.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import { requireJobCompletion } from './job-completion.js'
import { isLocalTextModel } from './job-retry-policy.js'

/** Filename of the per-episode sidecar, stored next to the narration file. */
export const EXPRESSION_SIDECAR = 'audio_expression.json'

export interface ExpressionSidecar {
  schema_version: 1
  /** Model used for the last LLM markup pass (informational). */
  model?: string
  /** Tag dialect the stored tags are in — render only uses them when it matches
   *  the target model's dialect (Fish tags must not go to ElevenLabs & vice
   *  versa). Absent = legacy Fish-only sidecar. */
  dialect?: 'fish' | 'elevenlabs'
  /** ISO timestamp of the last write (informational). */
  generated_at?: string
  /** Tagged narration per section slug. Missing slug = use plain narration. */
  sections: Record<string, string>
}

export function expressionSidecarPath(narrationPath: string): string {
  return path.join(path.dirname(narrationPath), EXPRESSION_SIDECAR)
}

export async function readExpression(narrationPath: string): Promise<ExpressionSidecar | null> {
  try {
    const raw = await fs.readFile(expressionSidecarPath(narrationPath), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sections && typeof parsed.sections === 'object') {
      return parsed as ExpressionSidecar
    }
  } catch { /* missing or corrupt — treat as no markup */ }
  return null
}

export async function writeExpression(narrationPath: string, data: ExpressionSidecar): Promise<void> {
  const sidecarPath = expressionSidecarPath(narrationPath)
  await withLock(sidecarPath, () => writeJsonAtomic(sidecarPath, data))
}

export async function checkpointExpressionSection(
  narrationPath: string,
  slug: string,
  text: string,
  model: string,
  dialect: TagDialect,
): Promise<ExpressionSidecar> {
  const tagged = text.trim()
  if (!slug.trim()) throw new Error('Cannot checkpoint expression markup without a section slug.')
  if (!tagged) throw new Error(`Cannot checkpoint empty expression markup for ${slug}.`)
  const sidecarPath = expressionSidecarPath(narrationPath)
  return withLock(sidecarPath, async () => {
    let existing: ExpressionSidecar | null = null
    try {
      const parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'))
      if (parsed?.sections && typeof parsed.sections === 'object') existing = parsed as ExpressionSidecar
    } catch { /* first completed section, or a corrupt sidecar to replace */ }
    const reusable = existing && (existing.dialect ?? 'fish') === dialect
    const next: ExpressionSidecar = {
      schema_version: 1,
      model,
      dialect,
      generated_at: new Date().toISOString(),
      sections: { ...(reusable ? existing!.sections : {}), [slug]: tagged },
    }
    await writeJsonAtomic(sidecarPath, next)
    return next
  })
}

/**
 * Which inline-tag dialect a TTS model speaks, or null if it can't do tags.
 *
 * Always null today — dead on purpose, not a bug to fix here. This used to
 * switch on literal engine ids: `eleven-v3` / `genaipro-v3` (ElevenLabs v3 via
 * fal / GenAIPro) and `fishaudio-s2-pro` (Fish Audio S2-Pro). Both retired
 * when v1.0.669 collapsed every generation path onto the GenStudio-only
 * gateway. `model` here is now one of GenStudio's TTS TIER ids
 * (`genstudio-tts-regular` / `-premium` / `-clone` — see
 * `resolveStoryTtsModelId` in services/project-manager.ts, which refuses any
 * other model id before a job is even created) and none of the three retired
 * literals can ever reach this function as `model` again.
 *
 * GenStudio owns which physical engine executes a tier and does not publish
 * that choice, or whether the chosen engine accepts inline performance tags,
 * anywhere in its catalog (`GenStudioVoice` carries no such field). Per
 * AGENTS.md's first rule, capability is never inferred from a model or
 * provider name and never invented when unpublished — so this returns null
 * unconditionally rather than guess a dialect from a tier id. Every caller
 * (the render-time tag swap-in and auto-pacing in generators/audio.ts, the
 * manual/"Tag all" markup endpoints in routes/audio.ts) already treats null
 * as "no dialect, feature inert for this model", so the expression-markup
 * feature is currently unreachable end-to-end for real TTS generation — it
 * stays that way until GenStudio's voice-contract refactor (TTS work is
 * frozen pending that) publishes a real per-tier/per-voice tag-dialect
 * signal for this to read.
 */
export type TagDialect = 'fish' | 'elevenlabs'
export function dialectForModel(model: string | undefined | null): TagDialect | null {
  void model
  return null
}

/**
 * System prompts for the markup pass — one per tag dialect. Strict: insert ONLY
 * bracketed tags, never touch the words. The user reviews/edits before it's
 * voiced, so this is a best-effort first draft, not a trusted transform.
 */
const FISH_SYSTEM = `You add Fish Audio S2 inline performance tags to narration that will be spoken by a text-to-speech voice.

Fish S2 tags are square-bracket directions that affect the words AFTER them, e.g.
  [whispering] Don't let them hear you.
  She set the folder down. [long pause] Then she looked up.
  [excited] We actually did it!
Tags are open-domain — write what you'd tell a voice actor: [warmly], [almost a whisper], [dead tired], [building urgency]. Common ones: whispering, soft voice, loud voice, shouting, excited, angry, sad, warmly, emphasis, sigh, inhale, exhale, gasp, laughing, chuckling, pause, short pause, long pause.

RULES — follow every one exactly:
- PACING IS YOUR FIRST JOB. The voice rushes through full stops with almost no gap, which sounds robotic. Give it rhythm: add a [short pause] after most sentence-ending periods (and after natural mid-sentence beats — commas that carry weight, dashes, colons), and a [long pause] at paragraph breaks and major topic shifts. Vary them so it sounds human, not metronomic — not every single sentence needs one, but silence should never feel absent.
- EVERY PARAGRAPH gets attention. Put a [long pause] at the START of each new paragraph (right after the line break), and make sure no paragraph is left without any pacing/emotion — work through the WHOLE text top to bottom, including the final paragraph. Never skip or thin out the later paragraphs.
- THEN add emotion/performance tags where they clearly help — emotional beats, emphasis, a breath. These are sparser than pauses; a few per paragraph.
- DO NOT change, add, remove, reorder, correct, or rephrase ANY of the narration's words. Insert ONLY bracketed tags between existing words.
- Preserve every line break and paragraph exactly as given.
- Output ONLY the tagged narration. No preamble, no commentary, no code fences.`

const ELEVEN_SYSTEM = `You add ElevenLabs v3 inline audio tags to narration that will be spoken by a text-to-speech voice.

ElevenLabs v3 audio tags are square-bracket stage directions, e.g.
  [whispers] Don't let them hear you.
  [excited] We actually did it!
  She set the folder down. [pause] Then she looked up.
Use ElevenLabs' VERB form: [whispers] (not whispering), [laughs] (not laughing), [sighs] (not sigh). Supported: whispers, shouts, excited, sad, angry, sarcastic, curious, sighs, exhales, laughs, chuckles, clears throat, gasps, crying. Pauses: the [pause] tag, plus an ellipsis (…) for a soft trailing beat. Capital letters add emphasis.

RULES — follow every one exactly:
- PACING FIRST: put a [pause] at each paragraph break / major topic shift, and where a sentence genuinely needs a beat. ElevenLabs paces sentences naturally, so do NOT pause after every sentence — add pauses where meaning calls for one; an ellipsis (…) suits a soft trailing beat.
- EVERY PARAGRAPH gets attention: work through the WHOLE text top to bottom including the final paragraph; never thin out the later paragraphs.
- THEN add emotion/delivery tags where they clearly help. Use them SPARINGLY — overusing reaction tags sounds cluttered and can destabilize the voice. A few per paragraph at most.
- DO NOT change, add, remove, reorder, correct, or rephrase ANY of the narration's words. Insert ONLY bracketed tags (and at most an ellipsis for a beat) between existing words.
- Preserve every line break and paragraph exactly as given.
- Output ONLY the tagged narration. No preamble, no commentary, no code fences.`

function systemFor(dialect: TagDialect): string {
  return dialect === 'elevenlabs' ? ELEVEN_SYSTEM : FISH_SYSTEM
}

/**
 * Deterministic pacing pass (no LLM): insert pause tags at paragraph (and, for
 * Fish, sentence) boundaries so the read stops rushing. Fish gets aggressive
 * sentence pacing (it rushes full stops); ElevenLabs gets paragraph pauses only
 * (it paces sentences naturally, and over-tagging can destabilize v3). Skips
 * common abbreviations on a lone period and never stacks adjacent pauses, so it
 * composes with the LLM pass + hand edits. Tag-capable models only.
 */
const PACING_ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'vs', 'etc', 'no', 'inc', 'ltd',
  'prof', 'gen', 'sgt', 'lt', 'col', 'capt', 'rev', 'hon', 'dept', 'fig', 'vol',
])
export function addSentencePacing(text: string, dialect: TagDialect = 'fish'): string {
  const PARA = dialect === 'elevenlabs' ? '[pause]' : '[long pause]'
  const SENT = dialect === 'elevenlabs' ? '' : '[short pause]'  // EL: paragraphs only
  // 1. ANY line break = a paragraph/beat boundary → a pause tag. Narration is
  //    never hard-wrapped mid-paragraph, so this reliably catches every
  //    paragraph change whether the source — or the LLM pass — separated
  //    paragraphs with one newline or two. The tag carries the pause.
  let t = text.trim().replace(/[ \t]*[\r\n]+[ \t]*/g, ` ${PARA} `)
  // 2. (Fish only) pause after sentence-ending . ? ! + whitespace + a capital /
  //    quote / open-paren, skipping common abbreviations on a lone period.
  if (SENT) {
    t = t.replace(/(\S+?)([.!?]+)([ \t]+)(?=["'“‘(]?[A-Z0-9])/g, (m, word: string, punct: string, sp: string) => {
      const bare = word.toLowerCase().replace(/[^a-z]/g, '')
      if (punct === '.' && PACING_ABBREV.has(bare)) return m  // Mr. / Dr. / etc.
      return `${word}${punct}${sp}${SENT} `
    })
  }
  // 3. Never stack pauses (the LLM pass + this pass can land on the same spot).
  t = t.replace(/\[(?:short |long )?pause\](?:\s*\[(?:short |long )?pause\])+/g, (m) => (m.includes('long') ? '[long pause]' : (m.includes('short') ? '[short pause]' : '[pause]')))
  return t.replace(/[ \t]{2,}/g, ' ').trim()
}

interface AiKeys { anthropic_api_key?: string; openai_api_key?: string; kie_api_key?: string }

const EXPRESSION_TAG_RE = /\[[^\]\r\n]{1,100}\]/g
const EXPRESSION_TOKEN_RE = /\.\.\.|…|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu

function expressionTokens(text: string): string[] {
  return text.match(EXPRESSION_TOKEN_RE) || []
}

function isEllipsis(token: string): boolean {
  return token === '…' || token === '...'
}

export interface ExpressionMarkupIntegrity {
  valid: boolean
  reason?: string
}

/**
 * Prove that a model inserted tags without changing the narration. Whitespace
 * around an inserted tag may move, and ElevenLabs may add ellipses, but every
 * original word and punctuation token must remain in the same order.
 */
export function inspectExpressionMarkup(
  original: string,
  tagged: string,
  dialect: TagDialect,
): ExpressionMarkupIntegrity {
  if (!tagged.trim()) return { valid: false, reason: 'the model returned empty text' }
  const tags = tagged.match(EXPRESSION_TAG_RE) || []
  if (!tags.length) return { valid: false, reason: 'the model returned no expression tags' }

  const originalTokens = expressionTokens(original)
  const taggedTokens = expressionTokens(tagged.replace(EXPRESSION_TAG_RE, ' '))
  let sourceIndex = 0
  let taggedIndex = 0
  while (taggedIndex < taggedTokens.length) {
    const candidate = taggedTokens[taggedIndex]!
    if (sourceIndex < originalTokens.length && candidate === originalTokens[sourceIndex]) {
      sourceIndex++
      taggedIndex++
      continue
    }
    if (dialect === 'elevenlabs' && isEllipsis(candidate)) {
      taggedIndex++
      continue
    }
    const expected = originalTokens[sourceIndex] ?? '<end of narration>'
    return {
      valid: false,
      reason: `narration changed near token ${sourceIndex + 1} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(candidate)})`,
    }
  }
  if (sourceIndex !== originalTokens.length) {
    return {
      valid: false,
      reason: `narration ended early at token ${sourceIndex + 1} of ${originalTokens.length}`,
    }
  }
  return { valid: true }
}

/**
 * Run the LLM markup pass over one section's text in the given dialect. Returns
 * the tagged text (or the original on an empty/failed response so a section is
 * never blanked).
 */
export async function markupSectionText(
  model: string,
  sectionText: string,
  apiKeys: AiKeys,
  slug: string,
  dialect: TagDialect = 'fish',
): Promise<string> {
  // Maximum: the model returns the whole section back with markup tags added,
  // so the response is always at least as long as the input section.
  const out = await callAiWithRetry(model, systemFor(dialect), sectionText, apiKeys, false, {
    slug, outputBudget: 'maximum',
  })
  const trimmed = (out || '').trim()
  const integrity = inspectExpressionMarkup(sectionText, trimmed, dialect)
  if (!integrity.valid) {
    throw new Error(`Expression markup rejected because ${integrity.reason}. The original narration was not changed.`)
  }
  return trimmed
}

export function resolveExpressionTagConcurrency(
  model: string,
  itemCount: number,
  configured: number,
): number {
  return Math.max(1, Math.min(itemCount, isLocalTextModel(model) ? itemCount : configured))
}

/** Cloud expression tagging follows the saved provider limit. Local Chat
 * Studio work is released immediately to its own fleet scheduler. */
export async function expressionTagConcurrency(model: string, itemCount: number): Promise<number> {
  return resolveExpressionTagConcurrency(model, itemCount, resolveGenStudioLocalFanout(itemCount))
}

/** Small bounded worker pool shared by background Tag All and audio auto-tag. */
export async function mapExpressionConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      out[index] = await worker(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run))
  return out
}

export interface ExpressionMarkupParams {
  episode_id: string
  title?: string
  /** Text model for the markup pass. When omitted, resolved against
   *  GenStudio's live catalog (see resolveDefaultChatModel in
   *  services/genstudio-default-model.ts) — never a hardcoded default. */
  model?: string
  /** Tag dialect to write (matches the target TTS model). Defaults to 'fish'. */
  dialect?: TagDialect
  /** Limit to these section slugs; omit/empty = every section. */
  slugs?: string[]
  /** Set when the enqueuing route resolved `model` itself and that resolution
   *  healed away from the project's saved preference. The route has no job to
   *  announce on, so the sentence rides here and this job logs it. */
  model_heal_notice?: string
}

/**
 * Background "Tag all" job — runs the LLM markup over every (or selected)
 * section server-side, saving the sidecar after EACH section so progress
 * survives navigation, a crash, or cancellation. This is why "Tag all" keeps
 * working after the operator leaves the Audio Generator page.
 */
export async function runExpressionMarkupJob(job: Job): Promise<void> {
  const params = job.params as ExpressionMarkupParams
  const episodeId = params.episode_id
  if (!episodeId) throw new Error('episode_id is required')
  const requestedModel = (typeof params.model === 'string') ? params.model.trim() : ''
  const dialect: TagDialect = params.dialect === 'elevenlabs' ? 'elevenlabs' : 'fish'

  const pm = await import('./project-manager.js')
  const { findNarrationFile } = await import('../generators/audio.js')
  const { parseNarrationDocx } = await import('../lib/docx-parser.js')
  const { isCancelled } = await import('./job-queue.js')

  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  // A job enqueued without a model resolves against GenStudio's live
  // catalog rather than a hardcoded external product id — GenStudio owns
  // the catalog and a retired/renamed literal must never be submitted
  // blind (see services/genstudio-default-model.ts).
  let model = requestedModel
  if (!model) {
    const { getApiKey } = await import('./app-secrets-store.js')
    const { resolveDefaultChatModel, describeHealedDefaultChatModel } = await import('./genstudio-default-model.js')
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) throw new Error('No GenStudio API key configured. Add it in Settings → This Mac before generating expression markup.')
    const saved = typeof (config as any)?.prompt_model === 'string' ? (config as any).prompt_model : null
    const resolved = await resolveDefaultChatModel(apiKey, saved)
    model = resolved.modelId
    // The heal itself is unchanged — only its silence is. Without this the log
    // named a model the operator never chose, with nothing saying why.
    const healNotice = describeHealedDefaultChatModel(resolved)
    if (healNotice) job.output_lines.push(healNotice)
  }
  // "Tag all" resolves the model in the route, before this job exists, so it
  // carries the notice in params rather than dropping it at the handoff.
  const carriedNotice = typeof params.model_heal_notice === 'string' ? params.model_heal_notice.trim() : ''
  if (carriedNotice) job.output_lines.push(carriedNotice)
  const narrationPath = await findNarrationFile(job.project_slug, episodeId)
  const parsed = await parseNarrationDocx(narrationPath)
  const targets = (Array.isArray(params.slugs) && params.slugs.length)
    ? parsed.filter(s => params.slugs!.includes(s.slug))
    : parsed
  if (!targets.length) throw new Error('No matching narration sections were found to tag. Refresh the script or clear the stale section selection.')

  const apiKeys: AiKeys = {
    anthropic_api_key: (config as any).anthropic_api_key,
    openai_api_key: (config as any).openai_api_key,
    kie_api_key: (config as any).kie_api_key,
  }
  const concurrency = await expressionTagConcurrency(model, targets.length)
  job.output_lines.push(`Tagging ${targets.length} section(s) with ${model} (${dialect}) — concurrency ${concurrency}…`)

  let completed = 0
  let cancelled = false
  const failures = new Map<string, string>()
  await mapExpressionConcurrent(targets, concurrency, async (s, index) => {
    if (isCancelled(job.job_id)) { cancelled = true; return '' }
    job.output_lines.push(`  ${s.label} (${index + 1}/${targets.length})`)
    try {
      const tagged = await markupSectionText(model, s.text, apiKeys, job.project_slug, dialect)
      if (isCancelled(job.job_id)) { cancelled = true; return tagged }
      await checkpointExpressionSection(narrationPath, s.slug, tagged, model, dialect)
      completed++
      job.progress = Math.round((completed / targets.length) * 100)
      job.output_lines.push(`  Saved ${s.label} (${completed}/${targets.length})`)
      return tagged
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failures.set(s.slug, detail)
      job.output_lines.push(`  Failed ${s.label}: ${detail}`)
      return ''
    }
  })
  if (cancelled) { job.output_lines.push('Cancelled by user.'); return }
  const missingSlugs = targets.filter(section => failures.has(section.slug)).map(section => section.slug)
  if (missingSlugs.length) {
    // Generic manual Retry clones params. Narrowing this job's durable params
    // prevents another paid call for sections already checkpointed above.
    job.params.slugs = missingSlugs
  }
  requireJobCompletion(job, {
    label: 'Expression markup',
    expected: targets.length,
    completed,
    missing: missingSlugs,
    retry_hint: 'Valid tagged sections were saved. Retry processes only the missing sections and never changes the narration source.',
  })
  job.progress = 100
  job.output_lines.push('Expression markup complete.')
}
