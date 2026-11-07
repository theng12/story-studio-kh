import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
  'utf8',
)

test('Audio Assembly is one page in Opening → Narration → Closing order', () => {
  assert.match(page, /AUDIO_ASSEMBLY_STAGES/)
  assert.match(page, /class="audio-stage-strip"/)
  assert.ok(page.indexOf('<h3>Opening</h3>') < page.indexOf('<h3>Narration</h3>'))
  assert.ok(page.indexOf('<h3>Narration</h3>') < page.indexOf('<h3>Closing</h3>'))
})

test('the four pools are distinct, optional, and start off', () => {
  assert.match(page, /<h3>Background Music<\/h3>/)
  assert.match(page, /<h3>Ambience<\/h3>/)
  assert.match(page, /<h3>Effects<\/h3>/)
  assert.match(page, /<h3>Background voice<\/h3>/)
  assert.match(page, /const ambience = reactive\(\{ enabled: false \}\)/)
  assert.match(page, /const effects = reactive\(\{ enabled: false \}\)/)
  assert.match(page, /const backgroundVoice = reactive\(\{ enabled: false \}\)/)
})

test('the ambience master switch keeps picks when switched off', () => {
  assert.match(page, /v-model="ambience\.enabled"/)
  assert.match(page, /ambience: \{ enabled: ambience\.enabled \}/)
  assert.match(page, /const liveAmbient = ambience\.enabled \? layerPayload\(ambientTracks\) : \[\]/)
  // The rows themselves are never cleared by the switch.
  assert.doesNotMatch(page, /ambience\.enabled[^\n]*ambientTracks\s*=\s*\[\]/)
})

test('every layer has group and item enable, a pool chooser, play, and volume', () => {
  for (const kind of ['effects', 'background_voice'] as const) {
    const model = kind === 'effects' ? 'effects' : 'backgroundVoice'
    assert.match(page, new RegExp(`v-model="${model}\\.enabled"`))
    assert.match(page, new RegExp(`moveLayerTrack\\('${kind}'`))
    assert.match(page, new RegExp(`refreshLayerLibrary\\('${kind}'\\)`))
    assert.match(page, new RegExp(`addLayerTrack\\('${kind}'`))
  }
  assert.match(page, /<h3>Background voice<\/h3>/)
  assert.match(page, /never replaced here|never a replacement for it/)
})

test('the short preview uses the same payload builder and writes nothing into the episode', () => {
  assert.match(page, /function buildAudioAssemblyPayload/)
  assert.match(page, /audio-assembly\/preview/)
  assert.match(page, /Preview First 20s/)
  assert.match(page, /Nothing is written to the episode folder/)
})

test('the current merge is described as a baked recording, not as the live settings', () => {
  assert.match(page, /bakedLayersSummary/)
  assert.match(page, /already baked with/)
  assert.match(page, /does not change it until you merge again/)
})

test('custom ambience is a valid choice without a file', () => {
  assert.match(page, /custom_file: backgroundNoise\.mode === 'custom' \? backgroundNoise\.custom_file : undefined/)
})
