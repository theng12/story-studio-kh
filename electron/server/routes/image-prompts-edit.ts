/**
 * Per-prompt Regenerate route for the Image Prompts page's review panel.
 *
 *   POST /api/projects/:slug/episodes/:episodeId/image-prompts/regenerate
 *     body: { kind: 'thumbnail', number, model?, style_tag? }
 *     200 : { number, title, prompt }
 *
 * Synchronous (no job queue) — single LLM call, ≤2s, fits the
 * click-and-wait UX on the Prompt Review panel. Reads the existing
 * thumbnail_prompts.docx, regenerates ONE entry
 * via callAi (passing the surrounding prompts as context so the new
 * one fits), and writes the docx back with the entry replaced.
 */

import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import { callAiWithRetry } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveChosenChatModel } from '../services/genstudio-default-model.js'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { resolveReadPath, toMdPath } from '../lib/episode-artifacts.js'
import { parseImagePromptsDocx, _clearImagePromptsParseCache } from '../lib/docx-parser.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { enforceThumbnailPromptElements } from '../generators/image-prompts.js'
import { HEADLINE_MODE_IDS, headlineInvents } from '../models/thumbnail-headlines.js'
import { buildPromptCharCapInstruction, parsePromptCharCap } from '../services/prompt-char-cap.js'
import { imagePromptGuidanceBlock } from '../lib/image-content-guidance.js'
import { freshActionFingerprint, readOperationId } from '../lib/fresh-generation-action.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { singleImagePromptOutputContract } from '../lib/story-output-contracts.js'

export const router = Router()

interface PromptRegenerationResult {
  number: number
  title: string
  prompt: string
}

interface PromptRegenerationAction {
  fingerprint: string
  source_fingerprint: string
  published_fingerprint?: string
  status: 'pending' | 'completed'
  result?: PromptRegenerationResult
}

interface PromptRegenerationActions {
  schema_version: 1
  actions: Record<string, PromptRegenerationAction>
}

const RegenerateSchema = z.object({
  operation_id: z.string().uuid(),
  kind: z.literal('thumbnail'),
  number: z.number().int().min(1).max(999),
  /** LLM model. Defaults to gpt-4o (matches the bulk generator's default). */
  model: z.string().optional(),
  /** Optional style override. When omitted, we recover the style from the
   *  TAIL of the existing prompt — every prompt in the docx ends with
   *  "<style_tag>" per the bulk generator's contract. */
  style_tag: z.string().optional(),
  title: z.string().optional(),
  current_title: z.string().optional(),
  current_prompt: z.string().optional(),
  notes: z.string().max(2000).optional(),
  /** Thumbnail-only: lets the regenerated prompt carry the same guaranteed
   *  ratio and ready-to-use title enforcement the bulk generator applies. */
  aspect_ratio: z.string().optional(),
  /** Recipe-owned copy strategy; short hooks are re-rendered as hooks, not full titles. */
  // Every published mode. This used to accept only two, so "Reprompt" on a
  // thumbnail in the page's default mode (two or three words) failed validation.
  headline_mode: z.string().refine(id => HEADLINE_MODE_IDS.includes(id), 'Unknown headline mode').optional(),
  /**
   * NEW-10 — the lettering the workspace currently has selected. Without these
   * the enforced ratio/title clause a regenerated row receives said "a font
   * chosen to suit the concept" even when the customer had chosen one. Omitted
   * means exactly what it meant before: no style is asserted.
   */
  thumb_font_style: z.string().max(200).optional(),
  thumb_text_style: z.string().max(200).optional(),
  thumb_font_style_custom: z.string().max(240).optional(),
  thumb_text_style_custom: z.string().max(240).optional(),
  /** The character CEILING the rewrite is written under — the intended image
   *  model's published `max_prompt_characters`, resolved by the workspace.
   *  Absent = no limit in force. Never a length to fill; the result is never
   *  truncated. See services/prompt-char-cap.ts. */
  prompt_char_cap: z.number().int().min(1).optional(),
  /** User-invoked "reword this prompt" — see lib/image-content-guidance.ts.
   *  Asks for a different angle on the same beat with the difficult-subjects
   *  guidance applied. Set only by the explicit action; never inferred. */
  reword: z.boolean().optional(),
})

