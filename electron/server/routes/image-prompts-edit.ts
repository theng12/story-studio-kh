/**
 * Per-prompt Regenerate route for the Image Prompts page's review panel.
 *
 *   POST /api/projects/:slug/episodes/:episodeId/image-prompts/regenerate
 *     body: { kind: 'scene' | 'thumbnail', number, model?, style_tag? }
 *     200 : { number, title, prompt }
 *
 * Synchronous (no job queue) — single LLM call, ≤2s, fits the
 * click-and-wait UX on the Prompt Review panel. Reads the existing
 * scene_prompts.docx / thumbnail_prompts.docx, regenerates ONE entry
 * via callAi (passing the surrounding prompts as context so the new
 * one fits), and writes the docx back with the entry replaced.
 */

import path from 'path'
import { existsSync } from 'fs'
import { Router } from 'express'
import { z } from 'zod'
import { validateBody } from '../lib/validate.js'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveDefaultChatModel } from '../services/genstudio-default-model.js'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { resolveReadPath, toMdPath } from '../lib/episode-artifacts.js'
import { parseImagePromptsDocx, _clearImagePromptsParseCache } from '../lib/docx-parser.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { enforceThumbnailPromptElements } from '../generators/image-prompts.js'
import { buildPromptCharCapInstruction, parsePromptCharCap } from '../services/prompt-char-cap.js'
import { imagePromptGuidanceBlock } from '../lib/image-content-guidance.js'

export const router = Router()

const RegenerateSchema = z.object({
  kind: z.enum(['scene', 'thumbnail']),
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
  headline_mode: z.enum(['episode-title', 'curiosity-hook']).optional(),
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
  kind: z.enum(['scene', 'thumbnail']),
  number: z.number().int().min(1).max(999),
  title: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(10).max(12000),
})

