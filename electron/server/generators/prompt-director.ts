/**
 * Prompt Director (v1.0.260).
 *
 * Rewrites every scene's planner prompt into an explainer COMPOSITION — the
 * scene's actual subject framed as the centrepiece, with the guide character at
 * the side pointing at it, expression matched to the narration beat — following
 * the Visual Recipe saved in continuity.json.
 *
 * Non-destructive + idempotent: the planner's original prompt is preserved in
 * `visual_prompt_raw` and is ALWAYS the source the recipe composes from, so the
 * recipe can be re-applied (or the directive tweaked + re-run) without drift.
 * `visual_prompt` becomes the composed prompt the renderer uses; `emotion` is
 * the per-scene expression (auto-derived, or kept when the user locked it).
 *
 * The layout itself is anchored at render time by the composition template
 * image (img2img-references/composition.png); this pass writes the matching
 * prompt text so the two reinforce each other.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { callAi } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getCharacter } from '../services/character-manager.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { Job, ScenePlan, ScenePlanEntry, VisualRecipe } from '../models/types.js'

interface PromptDirectorParams {
  episode_id: string
  title?: string
  /** Text model used for the rewrite (anything callAi supports). */
  model: string
}

const BATCH_SIZE = 10

/** Strip markdown fences + isolate the outermost JSON object, then parse. */
function parseDirectorJson(raw: string): { scenes: Array<{ id: string; prompt?: string; emotion?: string }> } {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) s = s.slice(first, last + 1)
  const parsed = JSON.parse(s)
  const scenes = Array.isArray(parsed?.scenes) ? parsed.scenes : []
  return { scenes }
}

function buildSystemGuide(recipe: VisualRecipe, guideName: string): string {
  const directive = recipe.directive?.trim()
    || 'The subject sits inside a clean framed window (white/clean edges); the guide stands at the side and points toward it.'
  return `You are a visual-prompt compositor for an explainer-style video. The on-screen host is a recurring guide character named "${guideName}". You receive a list of scenes; each has a SUBJECT (what the image should depict) and the NARRATION it accompanies. Rewrite each scene's SUBJECT into ONE image-generation prompt that follows this composition recipe:

${directive}

Hard requirements for every rewritten prompt:
- The SUBJECT is the framed centrepiece of the image — the thing being talked about. Keep it faithful to the given SUBJECT; do NOT invent a different subject or drop it.
- ${guideName} appears toward one side as the guide, gesturing or pointing toward the framed subject (not blocking it).
- Give ${guideName} a facial expression + body language matching the emotional tone of THAT scene's narration. Use the provided "use_emotion" verbatim when present; otherwise choose a fitting emotion (e.g. curiosity, wonder, care, concern, awe, unease, delight).
- Concrete and descriptive — no vague filler like "an interesting image".
- Do not describe video transitions, multiple panels, or text overlays.

For each scene, also report the single short emotion word you used for ${guideName}.

Return ONLY a JSON object, no prose or markdown:
{"scenes":[{"id":"<scene id>","prompt":"<rewritten prompt>","emotion":"<emotion>"}]}`
}

function buildSystemScene(recipe: VisualRecipe): string {
  const directive = recipe.directive?.trim()
    || 'Frame each image with a clean white border. Render the scene\'s real subject in a consistent illustration style.'
  return `You are a visual-prompt compositor for an illustrated video. You receive a list of scenes; each has a SUBJECT (what the image should depict) and the NARRATION it accompanies. Rewrite each scene's SUBJECT into ONE image-generation prompt that follows this composition recipe:

${directive}

Hard requirements for every rewritten prompt:
- Depict the scene's REAL subject faithfully — the actual objects, animals, places, or actions the narration is about. Keep it faithful to the given SUBJECT; do NOT invent a different subject or drop it.
- Do NOT include any recurring, named, or consistent main character. There is no host or guide.
- Only include a person when the narration genuinely involves one — and then only as a PLAIN, ANONYMOUS, generic figure enacting the action (no name, no fixed identity). When the narration does not involve a person, include NO people at all — show only the relevant subject/environment.
- Apply the framing/border and art style from the recipe to every image.
- Concrete and descriptive — no vague filler like "an interesting image".
- Do not describe video transitions, multiple panels, or text overlays.

Return ONLY a JSON object, no prose or markdown:
{"scenes":[{"id":"<scene id>","prompt":"<rewritten prompt>"}]}`
}

function buildUser(batch: Array<{ id: string; subject: string; narration: string; use_emotion?: string }>): string {
  return `Rewrite these ${batch.length} scene(s). Return one object per id.\n\n` + JSON.stringify({ scenes: batch }, null, 2)
}

