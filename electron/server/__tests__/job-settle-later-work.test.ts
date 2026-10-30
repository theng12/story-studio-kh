/**
 * A failed row whose work a LATER run made must stop asking for attention.
 *
 * Production, 2026-10-29: four `still_post_render` rows on little-weather-within
 * (6da4810d, 18663004, 0faf7acd, fcaeb3e5) had their artwork and finals produced
 * by later runs, and `POST /projects/little-weather-within/jobs/settle-completed`
 * resolved none of them — those types had no settle path at all. Scene Plan and
 * motion batch failures had the same shape.
 *
 * Each type settles here ONLY through the completion proof it already owns
 * (AGENTS §8): Still Posts through `listBatchStates`, motion clips through
 * `auditSceneClipCompletion` + the one freshness rule, Scene Plan through
 * `auditScenePlanOutput`. Complete → settled; partial, stale, or unprovable →
 * the row stays, because a wrong "settled" is worse than a visible failure (§6).
 *
 * A Scene Plan row that failed on a PRECONDITION never produced a plan, so it
 * stays even after that precondition passes (coordinator, 2026-10-29 — the live
 * quiet-longing EP0001 row).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
])

test('later work settles a failed still_post_render, motion clip and Scene Plan row — and nothing less', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const { settleCompletedFailures } = await import('../services/stale-failures.js')
  const app = (await import('../app.js')).app
  const { isBootComplete } = await import('../boot/migrations.js')
  await waitFor(() => isBootComplete(), { label: 'backend boot' })
  assert.ok(app)
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)

  /** One failed history row, exactly as a real failure leaves it. */
  const failedRow = async (slug: string, type: any, episodeId: string, params: Record<string, unknown> = {},
    finishedAt = new Date().toISOString(), startedAt: string | null = null) => {
    const job = jq.enqueuePreparedForTest({ project_slug: slug, type, episode_id: episodeId, title: type, params })
    await jq.mutateAuthoritativeJob(slug, job.job_id, current => ({
      ...current, status: 'error', finished_at: finishedAt, error: 'incomplete',
      ...(startedAt ? { started_at: startedAt } : {}),
    }))
    return job.job_id
  }
  const isSettled = async (slug: string, jobId: string) =>
    Boolean((await jq.getJobs(slug)).find(job => job.job_id === jobId)?.resolved)

  /** A channel with one accepted episode (a real folder + title). */
  const makeEpisode = async (name: string, title: string) => {
    const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
    const [idea] = await im.addIdeas(project.slug, [{
      title, logline: '', themes: [], suggested_chapters: 10, suggested_length: '45 min', mood: '',
    }], 'manual')
    const accepted = await im.acceptIdea(project.slug, idea!.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
    await fs.mkdir(paths.episode_dir, { recursive: true })
    return { slug: project.slug, code: accepted.episode_code, paths }
  }

  let oneClip: Buffer | null = null
  /** A real, playable H.264 clip — the audit decodes what it counts (cached for the whole file). */
  const playableClip = async (): Promise<Buffer> => {
    if (oneClip) return oneClip
    const { getFFmpegPath } = await import('../services/ffmpeg-manager.js')
    const ffmpeg = await getFFmpegPath()
    const work = await fs.mkdtemp(path.join(temp.dir, 'clips-'))
    const file = path.join(work, 'one.mp4')
    await promisify(execFile)(ffmpeg, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=teal:s=64x48:r=10:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file,
    ])
    oneClip = await fs.readFile(file)
    return oneClip
  }

  try {
    await t.test('Still Posts: complete settles, a missing final or stale words keep the row', async () => {
      const project = await pm.createProject({ name: 'Still post settle' })
      const slug = project.slug
      const sp = await import('../services/still-posts.js')
      const post = (id: string, text: string, finalText: string | null) => ({
        id,
        batch_id: 'batch-1',
        created_at: '2026-10-29T00:00:00.000Z',
        updated_at: '2026-10-29T00:00:00.000Z',
        format_id: 'quote-card',
        option_id: 'single',
        language: 'en' as const,
        character_ids: [],
        caption: '',
        panels: [{ id: 'p0', role: 'single' as const, text, scene_prompt: 'a quiet lake', image: null }],
        finals: finalText === null ? [] : [{
          aspect: '1:1' as const, panel_id: 'p0', filename: 'final-p0-1x1.png',
          rendered_at: '2026-10-29T00:00:00.000Z', text: finalText, style_hash: 'h', font_id: 'f',
        }],
        aspects: ['1:1' as const],
        published_at: null,
      })
      const writeArtifacts = async (id: string) => {
        const dir = sp.postDir(slug, id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'p0.png'), PNG)
        await fs.writeFile(path.join(dir, 'final-p0-1x1.png'), PNG)
      }
      // post-0001 finished, post-0002 has no final yet, post-0003's final shows the OLD words.
      await sp.writePost(slug, post('post-0001', 'The lake is still.', 'The lake is still.'))
      await writeArtifacts('post-0001')
      await sp.writePost(slug, post('post-0002', 'A heron waits.', null))
      await writeArtifacts('post-0002')
      await sp.writePost(slug, post('post-0003', 'The reeds bend.', 'The reeds stand.'))
      await writeArtifacts('post-0003')

      const row = await failedRow(slug, 'still_post_render', '', { batch_id: 'batch-1', image_model: 'made-up' })
      assert.deepEqual(await settleCompletedFailures(slug), [], 'a missing final and a stale final both keep the row')
      assert.equal(await isSettled(slug, row), false)

      // The later runs finished post-0002's frame and lettered post-0003 again with today's words.
      const two = await sp.readPost(slug, 'post-0002')
      await sp.writePost(slug, { ...two!, finals: [{
        aspect: '1:1', panel_id: 'p0', filename: 'final-p0-1x1.png',
        rendered_at: '2026-10-29T01:00:00.000Z', text: 'A heron waits.', style_hash: 'h', font_id: 'f',
      }] })
      const three = await sp.readPost(slug, 'post-0003')
      await sp.writePost(slug, { ...three!, finals: [{
        aspect: '1:1', panel_id: 'p0', filename: 'final-p0-1x1.png',
        rendered_at: '2026-10-29T01:00:00.000Z', text: 'The reeds bend.', style_hash: 'h', font_id: 'f',
      }] })

      assert.deepEqual(await settleCompletedFailures(slug), [row], 'every covered post is now complete')
      assert.equal(await isSettled(slug, row), true)
      assert.equal(jq.getQueueStats(slug).error, 0, 'settled rows leave "needs attention"')
      const history = (await jq.getJobs(slug)).find(job => job.job_id === row)!
      assert.equal(history.status, 'error', 'the row and its log stay in history')
      assert.match(history.resolved?.reason || '', /now saved/)
    })

    await t.test('Still Posts: a redraw settles only from artwork drawn AFTER the failure', async () => {
      const project = await pm.createProject({ name: 'Still post redraw settle' })
      const slug = project.slug
      const sp = await import('../services/still-posts.js')
      const record = (renderedAt: string) => ({
        id: 'post-0001', batch_id: 'batch-1',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: renderedAt,
        format_id: 'quote-card', option_id: 'single', language: 'en' as const,
        character_ids: [], caption: '',
        panels: [{
          id: 'p0', role: 'single' as const, text: 'Words.', scene_prompt: 'a scene',
          image: { filename: 'p0.png', rendered_at: renderedAt, sha256: 'a'.repeat(64), model_id: 'm', model_label: 'M', prompt: 'p', reference_character_ids: [], reference_names: [], mode: 'single' as const },
        }],
        finals: [{
          aspect: '1:1' as const, panel_id: 'p0', filename: 'final-p0-1x1.png',
          rendered_at: renderedAt, text: 'Words.', style_hash: 'h', font_id: 'f',
        }],
        aspects: ['1:1' as const],
        published_at: null,
      })
      await sp.writePost(slug, record('2026-10-01T00:00:00.000Z'))
      const dir = sp.postDir(slug, 'post-0001')
      await fs.writeFile(path.join(dir, 'p0.png'), PNG)
      await fs.writeFile(path.join(dir, 'final-p0-1x1.png'), PNG)

      const row = await failedRow(slug, 'still_post_render', '', { batch_id: 'batch-1', redraw: true },
        '2026-10-05T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
      assert.deepEqual(await settleCompletedFailures(slug), [], 'a redraw wanted NEW artwork; the older files prove nothing')
      assert.equal(await isSettled(slug, row), false)

      // The later redraw re-drew this post: every artifact it now shows is newer than the failure.
      await sp.writePost(slug, record('2026-10-10T00:00:00.000Z'))
      assert.deepEqual(await settleCompletedFailures(slug), [row], 'new artwork after the failure is the redraw it was for')
      assert.equal(await isSettled(slug, row), true)
    })

    await t.test('Still Posts: a redraw that failed after drawing its own post settles once the rest of its scope is finished', async () => {
      const project = await pm.createProject({ name: 'Still post redraw partial' })
      const slug = project.slug
      const sp = await import('../services/still-posts.js')
      const drawn = (id: string, renderedAt: string) => ({
        id, batch_id: 'batch-2',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: renderedAt,
        format_id: 'quote-card', option_id: 'single', language: 'en' as const,
        character_ids: [], caption: '',
        panels: [{
          id: 'p0', role: 'single' as const, text: 'Words.', scene_prompt: 'a scene',
          image: { filename: 'p0.png', rendered_at: renderedAt, sha256: 'a'.repeat(64), model_id: 'm', model_label: 'M', prompt: 'p', reference_character_ids: [], reference_names: [], mode: 'single' as const },
        }],
        finals: [{ aspect: '1:1' as const, panel_id: 'p0', filename: 'final-p0-1x1.png', rendered_at: renderedAt, text: 'Words.', style_hash: 'h', font_id: 'f' }],
        aspects: ['1:1' as const],
        published_at: null,
      })
      const pending = (id: string) => ({ ...drawn(id, '2026-10-01T00:00:00.000Z'), panels: [{ id: 'p0', role: 'single' as const, text: 'Words.', scene_prompt: 'a scene', image: null }], finals: [] })
      // The run began at 10:00 and drew post-0002 at 10:30, then post-0003 failed. Its row failed at 11:00.
      await sp.writePost(slug, drawn('post-0002', '2026-10-04T10:30:00.000Z'))
      await sp.writePost(slug, pending('post-0003'))
      for (const id of ['post-0002', 'post-0003']) {
        const dir = sp.postDir(slug, id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'p0.png'), PNG)
        await fs.writeFile(path.join(dir, 'final-p0-1x1.png'), PNG)
      }
      // A made-up model fails in preflight, so the fixture's queued row never draws in the background.
      const row = await failedRow(slug, 'still_post_render', '', { batch_id: 'batch-2', redraw: true, image_model: 'made-up' },
        '2026-10-04T11:00:00.000Z', '2026-10-04T10:00:00.000Z')
      assert.deepEqual(await settleCompletedFailures(slug), [], 'post-0003 is still missing its art')

      // A later run drew post-0003 at 12:00. Post-0002's artwork from the failed run is still the redraw it was for.
      await sp.writePost(slug, drawn('post-0003', '2026-10-04T12:00:00.000Z'))
      await fs.writeFile(path.join(sp.postDir(slug, 'post-0003'), 'p0.png'), PNG)
      assert.deepEqual(await settleCompletedFailures(slug), [row], 'the failed run\'s own drawing does not block its settle')
      assert.equal(await isSettled(slug, row), true)
      await jq._waitForJobPersistenceForTesting()
    })

    await t.test('Motion clips: every covered clip must be on disk, fresh and selected', async () => {
      const episode = await makeEpisode('Motion clip settle', 'Motion clip settle episode')
      const slug = episode.slug
      const clipsDir = await (await import('../generators/scene-clip.js')).resolveVideoAssetsDir(slug, episode.code, episode.paths.episode_dir)
      await fs.mkdir(clipsDir, { recursive: true })
      const planPath = await resolveScenePlanPath(slug, episode.code, episode.paths.episode_dir)
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      const writePlan = async (motionPrompts: { a: string, b: string }, rendered?: { b: string }) => {
        await fs.writeFile(planPath, JSON.stringify({
          scenes: [
            { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 1, motion_choice: 'clip', motion_prompt: motionPrompts.a, visual_prompt: 'A lake.' },
            { id: 'scene-b', scene_index: 2, start_sec: 1, end_sec: 2, motion_choice: 'clip', motion_prompt: motionPrompts.b, visual_prompt: 'A heron.',
              ...(rendered ? { rendered_motion_prompt: rendered.b } : {}) },
          ],
        }))
      }
      await writePlan({ a: 'slow drift', b: 'slow pan' })

      const row = await failedRow(slug, 'scene_clips_batch', episode.code, {
        episode_id: episode.code,
        model: 'made-up-model',
        motion_scene_ids: ['scene-a', 'scene-b'],
      })
      assert.deepEqual(await settleCompletedFailures(slug), [], 'no clips on disk yet')
      assert.equal(await isSettled(slug, row), false)

      const clip = await playableClip()
      await fs.writeFile(path.join(clipsDir, 'scene-a.mp4'), clip)
      assert.deepEqual(await settleCompletedFailures(slug), [], 'one of the two covered clips is still missing')
      assert.equal(await isSettled(slug, row), false)

      await fs.writeFile(path.join(clipsDir, 'scene-b.mp4'), clip)
      assert.deepEqual(await settleCompletedFailures(slug), [row], 'both covered clips exist, are playable and selected')
      assert.equal(await isSettled(slug, row), true)

      // Same shape, but the plan moved scene-b's motion prompt after its clip was made:
      // the clip recorded the OLD prompt, so the one freshness rule calls it stale.
      await writePlan({ a: 'slow drift', b: 'a fast pan now' }, { b: 'slow pan' })
      const staleRow = await failedRow(slug, 'scene_clips_batch', episode.code, {
        episode_id: episode.code, model: 'made-up-model', motion_scene_ids: ['scene-b'],
      })
      assert.deepEqual(await settleCompletedFailures(slug), [], 'a clip made from an older motion prompt is stale, not done')
      assert.equal(await isSettled(slug, staleRow), false)
    })

    await t.test('Scene Plan: the plan the run was for must be complete', async () => {
      const episode = await makeEpisode('Scene plan settle', 'Scene plan settle episode')
      const slug = episode.slug
      const planPath = await resolveScenePlanPath(slug, episode.code, episode.paths.episode_dir)
      await fs.mkdir(path.dirname(planPath), { recursive: true })
      const writePlan = async (prompts: [string, string]) => {
        await fs.writeFile(planPath, JSON.stringify({
          scenes: [
            { id: 'scene-a', scene_index: 1, start_sec: 0, end_sec: 10, visual_prompt: prompts[0] },
            { id: 'scene-b', scene_index: 2, start_sec: 10, end_sec: 20, visual_prompt: prompts[1] },
          ],
        }))
      }
      await writePlan(['A red door in a stone wall.', ''])
      const partial = await failedRow(slug, 'scene_plan_run', episode.code, { episode_id: episode.code })
      assert.deepEqual(await settleCompletedFailures(slug), [], 'a blank visual prompt is not a complete plan')
      assert.equal(await isSettled(slug, partial), false)

      await writePlan(['A red door in a stone wall.', 'A heron over grey water.'])
      assert.deepEqual(await settleCompletedFailures(slug), [partial], 'every prompt the plan owes is saved')
      assert.equal(await isSettled(slug, partial), true)
    })

    await t.test('Scene Plan: a precondition failure stays, even once the precondition passes', async () => {
      const episode = await makeEpisode('Scene plan precondition settle', 'Quiet Longing EP0001')
      const slug = episode.slug
      // The live quiet-longing EP0001 row failed with "Subtitle timeline is
      // incomplete — complete transcription and stitch subtitles again".
      const row = await failedRow(slug, 'scene_plan_run', episode.code, { episode_id: episode.code })

      // The owner later finished transcription and stitched the timeline, so the
      // precondition now passes — and the plan STILL never ran.
      const { parseSrt } = await import('../lib/subtitle-builder.js')
      const { stampFromCues } = await import('../lib/scene-plan-timeline.js')
      const { stitchedSrtPath } = await import('../services/subtitle-correction.js')
      const { assertSubtitleTimelineComplete } = await import('../services/scene-timeline-integrity.js')
      const srt = '1\n00:00:00,000 --> 00:00:05,000\nHello there.\n\n2\n00:00:05,000 --> 00:00:10,000\nGoodbye.\n'
      const stitched = stitchedSrtPath(episode.paths.subtitles_dir, episode.code)
      await fs.mkdir(path.dirname(stitched), { recursive: true })
      await fs.writeFile(stitched, srt)
      await fs.writeFile(`${stitched}.json`, JSON.stringify({
        complete: true,
        total_cues: parseSrt(srt).length,
        timeline: { sha256: stampFromCues(parseSrt(srt)).sha256 },
        sections: [{ slug: 'Chapter_01', source_srt: 'Chapter_01.srt', cues_added: parseSrt(srt).length, offset_sec: 0, duration_sec: 10 }],
      }))
      await assertSubtitleTimelineComplete(episode.paths.subtitles_dir, episode.code,
        { episodeDir: episode.paths.episode_dir, audioDir: episode.paths.audio_dir, scriptDir: episode.paths.script_dir })
        .catch(error => { throw new Error(`fixture should satisfy the precondition: ${error?.message || error}`) })

      assert.deepEqual(await settleCompletedFailures(slug), [], 'no plan was ever built, so the row is still true')
      assert.equal(await isSettled(slug, row), false)
    })
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