router.post(
  '/projects/:slug/episodes/:episodeId/image-prompts/regenerate',
  validateBody(RegenerateSchema),
  async (req, res) => {
    const { slug, episodeId } = req.params
    const { kind, number } = req.body as { kind: 'scene' | 'thumbnail'; number: number }
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
        if (!apiKey) throw new Error('No scoped GenStudio API key configured. Add it in Settings → This Mac before regenerating a prompt.')
        const saved = typeof (config as any)?.prompt_model === 'string' ? (config as any).prompt_model : null
        return (await resolveDefaultChatModel(apiKey, saved)).modelId
      })()

      const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
      const promptsConstant = kind === 'scene' ? paths.scene_prompts_docx : paths.thumb_prompts_docx
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
      const list = kind === 'scene' ? parsed.scenes : parsed.thumbnails
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
        .map(p => `${kind === 'scene' ? 'Scene' : 'Thumbnail'} ${p.number}: ${p.prompt}`)

      const llmPrompt = buildRegenPrompt({
        kind,
        number,
        target: { ...target, title: currentTitle, prompt: currentPrompt },
        peers,
        windowed,
        styleTag,
        notes,
        headlineMode: req.body.headline_mode as 'episode-title' | 'curiosity-hook' | undefined,
        promptCharCap: parsePromptCharCap(req.body.prompt_char_cap),
        reword: req.body.reword === true,
      })

      const apiKeys = {
        anthropic_api_key: config.anthropic_api_key,
        openai_api_key: config.openai_api_key,
        kie_api_key: config.kie_api_key,
      }
      const raw = await callAiWithRetry(model, '', llmPrompt, apiKeys, false, { slug })
      const next = parseSinglePromptResponse(raw, target)
      if (!next.prompt || next.prompt.trim().length < 10) {
        return res.status(502).json({ detail: 'LLM returned an empty or too-short prompt' })
      }

      // Thumbnail prompts always keep the ratio and a ready-to-use in-image
      // title, exactly like the bulk generator.
      if (kind === 'thumbnail') {
        next.prompt = enforceThumbnailPromptElements(next.prompt, {
          aspectRatio: (req.body.aspect_ratio as string | undefined) || '16:9',
          title: req.body.headline_mode === 'curiosity-hook' ? next.title || currentTitle : titleParam || currentTitle,
          headlineMode: req.body.headline_mode as 'episode-title' | 'curiosity-hook' | undefined,
        })
      }

      // Replace the entry in-place. Title + prompt update; number stays.
      const updatedList = list.map((p, i) => (i === targetIdx
        ? { number: target.number, title: next.title || target.title, prompt: next.prompt }
        : p
      ))

      // Re-serialise to the same markdown format the bulk generator uses,
      // writing as .md (upgrades a legacy .docx-only episode on save).
      const serialised = serialiseList(kind, updatedList)
      await buildImagePromptsDocx(serialised, episodeId, project.name || episodeId, writePath)
      _clearImagePromptsParseCache()

      res.json({
        number: target.number,
        title: next.title || target.title,
        prompt: next.prompt,
})

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
      const promptsConstant = kind === 'scene' ? paths.scene_prompts_docx : paths.thumb_prompts_docx
      const readPath = promptsConstant ? resolveReadPath(promptsConstant) : ''
      if (!readPath || !existsSync(readPath)) {
        return res.status(404).json({
          detail: `No ${kind} prompts on disk. Generate them on the Image Prompts page first.`,
        })
      }
      const writePath = toMdPath(promptsConstant)
      const parsed = await parseImagePromptsDocx(readPath)
      const list = kind === 'scene' ? parsed.scenes : parsed.thumbnails
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
      const serialised = serialiseList(kind, updatedList)
      await buildImagePromptsDocx(serialised, episodeId, project.name || episodeId, writePath)
      _clearImagePromptsParseCache()

      res.json({ number, title, prompt })
    } catch (e: any) {
      res.status(500).json({ detail: e?.message || 'Failed to save prompt edits' })
    }
  },
)
    } catch (e: any) {
      res.status(500).json({ detail: e?.message || 'Failed to regenerate prompt' })
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
  kind: 'scene' | 'thumbnail'
  number: number
  target: { number: number; title: string; prompt: string }
  peers: { number: number; title: string }[]
  windowed: string[]
  styleTag: string
  notes?: string
  headlineMode?: 'episode-title' | 'curiosity-hook'
  /** Published image-model ceiling, or absent for "no limit in force". */
  promptCharCap?: number
  /**
   * User-invoked reword: adds the different-angle directive on top of the
   * standard difficult-subjects guidance. Only ever set from the explicit
   * "Reword" action — nothing infers it from a failure.
   */
  reword?: boolean
}): string {
  const kindLabel = opts.kind === 'scene' ? 'scene' : 'thumbnail'
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
  const kindSpecific = opts.kind === 'thumbnail'
    ? `\n5. This is a THUMBNAIL brief, not a scene still. Make it feel like a professional YouTube cover: clear hero subject, emotional hook, negative space, title-safe composition, premium readability, and strong click appeal.\n6. If title text belongs in the image, explain how the composition, contrast, and lighting support it. If the current prompt implies a clean text-safe zone instead, preserve that deliberate layout.${opts.headlineMode === 'curiosity-hook' ? '\n7. Keep the current title as a truthful 1–4 word thumbnail hook. Render that exact hook inside the image; do not replace it with the full episode title.' : ''}`
    : ''

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
${opts.kind === 'thumbnail' ? (opts.headlineMode === 'curiosity-hook' ? '8' : '7') : '5'}. Do NOT change the ${kindLabel} number. Title may stay or be lightly improved.${charCapRequirement}

FORMAT — return ONLY a JSON object:
{ "title": "Brief Title", "prompt": "Full prompt text..." }
${imagePromptGuidanceBlock({ reword: opts.reword })}

No markdown, no code fences, no commentary.`
}

function parseSinglePromptResponse(
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
  kind: 'scene' | 'thumbnail',
  list: { number: number; title: string; prompt: string }[],
): string {
  const header = kind === 'scene' ? '# Scene Prompts' : '# Thumbnail Prompts'
  const label = kind === 'scene' ? 'Scene' : 'Thumbnail'
  let out = `${header}\n\n`
  for (const p of list) {
    out += `## ${label} ${p.number}: ${p.title}\n\n${p.prompt}\n\n`
  }
  return out
}