export async function runPromptDirectorJob(job: Job): Promise<void> {
  const params = job.params as PromptDirectorParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = path.join(paths.episode_dir, SCENE_PLAN_FILENAME)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan

  // Load the recipe from continuity.json.
  const continuityPath = path.join(paths.episode_dir, 'continuity.json')
  let recipe: VisualRecipe | undefined
  let anchorIds: string[] = []
  if (existsSync(continuityPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      recipe = raw?.recipe
      anchorIds = Array.isArray(raw?.anchor_character_ids) ? raw.anchor_character_ids : []
    } catch { /* fall through to the guard below */ }
  }
  if (!recipe?.enabled) {
    throw new Error('Visual Recipe is not enabled for this episode. Turn it on in the Character Sheet → Visual Recipe panel first.')
  }
  if (!recipe.directive?.trim()) {
    throw new Error('Visual Recipe has no directive. Describe the composition in the Character Sheet → Visual Recipe panel first.')
  }

  // v1.0.263 — two composition modes. 'scene' = no recurring character at all
  // (generic figures only when the narration has a person); 'guide' = the
  // explainer with a recurring side guide.
  const sceneMode = recipe.mode === 'scene'

  // Resolve the guide character's name (recipe pick → first anchor → fallback).
  // Only relevant in 'guide' mode.
  let guideName = 'the guide'
  if (!sceneMode) {
    const guideId = recipe.guide_character_id?.trim() || anchorIds[0] || ''
    if (guideId) {
      try {
        const ch = await getCharacter(job.project_slug, guideId)
        if ((ch as any)?.name) guideName = (ch as any).name
      } catch { /* keep fallback */ }
    }
  }

  // Pull candidate keys once; callAi picks the right one per call.
  const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])
  const apiKeys = { anthropic_api_key, openai_api_key, kie_api_key }

  const system = sceneMode ? buildSystemScene(recipe) : buildSystemGuide(recipe, guideName)

  // Work only on scenes with a real source prompt; placeholder/empty scenes are
  // left untouched. Source = visual_prompt_raw (preserved) ?? visual_prompt.
  const workable = plan.scenes.filter(s => (s.visual_prompt_raw ?? s.visual_prompt)?.trim())
  if (!workable.length) throw new Error('No scenes with prompts to compose.')

  job.output_lines.push(sceneMode
    ? `Applying Visual Recipe to ${workable.length} scene(s) — scene-accurate mode (no recurring character).`
    : `Applying Visual Recipe to ${workable.length} scene(s) — guide: ${guideName}, emotion: ${recipe.emotion_mode}.`)

  const byId = new Map<string, ScenePlanEntry>(plan.scenes.map(s => [s.id, s]))
  let composed = 0
  let failed = 0
  const totalBatches = Math.ceil(workable.length / BATCH_SIZE)

  for (let b = 0; b < totalBatches; b++) {
    const slice = workable.slice(b * BATCH_SIZE, b * BATCH_SIZE + BATCH_SIZE)
    // Decide the forced emotion (if any) per scene: a user-locked emotion wins,
    // then a recipe-level fixed emotion; otherwise the LLM chooses (auto).
    const batch = slice.map(s => {
      const forced = sceneMode
        ? undefined
        : (s.emotion_locked && s.emotion?.trim())
          ? s.emotion.trim()
          : (recipe!.emotion_mode === 'fixed' && recipe!.fixed_emotion.trim() ? recipe!.fixed_emotion.trim() : undefined)
      return {
        id: s.id,
        subject: (s.visual_prompt_raw ?? s.visual_prompt).trim(),
        narration: (s.transcript_segment || '').trim().slice(0, 600),
        ...(forced ? { use_emotion: forced } : {}),
      }
    })

    let parsed: ReturnType<typeof parseDirectorJson> | null = null
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !parsed; attempt++) {
      try {
        const raw = await callAi(model, system, buildUser(batch), apiKeys, false, {
          slug: job.project_slug, jobId: job.job_id, maxTokens: 16000,
        })
        parsed = parseDirectorJson(raw)
      } catch (e: any) {
        if (attempt >= MAX_ATTEMPTS) {
          job.output_lines.push(`⚠ Batch ${b + 1}/${totalBatches} failed (${e?.message || e}) — those scenes left unchanged.`)
        }
      }
    }

    if (parsed) {
      const results = new Map(parsed.scenes.map(r => [r.id, r]))
      for (const src of slice) {
        const r = results.get(src.id)
        const target = byId.get(src.id)
        if (!target) continue
        if (!r?.prompt?.trim()) { failed++; continue }
        // Preserve the planner's original as the raw source on first run.
        if (!target.visual_prompt_raw) target.visual_prompt_raw = target.visual_prompt
        target.visual_prompt = r.prompt.trim()
        // Scene mode has no character → no emotion. Guide mode: locked emotion
        // stays; fixed mode forces the recipe emotion; else take the LLM's choice.
        if (!sceneMode && !(target.emotion_locked && target.emotion?.trim())) {
          if (recipe!.emotion_mode === 'fixed' && recipe!.fixed_emotion.trim()) {
            target.emotion = recipe!.fixed_emotion.trim()
          } else if (r.emotion?.trim()) {
            target.emotion = r.emotion.trim()
          }
        }
        composed++
      }
    } else {
      failed += slice.length
    }

    job.progress = Math.round(((b + 1) / totalBatches) * 100)
    job.output_lines.push(`Batch ${b + 1}/${totalBatches} done — ${composed} composed so far.`)
  }

  await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8')
  job.progress = 100
  job.output_lines.push(
    `Visual Recipe applied: ${composed} scene(s) composed${failed ? `, ${failed} left unchanged` : ''}. Re-render to see the new layout.`,
  )
}
