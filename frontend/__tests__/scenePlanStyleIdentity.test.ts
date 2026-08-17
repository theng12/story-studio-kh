/**
 * v1.2.6 — Scene Plan names the selected art style.
 *
 * The owner: "style and guidance doesn't tell the name of the selected art
 * style. it only shows the prompts and description." The page showed the style
 * bible prose alone, so a wall of art direction was unattributable.
 *
 * The identity must come from the shared catalog — AGENTS.md names
 * `useBuiltInStyles.ts` the single source of truth and forbids duplicating the
 * built-in list into a page.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_STYLES } from '../composables/useBuiltInStyles'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)
const picker = readFileSync(
  fileURLToPath(new URL('../components/StylePicker.vue', import.meta.url)),
  'utf8',
)

test('the style name is resolved through the shared catalog, never a local list', () => {
  assert.match(page, /useVisualStyleCatalog/)
  assert.match(page, /styles: visualStyles/)
  // The catalog is asked for; nothing is assumed about what is in it.
  assert.match(page, /refresh: refreshVisualStyles/)
  assert.match(page, /void refreshVisualStyles\(\)/)
  // No built-in style id, name or category may be written into this page.
  for (const style of BUILT_IN_STYLES) {
    assert.doesNotMatch(page, new RegExp(style.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.ok(!page.includes(`'${style.name}'`), `${style.name} must not be hardcoded in Scene Plan`)
  }
  assert.doesNotMatch(page, /BUILT_IN_STYLES/)
})

test('identity matches the Character Sheet exactly — same prose comparison, no second rule', () => {
  // StylePicker identifies the active look by comparing the stored style bible
  // against the catalog. Scene Plan must use the identical comparison or the
  // two pages can disagree about which style an episode is using.
  assert.match(picker, /styles\.value\.find\(style => style\.data\.style_bible\.trim\(\) === bible\)/)
  assert.match(page, /visualStyles\.value\.find\(style => style\.data\.style_bible\.trim\(\) === text\)/)
})

test('both the episode style and the channel default are named, with the category tag', () => {
  assert.match(page, /const episodeStyleIdentity = computed\(\(\) => identifyStyle\(characterSheetStyleBible\.value\)\)/)
  assert.match(page, /const channelStyleIdentity = computed\(\(\) => identifyStyle\(savedDefaultStyleBible\.value\)\)/)
  assert.match(page, /\{\{ episodeStyleIdentity\.name \}\}/)
  assert.match(page, /\{\{ channelStyleIdentity\.name \}\}/)
  assert.match(page, /\{\{ episodeStyleIdentity\.category \}\}/)
  assert.match(page, /\{\{ channelStyleIdentity\.category \}\}/)
})

test('an unresolvable style is never blank and never guessed', () => {
  // Hand-written art direction is called what it is.
  assert.match(page, /Custom style/)
  assert.match(page, /written or edited by hand/)
  // A catalog that failed to load, or one running on offline recovery, cannot
  // tell a shipped look from a custom one — so it says so instead of guessing.
  assert.match(page, /Style name unavailable/)
  assert.match(page, /visualStylesError\.value/)
  assert.match(page, /visualStylesUsingFallback\.value/)
  assert.match(page, /visualStylesLoading\.value/)
  // Every branch returns a name; none can render empty.
  const identify = page.slice(page.indexOf('function identifyStyle'), page.indexOf('const channelStyleIdentity'))
  const returns = identify.match(/return \{ name:|return \{\n\s+name:/g) || []
  assert.ok(returns.length >= 5, `expected every identifyStyle branch to name itself, saw ${returns.length}`)
})