const UpdatePromptSchema = z.object({
  kind: z.literal('thumbnail'),
  number: z.number().int().min(1).max(999),
  title: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(10).max(12000),
})

router.post(
  '/projects/:slug/episodes/:episodeId/image-prompts/regenerate',
  validateBody(RegenerateSchema),
  async (req, res) => {
    const { slug, episodeId } = req.params
    const { kind, number } = req.body as { kind: 'thumbnail'; number: number }
    let operationId: string
    return withLock(`image-prompt-row:${slug}:${episodeId}:${kind}:${number}`, async () => {
    try {
      operationId = readOperationId(req.body, true)!
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
    }
    const titleParam = (req.body.title as string | undefined) || (req.query.title as string) || ''
    const requestedModel = typeof req.body.model === 'string' ? req.body.model.trim() : ''

    try {
      const project = await pm.getProject(slug)
      if (!project) return res.status(404).json({ detail: 'Project not found' })
      const config = await pm.getConfig(slug)
      if (!config) return res.status(404).json({ detail: 'Project config not found' })
      // A missing model is resolved against GenStudio's live catalog rather
      // than a hardcoded external product id — GenStudio owns the catalog
      // and a retired/renamed literal must never be submitted blind.
      const model = requestedModel || await (async () => {
        const apiKey = await getApiKey('genstudio').catch(() => '')
        if (!apiKey) throw new Error('No Gateway key configured. Add it in Settings → This Mac before regenerating a prompt.')
        const saved = typeof (config as any)?.prompt_model === 'string' ? (config as any).prompt_model : null
        return resolveChosenChatModel(apiKey, saved, 'the Image Prompts page')
      })()

      const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
      const promptsConstant = paths.thumb_prompts_docx
      // Read the existing file (prefer .md, accept a legacy .docx); always
      // WRITE back as .md so editing a legacy episode upgrades it.
      const readPath = promptsConstant ? resolveReadPath(promptsConstant) : ''
      if (!readPath || !existsSync(readPath)) {
        return res.status(404).json({
          detail: `No ${kind} prompts on disk. Generate them on the Image Prompts page first.`,
        })
      }
      const writePath = toMdPath(promptsConstant)

      // Parse the full prompt set so we can (a) find the target entry,
      // (b) thread surrounding prompts as context for cohesion, (c)
      // re-write the file with the regenerated entry replacing the old.
      const parsed = await parseImagePromptsDocx(readPath)
      const list = parsed.thumbnails
      const targetIdx = list.findIndex(p => p.number === number)
      if (targetIdx < 0) {
        return res.status(404).json({
          detail: `${kind} ${number} not found in ${path.basename(readPath)}`,
        })
      }
      const target = list[targetIdx]!
      const currentTitle = ((req.body.current_title as string | undefined)?.trim()) || target.title
      const currentPrompt = ((req.body.current_prompt as string | undefined)?.trim()) || target.prompt
      const notes = ((req.body.notes as string | undefined)?.trim()) || ''

      // Recover the style tag from the existing prompt's tail. The bulk
      // generator appends `<style_tag>` to every prompt, so the LAST
      // line / sentence is typically the style. Caller can override
      // with body.style_tag.
      const styleOverride = (req.body.style_tag as string | undefined)?.trim()
      const styleTag = styleOverride || extractStyleTag(target.prompt) || ''

      // Surrounding prompts for cohesion — give the LLM the FULL list
      // (titles + numbers, no bodies) so the regenerated one fits with
      // its neighbours' subjects, and a few BODIES nearby (target ± 2)
      // so style + voice match.
      const peers = list.map(p => ({ number: p.number, title: p.title }))
      const windowed = list
        .filter(p => Math.abs(p.number - number) <= 2 && p.number !== number)
        .map(p => `Thumbnail ${p.number}: ${p.prompt}`)

      const llmPrompt = buildRegenPrompt({
        kind,
        number,
        target: { ...target, title: currentTitle, prompt: currentPrompt },
        peers,
        windowed,
        styleTag,
        notes,
        headlineMode: req.body.headline_mode as string | undefined,
        promptCharCap: parsePromptCharCap(req.body.prompt_char_cap),
        reword: req.body.reword === true,
      })

      const actionPath = path.join(path.dirname(writePath), '.prompt-regeneration-actions.json')
      const actionFingerprint = freshActionFingerprint({
        slug,
        episode_id: episodeId,
        kind,
        number,
        model,
        title: titleParam,
        current_title: req.body.current_title,
        current_prompt: req.body.current_prompt,
        notes: req.body.notes,
        style_tag: req.body.style_tag,
        aspect_ratio: req.body.aspect_ratio,
        headline_mode: req.body.headline_mode,
        prompt_char_cap: req.body.prompt_char_cap,
        reword: req.body.reword === true,
      })
      const sourceFingerprint = promptRowFingerprint(target.title, target.prompt)
      const action = await beginPromptRegenerationAction(actionPath, operationId, actionFingerprint, sourceFingerprint)
      if (action === 'mismatch') {
        return res.status(409).json({ detail: 'operation_id was already used for a different prompt regeneration request.' })
      }
      if (action === 'stale') {
        return res.status(409).json({ detail: 'This prompt changed while the regeneration action was in progress. The newer saved edit was kept.' })
      }

      let result = action.result
      if (!result) {
        const apiKeys = {
          anthropic_api_key: config.anthropic_api_key,
          openai_api_key: config.openai_api_key,
          kie_api_key: config.kie_api_key,
        }
        const raw = await callAiWithRetry(model, '', llmPrompt, apiKeys, false, {
          slug,
          requestIdentity: `${slug}:fresh:${operationId}:${kind}-${number}`,
          // The prompt asks for `{ "title": ..., "prompt": ... }` and the reader
          // parses it, so JSON is declared. `parseSinglePromptResponse` keeps its
          // plain-text fallback, but it is no longer the thing standing between a
          // prose answer and a scene prompt that is really an essay.
          outputContract: singleImagePromptOutputContract(),
        })
        const next = parseSinglePromptResponse(raw, target)
        if (!next.prompt || next.prompt.trim().length < 10) {
          return res.status(502).json({ detail: 'LLM returned an empty or too-short prompt' })
        }

        // Thumbnail prompts always keep the ratio and a ready-to-use in-image
        // title, exactly like the bulk generator.
        if (kind === 'thumbnail') {
          next.prompt = enforceThumbnailPromptElements(next.prompt, {
            aspectRatio: (req.body.aspect_ratio as string | undefined) || '16:9',
            title: headlineInvents(req.body.headline_mode) ? next.title || currentTitle : titleParam || currentTitle,
            headlineMode: req.body.headline_mode as string | undefined,
            // NEW-10 — the workspace's current lettering, when it sent any, so a
            // single-row regeneration states the same style the bulk run would.
            fontStyle: typeof req.body.thumb_font_style === 'string' ? req.body.thumb_font_style : undefined,
            textStyle: typeof req.body.thumb_text_style === 'string' ? req.body.thumb_text_style : undefined,
            fontCustomText: typeof req.body.thumb_font_style_custom === 'string' ? req.body.thumb_font_style_custom : undefined,
            textCustomText: typeof req.body.thumb_text_style_custom === 'string' ? req.body.thumb_text_style_custom : undefined,
          })
        }

        result = {
          number: target.number,
          title: next.title || target.title,
          prompt: next.prompt,
        }
        // Record the provider result before publishing the document. A retry
        // after a crash can apply this exact answer without another paid call.
        await completePromptRegenerationAction(actionPath, operationId, actionFingerprint, result)
      }

      // Replace the entry in-place. Title + prompt update; number stays.
      // Re-read only while publishing. Different rows may generate in
      // parallel; this short file lock merges each answer into the latest
      // document instead of letting an older whole-document snapshot erase a
      // newer edit to another row.
      const publication = await withLock(writePath, async () => {
        _clearImagePromptsParseCache()
        const latest = await parseImagePromptsDocx(resolveReadPath(promptsConstant))
        const latestList = latest.thumbnails
        const latestTarget = latestList.findIndex(prompt => prompt.number === number)
        if (latestTarget < 0) throw new Error(`${kind} ${number} was removed while it was being regenerated.`)
        const current = latestList[latestTarget]!
        const currentFingerprint = promptRowFingerprint(current.title, current.prompt)
        const resultFingerprint = promptRowFingerprint(result!.title, result!.prompt)
        if (currentFingerprint !== action.sourceFingerprint
          && currentFingerprint !== action.publishedFingerprint
          && currentFingerprint !== resultFingerprint) return null
        const updatedList = latestList.map((prompt, index) => (index === latestTarget
          ? { number: prompt.number, title: result!.title || prompt.title, prompt: result!.prompt }
          : prompt
        ))
        const serialised = serialiseList(updatedList)
        await buildImagePromptsDocx(serialised, episodeId, project.name || episodeId, writePath)
        _clearImagePromptsParseCache()
        const persisted = await parseImagePromptsDocx(resolveReadPath(promptsConstant))
        const persistedRow = persisted.thumbnails.find(prompt => prompt.number === number)
        if (!persistedRow) throw new Error(`${kind} ${number} was not present after regeneration was saved.`)
        return promptRowFingerprint(persistedRow.title, persistedRow.prompt)
      })
      if (!publication) {
        return res.status(409).json({ detail: 'This prompt changed while regeneration was running. The newer saved edit was kept.' })
      }
      await markPromptRegenerationPublished(actionPath, operationId, actionFingerprint, publication)

      res.json({ ...result, ...(action.result ? { reused: true } : {}) })
    } catch (e: any) {
      res.status(500).json({ detail: e?.message || 'Failed to regenerate prompt' })
    }
    })
  },
)

