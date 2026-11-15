import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * The format pool UI (owner 2026-11-15) — "the options and additions need to
 * be a toggle. default off and easily spotted." Source-assertion lane: the
 * switch exists where the owner will see it, defaults OFF, gates its editor,
 * and the episode row (show + override before upload) is mounted on the
 * Finalizer page. Behaviour of the server side is pinned in
 * electron/server/__tests__/format-pool.test.ts.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('Format pool — default-off toggle, easily spotted', () => {
  test('the switch starts off and the editor only exists once it is on', () => {
    const source = read('../components/FormatPoolSettings.vue')
    // Off = the absent/disabled pool; the component never forces it on.
    assert.match(source, /const enabled = computed\(\(\) => props\.pool\?\.enabled === true\)/)
    assert.match(source, /:checked="enabled"/)
    assert.match(source, /v-if="enabled"/, 'the pool editor is gated on the switch')
    assert.match(source, /Off \(default\)/, 'the hint says what off means')
    assert.match(source, /FORMAT_POOL_MAX_MEMBERS/, 'the enforced 1..10 limit is shown')
    assert.match(source, /One format in the pool/, 'a pool of one says so instead of implying variety')
    assert.match(source, /YouTube Finalizer page before upload/, 'the owner is told where the per-episode override lives')
    // Every value editable: the title style, lettering and shell fields are inputs.
    for (const field of ['title_mode', 'title_prefix', 'title_suffix', 'title_guidance', 'thumb_font_style', 'thumb_text_style', 'thumb_text_position', 'thumbnail_shell_id', 'thumbnail_template_id']) {
      assert.ok(source.includes(field), `${field} is editable in the editor`)
    }
    // No native dialogs anywhere in this feature (studio gate #1).
    assert.doesNotMatch(source, /\bwindow\.(confirm|alert|prompt)\s*\(/)
    assert.doesNotMatch(source, /\b(confirm|alert|prompt)\s*\(/)
  })

  test('the switch is on the channel settings page with a searchable anchor', () => {
    const page = read('../pages/projects/[slug]/settings.vue')
    assert.match(page, /data-setting="format-pool"/, 'the anchor exists on the page')
    assert.match(page, /<FormatPoolSettings/, 'the component is mounted')
    assert.match(page, /:slug="slug"/)
    const index = read('../utils/settingsIndex.ts')
    assert.match(index, /anchor: 'format-pool'/, 'settings search can find it')
    assert.match(index, /section: 'writing', anchor: 'format-pool'/)
  })

  test('the episode’s assignment is shown and overridable before upload on the Finalizer', () => {
    const row = read('../components/FormatPoolEpisodeRow.vue')
    assert.match(row, /format-assignment/, 'reads and writes the assignment endpoint')
    assert.match(row, /v-if="shown"/, 'renders nothing while the pool is off')
    assert.match(row, /Follow the pool's pick/, 'the override can hand the episode back to the deterministic pick')
    assert.match(row, /Picked from the episode id/, 'the honest source is stated')
    assert.match(row, /Drives this episode's thumbnail/, 'the same-member promise is shown')
    assert.doesNotMatch(row, /\bwindow\.(confirm|alert|prompt)\s*\(/)
    const page = read('../pages/projects/[slug]/metadata.vue')
    assert.match(page, /<FormatPoolEpisodeRow/, 'mounted on the YouTube Finalizer, before upload')
    assert.match(page, /:episode-id="episodeId"/)
  })
})
