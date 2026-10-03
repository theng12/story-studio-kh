/**
 * Scene Plan "Regenerate prompts" for selected scenes — page wiring.
 *
 * Source checks (the page has no cheap mount harness): checkboxes with
 * select-all and shift-click range, the owner's confirm wording, the chosen
 * model only (never auto-picked), the unsaved-edits guard, visible hints,
 * progress + per-scene failures, and the selection reset on episode change.
 * Cannot catch: layout, the real confirm dialog, server behaviour (see
 * electron/server/__tests__/scene-plan-selected-prompts.test.ts).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)), 'utf8')
const fn = (name: string) => {
  const start = page.indexOf(`async function ${name}(`) >= 0 ? page.indexOf(`async function ${name}(`) : page.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  return page.slice(start, page.indexOf('\n}\n', start))
}

test('each scene has a checkbox; select-all and shift-click range select', () => {
  assert.match(page, /class="scene-select-box"[\s\S]{0,300}@click="toggleSceneSelection\(i, \$event\)"/)
  assert.match(page, /:indeterminate="selectedSceneCount > 0 && !allScenesSelected"[\s\S]{0,120}@change="toggleAllScenes"/)
  const toggle = fn('toggleSceneSelection')
  assert.match(toggle, /event\.shiftKey && lastToggledSceneIndex !== null/)
  assert.match(toggle, /Math\.min\(anchor, index\)[\s\S]*Math\.max\(anchor, index\)/)
})

test('Regenerate prompts confirms in plain words, uses the chosen model only, and sends only the selection', () => {
  const run = fn('regenerateSelectedPrompts')
  assert.match(run, /Rewrites the image prompts of \$\{n\} scene\$\{n === 1 \? '' : 's'\}\. Their current images stay until you regenerate them\./)
  assert.match(run, /model: form\.value\.model,/)
  assert.doesNotMatch(run, /form\.value\.model = /, 'never picks a model on the owner’s behalf')
  assert.match(run, /scene_ids: eligible\.map\(scene => scene\.id\)/)
  assert.match(run, /regenerate-prompt`/)
  assert.match(page, /const CHOOSE_WRITING_MODEL = 'Choose a writing model in “Visual & motion prompt model” above first\.'/)
  assert.match(page, /if \(!form\.value\.model\) return CHOOSE_WRITING_MODEL/)
})

test('guards, visible hint, progress and per-scene failures', () => {
  const blocker = page.slice(page.indexOf('const regenerateSelectedBlocker'), page.indexOf('function toggleSceneSelection'))
  assert.match(blocker, /if \(dirty\.value\) return 'Save your scene edits first/)
  assert.match(blocker, /planBusy\.value \|\| bulkReplan\.value\.active/)
  // The reason (or what the button does) is always visible, not only on hover.
  assert.match(page, /<p class="scene-select-hint"[\s\S]{0,200}\{\{ regenerateSelectedBlocker \|\| 'Rewrites only the image prompts of the ticked scenes/)
  assert.match(page, /:disabled="!!regenerateSelectedBlocker"/)
  assert.match(page, /v-if="regeneratingSelected" class="bulk-progress"/)
  assert.match(page, /data-testid="scene-select-failures"/)
  const run = fn('regenerateSelectedPrompts')
  assert.match(run, /result\?\.completion\?\.issues/)
  assert.match(run, /selectedSceneIds\.value = new Set\(issues\.map\(issue => issue\.item_id\)\)/, 'failed scenes stay ticked for a one-click retry')
})

test('ticked scenes never follow the owner to another episode', () => {
  const reset = page.slice(page.indexOf('watch([slug, episodeId], () => {'), page.indexOf('}, { immediate: true, flush: \'sync\' })'))
  assert.match(reset, /selectedSceneIds\.value = new Set\(\)/)
  assert.match(reset, /promptRegenFailures\.value = \[\]/)
})