async function readPromptRegenerationActions(filePath: string): Promise<PromptRegenerationActions> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<PromptRegenerationActions>
    if (value.schema_version !== 1 || !value.actions || typeof value.actions !== 'object' || Array.isArray(value.actions)) {
      throw new Error('invalid prompt regeneration action record')
    }
    return value as PromptRegenerationActions
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1, actions: {} }
    throw error
  }
}

async function beginPromptRegenerationAction(
  filePath: string,
  operationId: string,
  fingerprint: string,
  sourceFingerprint: string,
): Promise<{
  result: PromptRegenerationResult | null
  sourceFingerprint: string
  publishedFingerprint?: string
} | 'mismatch' | 'stale'> {
  return withLock(filePath, async () => {
    const ledger = await readPromptRegenerationActions(filePath)
    const existing = ledger.actions[operationId]
    if (existing) {
      if (existing.fingerprint !== fingerprint) return 'mismatch'
      const resultMatchesCurrent = existing.status === 'completed' && existing.result
        ? promptRowFingerprint(existing.result.title, existing.result.prompt) === sourceFingerprint
        : false
      if (existing.source_fingerprint !== sourceFingerprint
        && existing.published_fingerprint !== sourceFingerprint
        && !resultMatchesCurrent) return 'stale'
      return {
        result: existing.status === 'completed' && existing.result ? existing.result : null,
        sourceFingerprint: existing.source_fingerprint,
        publishedFingerprint: existing.published_fingerprint,
      }
    }
    ledger.actions[operationId] = { fingerprint, source_fingerprint: sourceFingerprint, status: 'pending' }
    await writeJsonAtomic(filePath, ledger)
    return { result: null, sourceFingerprint, publishedFingerprint: undefined }
  })
}

