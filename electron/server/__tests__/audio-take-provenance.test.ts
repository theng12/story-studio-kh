/**
 * TTS provenance for narration takes (owner, 2026-10-26): the Audio page must
 * show the engine, model and voice that actually produced a take, read only
 * from what was recorded — the per-part `.task-manifest.json`, the chapter's
 * `audio_quality.json` activation record, and the episode's `audio_tts_model.json`.
 *
 * The two defects this pins:
 *   1. a take with no record reports `recorded: false` and shows NOTHING;
 *   2. two records that disagree do not get a winner picked for them, and the
 *      episode-level model is never attributed to a take that is not the active
 *      one (AGENTS.md §2, §4 — never infer, and ownership is looked up).
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const { takeProvenance } = await import('../services/audio-take-provenance.js')

let root: string
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'take-provenance-test-')) })
after(async () => { await fs.rm(root, { recursive: true, force: true }).catch(() => {}) })

async function episode(name: string): Promise<{ episodeDir: string; audioDir: string }> {
  const episodeDir = path.join(root, name)
  const audioDir = path.join(episodeDir, 'EP001 - 07 Audio Assets')
  await fs.mkdir(audioDir, { recursive: true })
  return { episodeDir, audioDir }
}

async function manifest(audioDir: string, tasks: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(audioDir, '.task-manifest.json'), JSON.stringify({ schema_version: 1, tasks }))
}

async function quality(episodeDir: string, chapter: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(episodeDir, 'audio_quality.json'), JSON.stringify({
    version: 1,
    chapters: { Chapter_01: chapter },
  }))
}

const baseChapter = {
  normalized_script_hash: 'script-hash', normalization: 'tts-v1', source_audio_hash: 'audio-hash',
  source_files: ['EP001_Chapter_01.mp3'], recorded_at: '2026-10-26T00:00:00.000Z',
}

describe('recorded producer facts', () => {
  test('the per-part manifest answers model, voice and the published engine facts', async () => {
    const { episodeDir, audioDir } = await episode('manifest')
    await manifest(audioDir, {
      'EP001_Chapter_01.mp3': {
        provider: 'genstudio', task_id: 'job-1', submitted_at: '2026-10-26T00:00:00.000Z', operation: 'tts',
        model_id: 'fish-audio-s2-1-pro',
        tts: {
          model_id: 'fish-audio-s2-1-pro', model_display_name: 'Fish Audio S2.1 Pro',
          voice_id: 'kh-voice-1', voice_display_name: 'Khmer Narrator',
          provider: 'Fish Audio', engine_name: 'S2.1', model_revision_id: 'rev-9', voice_revision: 'v3',
        },
      },
    })
    const facts = await takeProvenance({
      episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], active: true,
    })
    assert.equal(facts.recorded, true)
    assert.equal(facts.model_id, 'fish-audio-s2-1-pro')
    assert.equal(facts.model_display_name, 'Fish Audio S2.1 Pro')
    assert.equal(facts.voice_id, 'kh-voice-1')
    assert.equal(facts.voice_display_name, 'Khmer Narrator')
    assert.equal(facts.provider, 'Fish Audio')
    assert.equal(facts.engine_name, 'S2.1')
    assert.equal(facts.model_revision_id, 'rev-9')
    assert.equal(facts.voice_revision, 'v3')
    assert.deepEqual(facts.sources, ['task-manifest'])
  })

  test('the activation record fills the voice when the parts did not record it', async () => {
    const { episodeDir, audioDir } = await episode('quality')
    await manifest(audioDir, {
      'EP001_Chapter_01.mp3': { provider: 'genstudio', task_id: 'job-1', submitted_at: '2026-10-26T00:00:00.000Z', operation: 'tts', model_id: 'fish-audio-s2-1-pro' },
    })
    await quality(episodeDir, { ...baseChapter, tts: { model_id: 'fish-audio-s2-1-pro', voice_id: 'kh-voice-2', provider: 'Fish Audio' } })
    const facts = await takeProvenance({
      episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], active: true,
    })
    assert.equal(facts.voice_id, 'kh-voice-2')
    assert.deepEqual(facts.sources.sort(), ['audio-quality', 'task-manifest'])
  })

  test('the episode record answers only for the ACTIVE take', async () => {
    const { episodeDir, audioDir } = await episode('episode-record')
    await fs.writeFile(path.join(episodeDir, 'audio_tts_model.json'), JSON.stringify({
      schema_version: 1, episode_code: 'EP001', model_id: 'fish-audio-s2-1-pro',
      model_display_name: 'Fish Audio S2.1 Pro', provider_name: 'Fish Audio',
      published_maximum_input_characters: 25000, request_budget: 22500, safety_margin: 0.1,
      recorded_at: '2026-10-26T00:00:00.000Z',
    }))
    const active = await takeProvenance({ episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], active: true })
    assert.equal(active.model_id, 'fish-audio-s2-1-pro')
    assert.deepEqual(active.sources, ['audio_tts_model'])

    const spare = await takeProvenance({ episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01_v2.mp3'], active: false })
    assert.equal(spare.recorded, false)
    assert.equal(spare.model_id, undefined, 'the episode record describes the active audio, not an alternate take')
  })

  test('nothing recorded shows nothing — never a guess', async () => {
    const { episodeDir, audioDir } = await episode('nothing')
    const facts = await takeProvenance({ episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], active: true })
    assert.deepEqual(facts, { recorded: false, sources: [] })
  })

  test('parts recorded under two different models claim neither', async () => {
    const { episodeDir, audioDir } = await episode('conflict')
    await manifest(audioDir, {
      'EP001_Chapter_01_part1.mp3': { provider: 'genstudio', task_id: 'a', submitted_at: '2026-10-26T00:00:00.000Z', operation: 'tts', model_id: 'model-a' },
      'EP001_Chapter_01_part2.mp3': { provider: 'genstudio', task_id: 'b', submitted_at: '2026-10-26T00:00:00.000Z', operation: 'tts', model_id: 'model-b' },
    })
    const facts = await takeProvenance({
      episodeDir, audioDir, section: 'Chapter_01',
      files: ['EP001_Chapter_01_part1.mp3', 'EP001_Chapter_01_part2.mp3'], active: true,
    })
    assert.equal(facts.model_id, undefined)
    assert.equal(facts.recorded, false, 'a split take made under two models cannot be attributed to either')
  })

  test('a quality record for DIFFERENT files is not used for this take', async () => {
    const { episodeDir, audioDir } = await episode('wrong-files')
    await quality(episodeDir, { ...baseChapter, tts: { model_id: 'model-a', voice_id: 'voice-a' } })
    const facts = await takeProvenance({
      episodeDir, audioDir, section: 'Chapter_01', files: ['EP001_Chapter_01_v2.mp3'], active: false,
    })
    assert.equal(facts.recorded, false)
  })
})
