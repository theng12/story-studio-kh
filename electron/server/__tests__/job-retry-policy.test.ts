import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { JobType } from '../models/types.js'
import { resolveJobAutoRetryPolicy } from '../services/job-retry-policy.js'

function policy(type: JobType, params: Record<string, any> = {}) {
  return resolveJobAutoRetryPolicy({ type, params })
}

describe('local auto-retry policy', () => {
  test('retries Voice Studio subtitles but never OpenAI Whisper', () => {
    assert.equal(policy('subtitles_transcribe', { engine: 'voicestudio' }).eligible, true)
    assert.equal(policy('subtitles_transcribe', { engine: 'openai' }).eligible, false)
    assert.equal(policy('subtitles_transcribe', {}).eligible, false)
  })

  test('retries local TTS but not cloud audio providers', () => {
    assert.equal(policy('audio', { model: 'voicestudio-kokoro' }).eligible, true)
    assert.equal(policy('audio', { model: 'macos-say' }).eligible, true)
    assert.equal(policy('audio', { model: 'fishaudio-s2-pro' }).eligible, false)
    assert.equal(policy('audio', { model: 'kie-elevenlabs' }).eligible, false)
  })

  test('retries local image generation but not image APIs', () => {
    assert.equal(policy('scene_images_batch', { model: 'imagestudio:org/model' }).eligible, true)
    assert.equal(policy('images', { model: 'gpt-image-1' }).eligible, false)
    assert.equal(policy('thumb_images', { model: 'flux-kontext-pro' }).eligible, false)
  })

  test('retries local Chat Studio models but not its cloud proxy catalog', () => {
    assert.equal(policy('image_prompts', { model: 'chatstudio:mlx-community/gemma' }).eligible, true)
    assert.equal(policy('metadata', { model: 'chatstudio:provider:openrouter:free-model' }).eligible, false)
    assert.equal(policy('outline_only', { model: 'deepseek-v4-flash' }).eligible, false)
  })

  test('retries deterministic timeline and explicitly local assembly work', () => {
    assert.equal(policy('scene_plan_run', { stage: 'timeline' }).eligible, true)
    assert.equal(policy('audio_merge').eligible, true)
    assert.equal(policy('video_assembly', { render_target: 'local' }).eligible, true)
    assert.equal(policy('video_assembly', { render_target: 'remote' }).eligible, false)
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

  test('uses two bounded retries and honours an explicit disable', () => {
    const local = policy('subtitles_transcribe', { engine: 'voicestudio' })
    assert.equal(local.max_attempts, 3)
    assert.deepEqual(local.delays_ms, [2_000, 8_000])
    assert.equal(policy('subtitles_transcribe', { engine: 'voicestudio', auto_retry: false }).eligible, false)
  })
})