async function markPromptRegenerationPublished(
  filePath: string,
  operationId: string,
  fingerprint: string,
  publishedFingerprint: string,
): Promise<void> {
  await withLock(filePath, async () => {
    const ledger = await readPromptRegenerationActions(filePath)
    const existing = ledger.actions[operationId]
    if (!existing || existing.fingerprint !== fingerprint || existing.status !== 'completed') {
      throw new Error('Prompt regeneration action changed while its document update was being saved.')
    }
    existing.published_fingerprint = publishedFingerprint
    await writeJsonAtomic(filePath, ledger)
  })
}

async function completePromptRegenerationAction(
  filePath: string,
  operationId: string,
  fingerprint: string,
  result: PromptRegenerationResult,
): Promise<void> {
  await withLock(filePath, async () => {
    const ledger = await readPromptRegenerationActions(filePath)
    const existing = ledger.actions[operationId]
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new Error('Prompt regeneration action changed while its result was being saved.')
    }
    ledger.actions[operationId] = {
      fingerprint,
      source_fingerprint: existing.source_fingerprint,
      status: 'completed',
      result,
    }
    await writeJsonAtomic(filePath, ledger)
  })
}

function promptRowFingerprint(title: string, prompt: string): string {
  return freshActionFingerprint({ title, prompt })
}

