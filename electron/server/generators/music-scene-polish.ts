/**
 * Episode Builder "Polish Scene Prompts" (SPEC §5: "optionally polished by the same picked writing
 * model"). One call to the writing model the owner picked at the click rewrites the chosen scenes'
 * picture prompts; each result is saved as that scene's own prompt (the same field the owner edits
 * by hand), so Reset still returns it to the song's scene idea. Nothing is drawn here.
 *
 * THE RUN KEEPS ITS OWN RECORD (next348). A polish is a PAID request, and the state that decides
 * whether this run already happened is not on the episode document — that document holds the
 * prompt the owner edits by hand and the prompt an earlier polish left behind, so "the document is
 * fresh and its prompts are not empty" proves nothing about THIS run (review, 2026-10-22: an old
 * override plus an unrelated fresh save, and a partial save made before `job.result` was written,
 * both read as complete).
 *
 * So the run writes one snapshot into its OWN job record (`params.music_scene_polish`) and moves it
 * forward with the queue's durable checkpoint:
 *
 *  - prepared  — before the request: the model, the system and user message, the temperature, the
 *                output budget, the output contract, the request identity and the scenes asked
 *                for. Every one of those is a digest input of the Gateway request, so a later
 *                attempt can rebuild THE SAME request instead of a changed one.
 *  - key      — the idempotency key the client prepared (`onRequestPrepared`, which fires BEFORE
 *                the POST, so it is not proof of an accepted request) and, separately, the key the
 *                Gateway accepted (`onJobAccepted`).
 *  - answered — after the answer, BEFORE the document save: the exact prompt this run produced for
 *                each scene, and the scenes it missed.
 *
 * That order is what makes an interrupted run safe. A run interrupted between saving the document
 * and recording its result finds its own answer in the record and finishes WITHOUT asking again:
 * the same scenes are not polished twice, and the Gateway is not charged twice. A run interrupted
 * before the answer reattaches to the request it made, by the key it prepared, under the same
 * digest — the client's own recovery, not a new submission of changed input.
 *
 * A run whose record cannot be read REFUSES (it does not start over), and a run that kept no
 * record at all but already announced a polish refuses too — re-polishing on changed input is
 * exactly the repeat work this record exists to prevent.
 */

import { createHash } from 'node:crypto'
import * as jq from '../services/job-queue.js'
import { callAiWithRetry } from '../lib/ai-client.js'
import { parseJsonOutput, type TextOutputContract } from '../lib/json-output-contract.js'
import { requireJobCompletion } from '../services/job-completion.js'
import type { GenStudioRequestPreview } from '../lib/genstudio-request-preview.js'
import { nonRetryable } from '../services/job-retry-policy.js'
import type { OutputBudgetTier } from '../services/output-token-budget.js'
import {
  buildEpisodeView,
  musicScenePolishRunId,
  readEpisodeDoc,
  readMusicScenePolishRun,
  updateEpisodeDoc,
  writeMusicScenePolishRun,
  type MusicScenePolishRunArtifact,
} from '../services/music-episode-store.js'
import { SCENE_TITLE_RULE } from '../services/music-episode.js'
import {
  MUSIC_SCENE_POLISH_SNAPSHOT_KEY,
  readMusicScenePolishSnapshot,
  sameText,
  scenePolishInputFingerprint,
  validateMusicScenePolishArtifact,
  type MusicScenePolishParamsRef,
} from '../services/text-completion.js'
import type { Job } from '../models/types.js'

export const POLISHED_PROMPT_MAX_CHARS = 2000

