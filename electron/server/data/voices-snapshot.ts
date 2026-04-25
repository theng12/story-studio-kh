/**
 * Minimal offline / first-run fallback for the voice picker.
 *
 * The live ElevenLabs `/v1/voices` + `/v1/shared-voices` fetch replaces
 * this the first time the user opens the Audio page with a valid API key;
 * the runtime cache in userData then serves as the baseline for offline
 * subsequent opens. Only ship voice_ids we are certain are stable — self-
 * curated community IDs belong in the live catalog, not here.
 *
 * Shape intentionally matches `VoiceMeta` in `lib/elevenlabs-voices.ts`
 * so the snapshot is a drop-in replacement when the live path fails.
 */
import type { VoiceMeta } from '../lib/elevenlabs-voices.js'

export const VOICES_SNAPSHOT: VoiceMeta[] = [
  {
    voice_id: 'Qe9WSybioZxssVEwlBSo',
    name: 'Vincent',
    category: 'premade',
    gender: 'male',
    language: 'en',
    accent: 'American',
    description: 'Calm narration voice — the default ships with Story Studio KH.',
    use_case: 'narration',
    preview_url: null,
    popularity: 100,
  },
  {
    voice_id: 'xGDJhCwcqw94ypljc95Z',
    name: 'Archer',
    category: 'premade',
    gender: 'male',
    language: 'en',
    accent: 'British',
    description: 'Guided-meditation voice — gentle, measured pacing.',
    use_case: 'meditation',
    preview_url: null,
    popularity: 90,
  },
]
