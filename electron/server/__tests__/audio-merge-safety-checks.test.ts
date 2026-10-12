/**
 * 1.4.300 — Audio Assembly's "All chapter audio present" (Block by default) and "Intro audio file
 * found" (Warn by default) safety checks: Off/Warn join what is there; Block stops as before.
 * ZERO paid calls: the voice catalogue the chapter list is read against is a local mock.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const { generateAudioMerge, scanEpisodeAudioAssets } = await import('../generators/audio-merge.js')
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

test.after(async () => {
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

/** Two chapters in the script; only Chapter 1 has audio. */
async function episodeMissingChapterTwo() {
  const project = await pm.createProject({ name: `Merge safety ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3 })
  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Test')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.', '## Chapter 2: Two', 'The second chapter is short.',
  ].join('\n\n'))
  const audioDir = await resolveAudioDir(project.slug, await findNarrationFile(project.slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  assert.equal((await scanEpisodeAudioAssets(project.slug, 'EP001')).audio_dir, audioDir, 'one audio folder for both readers')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'libmp3lame', path.join(audioDir, 'EP001_Chapter_01.mp3')])
  const run = (params: Record<string, unknown> = {}) => {
    const job: any = {
      job_id: `merge-${Math.random().toString(36).slice(2)}`, project_slug: project.slug, type: 'audio_merge',
      episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
      started_at: null, finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, ...params },
    }
    return generateAudioMerge(job).then(() => job)
  }
  return { slug: project.slug, run }
}

void test('chapter_audio_present: Block (default) stops on a missing chapter; Off joins the chapters that are there', async () => {
  const ep = await episodeMissingChapterTwo()
  await assert.rejects(ep.run(), /Audio Assembly is blocked: 1 required audio file\(s\) are missing: EP001_Chapter_02\.mp3/)
  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'off' } } as any)
  const job = await ep.run()
  assert.ok(job.output_lines.some((line: string) => /EP001_Chapter_02\.mp3\)\. Story joins the narration from the chapters that are there/.test(line)), job.output_lines.join('\n'))
  assert.equal(job.result?.complete, true)
})

void test('intro_audio: Warn (default) assembles without a missing intro; Block stops as before', async () => {
  const ep = await episodeMissingChapterTwo()
  const intro = { enabled: true, file: path.join(temp.dir, 'no-such-intro.mp3'), volume: 1, gap_after: 0 }
  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'off', intro_audio: 'block' } } as any)
  await assert.rejects(ep.run({ intro }), /no-such-intro\.mp3/)
  await pm.updateConfig(ep.slug, { safety_checks: { chapter_audio_present: 'off' } } as any)
  const job = await ep.run({ intro })
  assert.ok(job.result?.safety_warnings?.some((warning: any) => warning.check === 'intro_audio'), job.output_lines.join('\n'))
  assert.ok(job.output_lines.some((line: string) => /Opening recorded: no intro/.test(line)), job.output_lines.join('\n'))
})
