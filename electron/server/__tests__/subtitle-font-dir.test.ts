/**
 * A burned caption must use the face it asked for (owner, 2026-10-27).
 *
 * The app ships five OFL faces in `bundled/fonts/`. The thumbnail renderer
 * resolves them through its own Fontconfig file; the VIDEO burn did not, and on
 * this build that is not a cosmetic difference. `ffmpeg -loglevel verbose`
 * prints `Using font provider coretext`, and CoreText resolves a family against
 * macOS's installed fonts — `FONTCONFIG_FILE` is not consulted. Measured with
 * the bundled binary:
 *
 *   Helvetica             → /System/Library/Fonts/Helvetica.ttc
 *   Moul                  → (only because this Mac happens to have it installed)
 *   any family not installed → /System/Library/Fonts/Helvetica.ttc, silently
 *
 * So a channel whose caption style names a bundled face was drawn in Helvetica
 * on any Mac that had not installed that face, with nothing anywhere saying so —
 * the "CSS that silently does nothing" shape from AGENTS §3, in the renderer.
 *
 * `:fontsdir=` on the ass/subtitles filter is what makes the bundled directory a
 * search root for a CoreText libass. These tests pin the fragment's shape and
 * that a missing directory leaves the filter exactly as it was.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bundledFontsFilterOption } from '../lib/subtitle-font-dir.js'

/** Point `fontsResourceDir()` at a throwaway root for one case. */
function withResourcesDir<T>(dir: string | null, run: () => T): T {
  const previous = process.env.STORY_STUDIO_RESOURCES_DIR
  if (dir === null) delete process.env.STORY_STUDIO_RESOURCES_DIR
  else process.env.STORY_STUDIO_RESOURCES_DIR = dir
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
    else process.env.STORY_STUDIO_RESOURCES_DIR = previous
  }
}

describe('the burn can see the bundled fonts', () => {
  let root: string

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'story-fontsdir-'))
    mkdirSync(path.join(root, 'fonts', 'moul'), { recursive: true })
    writeFileSync(path.join(root, 'fonts', 'moul', 'Moul-Regular.ttf'), 'not a real font')
    writeFileSync(path.join(root, 'fonts', 'fonts.json'), JSON.stringify({ fonts: [] }))
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('a real fonts directory becomes a fontsdir filter option', () => {
    const option = withResourcesDir(root, () => bundledFontsFilterOption())
    assert.match(option, /^:fontsdir=/)
    assert.ok(option.endsWith('/fonts'), `the whole fonts root is passed, not one face: ${option}`)
    // The value is emitted unquoted, exactly like `filename=`, so a path with an
    // apostrophe or a colon cannot break out of the filter.
    assert.ok(!option.includes("'"), 'never quoted')
    assert.ok(!option.includes('"'), 'never quoted')
  })

  test('it is the ROOT, so a face added later needs no code change', () => {
    const option = withResourcesDir(root, () => bundledFontsFilterOption())
    assert.ok(!option.includes('/moul'), 'one face folder would hide every other face')
  })

  test('a build with no fonts folder emits NOTHING, so the filter is unchanged', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'story-fontsdir-none-'))
    try {
      const option = withResourcesDir(empty, () => bundledFontsFilterOption())
      assert.equal(option, '', 'an absent folder must not fail a burn')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('the fragment composes with the existing filter options', () => {
    // This is the exact string Video Assembly builds; the option must sit
    // between the filename and any later option, each prefixed by ':'.
    const option = withResourcesDir(root, () => bundledFontsFilterOption())
    const filter = `ass=filename=/tmp/x.ass${option}`
    assert.equal((filter.match(/:fontsdir=/g) || []).length, 1)
    assert.match(filter, /^ass=filename=\/tmp\/x\.ass:fontsdir=/)
  })
})