router.put(
  '/projects/:slug/episodes/:episodeId/image-prompts/item',
  validateBody(UpdatePromptSchema),
  async (req, res) => {
    const { slug, episodeId } = req.params
    const { kind, number, title, prompt } = req.body as z.infer<typeof UpdatePromptSchema>
    const titleParam = (req.query.title as string) || ''

    try {
      const project = await pm.getProject(slug)
      if (!project) return res.status(404).json({ detail: 'Project not found' })

      const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
      const promptsConstant = paths.thumb_prompts_docx
      const readPath = promptsConstant ? resolveReadPath(promptsConstant) : ''
      if (!readPath || !existsSync(readPath)) {
        return res.status(404).json({
          detail: `No ${kind} prompts on disk. Generate them on the Image Prompts page first.`,
        })
      }
      const writePath = toMdPath(promptsConstant)
      const parsed = await parseImagePromptsDocx(readPath)
      const list = parsed.thumbnails
      const targetIdx = list.findIndex(p => p.number === number)
      if (targetIdx < 0) {
        return res.status(404).json({
          detail: `${kind} ${number} not found in ${path.basename(readPath)}`,
        })
      }

      const updatedList = list.map((p, i) => (i === targetIdx
        ? { number, title, prompt }
        : p
      ))
      const serialised = serialiseList(updatedList)
      await buildImagePromptsDocx(serialised, episodeId, project.name || episodeId, writePath)
      _clearImagePromptsParseCache()

      res.json({ number, title, prompt })
    } catch (e: any) {
      res.status(500).json({ detail: e?.message || 'Failed to save prompt edits' })
    }
  },
)

// ── Helpers ───────────────────────────────────────────────────────────────

function extractStyleTag(prompt: string): string | null {
  // Bulk generator's contract: every prompt ends with the style_tag.
  // Heuristic: last sentence after the final period, or final newline-
  // separated chunk. Returns empty when nothing distinguishable found —
  // caller falls back to passing no explicit style.
  const trimmed = prompt.trim()
  if (!trimmed) return null
  const lastNewline = trimmed.split('\n').filter(l => l.trim()).pop() || ''
  const lastSentence = lastNewline.split(/(?<=[.!?])\s+/).pop() || lastNewline
  return lastSentence.trim() || null
}

