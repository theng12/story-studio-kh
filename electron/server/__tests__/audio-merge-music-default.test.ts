/**
 * Background music default (owner, 2026-10-26, after DM0018/PR0039 were mixed
 * with an 8% bed that buried the Khmer narration): 6% under the narration is
 * the starting level, and it applies to an UNSET value only. A stated value —
 * the page's control, a saved preset — is the customer's choice and is never
 * rewritten (AGENTS.md §5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_BACKGROUND_MUSIC_VOLUME, resolveBackgroundMusicVolume } = await import('../generators/audio-merge.js')

test('an unset level starts at 6%', () => {
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME, 0.06)
  assert.deepEqual(resolveBackgroundMusicVolume(undefined), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(null), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(''), { volume: 0.06, defaulted: true })
  assert.deepEqual(resolveBackgroundMusicVolume(Number.NaN), { volume: 0.06, defaulted: true })
})

test('a stated level — a preset at 8%, a customer at 3% — passes through untouched', () => {
  assert.deepEqual(resolveBackgroundMusicVolume(0.08), { volume: 0.08, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0.03), { volume: 0.03, defaulted: false })
  assert.deepEqual(resolveBackgroundMusicVolume(0), { volume: 0, defaulted: false }, '0 is a real choice (music muted)')
  assert.deepEqual(resolveBackgroundMusicVolume('0.5'), { volume: 0.5, defaulted: false })
})

/**
 * A stated value above unity is a percentage that skipped its one conversion (a mix saved before
 * 1.4.361). It is refused before any FFmpeg work instead of being replayed as 8× the voice or being
 * squeezed silently into range — the DM0018/PR0039 defect either way (lib/audio-gain.ts).
 */
test('a stated level above unity is refused before any work', async () => {
  const { generateAudioMerge } = await import('../generators/audio-merge.js')
  const job = {
    job_id: 'legacy-percent-level', project_slug: 'no-such-project', episode_id: 'EP0001', type: 'audio_merge',
    status: 'running', created_at: new Date().toISOString(), output_lines: [],
    params: {
      episode_id: 'EP0001', chapters: [], gap_duration: 0, normalize_volume: false,
      music: { enabled: true, source: 'manual', files: [], volume: 8 },
    },
  }
  await assert.rejects(generateAudioMerge(job as never), /Background music level 8 is not a gain Story can apply/)
})
