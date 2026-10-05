import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { JobType } from '../models/types.js'
import { resolveJobAutoRetryPolicy } from '../services/job-retry-policy.js'
import { terminalRetryIdentity } from '../generators/audio.js'

function policy(type: JobType, params: Record<string, any> = {}) {
  return resolveJobAutoRetryPolicy({ type, params })
}

describe('local auto-retry policy', () => {
  test('leaves Gateway durable recovery to the Gateway and never duplicates provider work', () => {
    assert.equal(policy('subtitles_transcribe', { engine: 'genstudio' }).eligible, false)
    assert.match(
      policy('subtitles_transcribe', { engine: 'genstudio' }).reason,
      /reconnects accepted Gateway tasks/,
    )
    // Queued pre-migration values are also manual-only while the generator
    // heals them onto GenStudio.
    assert.equal(policy('subtitles_transcribe', { engine: 'voicestudio' }).eligible, false)
    assert.equal(policy('subtitles_transcribe', { engine: 'openai' }).eligible, false)
    assert.equal(policy('subtitles_transcribe', {}).eligible, false)
  })

  test('retries local TTS but not cloud audio providers', () => {
    assert.equal(policy('audio', { model: 'voicestudio-kokoro' }).eligible, true)
    assert.equal(policy('audio', { model: 'macos-say' }).eligible, true)
    assert.equal(policy('audio', { model: 'fishaudio-s2-pro' }).eligible, false)
    assert.equal(policy('audio', { model: 'kie-elevenlabs' }).eligible, false)
  })

  test('retries free fleet TTS parts twice, then manual; paid Gateway voices stay manual', () => {
    // Breeze night-atlas 2026-10-05: 6 episodes were left with one failed free part.
    const fleet = policy('audio', { model: 'studio-hub::mlx-community/Breeze-TTS-2-mlx-4bit' })
    assert.equal(fleet.eligible, true)
    assert.equal(fleet.max_attempts, 3)
    assert.match(fleet.reason, /only the missing parts/)
    assert.equal(policy('audio', { model: 'studio-hub-9701220bf30f::breeze' }).eligible, true)
    assert.equal(policy('audio', { model: 'genstudio::paid-voice' }).eligible, false)
    assert.equal(policy('audio', { model: 'elevenlabs::eleven_v3' }).eligible, false)
    assert.equal(policy('audio', { model: 'studio-hub::breeze', auto_retry: false }).eligible, false)
  })

  test('each automatic retry of a failed part asks the Gateway under a fresh identity', () => {
    const base = 'proj:EP01:audio:TN_Chapter_01.mp3'
    // Attempt 1 keeps the identity a manual Retry has always used.
    assert.equal(terminalRetryIdentity(base, 'job-42'), `${base}:manual-retry:job-42`)
    assert.equal(terminalRetryIdentity(base, 'job-42', 1), `${base}:manual-retry:job-42`)
    const keys = new Set([1, 2, 3].map(attempt => terminalRetryIdentity(base, 'job-42', attempt)))
    assert.equal(keys.size, 3, 'a repeated key would replay the same failed Gateway job')
  })

  test('retries local image generation but not image APIs', () => {
    assert.equal(policy('continuity_render', { model: 'imagestudio:org/model' }).eligible, true)
    assert.equal(policy('thumb_images', { model: 'gpt-image-1' }).eligible, false)
    assert.equal(policy('thumb_images', { model: 'flux-kontext-pro' }).eligible, false)
  })

  test('retries local Chat Studio models but not its cloud proxy catalog', () => {
    assert.equal(policy('image_prompts', { model: 'chatstudio:mlx-community/gemma' }).eligible, true)
    assert.equal(policy('metadata', { model: 'chatstudio:provider:openrouter:free-model' }).eligible, false)
    assert.equal(policy('outline_only', { model: 'deepseek-v4-flash' }).eligible, false)
  })

  test('retries deterministic timeline and local assembly work', () => {
    assert.equal(policy('scene_plan_run', { stage: 'timeline' }).eligible, true)
    const genStudioPromptRun = policy('scene_plan_run', {
      stage: 'visual',
      model: 'genstudio-chat:genstudio-chat-test-v1',
    })
    assert.equal(genStudioPromptRun.eligible, false)
    assert.match(genStudioPromptRun.reason, /ID-scoped Gateway prompt repair/)
    assert.equal(policy('audio_merge').eligible, true)
    assert.equal(policy('video_assembly').eligible, true)
    assert.equal(policy('broll_normalize').eligible, true)
  })

  test('keeps all external API and provider recovery jobs manual-only', () => {
    assert.equal(policy('youtube_upload').eligible, false)
    assert.equal(policy('video').eligible, false)
    assert.equal(policy('scene_clip_generate').eligible, false)
    assert.equal(policy('images_repair').eligible, false)
    assert.equal(policy('research_run').eligible, false)
  })

  test('retries only the explicitly local research adapter', () => {
    assert.equal(policy('research_run', {
      source_provider: 'llm-only',
      model: 'chatstudio:mlx-community/gemma',
    }).eligible, true)
    assert.equal(policy('research_run', {
      source_provider: 'llm-only',
      model: 'deepseek-v4-flash',
    }).eligible, false)
    assert.equal(policy('research_run', {
      source_provider: 'tavily',
      model: 'chatstudio:mlx-community/gemma',
    }).eligible, false)
  })

  test('uses two bounded retries for local work and honours an explicit disable', () => {
    const local = policy('audio', { model: 'macos-say' })
    assert.equal(local.max_attempts, 3)
    assert.deepEqual(local.delays_ms, [2_000, 8_000])
    assert.equal(policy('audio', { model: 'macos-say', auto_retry: false }).eligible, false)
  })
})
