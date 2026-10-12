/**
 * A split chapter whose one part failed: making that part again (Generate
 * missing, or Repair after a restart) activates and joins the chapter exactly
 * like a first-time complete run. Before: "Audio replacement could not be
 * activated … durable replacement evidence", then "already present" forever,
 * the parts never joined (TTS comparison test, EP0011, 2026-10-04).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir, findNarrationFile, episodeDirForNarration } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const jq = await import('../services/job-queue.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { readPartsManifest } = await import('../services/chapter-parts.js')
const { readAudioQualityProvenance } = await import('../services/audio-quality-store.js')
const { getAudioStatus, reconcileAudio } = await import('../services/audio-reconciler.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
const model = (id: string) => ({
  id, display_name: id, provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 40,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
})
service.ttsModels = [model('tiny-model'), model('other-model')]
clearGenStudioCatalogCache()
jq.registerExecutor('audio', job => generateAudio(job))

test.after(async () => {
  assert.equal(await jq.drainJobPersistenceForShutdown(2_000), true)
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

let projects = 0
async function episode() {
  const project = await pm.createProject({ name: `Partial rerun ${++projects}`, episode_prefix: 'EP', episode_digits: 3 })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Script')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One',
    'First sentence is here. Second sentence is here.', 'Third paragraph is here.',
  ].join('\n\n'))
  const narration = await findNarrationFile(project.slug, 'EP001')
  const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
  const params = (modelId = 'tiny-model') => ({
    episode_id: 'EP001', model: modelId, voice: 'mock-voice', sections: 'Chapter_01', speed: 1, force: false, no_overwrite: false,
  })
  let run = 0
  const direct = async (modelId?: string) => {
    const job: any = {
      job_id: `${project.slug}-${++run}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration',
      status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(),
      finished_at: null, error: null, output_lines: [], params: params(modelId),
    }
    await generateAudio(job)
    return job
  }
  const queued = async (extra: Record<string, unknown> = {}) => {
    const job = await jq.enqueue({ project_slug: project.slug, type: 'audio', episode_id: 'EP001', title: 'Narration', params: { ...params(), ...extra } })
    return settled(job.job_id)
  }
  const settled = async (jobId: string) => {
    await waitFor(() => ['done', 'error', 'cancelled'].includes(jq.getJob(jobId)?.status || ''), { label: 'audio job to settle', timeoutMs: 20_000 })
    return jq.getJob(jobId)!
  }
  const mp3s = async () => (await fs.readdir(audioDir)).filter(name => name.endsWith('.mp3')).sort()
  /** The chapter is one active, joined file — what a first-time complete run leaves. */
  const assertJoined = async () => {
    assert.deepEqual(await mp3s(), ['EP001_Chapter_01.mp3'], 'one visible file, no loose parts')
    assert.equal((await readPartsManifest(audioDir, 'EP001_Chapter_01'))?.parts.length, 3)
    const chapter = (await readAudioQualityProvenance(episodeDirForNarration(narration))).chapters.Chapter_01
    assert.deepEqual(chapter?.source_files, ['EP001_Chapter_01.mp3'])
    assert.equal(chapter?.tts?.model_id, 'tiny-model')
    const status = await getAudioStatus(project.slug, 'EP001')
    assert.deepEqual([status.missing, status.awaiting_join], [[], []])
  }
  return { project, audioDir, narration, direct, queued, settled, mp3s, assertJoined }
}

/** Part 2 of 3 fails at its provider (the next submission). */
function failNextPartTwo() {
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
  service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'provider_error', finalCredits: 0 })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'] })
}

void test('one part failed → Generate missing makes it and the chapter is activated and joined', async () => {
  const ep = await episode()
  const before = service.providerSubmissionCount('tts')
  failNextPartTwo()
  await assert.rejects(ep.direct(), /1 section\(s\) failed/)
  assert.deepEqual(await ep.mp3s(), ['EP001_Chapter_01_part1.mp3', 'EP001_Chapter_01_part3.mp3'])

  const second = await ep.direct()
  assert.equal(service.providerSubmissionCount('tts'), before + 4, 'only the failed part is made again')
  assert.ok(second.output_lines.some((line: string) => /Joined 3 parts of Chapter 01/.test(line)), second.output_lines.join('\n'))
  await ep.assertJoined()

  const third = await ep.direct()
  assert.ok(third.output_lines.some((line: string) => /already present/.test(line)), 'a later run is a no-op')
  assert.equal(service.providerSubmissionCount('tts'), before + 4)
})

