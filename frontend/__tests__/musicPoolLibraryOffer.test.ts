import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Dreamlands E2E (2026-10-03): songs made on the Music Library page land in
// music-library/, but Audio Assembly's Music Pool only reads music/. The owner
// had to copy files in Finder to put the bed under the narration.
test('the Music Pool offers the Music Library songs it does not have yet', () => {
  const src = readFileSync(new URL('../components/MusicPoolPanel.vue', import.meta.url), 'utf8')
  assert.match(src, /`\/projects\/\$\{props\.projectSlug\}\/music-library`/)
  assert.match(src, /libraryTracks\.value\.filter\(t => t\.enabled && t\.path && !inPool\.has\(t\.filename\)\)/)
  assert.match(src, /post\(`\/projects\/\$\{props\.projectSlug\}\/music-pool\/tracks`, \{ source_path: t\.path \}\)/)
  assert.match(src, /from your Music Library/)
})

test('Audio Assembly remembers the music bed choice, but not the per-episode hand-picked files', () => {
  const src = readFileSync(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url), 'utf8')
  const call = src.slice(src.indexOf("useRememberedForm('audio-merge-music'"), src.indexOf("useRememberedForm('audio-merge-music'") + 300)
  assert.match(call, /include: \['enabled', 'source', 'volume'/)
  assert.doesNotMatch(call, /'files'/)
  // The remembered form must be declared after `slug` and `music` exist.
  assert.ok(src.indexOf('const slug = computed') < src.indexOf("useRememberedForm('audio-merge-music'"))
})
