/**
 * Narration pauses end to end. Without a channel override nothing is sent and
 * every seam uses the uniform rule (owner 2026-10-03: 0.6 s after a sentence,
 * 1.0 s at a paragraph). With one, the Audio Generator sends
 * `paragraph_pause_sec` / `sentence_pause_sec` with every narration request
 * when the model publishes them, and Story's own part seams use the same
 * pauses. With an older Hub (no `pause_parameters`) nothing is sent, the job
 * says so, and the seams still get the chapter's pauses.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { generateAudio, resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { readPartsManifest } = await import('../services/chapter-parts.js')

const MODEL = {
  id: 'tiny-model', display_name: 'Tiny', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 40,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}
const PAUSES = [
  { name: 'paragraph_pause_sec', minimum: 0, maximum: 3, default: 1.0 },
  { name: 'sentence_pause_sec', minimum: 0, maximum: 3, default: 0.6 },
]

async function run(name: string, model: Record<string, unknown>,
  pauses: Record<string, number> = { paragraph_pause_sec: 1, sentence_pause_sec: 0.3 }) {
  const service = await startMockGenStudioService()
  try {
    await setGenStudioUrl(service.baseUrl)
    await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    service.ttsModels = [model as any]
    clearGenStudioCatalogCache()
    const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
    const narrationDir = path.join((await pm.getProjectOutputRoot(project.slug))!, 'EP001 - Script')
    await fs.mkdir(narrationDir, { recursive: true })
    await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
      '# Narration', '## Chapter 1: One',
      'First sentence is here. Second sentence is here.', 'Third paragraph is here.',
    ].join('\n\n'))
    const job: any = {
      job_id: `audio-${name}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001',
      title: name, status: 'running', created_at: new Date().toISOString(),
      started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', model: 'tiny-model', voice: 'mock-voice', sections: 'all', speed: 1,
        force: false, no_overwrite: false, ...pauses },
    }
    await generateAudio(job)
    const bodies = service.requests
      .filter(request => request.method === 'POST' && request.path === '/v1/audio/jobs')
      .map(request => JSON.parse(request.bodyText))
    const narration = await findNarrationFile(project.slug, 'EP001')
    const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
    const [chapterFile] = (await fs.readdir(audioDir)).filter(file => file.endsWith('.mp3'))
    const manifest = (await readPartsManifest(audioDir, chapterFile!.replace(/\.mp3$/, '')))!
    return { job, bodies, manifest }
  } finally {
    clearGenStudioCatalogCache()
    await service.close()
  }
}

void test('a model that publishes the pauses gets them on every part; seams follow them', async () => {
  const { job, bodies, manifest } = await run('pauses-published', { ...MODEL, pause_parameters: PAUSES })
  assert.equal(bodies.length, 3, job.output_lines.join('\n'))
  for (const body of bodies) {
    assert.equal(body.paragraph_pause_sec, 1)
    assert.equal(body.sentence_pause_sec, 0.3)
  }
  assert.deepEqual(manifest.parts.map(part => part.pause_after_s), [0.3, 1, undefined])
  assert.ok(job.output_lines.some((line: string) => /1 s at a paragraph break, 0\.3 s after a sentence\.$/.test(line)))
})

void test('without an override nothing is sent and the seams use the uniform 0.6 s / 1.0 s', async () => {
  const { job, bodies, manifest } = await run('pauses-default', { ...MODEL, pause_parameters: PAUSES }, {})
  assert.equal(bodies.length, 3, job.output_lines.join('\n'))
  for (const body of bodies) assert.equal(JSON.stringify(body).includes('pause'), false)
  assert.deepEqual(manifest.parts.map(part => part.pause_after_s), [0.6, 1, undefined])
})

void test('an older Hub gets no pause fields, the job says so, and the seams still use them', async () => {
  const { job, bodies, manifest } = await run('pauses-unpublished', MODEL)
  assert.equal(bodies.length, 3, job.output_lines.join('\n'))
  for (const body of bodies) assert.equal(JSON.stringify(body).includes('pause'), false)
  assert.deepEqual(manifest.parts.map(part => part.pause_after_s), [0.3, 1, undefined])
  assert.ok(job.output_lines.some((line: string) => /older version of the Mac app/.test(line)), job.output_lines.join('\n'))
  await temp.cleanup()
})
