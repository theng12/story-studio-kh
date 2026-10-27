import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { JobType } from '../models/types.js'
import { resolveJobAutoRetryPolicy, isNonRetryableError } from '../services/job-retry-policy.js'
import { terminalRetryIdentity } from '../generators/audio.js'
import { ImagePromptsMissingError } from '../generators/images.js'

function policy(type: JobType, params: Record<string, any> = {}) {
  return resolveJobAutoRetryPolicy({ type, params })
}

describe('local auto-retry policy', () => {
  test('paid transcription stays manual; free-fleet Whisper retries by itself', () => {
    assert.equal(policy('subtitles_transcribe', { engine: 'genstudio' }).eligible, false)
    const paid = policy('subtitles_transcribe', { engine: 'genstudio', model: 'genstudio-whisper' })
    assert.equal(paid.eligible, false)
    assert.match(paid.reason, /Paid .* stays manual/)
    const free = policy('subtitles_transcribe', { engine: 'genstudio', model: 'studio-hub::whisper-turbo' })
    assert.equal(free.eligible, true)
    assert.deepEqual(free.delays_ms, [60_000, 300_000])
    assert.doesNotMatch(free.reason, /paid|never submitted twice/i, 'free work is not described as paid work')
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
    assert.deepEqual(fleet.delays_ms, [60_000, 300_000], 'a fleet Mac restarting is still down after 2 s and 8 s')
    assert.deepEqual(policy('audio', { model: 'voicestudio-kokoro' }).delays_ms, [2_000, 8_000], 'on-this-Mac TTS keeps the quick retry')
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

  test('retries local and free-fleet image generation but not paid image APIs', () => {
    assert.equal(policy('continuity_render', { model: 'imagestudio:org/model' }).eligible, true)
    const fleet = policy('continuity_render', { model: 'studio-hub::org/model' })
    assert.equal(fleet.eligible, true)
    assert.equal(fleet.max_attempts, 3)
    assert.deepEqual(fleet.delays_ms, [60_000, 300_000], 'a fleet hiccup lasts minutes; 2 s / 8 s burned all three attempts')
    assert.match(fleet.reason, /only the missing images/)
    assert.equal(policy('continuity_render', { model: 'studio-hub::org/model', auto_retry: false }).eligible, false)
    // Owner, 2026-10-07: every free-fleet image job retries by itself.
    for (const type of ['thumb_images', 'image_pool_generate', 'scene_image_generate', 'composition_generate'] as JobType[]) {
      const free = policy(type, { model: 'studio-hub::org/model' })
      assert.equal(free.eligible, true, type)
      assert.deepEqual(free.delays_ms, [60_000, 300_000], type)
      assert.equal(policy(type, { model: 'gpt-image-2' }).eligible, false, `paid ${type} stays manual`)
    }
    assert.equal(policy('thumb_images', { model: 'gpt-image-1' }).eligible, false)
    assert.equal(policy('thumb_images', { model: 'flux-kontext-pro' }).eligible, false)
  })

  test('chat work retries: local quickly, fleet and paid chat after minutes', () => {
    const local = policy('image_prompts', { model: 'chatstudio:mlx-community/gemma' })
    assert.equal(local.eligible, true)
    assert.deepEqual(local.delays_ms, [2_000, 8_000])
    const types: JobType[] = ['introduction-only', 'chapter-only', 'outline_only', 'expand_chapters', 'image_prompts',
      'metadata', 'contextual_cues', 'research_run', 'music_scene_polish', 'idea_campaign']
    for (const type of types) {
      for (const model of ['studio-hub::mlx-community/gemma', 'genstudio-chat:pool::gemini-free-all', 'pool::gemini-free-all', 'deepseek-v4-flash']) {
        const run = policy(type, { model })
        assert.equal(run.eligible, true, `${type} on ${model}`)
        assert.deepEqual(run.delays_ms, [60_000, 300_000], `${type} on ${model}`)
      }
    }
    assert.equal(policy('metadata', { model: 'chatstudio:provider:openrouter:free-model' }).eligible, true, 'paid chat may retry')
    assert.match(policy('metadata', { model: 'studio-hub::x' }).reason, /^Free writing/)
    assert.equal(policy('metadata', { model: 'studio-hub::x', auto_retry: false }).eligible, false)
  })

  test('judges the EFFECTIVE chat model: the Pipeline policy, then the default', () => {
    const pipeline = (stage: string, assigned: string, extra: Record<string, any> = {}) => ({
      pipeline_model_policy: { [stage]: { mode: 'single', models: [assigned], assigned_model: assigned } }, ...extra,
    })
    // Metadata via the policy (or the project default) has no params.model; it read as MANUAL.
    assert.equal(policy('metadata', pipeline('metadata', 'studio-hub::gemma')).eligible, true)
    assert.match(policy('metadata', pipeline('metadata', 'studio-hub::gemma')).reason, /^Free writing/)
    assert.match(policy('metadata', pipeline('metadata', 'studio-hub::gemma', { model: 'deepseek-v4-flash' })).reason, /^Free writing/,
      'the policy model, not a stale params.model, is the one that runs')
    assert.equal(policy('metadata', {}).eligible, true, 'no model = the project default chat model, which is still chat')
    assert.match(policy('expand_chapters', pipeline('script-only', 'studio-hub::q')).reason, /^Free writing/)
    assert.match(policy('contextual_cues', { settings: { model: 'studio-hub::q' } }).reason, /^Free writing/)
  })

  test('retries deterministic timeline and local assembly work', () => {
    assert.equal(policy('scene_plan_run', { stage: 'timeline' }).eligible, true)
    // Owner, 2026-10-07: paid chat prompts retry too — the earlier answer is collected by its
    // saved key first, so nothing is paid twice.
    const genStudioPromptRun = policy('scene_plan_run', {
      stage: 'visual',
      model: 'genstudio-chat:genstudio-chat-test-v1',
    })
    assert.equal(genStudioPromptRun.eligible, true)
    assert.deepEqual(genStudioPromptRun.delays_ms, [60_000, 300_000])
    assert.match(genStudioPromptRun.reason, /collects any earlier answer by its saved key/)
    // Free-fleet prompts retry by themselves (prompts stopping at N-k on a 400-episode run).
    for (const free of ['genstudio-chat:studio-hub::mlx-community/gemma', 'genstudio-chat:studio-hub-9701220bf30f::qwen']) {
      const freePromptRun = policy('scene_plan_run', { stage: 'visual', model: free })
      assert.equal(freePromptRun.eligible, true, free)
      assert.equal(freePromptRun.max_attempts, 3)
      assert.deepEqual(freePromptRun.delays_ms, [60_000, 300_000])
    }
    assert.equal(policy('scene_plan_run', { stage: 'visual', model: 'genstudio-chat:studio-hub::x', auto_retry: false }).eligible, false)
    // Pipeline runs pick the model from the channel's scene policy (a bare product id that
    // overrides params.model), which is how the owner runs everything.
    const pipelineFree = (assigned: string, extra: Record<string, any> = {}) => policy('scene_plan_run', {
      model: assigned,
      pipeline_model_policy: { scene_plan: { mode: 'single', models: [assigned], assigned_model: assigned } },
      ...extra,
    })
    for (const free of ['studio-hub::mlx-community/gemma', 'studio-hub-9701220bf30f::qwen']) {
      const run = pipelineFree(free)
      assert.equal(run.eligible, true, free)
      assert.deepEqual(run.delays_ms, [60_000, 300_000])
    }
    assert.equal(pipelineFree('studio-hub::x', { model: 'genstudio-chat:deepseek-v4-flash' }).eligible, true,
      'the scene policy overrides a stale params.model, as runScenePlanJob does')
    const paidPipeline = pipelineFree('deepseek-v4-flash')
    assert.equal(paidPipeline.eligible, true, 'paid Pipeline prompts retry too')
    assert.deepEqual(paidPipeline.delays_ms, [60_000, 300_000])
    assert.match(paidPipeline.reason, /collects any earlier answer by its saved key/)
    assert.match(pipelineFree('studio-hub::x', { model: 'deepseek-v4-flash' }).reason, /^Free writing/,
      'the scene policy, not a stale params.model, names the model that runs')
    assert.equal(pipelineFree('studio-hub::x', { auto_retry: false }).eligible, false)
    assert.equal(pipelineFree('deepseek-v4-flash', { auto_retry: false }).eligible, false)
    assert.equal(policy('scene_plan_run', { model: 'studio-hub::x' }).eligible, true, 'a bare free product id in params.model')
    assert.equal(policy('scene_plan_run', { stage: 'visual' }).eligible, true, 'no model = the default chat model')
    // The paid IMAGE twin stays fail-closed and manual.
    assert.equal(policy('continuity_render', { model: 'gpt-image-2' }).eligible, false)
    assert.equal(policy('continuity_render', { model: 'genstudio-image:paid' }).eligible, false)
    assert.equal(policy('audio_merge').eligible, true)
    assert.equal(policy('video_assembly').eligible, true)
    assert.equal(policy('broll_normalize').eligible, true)
    assert.equal(policy('music_video').eligible, true, 'spends nothing')
    assert.equal(policy('music_episode_build').eligible, true, 'spends nothing')
  })

  test('keeps all external API and provider recovery jobs manual-only', () => {
    assert.equal(policy('youtube_upload').eligible, false)
    assert.equal(policy('scene_clip_generate').eligible, false)
    assert.equal(policy('images_repair').eligible, false)
    assert.equal(policy('music_generate', { model: 'studio-hub::music' }).eligible, false)
  })

  test('uses two bounded retries for local work and honours an explicit disable', () => {
    const local = policy('audio', { model: 'macos-say' })
    assert.equal(local.max_attempts, 3)
    assert.deepEqual(local.delays_ms, [2_000, 8_000])
    assert.equal(policy('audio', { model: 'macos-say', auto_retry: false }).eligible, false)
  })

  test('a missing image-prompts file fails fast instead of burning automatic retries', () => {
    // Production, 2026-10-18: DM0010 thumb_images exhausted 3/3 in six minutes on
    // "Could not find thumbnail prompts for DM0010. Generate the prompts first." — a retry
    // cannot create the prompts file, so it stops at the same point every time.
    for (const kind of ['scene', 'thumbnail'] as const) {
      assert.equal(isNonRetryableError(new ImagePromptsMissingError(kind, 'DM0010')), true, kind)
    }
    // Only that input error is fail-fast: free-fleet image work still retries a transient fault by itself.
    assert.equal(policy('thumb_images', { model: 'studio-hub::org/model' }).eligible, true)
  })
})

describe('input and configuration refusals fail once with the reason', () => {
  test('a job missing a required input is not retried', () => {
    for (const message of [
      'episode_id is required',
      'model is required',
      'No writing model is chosen for this step. Choose one on Scripts, then run it again.',
      'No model selected — pick a model in the script form before expanding.',
      'No writing model was picked. Pick one on Episode Builder and press Polish again.',
      'This episode has no title yet, and an episode code is not thumbnail text. Give EP0001 a title in Ideas or Metadata, then generate its thumbnail prompts.',
    ]) assert.equal(isNonRetryableError(new Error(message)), true, message)
  })

  test('a transient failure is still retried, and a marked one stays marked', () => {
    for (const message of ['Request timed out', 'FFmpeg exited with code 1', 'The provider returned 503', 'Audio is required to be mono by the encoder, retrying']) {
      assert.equal(isNonRetryableError(new Error(message)), false, message)
    }
    assert.equal(isNonRetryableError(Object.assign(new Error('anything'), { retryable: false })), true)
    assert.equal(isNonRetryableError(null), false)
  })
})
