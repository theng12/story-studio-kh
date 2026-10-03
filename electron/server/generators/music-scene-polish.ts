/**
 * Episode Builder "Polish Scene Prompts" (SPEC §5: "optionally polished by the same picked writing
 * model"). One call to the writing model the owner picked at the click rewrites the chosen scenes'
 * picture prompts; each result is saved as that scene's own prompt (the same field the owner edits
 * by hand), so Reset still returns it to the song's scene idea. Nothing is drawn here.
 */

import * as jq from '../services/job-queue.js'
import { callAiWithRetry } from '../lib/ai-client.js'
import { parseJsonOutput, type TextOutputContract } from '../lib/json-output-contract.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  buildEpisodeView,
  loadEpisodeContext,
  readEpisodeDoc,
  saveEpisodeDoc,
} from '../services/music-episode-store.js'
import type { Job } from '../models/types.js'

export const POLISHED_PROMPT_MAX_CHARS = 2000

export function scenePolishOutputContract(ids: readonly string[]): TextOutputContract {
  return {
    mode: 'json_object',
    name: 'music_scene_prompts',
    schema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          minItems: ids.length,
          maxItems: ids.length,
          items: {
            type: 'object',
            properties: { id: { type: 'string', enum: [...ids] }, prompt: { type: 'string', minLength: 1, maxLength: POLISHED_PROMPT_MAX_CHARS } },
            required: ['id', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['scenes'],
      additionalProperties: false,
    },
  }
}

export function buildScenePolishPrompt(input: {
  theme: string
  style: string
  never: string[]
  scenes: Array<{ id: string; prompt: string; songs: string[] }>
}): string {
  return [
    'You polish picture prompts for an instrumental music video. Each scene is one still picture shown while its songs play;',
    'a text-to-image model (Z-Image / FLUX) draws it at 1280x720 and a slow camera drift moves over it.',
    '',
    'Rewrite each prompt so it is vivid, concrete and paintable: one place, its light, weather, season, colours and one focal point.',
    'Keep the original idea and mood. One or two sentences, under 400 characters. Keep "no people, no text" (no figures, no lettering, no logos).',
    input.theme ? `Episode theme: ${input.theme}.` : '',
    input.style ? `Channel visual style (keep consistent across scenes): ${input.style}` : '',
    input.never.length ? `Never include: ${input.never.join(', ')}.` : '',
    '',
    'Scenes (id, songs, current prompt):',
    ...input.scenes.map(scene => `- ${scene.id} [${scene.songs.join(' · ')}]: ${scene.prompt}`),
    '',
    'Return only JSON: {"scenes":[{"id":"<id>","prompt":"<polished prompt>"}]} with every id exactly once.',
  ].join('\n')
}

/** Keep only answers for asked-for ids with real text; everything else is reported missing. */
export function parseScenePolish(raw: string, ids: readonly string[]): { prompts: Record<string, string>; missing: string[] } {
  const parsed = parseJsonOutput(raw) as { scenes?: Array<{ id?: unknown; prompt?: unknown }> } | null
  const prompts: Record<string, string> = {}
  for (const row of Array.isArray(parsed?.scenes) ? parsed!.scenes! : []) {
    const id = typeof row?.id === 'string' ? row.id : ''
    const text = typeof row?.prompt === 'string' ? row.prompt.replace(/\s+/g, ' ').trim().slice(0, POLISHED_PROMPT_MAX_CHARS) : ''
    if (ids.includes(id) && text && !prompts[id]) prompts[id] = text
  }
  return { prompts, missing: ids.filter(id => !prompts[id]) }
}

export async function generateMusicScenePolish(job: Job): Promise<void> {
  const slug = job.project_slug
  const code = String(job.params?.episode_id || job.episode_id || '').toUpperCase()
  const model = typeof job.params?.model === 'string' ? job.params.model.trim() : ''
  if (!model) throw new Error('No writing model was picked. Pick one on Episode Builder and press Polish again.')
  const doc = await readEpisodeDoc(slug, code)
  if (!doc?.songs.length) throw new Error(`${code} has no songs. Draw songs in Episode Builder first.`)
  const view = await buildEpisodeView(slug, code)
  const wanted: string[] = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length ? job.params.scene_ids : view.scenes.map(s => s.id)
  const scenes = view.scenes.filter(scene => wanted.includes(scene.id))
  if (!scenes.length) throw new Error('None of those scenes are in this episode any more. Reload Episode Builder.')
  const titleOf = new Map(view.songs.map(song => [song.song_key, song.title]))
  const { getEffectiveNiche } = await import('../services/niche-loader.js')
  const niche = await getEffectiveNiche(slug).catch(() => null) as { musicFormat?: { songFormula?: { never?: unknown } } } | null
  const never = Array.isArray(niche?.musicFormat?.songFormula?.never)
    ? (niche!.musicFormat!.songFormula!.never as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const ids = scenes.map(scene => scene.id)
  const prompt = buildScenePolishPrompt({
    theme: doc.settings.theme,
    style: view.visual_style,
    never,
    scenes: scenes.map(scene => ({ id: scene.id, prompt: scene.prompt, songs: scene.song_keys.map(k => titleOf.get(k) || k) })),
  })
  job.output_lines.push(`Polishing ${scenes.length} scene prompt(s) with ${model}. Nothing is drawn; review them, then make the pictures.`)
  job.progress = 10

  const controller = new AbortController()
  const watcher = setInterval(() => { if (jq.isCancelled(job.job_id)) controller.abort() }, 500)
  let raw: string
  try {
    raw = await callAiWithRetry(model, '', prompt, {}, false, {
      slug,
      jobId: job.job_id,
      signal: controller.signal,
      outputContract: scenePolishOutputContract(ids),
      outputBudget: 'standard',
      temperature: 0.6,
    })
  } finally {
    clearInterval(watcher)
  }
  job.progress = 80
  const { prompts, missing } = parseScenePolish(raw, ids)
  // Save what came back; the rest keeps its current prompt.
  const fresh = await readEpisodeDoc(slug, code)
  if (!fresh) throw new Error(`${code}'s Episode Builder plan disappeared while polishing. Nothing was saved.`)
  const ctx = await loadEpisodeContext(slug, code, fresh.settings)
  await saveEpisodeDoc(slug, { ...fresh, prompt_overrides: { ...fresh.prompt_overrides, ...prompts } }, ctx.byKey)
  job.result = { polished: Object.keys(prompts).length, missing }
  job.progress = 100
  job.output_lines.push(`Saved ${Object.keys(prompts).length} polished prompt(s). Reset on a scene returns it to the song's scene idea.`)
  requireJobCompletion(job, {
    label: 'Scene prompt polish',
    expected: ids.length,
    completed: ids.length - missing.length,
    missing: missing.map(id => `scene ${scenes.find(s => s.id === id)?.scene_index ?? id}`),
    retry_hint: 'The polished prompts were saved. Open each scene listed in Episode Builder and press Polish This Scene; the others keep their new prompts.',
  })
}
