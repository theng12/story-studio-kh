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
 *
 * ── WHY THIS IS NOT PART OF `scene_plan_run` (asked 2026-08-26, answered here
 *    so it does not have to be re-derived) ────────────────────────────────────
 *
 * Both jobs are triggered from the Scene Plan page and both write
 * scene_plan.json, which makes "why aren't they one job?" the obvious question.
 * They are one artifact but not one stage, and the evidence says keep them apart:
 *
 *  - DIRECTION OF DEPENDENCE. This job REQUIRES a plan that already has visual
 *    prompts (see the two guards below). It cannot run first, and the planner
 *    cannot depend on it. It is a layer over the planner's output, which is how
 *    it was introduced: "a decoupled layer on top of the existing planner →
 *    render flow, so nothing about plain rendering changes when it's off".
 *
 *  - THE FIELD OVERLAP IS TINY. This job writes exactly three scene fields:
 *    visual_prompt, visual_prompt_raw, emotion — and no top-level ScenePlan
 *    field at all. The planner owns everything else (timings, transcript,
 *    motion_prompt, motion_mode, creative_strategy, scene_type, and every
 *    top-level field). They are not two features fighting over one document.
 *
 *  - RE-APPLYING WITHOUT RE-PLANNING IS THE POINT. The composition always comes
 *    from visual_prompt_raw, so the recipe is idempotent and revertible: tweak
 *    the directive, press it again, or revert to the planner's prompts. The
 *    button even relabels itself "↻ Re-apply recipe". Folding this into the
 *    planner would mean re-planning to re-compose, which is the one thing the
 *    design exists to avoid — and the planner's timeline stage discards composed
 *    prompts wholesale, so it is the destructive direction, not the cheap one.
 *
 *  - THE PRECONDITIONS ARE DISJOINT, NEITHER A SUBSET. This job needs
 *    continuity.json with recipe.enabled + a directive, and no subtitles and no
 *    GenStudio catalogue model. The planner needs a complete stitched subtitle
 *    timeline and a GenStudio model that can hold a JSON contract, and never
 *    reads `recipe` at all.
 *
 * MERGING WOULD ALSO NOT HAVE CLOSED THE RACE THIS COMMENT SITS BESIDE.
 * scene_plan.json has many writers, not two: five Scene Review routes, seven
 * Scene Plan routes and the revert-recipe route all read-modify-write it from
 * HTTP requests while any job is mid-flight. One merged job would still race
 * the Approve button. Mutual exclusion on the path is the fix; the job split is
 * a separate, and correct, design decision.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { callAi } from '../lib/ai-client.js'
import { isGenStudioInsufficientCredits } from '../lib/genstudio-client.js'
import { promptDirectorOutputContract } from '../lib/story-output-contracts.js'
import { imagePromptGuidanceBlock } from '../lib/image-content-guidance.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { getCharacter } from '../services/character-manager.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type { Job, ScenePlan, ScenePlanEntry, VisualRecipe } from '../models/types.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { isLocalTextModel } from '../services/job-retry-policy.js'
import { truncateChars } from '../lib/well-formed-text.js'

interface PromptDirectorParams {
  episode_id: string
  title?: string
  /** Text model used for the rewrite (anything callAi supports). */
  model: string
}

const BATCH_SIZE = 10

