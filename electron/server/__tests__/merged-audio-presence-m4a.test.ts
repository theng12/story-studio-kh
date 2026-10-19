/**
 * Regression for a surviving completion-review finding — 2026-10-19
 * (asset-status completion review). REACHABILITY CONFIRMED 2026-10-19.
 *
 * FINDING: the merged-audio presence check reports a present, recognised track
 * as MISSING when it is not `.mp3`, contradicting the canonical pattern and the
 * same file's own other selector.
 *
 * `inspectAudioMergeAtPaths` (services/asset-status.ts:689-752), on the
 * no-owner-pin path, matches merged audio with a `.mp3`-only, case-sensitive
 * regex:
 *     const re = new RegExp(`^${code}_merged_audio(?:_v(\\d+))?\\.mp3$`)   (line 718)
 * A non-`.mp3` track never matches, so `best` stays null and the function
 * returns `{ present: false }` at line 727 — before the completion-record and
 * freshness checks are ever reached.
 *
 * The canonical pattern is
 *     MERGED_AUDIO_FILENAME = /_merged_audio(?:_v\d+)?\.(?:mp3|wav|m4a)$/i
 * (lib/merged-audio-selection.ts:64), and the SAME asset-status file already
 * uses the canonical selector at line 1410
 * (`selectMergedAudioFilename(mergedChoice.entries, code)`).
 *
 * TRIGGER (reachable): a music episode. `generators/music-episode-build.ts:225`
 * writes exactly `${code}_merged_audio.m4a` — no `.mp3` — and writes NO pin and
 * NO `{code}_merged_audio.completion.json`. The pin (`.selected_merged_audio`)
 * is written ONLY by the owner route
 * `PUT /projects/:slug/video-editor/merged-audio/select/:episodeId`
 * (routes/video.ts:1923-1951); nothing pins automatically. So a freshly built
 * music episode takes the no-pin branch above.
 *
 * ACTUAL CALLERS that then read `present: false` for an existing m4a:
 *   - `getAudioMergeStatus` (asset-status.ts:759 -> 798) — the audio-merge
 *     status route (routes/audio-merge.ts:30), the Production Board's
 *     `merged_audio` cell (computeEpisodeStatus, asset-status.ts:1572) and
 *     `auditProjectAssets` (asset-status.ts:863).
 *   - `inspectAudioAssemblyReadiness` (audio-workflow-readiness.ts:176) —
 *     reports `audio_assembly_ready: false` and "no playable merged narration".
 *   - `resolveAuthoritativeBrollNarration` (video-visual-source.ts:215) — throws
 *     "Merged narration exists but is stale or unverified" (line 219) although a
 *     valid m4a is right there.
 *
 * DIVERGENCE (the app disagrees with itself): the renderer `scanEpisodeAssets`
 * DOES surface the m4a (`isMergedFilename` accepts it; asserted in
 * __tests__/music-episode-routes.test.ts:191), so the picture and the status
 * disagree about one episode (AGENTS §6 canonical/endsWith matching; §8 true
 * per-output completion).
 *
 * COVERAGE: none — no test in electron/server/__tests__ references
 * `inspectAudioMergeAtPaths`, and all audio-merge fixtures use `.mp3`.
 * `merged-audio-selection.test.ts:108` asserts `.m4a` IS a valid merged track.
 *
 * NOT FIXED on current main: `git diff 2e94d598..HEAD` is empty for
 * asset-status.ts, music-episode-build.ts and merged-audio-selection.ts (main is
 * 3e998778, release/1.4.331 merged).
 *
 * PLACEMENT: uses the application's own relative imports, so copy to
 * electron/server/__tests__/ before running against a release worktree.
 *
 * EXPECTED RED on the current source: the `.m4a` and `.wav` cases read
 * `present: false`. GREEN once the presence path uses the canonical selector:
 * `present: true`, file the non-mp3 track. The `.mp3` case is the POSITIVE
 * CONTROL — it must read `present: true` before and after, so a broken fixture
 * cannot masquerade as a green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inspectAudioMergeAtPaths } from '../services/asset-status.js'
import { MERGED_AUDIO_FILENAME, selectMergedAudioFilename } from '../lib/merged-audio-selection.js'

const CODE = 'EP0047'

/**
 * A fresh episode fixture: an empty audio_dir (no source sidecar, so the
 * freshness check passes via ENOENT at asset-status.ts:656) and one merged
 * track. Nothing is deleted; each case gets its own temp dir.
 */
async function fixture(ext: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merged-audio-'))
  const episodeDir = path.join(root, 'episode')
  const audioDir = path.join(root, 'audio')
  const mergedDir = path.join(root, 'merged')
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.mkdir(audioDir, { recursive: true })
  await fs.mkdir(mergedDir, { recursive: true })
  const name = `${CODE}_merged_audio${ext}`
  await fs.writeFile(path.join(mergedDir, name), 'audio bytes')
  return { episodeDir, audioDir, mergedDir, name }
}

function inspect(f: { episodeDir: string; audioDir: string; mergedDir: string }) {
  return inspectAudioMergeAtPaths(
    { episode_dir: f.episodeDir, audio_dir: f.audioDir, merged_audio_dir: f.mergedDir },
    CODE,
  )
}

test('control: an .mp3 merged track with no pin reads present (fixture is live)', async () => {
  const f = await fixture('.mp3')
  assert.equal(MERGED_AUDIO_FILENAME.test(f.name), true)
  assert.equal(selectMergedAudioFilename([f.name], CODE), f.name)
  const status = await inspect(f)
  assert.equal(status.present, true, 'the control track must be present, or the fixture is broken')
  assert.equal(status.file, f.name)
})

test('RED: an .m4a merged track (a music episode) must be reported present, not missing', async () => {
  const f = await fixture('.m4a')
  // The app's own canonical rule and its sibling selector both accept this file.
  assert.equal(MERGED_AUDIO_FILENAME.test(f.name), true)
  assert.equal(selectMergedAudioFilename([f.name], CODE), f.name)
  const status = await inspect(f)
  assert.equal(status.present, true, 'a merged track the app itself recognises must not be reported missing')
  assert.equal(status.file, f.name)
})

test('RED: a .wav merged track must be reported present, not missing', async () => {
  const f = await fixture('.wav')
  assert.equal(MERGED_AUDIO_FILENAME.test(f.name), true)
  assert.equal(selectMergedAudioFilename([f.name], CODE), f.name)
  const status = await inspect(f)
  assert.equal(status.present, true, 'a merged track the app itself recognises must not be reported missing')
  assert.equal(status.file, f.name)
})
