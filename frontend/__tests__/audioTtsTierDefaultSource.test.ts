/**
 * Source-level regression: the Audio Generator must not seed `form.model` with
 * any model id at all. GenStudio's live `/v1/tts/models` is the only source of
 * a valid selection, so the page starts empty and waits for the catalogue —
 * inventing a default here is exactly the drift AGENTS.md forbids.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Audio Generator seeds no TTS model id of its own', () => {
  const source = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(source, /model: '',/)
  assert.doesNotMatch(source, /model:\s*'genstudio-tts-/)
})

test('a remembered model that GenStudio no longer publishes is dropped, not submitted', () => {
  const source = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(source, /watch\(\[ttsModels, \(\) => form\.model\]/)
  assert.match(source, /no longer in your GenStudio KH catalogue/)
})

test('GenStudio TTS submission carries the voice, the text, the speed and published controls only', () => {
  const source = readFileSync(new URL('../../electron/server/lib/genstudio-client.ts', import.meta.url), 'utf8')
  // No voice TIER, no provider, no model id chosen here: the voice identifies
  // the work. `controls` joined it when GenStudio began publishing per-model
  // controls, and is spread CONDITIONALLY so a model publishing none produces
  // the exact bytes — and therefore the exact idempotency key — it did before.
  assert.match(source, /voice_id: voiceId,\n\s*text: request\.text,\n\s*speed: request\.speed,\n\s*\.\.\.\(controls \? \{ controls \} : \{\}\),/)
  assert.doesNotMatch(source, /const body = \{[^}]*tier/)
})
