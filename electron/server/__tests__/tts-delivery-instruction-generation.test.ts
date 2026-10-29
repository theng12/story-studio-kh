/**
 * Delivery / emotion at the REAL audio-generation boundary (owner, 2026-10-29).
 *
 * The reading side and the request builder have unit tests (`tts-delivery-instruction.test.ts`),
 * and the generator's refusal was pinned by asserting source text. That cannot fail if the guard
 * is wired to the wrong value, placed after the request, or skipped by a catalogue row that
 * publishes no control. These tests run `generateAudio` against the in-process mock Gateway:
 *
 *   - a non-empty instruction on a model whose live catalogue row publishes no
 *     `delivery_instruction` control → loud refusal, and no TTS request is made;
 *   - a model that publishes it → the instruction rides top-level on the request and is recorded
 *     on the take's provenance (the part manifest + the chapter's activation record);
 *   - a published limit of 0 characters → its own reason, never "this model does not take one".
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

const MODEL = {
  id: 'delivery-model', display_name: 'Delivery Model', provider_id: 'p', provider_name: 'Mock provider',
  description: '', credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 5_000,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [] as unknown[],
}

/** The control exactly as the Gateway publishes it for a model that takes a direction. */
const PUBLISHED_CONTROL = {
  name: 'delivery_instruction',
  label: 'Delivery / emotion',
  type: 'text',
  max_length: 500,
  guidance: { kind: 'free text', text: 'Describe the voice, not the words.' },
}

interface Run {
  job: any
  error: Error | null
  bodies: any[]
  audioDir: string
  episodeDir: string
}

/** Run the real generator against the mock Gateway, collecting the wire bodies it sent. */
async function run(name: string, model: Record<string, unknown>, instruction?: string): Promise<Run> {
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
      'Every evening the river remembered a different name.',
    ].join('\n\n'))

    const job: any = {
      job_id: `audio-${name}`, project_slug: project.slug, type: 'audio', episode_id: 'EP001',
      title: name, status: 'running', created_at: new Date().toISOString(),
      started_at: new Date().toISOString(), finished_at: null, error: null, output_lines: [],
      params: {
        episode_id: 'EP001', model: model.id, voice: 'mock-voice', sections: 'all', speed: 1,
        force: false, no_overwrite: false,
        ...(instruction !== undefined ? { delivery_instruction: instruction } : {}),
      },
    }

    let error: Error | null = null
    try { await generateAudio(job) } catch (caught: any) { error = caught }

    const bodies = service.requests
      .filter(request => request.method === 'POST' && request.path === '/v1/audio/jobs')
      .map(request => JSON.parse(request.bodyText))
    const narration = await findNarrationFile(project.slug, 'EP001')
    const audioDir = await resolveAudioDir(project.slug, narration, 'EP001')
    return { job, error, bodies, audioDir, episodeDir: path.dirname(narrationDir) }
  } finally {
    clearGenStudioCatalogCache()
    await service.close()
  }
}

test('an instruction on a model that publishes no control is refused before any TTS request', async () => {
  const result = await run('delivery-refused', MODEL, 'Warm and unhurried.')

  assert.ok(result.error, 'the generator must refuse, not drop the instruction')
  assert.match(result.error!.message, /does not take a delivery\/emotion instruction/)
  assert.match(result.error!.message, /Clear it on the Audio tab/)
  assert.equal(result.bodies.length, 0, 'nothing was sent to the Gateway')
  // No take was written either: a refused run leaves no half-made narration.
  assert.deepEqual(await fs.readdir(result.audioDir).catch(() => [] as string[]), [])
})

test('a published control sends the instruction top-level and records it on the take', async () => {
  const result = await run('delivery-published', { ...MODEL, controls: [PUBLISHED_CONTROL] }, 'Warm and unhurried.')
  assert.equal(result.error, null, (result.error as Error | null)?.message)

  assert.ok(result.bodies.length > 0, 'the narration was actually requested')
  for (const body of result.bodies) {
    assert.equal(body.delivery_instruction, 'Warm and unhurried.', 'top-level, as the Gateway takes it')
    assert.equal(body.controls, undefined, 'never duplicated inside controls')
  }

  // The part manifest is the per-take provenance the Audio page reads back.
  const manifest = JSON.parse(await fs.readFile(path.join(result.audioDir, '.task-manifest.json'), 'utf8'))
  const entries = Object.values(manifest.tasks) as any[]
  assert.ok(entries.length > 0)
  for (const entry of entries) {
    assert.equal(entry.tts?.delivery_instruction, 'Warm and unhurried.')
    assert.equal(entry.tts?.model_id, MODEL.id)
  }
  // …and the chapter's activation record, which describes the take now in use.
  const quality = JSON.parse(await fs.readFile(path.join(result.episodeDir, 'audio_quality.json'), 'utf8'))
  const chapters = Object.values(quality.chapters) as any[]
  assert.ok(chapters.length > 0)
  assert.equal(chapters[0].tts?.delivery_instruction, 'Warm and unhurried.')

  // The Audio page reads this take through `takeProvenance`; both recorded sources agree.
  const { takeProvenance } = await import('../services/audio-take-provenance.js')
  const facts = await takeProvenance({
    episodeDir: result.episodeDir, audioDir: result.audioDir, section: 'Chapter_01',
    files: chapters[0].source_files, active: true,
  })
  assert.equal(facts.delivery_instruction, 'Warm and unhurried.')
  assert.deepEqual([...facts.sources].sort(), ['audio-quality', 'task-manifest'])
})

test('a published 0-character limit says so, rather than “does not take an instruction”', async () => {
  const result = await run('delivery-zero-limit', {
    ...MODEL, controls: [{ ...PUBLISHED_CONTROL, max_length: 0 }],
  }, 'Warm.')

  assert.ok(result.error)
  assert.match(result.error!.message, /publishes a 0-character delivery\/emotion limit/)
  assert.doesNotMatch(result.error!.message, /does not take a delivery\/emotion instruction/)
  assert.match(result.error!.message, /Clear it on the Audio tab/)
  assert.equal(result.bodies.length, 0)
})
