/**
 * Audio Assembly writes exactly one audio file per merge: the episode's MP3.
 *
 * This runs a REAL merge and reads its output folder. Nothing here asserts a flag —
 * the folder itself is the proof.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { after } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudioMerge } = await import('../generators/audio-merge.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
service.ttsModels = [{
  id: 'roomy-model', display_name: 'roomy-model', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 4_000,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}] as any
clearGenStudioCatalogCache()

after(async () => {
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

const AUDIO = /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm)$/i

test('a real merge leaves exactly one audio file in its output folder: the MP3', async () => {
  const project = await pm.createProject({
    name: `MP3 only ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3,
  })
  await pm.updateConfig(project.slug, { safety_checks: { chapter_audio_present: 'off' } } as any)

  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const episodeDir = path.join(outputRoot, 'EP001 - Test')
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.',
  ].join('\n\n'))

  const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
  const audioDir = await resolveAudioDir(project.slug, await findNarrationFile(project.slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:a', 'libmp3lame', path.join(audioDir, 'EP001_Chapter_01.mp3')])

  const job: any = {
    job_id: `merge-${Math.random().toString(36).slice(2)}`, project_slug: project.slug, type: 'audio_merge',
    episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
    started_at: null, finished_at: null, error: null, output_lines: [],
    params: { episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false },
  }
  await generateAudioMerge(job)

  const dir = job.output_dir as string
  const audio = (await fs.readdir(dir)).filter(name => AUDIO.test(name))
  assert.deepEqual(audio, ['EP001_merged_audio.mp3'],
    `the merge's output folder held: ${audio.join(', ') || '(no audio)'} — it must hold the MP3 and nothing else`)
  assert.equal(await fs.stat(path.join(dir, 'EP001_merged_audio.master.flac')).catch(() => null), null)

  const record = JSON.parse(await fs.readFile(path.join(dir, 'EP001_merged_audio.completion.json'), 'utf8'))
  assert.equal(record.master_filename, undefined)
  assert.equal(record.output_filename, 'EP001_merged_audio.mp3')
})
