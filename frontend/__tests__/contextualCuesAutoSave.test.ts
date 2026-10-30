/**
 * v1.3.3 — Contextual Cues: a preset announces what it changed, and edits save
 * themselves.
 *
 * Two owner reports, one page:
 *
 *   "i don't remember telling you that the it's preset for auto approved is
 *    being applied or not."
 *   "i keep forgetting to click save changes. so i want it to be automatic as
 *    well as a manual one for people who wants to click it again just to safe."
 *
 * `auto_approve` STAYS in these presets. Removing it was offered and declined
 * on 2026-08-18 (AGENTS.md, Preset Boundaries) — so what is asserted here is
 * the announcement, in both directions, and the third case where the preset
 * says nothing and nothing moves. A future reader who thinks a trust setting
 * has wrongly crept into a preset is looking at a decision, not a regression.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import ts from 'typescript'

import { storedPresetAutoApprove } from '../utils/contextual-cues.js'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/sound-and-labels.vue', import.meta.url)),
  'utf8',
)

test('applying and saving a Contextual Cues preset round-trips label choices', () => {
  const script = page.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const ast = ts.createSourceFile('sound-and-labels.ts', script, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'activePresets'))!
  const code = transformSync(declaration.getText(ast), { loader: 'ts', format: 'cjs' }).code
  const form = { value: { model: '', density: 'restrained', placement: 'top-right', auto_approve: false, label_themes: [], label_motions: [] } }
  const options = new Function('usePresets', 'slug', 'form', 'isContextualCueCorner', 'storedPresetAutoApprove', 'autoApproveNotice', `${code}; return activePresets`)(
    (value: unknown) => value, { value: 'project' }, form, () => true, storedPresetAutoApprove, { value: null },
  )
  const saved = { model: 'test', label_themes: ['comedy', 'exploration'], label_motions: ['slide', 'wipe'] }
  options.apply(saved)
  assert.deepEqual(options.snapshot().label_themes, saved.label_themes)
  assert.deepEqual(options.snapshot().label_motions, saved.label_motions)
  options.apply({ model: 'old preset' })
  assert.deepEqual(options.snapshot().label_themes, [])
  assert.deepEqual(options.snapshot().label_motions, [])
})

// ── Part A: what the preset actually says ───────────────────────────────────

test('a preset that stores auto-approve reports the value it stores', () => {
  // A real preset body, taken from a live project's config.json.
  assert.equal(storedPresetAutoApprove({
    model: 'deepseek-v4-flash', density: 'restrained', placement: 'top-right', auto_approve: true,
  }), true)
  assert.equal(storedPresetAutoApprove({ auto_approve: false }), false)
})

test('a preset with no opinion about auto-approve says so, and is not read as "off"', () => {
  // This is the whole reason the helper has three answers. `=== true` — what
  // the page used to do — turns every one of these into `false` and silently
  // switches the setting off for a preset that never mentioned it.
  assert.equal(storedPresetAutoApprove({ model: 'deepseek-v4-flash' }), null)
  assert.equal(storedPresetAutoApprove({}), null)
  assert.equal(storedPresetAutoApprove(null), null)
  assert.equal(storedPresetAutoApprove(undefined), null)
  // Truthy-but-not-boolean is not an opinion either.
  assert.equal(storedPresetAutoApprove({ auto_approve: 'yes' }), null)
  assert.equal(storedPresetAutoApprove({ auto_approve: 1 }), null)
})

test('the page announces auto-approve in both directions, and only when it was carried', () => {
  // Both a switch-on and a switch-off are announced; a silent switch-off is
  // the same defect in the other direction.
  assert.match(page, /switched on Auto-approve safe labels/)
  assert.match(page, /switched off Auto-approve safe labels/)
  // A preset carrying nothing leaves the live setting alone and says nothing.
  assert.match(page, /autoApproveNotice\.value = stored === null \? null : \{ on: stored, changed: form\.value\.auto_approve !== stored \}/)
  assert.match(page, /if \(stored !== null\) form\.value\.auto_approve = stored/)
  // The old default-fallback is gone for good.
  assert.doesNotMatch(page, /form\.value\.auto_approve = data\?\.auto_approve === true/)
  // Read the live value BEFORE the write, or "the preset set it" and "it was
  // already like that" cannot be told apart.
  assert.match(page, /changed: form\.value\.auto_approve !== stored/)
})

test('the notice clears on a hand edit and on an episode change, and never fires on mount', () => {
  // Ticking the box yourself supersedes whatever the last preset said.
  assert.match(page, /v-model="form\.auto_approve"[^\n]*@change="onAutoApproveEdited"/)
  assert.match(page, /function onAutoApproveEdited\(\): void \{ autoApproveNotice\.value = null \}/)
  // Switching episode makes the announcement stale — it described the episode
  // you just left.
  assert.match(page, /watch\(\[slug, episodeId\], \(\) => \{ scopeEpoch\+\+; autoApproveNotice\.value = null; void loadEpisode\(\); void loadTransitions\(\) \}, \{ flush: 'sync' \}\)/)
  // `usePresets.load()` re-applies the active preset on every mount. That is a
  // restore, not something the customer just did, so it announces nothing.
  assert.match(page, /await Promise\.all\(\[activePresets\.load\(\), soundPresets\.load\(\)\]\)[\s\S]{0,400}?autoApproveNotice\.value = null/)
})

// ── Part B: saving ──────────────────────────────────────────────────────────

test('every edit goes through one entry point, so nothing can be dirty without being scheduled', () => {
  // No edit anywhere may set the flag by hand — that is exactly how an edit
  // ends up marked unsaved with nothing arranged to save it.
  const script = page.slice(page.indexOf('<script setup'))
  const rawSets = script.match(/dirty\.value = true/g) || []
  assert.equal(rawSets.length, 1, 'only markDirty() may set dirty')
  assert.match(page, /function markDirty\(\): void \{ dirty\.value = true/)
  // Including the template handlers.
  assert.doesNotMatch(page, /@input="dirty = true"/)
  assert.doesNotMatch(page, /@change="dirty = true"/)
})

test('a save is debounced, and the debounce is never the only thing keeping an edit', () => {
  assert.match(page, /const AUTO_SAVE_DELAY_MS = 800/)
  assert.match(page, /autoSaveTimer = setTimeout\([^\n]*saveNow\(false\) \}, AUTO_SAVE_DELAY_MS\)/)
  // Leaving the page flushes it.
  assert.match(page, /onBeforeUnmount\(\(\) => \{ void saveNow\(false\); audio\?\.pause\(\) \}\)/)
  // So does reloading the timeline — which is what the episode picker, the
  // enable switch and a finished proposal job all go through.
  assert.match(page, /async function loadEpisode\(\): Promise<void> \{[\s\S]{0,400}?await saveNow\(false\)/)
})

test('two writes never overlap, and a stale response never overwrites what was typed', () => {
  // One tail, as usePresets.persistNow() does — and the SAME write both queued.
  assert.match(page, /saveTail\.then\(\(\) => writeTimeline\(announce\), \(\) => writeTimeline\(announce\)\)/)
  // A response that comes back to a changed timeline is dropped, not applied.
  assert.match(page, /const sentAt = editSeq/)
  // The write addresses the episode the cues came from, not whichever is
  // selected by the time it fires.
  assert.match(page, /const episode = timelineOwner\?\.episode/)
  assert.match(page, /timelineOwner = \{ project, episode \}/)
  assert.match(page, /sound-and-labels\/\$\{episode\}\/labels`, \{ cues: labelPayload \}\)/)
})

test('a failed save keeps the edits, says so, and does not retry on a timer', () => {
  const failure = page.slice(page.indexOf('async function writeTimeline'))
  const body = failure.slice(0, failure.indexOf('\n}\n'))
  // No revert, no reload, no clearing of the dirty flag on the failure path.
  const rescue = body.slice(body.indexOf('} catch'))
  assert.match(rescue, /saveError\.value =/)
  assert.doesNotMatch(rescue, /dirty\.value = false/)
  assert.doesNotMatch(rescue, /loadTimeline\(/)
  // Nothing schedules itself again after a failure — a dead backend would
  // otherwise be asked every 800ms forever.
  assert.doesNotMatch(rescue, /setTimeout|markDirty\(\)|saveNow\(\)/)
  // And the customer is told plainly, including that the work is still there
  // on screen and still dirty, so the next edit or Save changes retries.
  assert.match(page, /saveError\.value = cause\?\.data\?\.detail \|\| 'Could not save\.'/)
  assert.match(page, /if \(saveError\.value\) return `Not saved — \$\{saveError\.value\}`/)
})

test('the manual button survives auto-save: always pressable, honest about what it did', () => {
  // Never disabled just because everything is saved — that reads as broken.
  assert.match(page, /:disabled="saving" @click="saveNow\(true\)">Save changes</)
  assert.doesNotMatch(page, /:disabled="saving \|\| !dirty"/)
  // Pressing it with nothing to save confirms that instead of doing nothing.
  assert.match(page, /if \(!dirty\.value \|\| !episodeId\.value\) \{/)
  assert.match(page, /if \(saveError\.value\) showError\(saveError\.value\)\s*\n\s*else success\('Everything here is already saved\.'\)/)
  // And it never reports success for a write that failed: the success line sits
  // in the try, the refusal in the catch, so a failed write cannot announce.
  assert.match(page, /if \(announce\) success\('Saved'\)\s*\n\s*\} catch[\s\S]{0,600}?if \(announce\) showError\(saveError\.value\)/)
})

test('the page states saving/unsaved/saved rather than leaving it to be guessed', () => {
  assert.match(page, /class="sl-save-state" :data-state="saveState"/)
  assert.match(page, /return 'Saving…'/)
  assert.match(page, /return 'Unsaved — saving in a moment'/)
  assert.match(page, /savedAt\.value \? `Saved at \$\{savedAt\.value\}` : 'Saved'/)
})

test('bulk actions ride the same auto-save, and stop telling the customer to click Save', () => {
  // Approve All still writes nothing directly — it marks dirty like every
  // other edit, and the shared debounce does the writing.
  assert.doesNotMatch(page, /function approveAll(Proposed|Labels)[\s\S]{0,400}?await (put|post)\(/)
  assert.match(page, /for \(const cue of proposedLabels\.value\) cue\.status = 'approved'/)
  // Their toasts would otherwise be instructions the page no longer needs —
  // a control that describes an action it is not performing.
  assert.doesNotMatch(page, /click Save Changes to keep this/)
})