/** Strip markdown fences + isolate the outermost JSON object, then parse. */
export function parseDirectorJson(raw: string): { scenes: Array<{ id: string; prompt?: string; emotion?: string }> } {
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
{"scenes":[{"id":"<scene id>","prompt":"<rewritten prompt>","emotion":"<emotion>"}]}${imagePromptGuidanceBlock()}`
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
{"scenes":[{"id":"<scene id>","prompt":"<rewritten prompt>"}]}${imagePromptGuidanceBlock()}`
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
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
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
  /** Composed results awaiting the locked write. Keyed by stable scene id. */
  const composedById = new Map<string, { prompt: string; emotion?: string }>()
  let composed = 0
  let failed = 0
  const failedIds = new Set<string>()
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
        narration: truncateChars((s.transcript_segment || '').trim(), 600),
        ...(forced ? { use_emotion: forced } : {}),
      }
    })

    let parsed: ReturnType<typeof parseDirectorJson> | null = null
    const MAX_ATTEMPTS = isLocalTextModel(model) ? 2 : 1
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !parsed; attempt++) {
      try {
        const raw = await callAi(model, system, buildUser(batch), apiKeys, false, {
          // Maximum: a full batch of director JSON. Was a hardcoded 16,000,
          // which both ignored a larger product and hard-failed the
          // pre-network limit check on a product publishing less.
          slug: job.project_slug, jobId: job.job_id, outputBudget: 'maximum',
          // Parsed with JSON.parse and matched back by scene id, so JSON is
          // requested and the ids in this batch are named in the contract: an
          // invented id is a rewrite that silently lands nowhere.
          outputContract: promptDirectorOutputContract(batch.map(item => item.id)),
        })
        parsed = parseDirectorJson(raw)
      } catch (e: any) {
        if (isGenStudioInsufficientCredits(e)) throw e
        if (attempt >= MAX_ATTEMPTS) {
          job.output_lines.push(`⚠ Batch ${b + 1}/${totalBatches} failed (${e?.message || e}) — those scenes left unchanged.`)
        }
      }
    }

    if (parsed) {
      const results = new Map(parsed.scenes.map(r => [r.id, r]))
      for (const src of slice) {
        const r = results.get(src.id)
        if (!byId.has(src.id)) continue
        if (!r?.prompt?.trim()) { failed++; failedIds.add(src.id); continue }
        // Recorded, not applied. The plan read at the top of this job is minutes
        // stale by now, so the mutation is replayed against a fresh copy under
        // the lock below rather than written back from this snapshot.
        composedById.set(src.id, { prompt: r.prompt.trim(), emotion: r.emotion?.trim() || undefined })
      }
    } else {
      failed += slice.length
      for (const src of slice) failedIds.add(src.id)
    }

    job.progress = Math.round(((b + 1) / totalBatches) * 100)
    job.output_lines.push(`Batch ${b + 1}/${totalBatches} done — ${composedById.size} composed so far.`)
  }

  // ── The write is a locked replay, not a snapshot flush (v1.4.70) ────────
  //
  // `plan` above was read before the first LLM batch and is minutes old by the
  // time the last one returns. Writing it back whole would silently discard
  // every change any other writer made to this episode in that window — a
  // Scene Review approval, a rendered image's checkpoint, a Scene Plan repair.
  //
  // An atomic write does NOT prevent that. `writeJsonAtomic` only guarantees a
  // reader never sees half a file; the lost update here is a complete, valid
  // document that happens to be missing someone else's field. Mutual exclusion
  // is the separate property, and `withLock` is what supplies it — exactly as
  // services/scene-prompt-checkpoint.ts and services/scene-media-checkpoint.ts
  // already do against this same path.
  //
  // Re-reading INSIDE the lock is the load-bearing half. Locking only the write
  // would still persist the stale snapshot, just without a concurrent writer
  // interleaved into it.
  await withLock(planPath, async () => {
    const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    for (const [sceneId, result] of composedById) {
      const target = fresh.scenes.find(scene => scene.id === sceneId)
      // Deleted while this job was composing — same tolerance the pre-lock code
      // had for a scene missing from its snapshot.
      if (!target) continue
      // Preserve the planner's original as the raw source on first run.
      if (!target.visual_prompt_raw) target.visual_prompt_raw = target.visual_prompt
      target.visual_prompt = result.prompt
      // Scene mode has no character → no emotion. Guide mode: locked emotion
      // stays; fixed mode forces the recipe emotion; else take the LLM's choice.
      // Read from `fresh`, so an emotion the user locked mid-run is honoured.
      if (!sceneMode && !(target.emotion_locked && target.emotion?.trim())) {
        if (recipe!.emotion_mode === 'fixed' && recipe!.fixed_emotion.trim()) {
          target.emotion = recipe!.fixed_emotion.trim()
        } else if (result.emotion) {
          target.emotion = result.emotion
        }
      }
      composed++
    }
    await writeJsonAtomic(planPath, fresh)
  })
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Prompt Director', expected: workable.length, completed: workable.length - failedIds.size,
    missing: [...failedIds],
    retry_hint: 'Composed prompts were saved; Retry safely re-applies the recipe and repairs omitted scenes.',
  })
  job.output_lines.push(
    `Visual Recipe applied: ${composed} scene(s) composed${failed ? `, ${failed} left unchanged` : ''}. Re-render to see the new layout.`,
  )
}
