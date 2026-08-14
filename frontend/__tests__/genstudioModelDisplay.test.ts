import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildGenStudioModelLabelEntries,
  plainGenStudioModelName,
} from '../utils/genstudio-model-display.ts'

// What this protects has not changed: the customer sees ONE clear boundary and
// a provider identity is never invented. What changed is where the boundary is
// stated. Appending "[GenStudio KH]" to every model name was a third statement
// of a gateway that already had a group heading and a per-row badge — and it
// crowded out the model name, which is the only part of the row that varies.
// The suffix is now stated once per surface, by the group heading, and never
// baked into the name itself.
test('GenStudio model catalogs expose the catalogue name, unbranded', () => {
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
    'DeepSeek V4 Flash',
  )
  assert.equal(labels.get('deepseek-v4-flash'), 'DeepSeek V4 Flash')
  assert.equal(labels.get('genstudio-image-opaque-v1'), 'Flux 2 Klein')
  assert.equal(
    labels.get('genstudio-video:genstudio-video-opaque-v1'),
    'Kling 3.0',
  )
  assert.equal(
    labels.get('genstudio-transcription-opaque-v1'),
    'Whisper Large V3 Turbo',
  )
  // Speech is in the map like every other modality now: the customer picks a
  // TTS model and is charged by it, so its published name is the customer name.
  assert.equal(labels.get('tts-qwen3'), 'Qwen3 TTS')
  assert.equal(labels.get('genstudio-tts:tts-qwen3'), 'Qwen3 TTS')
  // No label may carry the gateway. A model name is the model's.
  for (const label of labels.values()) assert.doesNotMatch(label, /GenStudio/i)
})

test('a name branded by an older release is healed, not shown', () => {
  // The label map is persisted to localStorage and is CUMULATIVE — a retired
  // model's remembered label is never refreshed by a catalogue read. So the
  // match on the old suffix has to survive even though nothing writes it any
  // more, or every old job and usage row would keep the branding forever.
  assert.equal(plainGenStudioModelName('Existing [GenStudio]'), 'Existing')
  assert.equal(plainGenStudioModelName('Existing [GenStudio KH]'), 'Existing')
  assert.equal(plainGenStudioModelName('  Claude Fable 5 (128K) [genstudio kh]  '), 'Claude Fable 5 (128K)')
  // A name that never carried the suffix is returned untouched, and a bracket
  // that is part of the real name is not mistaken for branding.
  assert.equal(plainGenStudioModelName('Kling 3.0'), 'Kling 3.0')
  assert.equal(plainGenStudioModelName('Flux 2 Klein [fast]'), 'Flux 2 Klein [fast]')
  assert.equal(plainGenStudioModelName('   '), '')
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
  assert.match(usage, /Tier standing/)
  assert.match(usage, /tierHeading\(snapshot\.overview\.service_tier\.current\)/)
  assert.match(usage, /paid_active_jobs.*paid_concurrency_limit/s)
    assert.match(usage, /snapshot\.overview\.app_links\.billing/)
    assert.ok(
      usage.indexOf('snapshot.overview.app_links.billing') < usage.indexOf('<section v-if="snapshot.overview.service_tier"'),
      'billing action must not depend on service-tier metadata',
    )
  assert.match(usage, /target="_blank"[^>]*rel="noopener noreferrer"/)
  assert.match(usage, /Billing is not available on this GenStudio deployment/)
  assert.doesNotMatch(usage, /will link directly|localhost.*billing|GenStudioUrl/i)
  assert.doesNotMatch(usage, /Current plan|Manage plan · coming soon/)
  assert.match(usage, /<NuxtLink to="\/" class="btn btn-secondary btn-sm">← Back to projects<\/NuxtLink>/)
  assert.doesNotMatch(usage, /<small>\{\{\s*job\.model_id\s*\}\}<\/small>/)
  assert.match(previewRow, /\{\{\s*previewModelName\s*\}\}/)
  // voice_tier is published metadata carried beside the job for history —
  // taken from the SELECTED VOICE, no longer from a Story-owned tier token.
  assert.match(audioRoute, /req\.body\.tts_tier = selectedVoice\.voice_tier/)
})
