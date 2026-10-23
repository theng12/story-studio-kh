/**
 * Owner, 2026-10-09: "Let subtitles catch it." 8 GB Macs skip the Mac's own
 * Whisper check, so 55 % of sections went unchecked overnight; Story's subtitle
 * check still sees a skipped sentence (EP0041 chapter 9 "skips 3 script
 * sentences"). On the free fleet that part alone is narrated again, then its
 * subtitles — at most AUTO_RENARRATE_MAX times per chapter; paid voices stay manual.
 *
 * The voice a repair replays must belong to whoever made the audio now on disk. A
 * done job's status and recency prove nothing — it may have skipped every existing
 * file. These cases pin that: provenance records the producing run's per-part
 * GenStudio request identities, those bind one historical job, and anything
 * unresolved refuses instead of guessing a voice.
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
const ideas = await import('../services/idea-manager.js')
const { resolveEpisodePathsByCode } = await import('../services/utils.js')
const { hashSubtitleAudioSources } = await import('../services/subtitle-completion.js')
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

/** A real accepted episode, so path resolution and provenance live on disk. */
async function acceptedEpisode(projectSlug: string, title: string): Promise<string> {
  const [idea] = await ideas.addIdeas(projectSlug, [{ title, logline: 'Fixture', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(projectSlug, idea!.id, false)
  return accepted.episode_code
}

async function episodePaths(projectSlug: string, code: string) {
  const paths = await resolveEpisodePathsByCode(projectSlug, code)
  await fs.mkdir(paths.audio_dir, { recursive: true })
  await fs.mkdir(paths.episode_dir, { recursive: true })
  return paths
}

const narrationJob = (slug: string, code: string, params: Record<string, unknown>) =>
  jq.enqueuePreparedForTest({ project_slug: slug, type: 'audio', episode_id: code, title: 'Narration', params: { episode_id: code, ...params } })

const subtitleCheck = (slug: string, code: string, name: string) =>
  jq.enqueuePreparedForTest({ project_slug: slug, type: 'subtitles_transcribe', episode_id: code, title: name,
    params: { episode_id: code, model: 'studio-hub::whisper-turbo', per_chapter: true }, dedupeParams: params => params?.name === name })

const redoFor = async (slug: string, checkJobId: string) =>
  (await jq.getJobs(slug, { type: 'audio' })).find(job => job.params.auto_renarrate_from === checkJobId)

const markDone = async (slug: string, jobId: string, extra: Record<string, unknown> = {}) =>
  jq.mutateAuthoritativeJob(slug, jobId, current => ({ ...current, status: 'done', finished_at: new Date().toISOString(), ...extra }))

/**
 * Seed a chapter's active audio, its provenance (with the producing run's per-part
 * request identities), and the one historical job those identities bind.
 */
async function seedChapters(projectSlug: string, code: string, chapters: Array<{
  slug: string
  model: string
  voice: string
  extra?: Record<string, unknown>
  /** Original part filenames the request identities were minted against. */
  partNames?: string[]
  /** Omit the per-part identities to model legacy provenance. */
  withoutIdentity?: boolean
}>) {
  const paths = await episodePaths(projectSlug, code)
  const chaptersOut: Record<string, any> = {}
  const jobs: any[] = []
  for (const chapter of chapters) {
    const joined = `${code}_${chapter.slug}.mp3`
    await fs.writeFile(path.join(paths.audio_dir, joined), `audio:${chapter.slug}:${chapter.model}:${chapter.voice}`)
    const hash = await hashSubtitleAudioSources([path.join(paths.audio_dir, joined)])
    const parts = chapter.partNames ?? [joined]
    const assets: Record<string, any> = {}
    const idempotency_keys: Record<string, string> = {}
    const task_ids: Record<string, string> = {}
    parts.forEach((part, index) => {
      const key = `idem-${chapter.slug}-${index}`
      const task = `task-${chapter.slug}-${index}`
      assets[part] = { operation: 'tts', idempotency_key: key, job_id: task, state: 'succeeded', updated_at: new Date().toISOString() }
      idempotency_keys[part] = key
      task_ids[part] = task
    })
    const params: Record<string, any> = { model: chapter.model, voice: chapter.voice, ...(chapter.extra || {}) }
    if (!chapter.withoutIdentity) params.genstudio_recovery = { version: 1, route: 'genstudio', assets }
    const job = narrationJob(projectSlug, code, params)
    await markDone(projectSlug, job.job_id)
    jobs.push(job)
    chaptersOut[chapter.slug] = {
      normalized_script_hash: 'script-hash', normalization: 'tts-v1',
      source_audio_hash: hash, source_files: [joined], recorded_at: new Date().toISOString(),
      tts: chapter.withoutIdentity
        ? { model_id: chapter.model, voice_id: chapter.voice }
        : { model_id: chapter.model, voice_id: chapter.voice, idempotency_keys, task_ids },
    }
  }
  await fs.writeFile(path.join(paths.episode_dir, 'audio_quality.json'), JSON.stringify({ version: 1, chapters: chaptersOut }))
  return { paths, jobs }
}

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
    const project = await pm.createProject({ name: 'Auto redo queue', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Skipped chapter')
    await seedChapters(project.slug, code, [{ slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1', extra: { speed: 1, force: true, operation_id: 'op-1' } }])

    const skipped = [{ slug: 'Chapter_09', sentences: ['The lantern swayed above the quiet harbour wall.', 'Gulls settled along the darkening pier.', 'Night came softly over the water.'] }]
    const redos = async () => (await jq.getJobs(project.slug, { type: 'audio' })).filter(job => job.params.auto_renarrate_from)

    const first = subtitleCheck(project.slug, code, 'first')
    await queueAutoRenarrate(first, skipped)
    let queued = await redos()
    assert.equal(queued.length, 1, 'one targeted redo')
    assert.equal(queued[0]!.params.sections, 'Chapter_09')
    assert.deepEqual(queued[0]!.params.redo_sentences, { Chapter_09: skipped[0]!.sentences })
    assert.equal(queued[0]!.params.then_subtitles, true, 'its subtitles are made again after')
    assert.equal(queued[0]!.params.force, false, 'only the skipping part, not the whole chapter')
    assert.equal(queued[0]!.params.model, 'studio-hub::breeze')
    assert.equal(queued[0]!.params.voice, 'v1')
    assert.equal(queued[0]!.params.operation_id, undefined)
    assert.match(first.output_lines.at(-1)!, /Re-narrating only the part\(s\) of Chapter 09 .*automatic try 1 of 2/)

    await queueAutoRenarrate(first, skipped)
    assert.equal((await redos()).length, 1, 'a replayed check never queues twice')

    await markDone(project.slug, queued[0]!.job_id)
    const second = subtitleCheck(project.slug, code, 'second')
    await queueAutoRenarrate(second, skipped)
    queued = await redos()
    assert.equal(queued.length, AUTO_RENARRATE_MAX)
    assert.match(second.output_lines.at(-1)!, /automatic try 2 of 2/)

    await markDone(project.slug, queued[1]!.job_id)
    const third = subtitleCheck(project.slug, code, 'third')
    await queueAutoRenarrate(third, skipped)
    assert.equal((await redos()).length, AUTO_RENARRATE_MAX, 'capped: no third redo, so it can never loop')
    assert.match(third.output_lines.at(-1)!, /Chapter 09 still skips script sentences after 2 automatic re-narrations\. Left for you/)
    assert.deepEqual(third.result?.renarrate_needs_owner, ['Chapter_09'])

    const untouched = subtitleCheck(project.slug, code, 'no skip')
    await queueAutoRenarrate(untouched, [])
    assert.deepEqual(untouched.output_lines, [], 'no skip, nothing said or queued')

    // A paid voice stays manual.
    const paidProject = await pm.createProject({ name: 'Auto redo paid', episode_prefix: 'EP', episode_digits: 4 })
    const paidCode = await acceptedEpisode(paidProject.slug, 'Paid chapter')
    await seedChapters(paidProject.slug, paidCode, [{ slug: 'Chapter_09', model: 'eleven-v3', voice: 'v1' }])
    const paidCheck = subtitleCheck(paidProject.slug, paidCode, 'Subtitles')
    await queueAutoRenarrate(paidCheck, skipped)
    assert.equal((await jq.getJobs(paidProject.slug, { type: 'audio' })).filter(job => job.params.auto_renarrate_from).length, 0, 'no paid redo')
    assert.match(paidCheck.output_lines.at(-1)!, /not re-narrated automatically: a paid voice stays manual/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('a newer job that skipped every file never donates its voice to automatic repair', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Skip only donor', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Skip only donor')
    await seedChapters(project.slug, code, [{ slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1', extra: { speed: 1.1 } }])

    // Newer and done, with a different voice — but it never produced these bytes and
    // carries none of their request identities.
    const skippedJob = narrationJob(project.slug, code, { model: 'studio-hub::other-free', voice: 'v2', speed: 0.9 })
    await markDone(project.slug, skippedJob.job_id, { output_lines: ['Existing audio was already present; active source selection was left unchanged.'] })

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [{ slug: 'Chapter_09', sentences: ['The lantern swayed above the quiet harbour wall.'] }])

    const redo = await redoFor(project.slug, check.job_id)
    assert.ok(redo, 'a targeted redo was queued')
    assert.equal(redo!.params.model, 'studio-hub::breeze', 'the producing voice, not the newer skip-only job')
    assert.equal(redo!.params.voice, 'v1')
    assert.equal(redo!.params.speed, 1.1, "the producer's stored request input is kept")
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('a split chapter is refused unless one job covers every recorded part identity', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Partial producer', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Partial producer')
    // Provenance records two parts; the seeded job carries only the first.
    await seedChapters(project.slug, code, [{
      slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1', partNames: [`${code}_Chapter_09_part1.mp3`],
    }])
    const paths = await episodePaths(project.slug, code)
    const entryPath = path.join(paths.episode_dir, 'audio_quality.json')
    const provenance = JSON.parse(await fs.readFile(entryPath, 'utf8'))
    const joined = `${code}_Chapter_09.mp3`
    const hash = await hashSubtitleAudioSources([path.join(paths.audio_dir, joined)])
    provenance.chapters.Chapter_09.tts.idempotency_keys[`${code}_Chapter_09_part2.mp3`] = 'idem-Chapter_09-part2'
    provenance.chapters.Chapter_09.tts.task_ids[`${code}_Chapter_09_part2.mp3`] = 'task-Chapter_09-part2'
    provenance.chapters.Chapter_09.source_audio_hash = hash
    await fs.writeFile(entryPath, JSON.stringify(provenance))

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [{ slug: 'Chapter_09', sentences: ['Gulls settled along the darkening pier.'] }])

    assert.equal(await redoFor(project.slug, check.job_id), undefined, 'a part-only producer is not accepted')
    assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_09'])
    assert.match(check.output_lines.at(-1)!, /could not be identified/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('legacy provenance without producer identities is refused, not guessed', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Legacy provenance', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Legacy provenance')
    await seedChapters(project.slug, code, [{ slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1', withoutIdentity: true }])

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [{ slug: 'Chapter_09', sentences: ['Night came softly over the water.'] }])

    assert.equal(await redoFor(project.slug, check.job_id), undefined, 'no redo without a producer link')
    assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_09'])
    assert.match(check.output_lines.at(-1)!, /could not be identified/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('a selector that no longer matches provenance is refused', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Selector moved', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Selector moved')
    const { paths } = await seedChapters(project.slug, code, [{ slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1' }])
    // The selector now points at a different take than the one provenance describes.
    const other = `${code}_Chapter_09_v2.mp3`
    await fs.writeFile(path.join(paths.audio_dir, other), 'audio:other-take')
    await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'),
      JSON.stringify({ sections: [{ slug: 'Chapter_09', source_file: other, source_files: [other] }] }))

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [{ slug: 'Chapter_09', sentences: ['The lantern swayed above the quiet harbour wall.'] }])

    assert.equal(await redoFor(project.slug, check.job_id), undefined, 'the moved selection is not described by provenance')
    assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_09'])
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('chapters produced by different voices are refused, not guessed', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Mixed voices', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Mixed voices')
    await seedChapters(project.slug, code, [
      { slug: 'Chapter_08', model: 'studio-hub::breeze', voice: 'v1' },
      { slug: 'Chapter_09', model: 'studio-hub::other-free', voice: 'v2' },
    ])

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [
      { slug: 'Chapter_08', sentences: ['Gulls settled along the darkening pier.'] },
      { slug: 'Chapter_09', sentences: ['Night came softly over the water.'] },
    ])

    assert.equal(await redoFor(project.slug, check.job_id), undefined, 'no single repair voice is invented')
    assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_08', 'Chapter_09'])
    assert.match(check.output_lines.at(-1)!, /different voices/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('chapters made with different synthesis settings under one voice are refused', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Mixed settings', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Mixed settings')
    await seedChapters(project.slug, code, [
      { slug: 'Chapter_08', model: 'studio-hub::breeze', voice: 'v1', extra: { speed: 1.0 } },
      { slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1', extra: { speed: 1.4 } },
    ])

    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, [
      { slug: 'Chapter_08', sentences: ['Gulls settled along the darkening pier.'] },
      { slug: 'Chapter_09', sentences: ['Night came softly over the water.'] },
    ])

    assert.equal(await redoFor(project.slug, check.job_id), undefined, 'one run cannot replay two settings')
    assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_08', 'Chapter_09'])
    assert.match(check.output_lines.at(-1)!, /different synthesis settings/)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('refuses when provenance is stale, selector is malformed, or checkpoint identity is non-TTS/pending', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const cases: Array<{
      name: string
      mutate: (paths: Awaited<ReturnType<typeof episodePaths>>, code: string, slug: string) => Promise<void>
      match: RegExp
    }> = [
      {
        name: 'stale bytes on disk',
        mutate: async (paths, code) => {
          // Overwrite the active file so its hash no longer matches provenance.
          await fs.writeFile(path.join(paths.audio_dir, `${code}_Chapter_09.mp3`), 'audio:replaced-take')
        },
        match: /could not be identified/,
      },
      {
        name: 'malformed selector sections',
        mutate: async (paths) => {
          await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'), '{"sections":"not-an-array"}')
        },
        match: /could not be identified/,
      },
      {
        name: 'selector missing chapter row',
        mutate: async (paths) => {
          await fs.writeFile(path.join(paths.episode_dir, 'audio_chapters.json'),
            JSON.stringify({ sections: [{ slug: 'Chapter_99', source_files: ['x.mp3'] }] }))
        },
        match: /could not be identified/,
      },
      {
        name: 'checkpoint asset is not tts',
        mutate: async (paths, code, slug) => {
          const entryPath = path.join(paths.episode_dir, 'audio_quality.json')
          const prov = JSON.parse(await fs.readFile(entryPath, 'utf8'))
          const joined = `${code}_Chapter_09.mp3`
          // Provenance still references the original idempotency key; rewrite the
          // job's recovery asset to a non-tts operation so coverage fails.
          const jobId = Object.values(prov.chapters.Chapter_09.tts.idempotency_keys)[0]!
          const jobs = await jq.getJobs(slug, { type: 'audio' })
          const producer = jobs.find(j => j.params?.genstudio_recovery?.assets?.[joined]?.idempotency_key === jobId)
          assert.ok(producer, 'seeded producer must exist')
          await jq.mutateAuthoritativeJob(slug, producer!.job_id, current => ({
            ...current,
            params: {
              ...current.params,
              genstudio_recovery: {
                version: 1, route: 'genstudio',
                assets: { [joined]: { operation: 'image', state: 'succeeded', idempotency_key: jobId, updated_at: new Date().toISOString() } },
              },
            },
          }))
        },
        match: /could not be identified/,
      },
      {
        name: 'checkpoint asset is pending (not succeeded)',
        mutate: async (paths, code, slug) => {
          const entryPath = path.join(paths.episode_dir, 'audio_quality.json')
          const prov = JSON.parse(await fs.readFile(entryPath, 'utf8'))
          const joined = `${code}_Chapter_09.mp3`
          const jobId = Object.values(prov.chapters.Chapter_09.tts.idempotency_keys)[0]!
          const jobs = await jq.getJobs(slug, { type: 'audio' })
          const producer = jobs.find(j => j.params?.genstudio_recovery?.assets?.[joined]?.idempotency_key === jobId)
          assert.ok(producer)
          await jq.mutateAuthoritativeJob(slug, producer!.job_id, current => ({
            ...current,
            params: {
              ...current.params,
              genstudio_recovery: {
                version: 1, route: 'genstudio',
                assets: { [joined]: { operation: 'tts', state: 'running', idempotency_key: jobId, updated_at: new Date().toISOString() } },
              },
            },
          }))
        },
        match: /could not be identified/,
      },
    ]

    for (const c of cases) {
      const project = await pm.createProject({ name: `Refusal ${c.name}`, episode_prefix: 'EP', episode_digits: 4 })
      const code = await acceptedEpisode(project.slug, c.name)
      const { paths } = await seedChapters(project.slug, code, [{ slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1' }])
      await c.mutate(paths, code, project.slug)
      const check = subtitleCheck(project.slug, code, 'Subtitles')
      await queueAutoRenarrate(check, [{ slug: 'Chapter_09', sentences: ['The lantern swayed above the quiet harbour wall.'] }])
      assert.equal(await redoFor(project.slug, check.job_id), undefined, `${c.name}: no redo queued`)
      assert.deepEqual(check.result?.renarrate_needs_owner, ['Chapter_09'], `${c.name}: owner fallback set`)
      assert.match(check.output_lines.at(-1)!, c.match, `${c.name}: message matches`)
    }
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})

test('consolidated success: joined filename with original part keys, full coverage, newer skip-only job ignored', async () => {
  const wasPaused = jq.isQueuePaused()
  await jq.setQueuePaused(true)
  try {
    const project = await pm.createProject({ name: 'Consolidated success', episode_prefix: 'EP', episode_digits: 4 })
    const code = await acceptedEpisode(project.slug, 'Consolidated success')
    // Seed with explicit original part names; provenance records them, but the
    // active file on disk is the joined base (as commitJoin produces).
    const partNames = [`${code}_Chapter_09_part1.mp3`, `${code}_Chapter_09_part2.mp3`]
    const { paths } = await seedChapters(project.slug, code, [{
      slug: 'Chapter_09', model: 'studio-hub::breeze', voice: 'v1',
      extra: { speed: 1.2, controls: { warmth: 0.7 } }, partNames,
    }])
    // seedChapters writes the joined file; ensure part files also exist so the
    // per-part checkpoint identities are grounded on disk.
    for (const part of partNames) {
      await fs.writeFile(path.join(paths.audio_dir, part), `audio:${part}`)
    }

    // Newer skip-only job with a different voice — must NOT be chosen.
    const skipOnly = narrationJob(project.slug, code, { model: 'studio-hub::other-free', voice: 'v2', speed: 0.9 })
    await markDone(project.slug, skipOnly.job_id, { output_lines: ['Existing audio was already present; active source selection was left unchanged.'] })

    const skipped = [{ slug: 'Chapter_09', sentences: ['Night came softly over the water.'] }]
    const check = subtitleCheck(project.slug, code, 'Subtitles')
    await queueAutoRenarrate(check, skipped)

    const redo = await redoFor(project.slug, check.job_id)
    assert.ok(redo, 'redo queued from consolidated provenance')
    assert.equal(redo!.params.model, 'studio-hub::breeze')
    assert.equal(redo!.params.voice, 'v1')
    assert.equal(redo!.params.speed, 1.2, 'full synthesis config preserved')
    assert.deepEqual(redo!.params.controls, { warmth: 0.7 })
    assert.equal(redo!.params.sections, 'Chapter_09')
    assert.deepEqual(redo!.params.redo_sentences, { Chapter_09: skipped[0]!.sentences })
    assert.equal(redo!.params.then_subtitles, true)
    assert.equal(redo!.params.force, false)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    if (!wasPaused) await jq.setQueuePaused(false)
    await jq._waitForJobPersistenceForTesting()
  }
})