/** The temperature this run sends. Part of the request's digest, so it is recorded with it. */
const POLISH_TEMPERATURE = 0.6
/** The output budget tier this run sends. Part of the request's digest. */
const POLISH_OUTPUT_BUDGET = 'standard'

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
    // WHAT THIS WORKFLOW CAN SAFELY USE — not what it asks for.
    //
    // Each scene's prompt is an independent item: a scene the model did not
    // answer must not throw away the answers it did give. The strict shape
    // above is what the request ASKS for; this looser one is what the run can
    // USE, and the run checks every scene itself — `parseScenePolish` keeps
    // the answers that arrived, names the scenes that did not, and the run
    // fails loudly with the missing ones while the polished prompts it DID
    // get stay on the episode. Without this, one missing scene would cost the
    // whole episode its polish.
    accept: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 } },
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
  /** Set per scene when its picture shows the song's title (title on scene, one-song scenes). */
  scenes: Array<{ id: string; prompt: string; songs: string[]; title?: string }>
}): string {
  const titled = input.scenes.some(scene => scene.title)
  return [
    'You polish picture prompts for an instrumental music video. Each scene is one still picture shown while its songs play;',
    'a text-to-image model (Z-Image / FLUX) draws it at 1280x720 and a slow camera drift moves over it.',
    '',
    'Rewrite each prompt so it is vivid, concrete and paintable: one place, its light, weather, season, colours and one focal point.',
    titled
      ? 'Keep the original idea and mood. One or two sentences, under 400 characters. Keep "no people" (no figures). '
        + `A scene marked "title on picture" shows ${SCENE_TITLE_RULE}: keep the sign it already has, keep the title quoted exactly, never small, distant or decorative. `
        + 'Other scenes keep "no text" (no lettering, no logos).'
      : 'Keep the original idea and mood. One or two sentences, under 400 characters. Keep "no people, no text" (no figures, no lettering, no logos).',
    input.theme ? `Episode theme: ${input.theme}.` : '',
    input.style ? `Channel visual style (keep consistent across scenes): ${input.style}` : '',
    input.never.length ? `Never include: ${input.never.join(', ')}.` : '',
    '',
    'Scenes (id, songs, current prompt):',
    ...input.scenes.map(scene => `- ${scene.id} [${scene.songs.join(' · ')}]${scene.title ? ` (title on picture: "${scene.title}")` : ''}: ${scene.prompt}`),
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

export { scenePolishInputFingerprint } from '../services/text-completion.js'

/**
 * How to get the answer of the request this run already made.
 *
 * A key means the request was already prepared for the Gateway, so the answer
 * is COLLECTED under that key instead of a new request being sent. No key
 * means the POST never happened (the prepared checkpoint is written before
 * the POST, and a failed checkpoint write aborts the request), so a first
 * submission of the recorded body is safe.
 */
export function scenePolishRecoveryOptions(snapshot: { accepted_key?: string; prepared_key?: string }): {
  recoverByIdempotencyKey?: boolean
  idempotencyKey?: string
  allowedRecoveryKeys?: string[]
} {
  const key = (snapshot.accepted_key || snapshot.prepared_key || '').trim()
  if (!key) return {}
  return { recoverByIdempotencyKey: true, idempotencyKey: key, allowedRecoveryKeys: [key] }
}

/**
 * What may be written for one scene.
 *
 * `restore` — the document still holds exactly the prompt this run started
 * from, so this run's answer is what belongs there.
 * `skip` — the document already holds this run's answer.
 * `conflict` — the document holds something else, which means the owner (or
 * another run) changed it after this run started. This run does NOT overwrite
 * that; the owner decides.
 */
export type ScenePolishRestore =
  | { action: 'skip' }
  | { action: 'restore'; scene_id: string; prompt: string }
  | { action: 'conflict'; scene_id: string; saved: string }

export function decideScenePolishRestore(input: {
  sceneId: string
  produced: string
  savedNow: string
  startedFrom: string
}): ScenePolishRestore {
  if (sameText(input.savedNow, input.produced)) return { action: 'skip' }
  if (sameText(input.savedNow, input.startedFrom)) {
    return { action: 'restore', scene_id: input.sceneId, prompt: input.produced }
  }
  return { action: 'conflict', scene_id: input.sceneId, saved: input.savedNow }
}

async function checkpointMusicScenePolish(job: Job, ref: MusicScenePolishParamsRef): Promise<void> {
  job.params = { ...(job.params || {}), [MUSIC_SCENE_POLISH_SNAPSHOT_KEY]: ref }
  await jq.checkpointJobState(job)
}

function outputDigests(outputs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(outputs).map(([id, text]) => [id, createHash('sha256').update(text).digest('hex')]))
}

function retryPredecessor(job: Job): { job_id: string; run_id: string } | null {
  const value = job.params?.music_scene_polish_retry_of
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const jobId = typeof value.job_id === 'string' ? value.job_id : ''
  const runId = typeof value.run_id === 'string' ? value.run_id : ''
  return jobId && /^[0-9a-f]{32}$/.test(runId) ? { job_id: jobId, run_id: runId } : null
}

/** The request this run is about to make, built from the episode as it is now. */
interface MusicScenePolishRequest {
  model: string
  system: string
  userMessage: string
  sceneIds: string[]
  contract: TextOutputContract
  inputPrompts: Record<string, string>
}

async function buildMusicScenePolishRequest(
  job: Job,
  slug: string,
  code: string,
  model: string,
): Promise<MusicScenePolishRequest> {
  const doc = await readEpisodeDoc(slug, code)
  if (!doc?.songs.length) throw new Error(`${code} has no songs. Draw songs in Episode Builder first.`)
  const view = await buildEpisodeView(slug, code)
  const requested: string[] = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? job.params.scene_ids
    : view.scenes.map(s => s.id)
  const available = new Set(view.scenes.map(scene => scene.id))
  const absent = requested.filter(id => !available.has(id))
  if (absent.length) {
    throw nonRetryable(new Error(`Requested scene ${absent.join(', ')} is no longer in ${code}. Reload Episode Builder and choose its current scenes.`))
  }
  const wanted = new Set(requested)
  const scenes = view.scenes.filter(scene => wanted.has(scene.id))
  if (!scenes.length) throw new Error('None of those scenes are in this episode any more. Reload Episode Builder.')
  const titleOf = new Map(view.songs.map(song => [song.song_key, song.title]))
  const { getEffectiveNiche } = await import('../services/niche-loader.js')
  const niche = await getEffectiveNiche(slug).catch(() => null) as { musicFormat?: { songFormula?: { never?: unknown } } } | null
  const never = Array.isArray(niche?.musicFormat?.songFormula?.never)
    ? (niche!.musicFormat!.songFormula!.never as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const ids = scenes.map(scene => scene.id)
  return {
    model,
    system: '',
    userMessage: buildScenePolishPrompt({
      theme: doc.settings.theme,
      style: view.visual_style,
      never,
      scenes: scenes.map(scene => {
        const title = doc.settings.scenes.title_on_scene && scene.title_on_scene ? titleOf.get(scene.song_keys[0]!) : undefined
        return { id: scene.id, prompt: scene.prompt, songs: scene.song_keys.map(k => titleOf.get(k) || k), ...(title ? { title } : {}) }
      }),
    }),
    sceneIds: ids,
    contract: scenePolishOutputContract(ids),
    // The document's OWN prompt for each scene (empty when it has none). This
    // is what the scene held before this run, and it is what a later restore
    // is allowed to replace — nothing else.
    inputPrompts: Object.fromEntries(ids.map(id => [id, String(doc.prompt_overrides[id] ?? '')])),
  }
}

/**
 * Put this run's answers on the document and declare what the run produced.
 *
 * It is called with the run's own record, so it is the same code whether the
 * answer arrived just now or was recovered from the record after an
 * interruption. Nothing is requested here, ever.
 */
async function finishMusicScenePolish(
  job: Job,
  slug: string,
  code: string,
  artifact: MusicScenePolishRunArtifact,
  recovered: boolean,
): Promise<void> {
  const missing = Array.isArray(artifact.missing) ? artifact.missing : []
  const conflicts = await updateEpisodeDoc(slug, code, doc => {
    const overrides = { ...(doc.prompt_overrides || {}) }
    const found: string[] = []
    for (const id of artifact.scene_ids) {
      if (missing.includes(id)) continue
      const produced = String(artifact.outputs?.[id] ?? '')
      if (!produced) continue
      const decision = decideScenePolishRestore({
        sceneId: id,
        produced,
        savedNow: String(overrides[id] ?? ''),
        startedFrom: String(artifact.baseline_prompts[id] ?? ''),
      })
      if (decision.action === 'restore') overrides[id] = decision.prompt
      else if (decision.action === 'conflict') found.push(id)
    }
    return { doc: { ...doc, prompt_overrides: overrides }, result: found }
  })
  const outputs = artifact.outputs || {}
  const view = await buildEpisodeView(slug, code).catch(() => null)
  const label = (id: string) => {
    const scene = view?.scenes.find(value => value.id === id)
    return scene ? `scene ${scene.scene_index}` : `scene ${id}`
  }
  const allMissing = [...new Set([...missing, ...conflicts])]
  job.result = { polished: Object.keys(outputs).length, missing: allMissing }
  job.progress = 100
  job.output_lines.push(recovered
    ? 'Recovered this run\'s own polished prompts from its record; no new request was sent.'
    : `Saved ${Object.keys(outputs).length} polished prompt(s). Reset on a scene returns to the song's scene idea.`)
  const audit = {
    label: 'Scene prompt polish',
    expected: artifact.scene_ids.length,
    completed: artifact.scene_ids.length - allMissing.length,
    missing: allMissing.map(label),
    retry_hint: 'The saved prompts are preserved. Review any changed scenes in Episode Builder, then press Polish This Scene for each missing scene.',
  }
  if (conflicts.length) {
    try { requireJobCompletion(job, audit) } catch (error) {
      throw nonRetryable(new Error(
        `The prompt saved for ${conflicts.map(label).join(', ')} changed after this run started. The other polished prompts were saved. `
        + `Polish the conflicting scene(s) again in Episode Builder. ${error instanceof Error ? error.message : String(error)}`
      ))
    }
  }
  requireJobCompletion(job, audit)
}

function refFromArtifact(artifact: MusicScenePolishRunArtifact): MusicScenePolishParamsRef {
  return {
    version: 2,
    run_id: artifact.run_id,
    project_slug: artifact.project_slug,
    episode_code: artifact.episode_code,
    scene_ids: [...artifact.scene_ids],
    input_fingerprint: artifact.input_fingerprint,
    owner_job_id: artifact.owner_job_id,
    ...(artifact.predecessor_job_id ? { retry_of: { job_id: artifact.predecessor_job_id, run_id: artifact.run_id } } : {}),
    ...(artifact.prepared_key ? { prepared_key: artifact.prepared_key } : {}),
    ...(artifact.accepted_key ? { accepted_key: artifact.accepted_key } : {}),
    ...(artifact.accepted_job_id ? { accepted_job_id: artifact.accepted_job_id } : {}),
    ...(artifact.outputs ? { output_digests: outputDigests(artifact.outputs) } : {}),
    ...(artifact.missing ? { missing: [...artifact.missing] } : {}),
    ...(artifact.outputs_recorded_at ? { outputs_recorded_at: artifact.outputs_recorded_at } : {}),
  }
}

export async function generateMusicScenePolish(job: Job): Promise<void> {
  const slug = job.project_slug
  const code = String(job.params?.episode_id || job.episode_id || '').toUpperCase()
  const read = readMusicScenePolishSnapshot(job)
  if (read.state === 'invalid') {
    throw nonRetryable(new Error(`This run reference cannot be trusted (${read.reason}). Nothing was submitted. Start a new Polish run in Episode Builder.`))
  }
  let artifact: MusicScenePolishRunArtifact
  if (read.state === 'valid') {
    const ref = read.ref
    if (ref.project_slug !== slug || ref.episode_code.toUpperCase() !== code) {
      throw nonRetryable(new Error('This run reference belongs to a different project or episode. Nothing was submitted.'))
    }
    const loaded = await readMusicScenePolishRun(slug, code, ref.run_id)
    if (!loaded) throw nonRetryable(new Error("This run's sidecar is missing or malformed. Nothing was submitted. Start a new Polish run."))
    const reason = validateMusicScenePolishArtifact({ artifact: loaded, ref, jobId: job.job_id, retryOf: retryPredecessor(job) })
    if (reason) throw nonRetryable(new Error(`This run's sidecar cannot be trusted (${reason}). Nothing was submitted.`))
    artifact = loaded
    if (artifact.owner_job_id !== job.job_id) {
      const retryOf = retryPredecessor(job)
      if (!retryOf || retryOf.job_id !== artifact.owner_job_id || retryOf.run_id !== artifact.run_id) {
        throw nonRetryable(new Error('This run is not owned by this job or its queue-stamped predecessor. Nothing was submitted.'))
      }
      artifact = { ...artifact, predecessor_job_id: artifact.owner_job_id, owner_job_id: job.job_id }
      await writeMusicScenePolishRun(slug, code, artifact)
      await checkpointMusicScenePolish(job, refFromArtifact(artifact))
    }
  } else {
    const model = typeof job.params?.model === 'string' ? job.params.model.trim() : ''
    if (!model) throw new Error('No writing model was picked. Pick one on Episode Builder and press Polish again.')
    const request = await buildMusicScenePolishRequest(job, slug, code, model)
    const runId = musicScenePolishRunId(slug, code, job.job_id)
    artifact = {
      version: 2,
      run_id: runId,
      project_slug: slug,
      episode_code: code,
      owner_job_id: job.job_id,
      scene_ids: request.sceneIds,
      request: {
        model: request.model,
        system: '',
        user_message: request.userMessage,
        temperature: POLISH_TEMPERATURE,
        output_budget: POLISH_OUTPUT_BUDGET,
        output_contract: request.contract,
        request_identity: slug,
      },
      input_fingerprint: scenePolishInputFingerprint({
        model: request.model,
        system: '',
        userMessage: request.userMessage,
        temperature: POLISH_TEMPERATURE,
        outputBudget: POLISH_OUTPUT_BUDGET,
        outputContract: request.contract,
        requestIdentity: slug,
        sceneIds: request.sceneIds,
        baselinePrompts: request.inputPrompts,
      }),
      baseline_prompts: request.inputPrompts,
    }
    await writeMusicScenePolishRun(slug, code, artifact)
    await checkpointMusicScenePolish(job, refFromArtifact(artifact))
  }
  if (artifact.outputs) {
    await finishMusicScenePolish(job, slug, code, artifact, true)
    return
  }
  job.output_lines.push(`Polishing ${artifact.scene_ids.length} scene prompt(s) with ${artifact.request.model}. Nothing is drawn; review them, then make the pictures.`)
  job.progress = 10
  const controller = new AbortController()
  const watcher = setInterval(() => { if (jq.isCancelled(job.job_id)) controller.abort() }, 500)
  let raw: string
  try {
    const key = artifact.prepared_key || ''
    raw = await callAiWithRetry(artifact.request.model, artifact.request.system, artifact.request.user_message, {}, false, {
      slug,
      jobId: job.job_id,
      signal: controller.signal,
      outputContract: artifact.request.output_contract as TextOutputContract,
      outputBudget: artifact.request.output_budget as OutputBudgetTier,
      temperature: artifact.request.temperature,
      requestIdentity: artifact.request.request_identity,
      ...(key ? {
        recoverByIdempotencyKey: !artifact.request_preview,
        allowUncreatedRecovery: !!artifact.request_preview,
        ...(artifact.request_preview ? { recoveryRequestPreview: artifact.request_preview as any } : {}),
        idempotencyKey: key,
        allowedRecoveryKeys: [key],
      } : {}),
      onRequestPrepared: async (idempotencyKey: string, preview?: GenStudioRequestPreview) => {
        artifact = { ...artifact, prepared_key: idempotencyKey, ...(preview ? { request_preview: preview } : {}) }
        await writeMusicScenePolishRun(slug, code, artifact)
        await checkpointMusicScenePolish(job, refFromArtifact(artifact))
      },
      onJobAccepted: async (gatewayJobId: string, idempotencyKey: string) => {
        artifact = { ...artifact, accepted_key: idempotencyKey, accepted_job_id: gatewayJobId }
        await writeMusicScenePolishRun(slug, code, artifact)
        await checkpointMusicScenePolish(job, refFromArtifact(artifact))
      },
    })
  } finally {
    clearInterval(watcher)
  }
  job.progress = 80
  const { prompts, missing } = parseScenePolish(raw, artifact.scene_ids)
  artifact = { ...artifact, outputs: prompts, missing, outputs_recorded_at: new Date().toISOString() }
  await writeMusicScenePolishRun(slug, code, artifact)
  await checkpointMusicScenePolish(job, refFromArtifact(artifact))
  await finishMusicScenePolish(job, slug, code, artifact, false)
}
