import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  brandedGenStudioModelName,
  buildGenStudioModelLabelEntries,
  genStudioTtsDisplayName,
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
  assert.equal(
    brandedGenStudioModelName('Existing [GenStudio]'),
    'Existing [GenStudio KH]',
  )
})

test('TTS remains masked behind the three GenStudio product tiers', () => {
  assert.equal(genStudioTtsDisplayName('genstudio-standard-v1'), 'GenStudio TTS Regular')
  assert.equal(genStudioTtsDisplayName('genstudio-clone-v1'), 'GenStudio TTS Clone')
  assert.equal(
    genStudioTtsDisplayName('private-premium-engine', 'premium'),
    'GenStudio TTS Premium',
  )
  assert.equal(
    genStudioTtsDisplayName('private-qwen-engine', 'cloned'),
    'GenStudio TTS Clone',
  )
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
  const stylePreview = readFileSync(
    new URL('../components/StylePreviewCard.vue', import.meta.url),
    'utf8',
  )
  const audioRoute = readFileSync(
    new URL('../../electron/server/routes/audio.ts', import.meta.url),
    'utf8',
  )

  assert.match(jobs, /jobModelDisplay\(job\)/)
  assert.doesNotMatch(jobs, /\{\{\s*job\.params\.model\s*\}\}/)
  assert.match(usage, /usageModelDisplay\(job\)/)
  assert.doesNotMatch(usage, /<small>\{\{\s*job\.model_id\s*\}\}<\/small>/)
  assert.match(previewRow, /\{\{\s*previewModelName\s*\}\}/)
  assert.match(stylePreview, /\{\{\s*previewModelName\s*\}\}/)
  assert.match(audioRoute, /req\.body\.tts_tier = requestedTier/)
})
