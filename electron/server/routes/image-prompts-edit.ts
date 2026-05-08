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
import { callAi } from '../lib/ai-client.js'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { parseImagePromptsDocx, _clearImagePromptsParseCache } from '../lib/docx-parser.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'

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
})

router.post(
  '/projects/:slug/episodes/:episodeId/image-prompts/regenerate',
  validateBody(RegenerateSchema),
  async (req, res) => {
    const { slug, episodeId } = req.params
    const { kind, number } = req.body as { kind: 'scene' | 'thumbnail'; number: number }
    const titleParam = (req.body.title as string | undefined) || (req.query.title as string) || ''
    const model = (req.body.model as string | undefined) || 'gpt-4o'

    try {
      const project = await pm.getProject(slug)
      if (!project) return res.status(404).json({ detail: 'Project not found' })
      const config = await pm.getConfig(slug)
      if (!config) return res.status(404).json({ detail: 'Project config not found' })

      const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
      const docxPath = kind === 'scene' ? paths.scene_prompts_docx : paths.thumb_prompts_docx
      if (!docxPath || !existsSync(docxPath)) {
        return res.status(404).json({
          detail: `No ${kind} prompts on disk. Generate them on the Image Prompts page first.`,
        })
      }

      // Parse the full prompt set so we can (a) find the target entry,
      // (b) thread surrounding prompts as context for cohesion, (c)
      // re-write the docx with the regenerated entry replacing the old.
      const parsed = await parseImagePromptsDocx(docxPath)
      const list = kind === 'scene' ? parsed.scenes : parsed.thumbnails
      const targetIdx = list.findIndex(p => p.number === number)
      if (targetIdx < 0) {
        return res.status(404).json({
          detail: `${kind} ${number} not found in ${path.basename(docxPath)}`,
        })
      }
      const target = list[targetIdx]!

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
        kind, number, target, peers, windowed, styleTag,
      })

      const apiKeys = {
        anthropic_api_key: config.anthropic_api_key,
        openai_api_key: config.openai_api_key,
        kie_api_key: config.kie_api_key,
      }
      const raw = await callAi(model, '', llmPrompt, apiKeys, false, { slug })
      const next = parseSinglePromptResponse(raw, target)
      if (!next.prompt || next.prompt.trim().length < 10) {
        return res.status(502).json({ detail: 'LLM returned an empty or too-short prompt' })
      }

      // Replace the entry in-place. Title + prompt update; number stays.
      const updatedList = list.map((p, i) => (i === targetIdx
        ? { number: target.number, title: next.title || target.title, prompt: next.prompt }
        : p
      ))

      // Re-serialise to the same docx format the bulk generator uses.
      const serialised = serialiseList(kind, updatedList)
      await buildImagePromptsDocx(serialised, episodeId, project.name || episodeId, docxPath)
      _clearImagePromptsParseCache()

      res.json({
        number: target.number,
        title: next.title || target.title,
        prompt: next.prompt,
      })
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
}): string {
  const kindLabel = opts.kind === 'scene' ? 'scene' : 'thumbnail'
  const peerList = opts.peers
    .map(p => `  ${p.number}. ${p.title}`)
    .join('\n')
  const windowed = opts.windowed.length
    ? `\n\nNeighbouring prompts for tone/voice consistency:\n\n${opts.windowed.join('\n\n')}`
    : ''

  return `Regenerate a single image ${kindLabel} prompt for an episode.

The ${kindLabel} being regenerated is #${opts.number} — "${opts.target.title}". Its current prompt is:

"${opts.target.prompt}"

Other ${kindLabel}s in this episode (titles only, for context):

${peerList}
${windowed}

REQUIREMENTS:
1. Produce ONE replacement prompt. Keep ${kindLabel} number ${opts.number} and its subject coherent with the title.
2. 60–120 words, 3–5 sentences. Cover: subject + action, setting + props, lighting + time of day, mood + atmosphere, framing/composition, character physical detail when present.
3. Match the visual voice of the surrounding ${kindLabel}s — same style language, same image quality.
4. End with this exact style tag: "${opts.styleTag || '(retain the style from the original prompt)'}"
5. Do NOT change the ${kindLabel} number. Title may stay or be lightly improved.

FORMAT — return ONLY a JSON object:
{ "title": "Brief Title", "prompt": "Full prompt text..." }

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
