import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  brandedGenStudioModelName,
  buildGenStudioModelLabelEntries,
} from '../utils/genstudio-model-display.ts'

test('GenStudio model catalogs expose real names with consistent branding', () => {
  const labels = new Map(buildGenStudioModelLabelEntries({
    chat: [{
      id: 'genstudio-chat-opaque-v1',
      display_name: 'DeepSeek V4 Flash',
      legacy_ids: ['deepseek-v4-flash'],
    }],
    image: [{ id: 'genstudio-image-opaque-v1', display_name: 'Flux 2 Klein' }],
    video: [{ id: 'genstudio-video-opaque-v1', display_name: 'Kling 3.0' }],
    transcription: [{
      id: 'genstudio-transcription-opaque-v1',
      display_name: 'Whisper Large V3 Turbo',
    }],
    tts: [{ id: 'tts-qwen3', display_name: 'Qwen3 TTS' }],
  }))

  assert.equal(
    labels.get('genstudio-chat:genstudio-chat-opaque-v1'),
    'DeepSeek V4 Flash [GenStudio KH]',
  )
  assert.equal(labels.get('deepseek-v4-flash'), 'DeepSeek V4 Flash [GenStudio KH]')
  assert.equal(labels.get('genstudio-image-opaque-v1'), 'Flux 2 Klein [GenStudio KH]')
  assert.equal(
    labels.get('genstudio-video:genstudio-video-opaque-v1'),
    'Kling 3.0 [GenStudio KH]',
  )
  assert.equal(
    labels.get('genstudio-transcription-opaque-v1'),
    'Whisper Large V3 Turbo [GenStudio KH]',
  )
  // Speech is in the map like every other modality now: the customer picks a
  // TTS model and is charged by it, so its published name is the customer name.
  assert.equal(labels.get('tts-qwen3'), 'Qwen3 TTS [GenStudio KH]')
  assert.equal(labels.get('genstudio-tts:tts-qwen3'), 'Qwen3 TTS [GenStudio KH]')
  assert.equal(
    brandedGenStudioModelName('Existing [GenStudio]'),
    'Existing [GenStudio KH]',
  )
})

test('the display layer keeps no voice-tier vocabulary of its own', () => {
  const display = readFileSync(
    new URL('../utils/genstudio-model-display.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(display, /genStudioTtsDisplayName|TTS_TIER_BY_ENGINE_ID|GenStudioTtsTier/)
  assert.doesNotMatch(display, /GenStudio TTS (?:Regular|Premium|Clone)/)
})

test('Jobs and Usage resolve catalog names instead of printing dispatch ids', () => {
  const jobs = readFileSync(
    new URL('../pages/projects/[slug]/jobs.vue', import.meta.url),
    'utf8',
  )
  const usage = readFileSync(new URL('../pages/usage.vue', import.meta.url), 'utf8')
  const previewRow = readFileSync(
    new URL('../components/PreviewPromptRow.vue', import.meta.url),
    'utf8',
  )
  const audioRoute = readFileSync(
    new URL('../../electron/server/routes/audio.ts', import.meta.url),
    'utf8',
  )

  assert.match(jobs, /jobModelDisplay\(job\)/)
  assert.doesNotMatch(jobs, /\{\{\s*job\.params\.model\s*\}\}/)
  assert.match(usage, /usageModelDisplay\(job\)/)
  assert.match(usage, /<NuxtLink to="\/" class="btn btn-secondary btn-sm">← Back to projects<\/NuxtLink>/)
  assert.doesNotMatch(usage, /<small>\{\{\s*job\.model_id\s*\}\}<\/small>/)
  assert.match(previewRow, /\{\{\s*previewModelName\s*\}\}/)
  // voice_tier is published metadata carried beside the job for history —
  // taken from the SELECTED VOICE, no longer from a Story-owned tier token.
  assert.match(audioRoute, /req\.body\.tts_tier = selectedVoice\.voice_tier/)
})
