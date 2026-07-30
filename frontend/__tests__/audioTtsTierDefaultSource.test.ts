/**
 * Source-level regression: the Audio Generator's initial `form.model` must
 * not be a bare hardcoded literal — it should be sourced from the shared
 * GENSTUDIO_TTS_TIER_OPTIONS list (utils/genstudio-tts-tiers.ts), the single
 * place that owns Story's three customer-facing TTS tier tokens.
 *
 * Note: those tier tokens ('genstudio-tts-regular' etc.) are NOT literal
 * GenStudio product ids — buildGenStudioSubmission's TTS payload is only
 * { voice_id, text, speed }, so the tier token itself is never submitted to
 * GenStudio as execution authority. This test only pins that the page
 * doesn't duplicate the literal a second time in its own reactive state.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Audio Generator seeds its initial TTS model from the shared tier list, not a duplicated literal', () => {
  const source = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  assert.match(source, /model:\s*GENSTUDIO_TTS_TIER_OPTIONS\[0\]\.id,/)
  assert.doesNotMatch(source, /model:\s*'genstudio-tts-regular'/)
})

test('GenStudio TTS submission is keyed by voice_id only, never by the Story tier token', () => {
  const source = readFileSync(new URL('../../electron/server/lib/genstudio-client.ts', import.meta.url), 'utf8')
  assert.match(source, /const body = \{ voice_id: voiceId, text: request\.text, speed: request\.speed \}/)
})
