/**
 * An episode code is judged ONCE, before the queue owns the job.
 *
 * Production, 2026-10-29 (job 70795c6c): an Audio job for `AU0001` was admitted
 * into the queue and then failed with "Invalid episode code: AU0001 (expected
 * prefix: EP)". `AU0001` is a REAL stored episode — accepted while the channel's
 * prefix was briefly `AU`, and an accepted episode keeps the code it was
 * accepted with forever (`storedEpisodeNumber`, 1.4.368). The queue simply
 * never asked, so the refusal arrived after admission.
 *
 * Admission now asks the resolver's own question, so the queue and the audio
 * generator cannot disagree:
 *   - a stored episode under an older prefix is ADMITTED and resolves;
 *   - a code with no episode number is REFUSED at submit time, in the same
 *     words the generator would have failed with, using the CHANNEL's prefix.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

test('episode codes are admitted or refused by the resolver admission and execution share', async t => {
  const temp = await useTempDataDir()
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { isBootComplete } = await import('../boot/migrations.js')
  await (await import('../app.js')).app
  await waitFor(() => isBootComplete(), { label: 'backend boot' })
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)

  try {
    await t.test('a stored episode under an older prefix is admitted AND resolves', async () => {
      const project = await pm.createProject({ name: 'Older prefix admission', episode_prefix: 'EP', episode_digits: 4 })
      const [idea] = await im.addIdeas(project.slug, [{
        title: 'Chris Khmer Audition', logline: '', themes: [], suggested_chapters: 1,
        suggested_length: 'short', mood: 'neutral',
      }], 'manual')
      // The prefix was briefly AU when this episode was accepted, exactly as in production.
      await pm.updateProject(project.slug, { episode_prefix: 'AU' } as any)
      const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'AU0001' })
      await pm.updateProject(project.slug, { episode_prefix: 'EP' } as any)
      assert.equal(accepted.episode_code, 'AU0001')

      // ADMISSION: the audio job the queue used to accept and then fail is accepted — and works.
      const job = await jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'AU0001', params: {} })
      assert.equal(job.episode_id, 'AU0001')
      assert.equal(job.status, 'queued')
      assert.ok((await jq.getJobs(project.slug)).some(entry => entry.job_id === job.job_id), 'the job is in the queue')

      // EXECUTION: the audio path resolves the very same episode — no "Invalid episode
      // code" from a hardcoded EP. `findNarrationFile` is what generateAudio calls first;
      // it must fail on the missing narration (nothing was written yet), never on the code.
      const paths = await resolveEpisodePathsByCode(project.slug, 'AU0001')
      assert.match(paths.episode_dir, /AU0001 - Chris Khmer Audition\/?$/)
      const { findNarrationFile } = await import('../generators/audio.js')
      const audioPathError = await findNarrationFile(project.slug, 'AU0001').then(() => null, (error: any) => String(error?.message || error))
      assert.ok(audioPathError === null || !/Invalid episode code/.test(audioPathError),
        `the audio path must never refuse AU0001 on its code: ${audioPathError}`)
    })

    await t.test('a code with no episode number is refused at submit with the generator\'s own words', async () => {
      const project = await pm.createProject({ name: 'Invalid code admission', episode_prefix: 'EP' })
      const before = (await jq.getJobs(project.slug)).length
      await assert.rejects(
        jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'notacode', params: {} }),
        (error: any) => {
          assert.match(String(error?.message), /^Invalid episode code: notacode \(expected prefix: EP\)$/)
          assert.equal(error?.statusCode, 400, 'a refused submission is a bad request, not a server error')
          return true
        },
      )
      assert.equal((await jq.getJobs(project.slug)).length, before, 'a refused job never becomes a row')

      // The same check guards the inline (sync) branch, which never reaches `enqueue`.
      await assert.rejects(
        jq.enqueueOrRun({ project_slug: project.slug, type: 'audio', episode_id: 'notacode', params: {}, sync: true }),
        /Invalid episode code: notacode/,
      )
    })

    await t.test('the refusal names THIS channel\'s prefix, not a hardcoded EP', async () => {
      const project = await pm.createProject({ name: 'Prefix wording admission', episode_prefix: 'AU' })
      await assert.rejects(
        jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'episode', params: {} }),
        (error: any) => {
          assert.match(String(error?.message), /\(expected prefix: AU\)$/)
          return true
        },
      )
    })

    await t.test('types whose slot is not an episode code are not code-checked', async () => {
      const project = await pm.createProject({ name: 'Non-episode slots' })
      const stillPosts = await jq.enqueue({
        project_slug: project.slug, type: 'still_post_write', episode_id: '',
        params: { batch_id: 'batch-20261029' },
      })
      assert.equal(stillPosts.status, 'queued')
      const music = await jq.enqueue({ project_slug: project.slug, type: 'music_generate', episode_id: '', params: {} })
      assert.equal(music.status, 'queued')
    })

    await t.test('every job type is classified as an episode code or not', async () => {
      const { JOB_TYPES } = await import('../models/types.js')
      const overlap = JOB_TYPES.filter(type =>
        jq.EPISODE_CODE_JOB_TYPES.has(type) && jq.NON_EPISODE_ID_JOB_TYPES.has(type))
      assert.deepEqual(overlap, [], 'a type cannot be in both sets')
      const unclassified = JOB_TYPES.filter(type =>
        !jq.EPISODE_CODE_JOB_TYPES.has(type) && !jq.NON_EPISODE_ID_JOB_TYPES.has(type))
      assert.deepEqual(unclassified, [], 'a new job type must decide whether its episode_id is a code')
    })
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
    await temp.cleanup()
  }
})