function buildRegenPrompt(opts: {
  kind: 'thumbnail'
  number: number
  target: { number: number; title: string; prompt: string }
  peers: { number: number; title: string }[]
  windowed: string[]
  styleTag: string
  notes?: string
  headlineMode?: string
  /** Published image-model ceiling, or absent for "no limit in force". */
  promptCharCap?: number
  /**
   * User-invoked reword: adds the different-angle directive on top of the
   * standard difficult-subjects guidance. Only ever set from the explicit
   * "Reword" action — nothing infers it from a failure.
   */
  reword?: boolean
}): string {
  const kindLabel = opts.kind
  const peerList = opts.peers
    .map(p => `  ${p.number}. ${p.title}`)
    .join('\n')
  const windowed = opts.windowed.length
    ? `\n\nNeighbouring prompts for tone/voice consistency:\n\n${opts.windowed.join('\n\n')}`
    : ''
  const userNotes = opts.notes?.trim()
    ? `\n\nUser feedback for this retry:\n${opts.notes.trim()}`
    : ''
  // A ceiling layered on top of requirement 2's length guidance, never a
  // length to reach. Empty when no limit is in force.
  const charCapInstruction = buildPromptCharCapInstruction(opts.promptCharCap)
  const charCapRequirement = charCapInstruction ? `\n${charCapInstruction}` : ''
  const kindSpecific = `\n5. This is a THUMBNAIL brief, not a scene still. Make it feel like a professional YouTube cover: clear hero subject, emotional hook, negative space, title-safe composition, premium readability, and strong click appeal.\n6. If title text belongs in the image, explain how the composition, contrast, and lighting support it. If the current prompt implies a clean text-safe zone instead, preserve that deliberate layout.${headlineInvents(opts.headlineMode) ? '\n7. Keep the current title as the thumbnail’s short hook. Render that exact hook inside the image; do not replace it with the full episode title.' : ''}`

  return `Regenerate a single image ${kindLabel} prompt for an episode.

The ${kindLabel} being regenerated is #${opts.number} — "${opts.target.title}". Its current prompt is:

"${opts.target.prompt}"

Other ${kindLabel}s in this episode (titles only, for context):

${peerList}
${windowed}${userNotes}

REQUIREMENTS:
1. Produce ONE replacement prompt. Keep ${kindLabel} number ${opts.number} and its subject coherent with the title.
2. 60–120 words, 3–5 sentences. Cover: subject + action, setting + props, lighting + time of day, mood + atmosphere, framing/composition, character physical detail when present.
3. Match the visual voice of the surrounding ${kindLabel}s — same style language, same image quality.
4. End with this exact style tag: "${opts.styleTag || '(retain the style from the original prompt)'}"
${kindSpecific}
${headlineInvents(opts.headlineMode) ? '8' : '7'}. Do NOT change the ${kindLabel} number. Title may stay or be lightly improved.${charCapRequirement}

FORMAT — return ONLY a JSON object:
{ "title": "Brief Title", "prompt": "Full prompt text..." }
${imagePromptGuidanceBlock({ reword: opts.reword })}

No markdown, no code fences, no commentary.`
}

export function parseSinglePromptResponse(
  raw: string, fallback: { number: number; title: string; prompt: string },
): { title: string; prompt: string } {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n').trim()
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) {
    // Treat the whole response as the prompt body, keep the old title.
    return { title: fallback.title, prompt: text }
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      title: typeof obj?.title === 'string' && obj.title.trim() ? obj.title.trim() : fallback.title,
      prompt: typeof obj?.prompt === 'string' ? obj.prompt.trim() : '',
    }
  } catch {
    return { title: fallback.title, prompt: text }
  }
}

function serialiseList(
  list: { number: number; title: string; prompt: string }[],
): string {
  let out = `# Thumbnail Prompts\n\n`
  for (const p of list) {
    out += `## Thumbnail ${p.number}: ${p.title}\n\n${p.prompt}\n\n`
  }
  return out
}
