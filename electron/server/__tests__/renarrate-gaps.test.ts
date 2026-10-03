/**
 * Dreamlands subtitle gaps were the narration, not Whisper: Breeze rendered a
 * sentence as silence, drift or humming. Studio Hub 0.6.137 checks every section
 * and re-makes bad ones (`section_quality`); Story shows that per chapter, says a
 * failed section in plain words, and "Re-narrate Chapter 3" re-makes the
 * chapter's subtitles once its new narration is saved.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'
import { addSectionQuality, plainSectionFailure, summarizeSectionQuality } from '../lib/tts-section-quality.js'
import { humanGatewayText } from '../lib/gateway-failure-text.js'

const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })

test('section_quality → sections checked and re-makes, summed over a chapter\'s requests', () => {
  // One row per attempt, as the Hub broker records it.
  const raw = { revision: 'r1', sections: [
    { section: 1, attempt: 1, accepted: true },
    { section: 2, attempt: 1, accepted: false, rejection_code: 'TTS_SECTION_SILENT' },
    { section: 2, attempt: 2, accepted: false, rejection_code: 'TTS_SECTION_TOO_LONG' },
    { section: 2, attempt: 3, accepted: true },
    { section: 3, attempt: 1, accepted: true },
  ] }
  assert.deepEqual(summarizeSectionQuality(raw), { sections: 3, remade: 2 })
  assert.equal(summarizeSectionQuality(null), null)
  assert.equal(summarizeSectionQuality({ sections: 'nope' }), null)
  assert.equal(summarizeSectionQuality({ sections: [] }), null)
  const chapter = addSectionQuality(addSectionQuality(undefined, { sections: 3, remade: 2 }), { sections: 2, remade: 0 })
  assert.deepEqual(chapter, { sections: 5, remade: 2 })
})

test('a section that failed every try reads as a plain sentence', () => {
  const hub = 'hub item error: TTS_SECTION_SILENT: Section 4 of 9 came out (nearly) silent or as a DC drift on all 4 attempts, so the audio was not delivered. Try again, or reword that part of the text.'
  const plain = 'Section 4 of 9 came out silent on all 4 tries, so this part was not saved. Re-narrate to try again, or reword that part of the script.'
  assert.equal(plainSectionFailure(hub), plain)
  assert.equal(humanGatewayText(hub), plain)
  assert.match(plainSectionFailure('Section 2 of 3 ran far longer than its text (babble or humming) on all 4 attempts')!, /came out as humming or mumbling instead of speech/)
  assert.match(plainSectionFailure('Section 7 of 8 does not say its text (Whisper heard other words) on all 4 attempts')!, /did not say its words/)
  assert.doesNotMatch(humanGatewayText(hub), /DC drift|Whisper|delivered/)
  assert.equal(plainSectionFailure('hub submit failed: timed out'), null)
})

test('Re-narrate queues only the chapter\'s subtitles, with the model that made them before', async () => {
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  const { queueSubtitlesAfterNarration } = await import('../generators/audio.js')
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Renarrate Subtitles' })
    const audio = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: 'EP0001', title: 'Audio', params: { episode_id: 'EP0001', then_subtitles: true } })

    // No transcription on record: say so instead of guessing a model.
    await queueSubtitlesAfterNarration(audio, ['Chapter_03'])
    assert.match(audio.output_lines.at(-1)!, /no earlier transcription model is on record/)

    const earlier = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'subtitles_transcribe', episode_id: 'EP0001', title: 'Subtitles',
      params: { episode_id: 'EP0001', model: 'studio-hub::whisper-turbo', language: 'en', per_chapter: true } })
    await jq.mutateAuthoritativeJob(project.slug, earlier.job_id, current => ({ ...current, status: 'done', finished_at: new Date().toISOString() }))

    await queueSubtitlesAfterNarration(audio, ['Chapter_03'])
    const queued = (await jq.getJobs(project.slug)).find(job => job.job_id === audio.result?.subtitles_job_id)!
    assert.equal(queued.type, 'subtitles_transcribe')
    assert.deepEqual(queued.params.sections, ['Chapter_03'])
    assert.equal(queued.params.model, 'studio-hub::whisper-turbo')
    assert.equal(queued.params.language, 'en')
    assert.equal(queued.params.force, false, 'only out-of-date chapters are transcribed, so a replay never pays twice')

    await queueSubtitlesAfterNarration(audio, ['Chapter_03'])
    assert.match(audio.output_lines.at(-1)!, /already being made/, 'never a second subtitle job for the same episode')
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})
