import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { resolveMediaBase, isHeavySubfolder } from '../services/media-root.js'

// Level B external media root — the routing decision is pure (no fs), so these
// pin the opt-in default and the mirroring behavior without a project fixture.

test('resolveMediaBase: opt-out is the default (falsy media_root → null)', () => {
  const rel = 'Season 006/EP0110 - Breathe/'
  assert.equal(resolveMediaBase(undefined, rel), null)
  assert.equal(resolveMediaBase(null, rel), null)
  assert.equal(resolveMediaBase('', rel), null)
  assert.equal(resolveMediaBase('   ', rel), null)
})

test('resolveMediaBase: absolute media root mirrors episodeRel', () => {
  const rel = 'Season 006/EP0110 - Breathe Peace/'
  assert.equal(
    resolveMediaBase('/Volumes/StudioSSD/Media', rel),
    path.join('/Volumes/StudioSSD/Media', rel),
  )
})

test('resolveMediaBase: undefined named-root token → null, never throws', () => {
  // ${MEDIA} is not defined in the test environment. resolveMediaBase must
  // swallow the resolver error and return null so LIGHT-only path computation
  // never breaks on a machine that hasn't defined the root yet.
  assert.equal(resolveMediaBase('${MEDIA}', 'Season 006/EP0110 - X/'), null)
})

test('isHeavySubfolder: only large-media subfolders are heavy', () => {
  for (const k of ['images', 'thumbnails', 'audio', 'merged_audio', 'video']) {
    assert.ok(isHeavySubfolder(k), `${k} should be heavy`)
  }
  for (const k of ['script', 'metadata', 'scene_prompts', 'thumb_prompts', 'subtitles']) {
    assert.ok(!isHeavySubfolder(k), `${k} should be light`)
  }
})
