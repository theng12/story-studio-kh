/**
 * Owner, 2026-10-09: "Let subtitles catch it." 8 GB Macs skip the Mac's own
 * Whisper check, so 55 % of sections went unchecked overnight; Story's subtitle
 * check still sees a skipped sentence (EP0041 chapter 9 "skips 3 script
 * sentences"). On the free fleet that part alone is narrated again, then its
 * subtitles — at most AUTO_RENARRATE_MAX times per chapter; paid voices stay manual.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir, findNarrationFile, episodeDirForNarration, queueAutoRenarrate, AUTO_RENARRATE_MAX } = await import('../generators/audio.js')
const { partHoldingSentence } = await import('../lib/script-transcript-check.js')
const pm = await import('../services/project-manager.js')
const jq = await import('../services/job-queue.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { readPartsManifest } = await import('../services/chapter-parts.js')
const { readAudioQualityProvenance } = await import('../services/audio-quality-store.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
service.ttsModels = [{
  id: 'tiny-model', display_name: 'tiny-model', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 40,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}] as any
clearGenStudioCatalogCache()

test.after(async () => {
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

test('the part holding a skipped sentence is the one with most of its words', () => {
  const parts = ['First sentence is here.', 'Second sentence is here.', 'Third paragraph is here.']
  assert.equal(partHoldingSentence('Second sentence is here.', parts), 1)
  assert.equal(partHoldingSentence('Third paragraph is here.', parts), 2)
  assert.equal(partHoldingSentence('Nothing matches at all', parts), 0, 'no match falls back to the first part')
})

test('a skip re-narrates only that part (fresh request), and the chapter is joined again', async () => {
  const project = await pm.createProject({ name: 'Auto redo part', episode_prefix: 'EP', episode_digits: 3 })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Script')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One',
    'First sentence is here. Second sentence is here.', 'Third paragraph is here.',
  ].join('\n\n'))
  const narration = await findNarrationFile(project.slug, 'EP001')
  const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
  let run = 0
  const direct = async (extra: Record<string, unknown> = {}) => {
    const job: any = {
      job_id: `${project.slug}-${++run}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration',
      status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', model: 'tiny-model', voice: 'mock-voice', sections: 'Chapter_01', speed: 1, force: false, no_overwrite: false, ...extra },
    }
    await generateAudio(job)
    return job
  }
  await direct()
  assert.equal((await readPartsManifest(audioDir, 'EP001_Chapter_01'))?.parts.length, 3, 'a joined three-part chapter')
  const before = service.providerSubmissionCount('tts')

  const untouched = await direct()
  assert.equal(service.providerSubmissionCount('tts'), before, 'a chapter with no skip is left alone')
  assert.ok(untouched.output_lines.some((line: string) => /already present/.test(line)))

  const redo = await direct({ redo_sentences: { Chapter_01: ['Second sentence is here.'] } })
  assert.equal(service.providerSubmissionCount('tts'), before + 1, 'only the skipping part is bought again')
  assert.ok(redo.output_lines.some((line: string) => /Narrating part 2 of 3 again: the subtitles show 1 skipped sentence/.test(line)), redo.output_lines.join('\n'))
  assert.ok(redo.output_lines.some((line: string) => /Skipping EP001_Chapter_01_part1\.mp3 \(exists\)/.test(line)))
  // The mock serves the same bytes for every take, so the chapter re-joins as it was; real takes differ.
  assert.equal((await readPartsManifest(audioDir, 'EP001_Chapter_01'))?.parts.length, 3)
  assert.deepEqual((await fs.readdir(audioDir)).filter(name => name.endsWith('.mp3')), ['EP001_Chapter_01.mp3'])
  const chapter = (await readAudioQualityProvenance(episodeDirForNarration(narration))).chapters.Chapter_01
  assert.deepEqual(chapter?.source_files, ['EP001_Chapter_01.mp3'])
})

test('subtitles queue one targeted redo, capped per chapter, never for paid voices', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Auto redo queue' })
    const ep = 'EP0041'
    const done = async (job: { job_id: string }) => jq.mutateAuthoritativeJob(project.slug, job.job_id, current => ({ ...current, status: 'done', finished_at: new Date().toISOString() }))
    const narration = jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'audio', episode_id: ep, title: 'Narration',
      params: { episode_id: ep, model: 'studio-hub::breeze', voice: 'v1', speed: 1, force: true, operation_id: 'op-1' } })
    await done(narration)
    const skipped = [{ slug: 'Chapter_09', sentences: ['The lantern swayed above the quiet harbour wall.', 'Gulls settled along the darkening pier.', 'Night came softly over the water.'] }]
    const check = (name: string) => jq.enqueuePreparedForTest({ project_slug: project.slug, type: 'subtitles_transcribe', episode_id: ep, title: name,
      params: { episode_id: ep, model: 'studio-hub::whisper-turbo', per_chapter: true }, dedupeParams: params => params?.name === name })
    const redos = async () => (await jq.getJobs(project.slug, { type: 'audio' })).filter(job => job.params.auto_renarrate_from)

    const first = check('first')
    await queueAutoRenarrate(first, skipped)
    let queued = await redos()
    assert.equal(queued.length, 1, 'one targeted redo')
    assert.equal(queued[0]!.params.sections, 'Chapter_09')
    assert.deepEqual(queued[0]!.params.redo_sentences, { Chapter_09: skipped[0]!.sentences })
    assert.equal(queued[0]!.params.then_subtitles, true, 'its subtitles are made again after')
    assert.equal(queued[0]!.params.force, false, 'only the skipping part, not the whole chapter')
    assert.equal(queued[0]!.params.model, 'studio-hub::breeze')
    assert.equal(queued[0]!.params.operation_id, undefined)
    assert.match(first.output_lines.at(-1)!, /Re-narrating only the part\(s\) of Chapter 09 .*automatic try 1 of 2/)

    await queueAutoRenarrate(first, skipped)
    assert.equal((await redos()).length, 1, 'a replayed check never queues twice')

    await done(queued[0]!)
    const second = check('second')
    await queueAutoRenarrate(second, skipped)
    queued = await redos()
    assert.equal(queued.length, AUTO_RENARRATE_MAX)
    assert.match(second.output_lines.at(-1)!, /automatic try 2 of 2/)

    await done(queued[1]!)
    const third = check('third')
    await queueAutoRenarrate(third, skipped)
    assert.equal((await redos()).length, AUTO_RENARRATE_MAX, 'capped: no third redo, so it can never loop')
    assert.match(third.output_lines.at(-1)!, /Chapter 09 still skips script sentences after 2 automatic re-narrations\. Left for you/)
    assert.deepEqual(third.result?.renarrate_needs_owner, ['Chapter_09'])

    const untouched = check('no skip')
    await queueAutoRenarrate(untouched, [])
    assert.deepEqual(untouched.output_lines, [], 'no skip, nothing said or queued')

    // A paid voice stays manual.
    const paidProject = await pm.createProject({ name: 'Auto redo paid' })
    const paid = jq.enqueuePreparedForTest({ project_slug: paidProject.slug, type: 'audio', episode_id: ep, title: 'Narration',
      params: { episode_id: ep, model: 'eleven-v3', voice: 'v1' } })
    await jq.mutateAuthoritativeJob(paidProject.slug, paid.job_id, current => ({ ...current, status: 'done', finished_at: new Date().toISOString() }))
    const paidCheck = jq.enqueuePreparedForTest({ project_slug: paidProject.slug, type: 'subtitles_transcribe', episode_id: ep, title: 'Subtitles', params: { episode_id: ep } })
    await queueAutoRenarrate(paidCheck, skipped)
    assert.equal((await jq.getJobs(paidProject.slug, { type: 'audio' })).length, 1, 'no paid redo')
    assert.match(paidCheck.output_lines.at(-1)!, /not re-narrated automatically: a paid voice stays manual/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})