void test('after a restart left every part on disk but the chapter inactive, Repair joins it without buying anything', async () => {
  const ep = await episode()
  failNextPartTwo()
  assert.equal((await ep.queued()).status, 'error')
  // The re-run makes part 2, then stops before activating (an unreadable
  // selection stands in for the restart): every part is on disk, none active.
  const selector = path.join(episodeDirForNarration(ep.narration), 'audio_chapters.json')
  await fs.writeFile(selector, '{')
  const cut = await ep.queued()
  assert.equal(cut.status, 'error')
  assert.match(cut.error || '', /could not be activated/)
  await fs.rename(selector, path.join(temp.dir, `unreadable-selector-${ep.project.slug}.json`))
  assert.equal((await ep.mp3s()).length, 3)
  const stuck = await getAudioStatus(ep.project.slug, 'EP001')
  assert.deepEqual([stuck.missing, stuck.awaiting_join], [[], ['Chapter_01']], 'nothing missing, yet the chapter waits to be joined')

  const submissions = service.providerSubmissionCount('tts')
  const repair = await reconcileAudio(ep.project.slug, 'EP001')
  assert.ok(!repair.logs.includes('Nothing to repair.'), repair.logs.join('\n'))
  assert.ok(repair.join_job_id, repair.logs.join('\n'))
  const join = await ep.settled(repair.join_job_id!)
  assert.equal(join.status, 'done', `${join.error}\n${join.output_lines.join('\n')}`)
  assert.equal(join.params.join_only, true)
  assert.equal(service.providerSubmissionCount('tts'), submissions, 'Repair makes nothing')
  await ep.assertJoined()
  assert.ok((await reconcileAudio(ep.project.slug, 'EP001')).logs.includes('Nothing to repair.'))
})

void test('parts left by another voice model are not activated with this one', async () => {
  const ep = await episode()
  failNextPartTwo()
  await assert.rejects(ep.direct(), /1 section\(s\) failed/)
  await assert.rejects(ep.direct('other-model'), /durable replacement evidence/)
  assert.deepEqual((await readAudioQualityProvenance(episodeDirForNarration(ep.narration))).chapters, {})
  assert.equal((await ep.mp3s()).length, 3, 'the parts stay loose')
})

/** A short, audible 440 Hz tone: real, decodable, not silent. */
function toneWav(): Buffer {
  const rate = 8_000
  const samples = 4_000
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2)
  return wav
}

void test('parts whose replacement record was lost are still activated when they are playable audio', async () => {
  const ep = await episode()
  const tone = toneWav()
  service.queueScenario('tts', { states: ['accepted', 'succeeded'], audioArtifact: tone })
  service.queueScenario('tts', { states: ['accepted', 'failed'], failureCode: 'provider_error', finalCredits: 0 })
  service.queueScenario('tts', { states: ['accepted', 'succeeded'], audioArtifact: tone })
  await assert.rejects(ep.direct(), /1 section\(s\) failed/)
  // The record of who made parts 1 and 3 is gone; the parts themselves are fine.
  await fs.writeFile(path.join(ep.audioDir, '.task-manifest.json'), JSON.stringify({ schema_version: 1, tasks: {} }))
  service.queueScenario('tts', { states: ['accepted', 'succeeded'], audioArtifact: tone })
  const second = await ep.direct()
  assert.ok(second.output_lines.some((line: string) => /replacement record was incomplete.*so it was activated/.test(line)), second.output_lines.join('\n'))
  await ep.assertJoined()
})

void test('a section the last Audio Assembly did not have joins the active selection (1.4.297, MineePod EP0003)', async () => {
  const ep = await episode()
  const selector = path.join(episodeDirForNarration(ep.narration), 'audio_chapters.json')
  await fs.writeFile(selector, JSON.stringify({ sections: [{ slug: 'Introduction', source_file: 'EP001_Introduction.mp3', source_files: ['EP001_Introduction.mp3'] }] }))
  const job = await ep.direct()
  assert.ok(!/has no row/.test(job.error || ''), job.output_lines.join('\n'))
  const saved = JSON.parse(await fs.readFile(selector, 'utf8'))
  assert.deepEqual(saved.sections.map((s: any) => s.slug), ['Introduction', 'Chapter_01'])
  assert.ok(saved.sections[1].source_files.length > 0)
})
