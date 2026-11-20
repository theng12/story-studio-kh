/**
 * 1.4.415 — a failed row for work whose result is NOT a file on this Mac never settled.
 *
 * Production (2026-11-19): WI0010 still read "No YouTube channel is assigned" hours after that video
 * had uploaded and been scheduled — an episode reported as blocked while it was on YouTube. The disk
 * rule cannot answer it: an upload's output is a video on YouTube. Its rule is its own — a LATER
 * SUCCESSFUL upload of the SAME episode to the SAME channel supersedes the failed row — and the row
 * names the winner rather than just going quiet (row `20261120-150`-class defect, Production #5).
 *
 * Every assertion here fails on the code before 1.4.415: `youtube_upload` was not in the resolvable
 * set at all, and the two image producers were not either, so `settleCompletedFailures` returned [].
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600)])

test('a failed row settles by its own rule: an upload superseded by a later one, an image row by its files', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { settleCompletedFailures } = await import('../services/stale-failures.js')
  const { isBootComplete } = await import('../boot/migrations.js')
  // Booting the app is what runs the queue registration these rows live in.
  const app = (await import('../app.js')).app
  assert.ok(app)
  await waitFor(() => isBootComplete(), { label: 'backend boot' })
  await jq.setQueuePaused(true)

  const failedRow = async (slug: string, type: any, episodeId: string, params: Record<string, unknown> = {},
    finishedAt = new Date().toISOString()) => {
    const job = jq.enqueuePreparedForTest({ project_slug: slug, type, episode_id: episodeId, title: type, params })
    await jq.mutateAuthoritativeJob(slug, job.job_id, current => ({
      ...current, status: 'error', finished_at: finishedAt, error: 'failed for the fixture',
    }))
    return job.job_id
  }
  const doneRow = async (slug: string, type: any, episodeId: string, params: Record<string, unknown> = {},
    finishedAt = new Date().toISOString()) => {
    const job = jq.enqueuePreparedForTest({ project_slug: slug, type, episode_id: episodeId, title: type, params })
    await jq.mutateAuthoritativeJob(slug, job.job_id, current => ({
      ...current, status: 'done', finished_at: finishedAt, error: null,
    }))
    return job.job_id
  }
  const isSettled = async (slug: string, jobId: string) =>
    Boolean((await jq.getJobs(slug)).find(job => job.job_id === jobId)?.resolved)

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

  await t.test('a failed upload settles only on a LATER SUCCESSFUL upload of the same episode and channel', async () => {
    const { slug, code } = await makeEpisode('Upload supersede', 'Upload supersede episode')
    // A second episode in the SAME project — a different project would also be EP001.
    const [secondIdea] = await im.addIdeas(slug, [{
      title: 'A second episode', logline: '', themes: [], suggested_chapters: 10, suggested_length: '45 min', mood: '',
    }], 'manual')
    const second = await im.acceptIdea(slug, secondIdea!.id, false)
    assert.notEqual(second.episode_code, code, 'the fixture needs two different episode codes')
    const CHANNEL = 'chan-A'
    const failed = await failedRow(slug, 'youtube_upload', code,
      { expected_channel_id: CHANNEL }, '2026-11-19T10:00:00.000Z')

    // Nothing later: the row is a real failure and stays.
    assert.deepEqual(await settleCompletedFailures(slug), [], 'no later upload yet')

    // A later ATTEMPT that also failed proves nothing.
    await doneRow(slug, 'youtube_upload', code, { expected_channel_id: CHANNEL }, '2026-11-19T09:00:00.000Z')
    assert.deepEqual(await settleCompletedFailures(slug), [], 'an upload that finished BEFORE the failure proves nothing')
    await failedRow(slug, 'youtube_upload', code, { expected_channel_id: CHANNEL }, '2026-11-19T11:00:00.000Z')
    assert.deepEqual(await settleCompletedFailures(slug), [], 'a later failed attempt is not a success')

    // Another episode's success on the same channel is not this episode.
    await doneRow(slug, 'youtube_upload', second.episode_code, { expected_channel_id: CHANNEL }, '2026-11-19T12:00:00.000Z')
    assert.deepEqual(await settleCompletedFailures(slug), [], 'a different episode proves nothing')

    // The same episode on ANOTHER channel is not the one that is missing.
    await doneRow(slug, 'youtube_upload', code, { expected_channel_id: 'chan-B' }, '2026-11-19T12:30:00.000Z')
    assert.deepEqual(await settleCompletedFailures(slug), [], 'a different channel proves nothing')

    // The one that counts: same episode, same channel, done, after the failure.
    const winner = await doneRow(slug, 'youtube_upload', code, { expected_channel_id: CHANNEL }, '2026-11-19T13:00:00.000Z')
    const settled = await settleCompletedFailures(slug)
    assert.ok(settled.includes(failed), 'the failed upload row settles once a later upload of it succeeded')
    assert.equal(await isSettled(slug, failed), true)
    const row = (await jq.getJobs(slug)).find(job => job.job_id === failed) as any
    assert.match(row.resolved.reason, /later upload of the same episode to the same channel succeeded/)
    assert.match(row.resolved.reason, new RegExp(winner), 'the row names the upload that superseded it')
    assert.equal(row.status, 'error', 'history is kept, never rewritten')

    // And it does not settle twice.
    assert.equal((await settleCompletedFailures(slug)).includes(failed), false, 'already settled')
  })

  await t.test('a failed scene image row settles through the same disk rule images_repair already uses', async () => {
    const { slug, code, paths } = await makeEpisode('Scene image settle', 'Scene image settle episode')
    const prompts = [
      '# Scene Prompts', '',
      '## Scene 1: One', '', 'first prompt', '',
      '## Scene 2: Two', '', 'second prompt', '',
    ].join('\n')
    await fs.mkdir(path.dirname(paths.scene_prompts_docx), { recursive: true })
    await fs.writeFile(paths.scene_prompts_docx, prompts)

    const { resolveImageDirs } = await import('../generators/images.js')
    const { bgDir } = await resolveImageDirs(slug, paths.scene_prompts_docx, code)
    await fs.mkdir(bgDir, { recursive: true })

    const failed = await failedRow(slug, 'scene_image_generate', code, { episode_id: code })
    assert.deepEqual(await settleCompletedFailures(slug), [], 'no pictures on disk yet — the row is a real failure')

    await fs.writeFile(path.join(bgDir, `${code}_Scene01_v1.png`), PNG)
    assert.deepEqual(await settleCompletedFailures(slug), [], 'one of the two scenes is still missing')
    assert.equal(await isSettled(slug, failed), false)

    await fs.writeFile(path.join(bgDir, `${code}_Scene02_v1.png`), PNG)
    assert.deepEqual(await settleCompletedFailures(slug), [failed], 'every scene the row covered has its picture')
    assert.equal(await isSettled(slug, failed), true)
  })
})
