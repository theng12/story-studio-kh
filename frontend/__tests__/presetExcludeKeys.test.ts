/**
 * Preset exclusions: episode-specific state must not ride in a preset — v1.4.205
 *
 * AGENTS.md §5. The trap this file exists for: `usePresets` does
 *
 *     const excludeKeys = opts.excludeKeys ?? DEFAULT_EXCLUDE_KEYS
 *
 * so `excludeKeys` REPLACES the list rather than extending it. A page that
 * passes its own list silently starts snapshotting `episode_id` again — the very
 * leak §4 is about — and the only workaround until now was for each caller to
 * re-type the four identity strings, which drifts.
 *
 * OWNER DECISIONS, 2026-09-20:
 *   #10  keep `character_ids` (cast is channel/series-level and identical across
 *        episodes); exclude `manual_guidance`; exclude `force` unconditionally,
 *        because a restored `force: true` silently overwrites existing work.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { DEFAULT_EXCLUDE_KEYS } from '../composables/usePresets.js'
import { CONTINUITY_PRESET_EXCLUDE_KEYS } from '../composables/useContinuityConfig.js'

const IDENTITY_KEYS = ['episode_id', 'episodeId', 'episode', 'title']

const scriptsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)),
  'utf8',
)

describe('preset exclude keys', () => {
  test('the shared default carries every per-episode identifier', () => {
    for (const key of IDENTITY_KEYS) {
      assert.ok(DEFAULT_EXCLUDE_KEYS.includes(key), `${key} must never be captured by a preset`)
    }
  })

  test('a caller with its own list still carries the identifiers (the trap)', () => {
    // Continuity is the existing caller. It used to RE-TYPE these four strings
    // with a comment apologising for it; it now spreads the exported list, so
    // the two cannot drift apart.
    for (const key of IDENTITY_KEYS) {
      assert.ok(
        CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key),
        `${key} was dropped: a custom excludeKeys list REPLACES the default, so `
        + 'it must spread DEFAULT_EXCLUDE_KEYS rather than restate it',
      )
    }
  })
})

describe('the script preset', () => {
  test('excludes force and manual_guidance but keeps character_ids', () => {
    const controller = scriptsSource.match(/usePresets<any>\(\{[\s\S]*?\n\}\)/)
    assert.ok(controller, 'expected the script preset controller')
    const body = controller[0]

    assert.match(body, /excludeKeys:/, 'the preset must declare its exclusions')
    assert.match(body, /'force'/, 'a restored force:true would overwrite existing work')
    assert.match(body, /'manual_guidance'/, 'the episode\'s written direction must not ride along')
    assert.doesNotMatch(body, /'character_ids'/, 'the cast is kept — owner decision #10')
    assert.match(
      body,
      /\.\.\.DEFAULT_EXCLUDE_KEYS/,
      'the spread is load-bearing: excludeKeys replaces the default list',
    )
  })
})
