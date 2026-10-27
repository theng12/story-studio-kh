import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * v1.4.365 — the same promises, over the merged page.
 *
 * The old `contextual-cues.vue` is a redirect now; everything asserted here
 * lived on it and lives on `sound-and-labels.vue`. Three of the old assertions
 * were about the project-level auto-approve switch, which the owner deleted
 * (2026-10-28) — where the page now says something about auto-approve, it is
 * about the PRESET, and it is announced in both directions.
 */
const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/sound-and-labels.vue', import.meta.url)),
  'utf8',
)

test('a partial proposal is named as partial, never as complete', () => {
  // The page shows what the backend reported; a partial run is never dressed
  // up as a finished one. (The backend names the remaining batches; the page
  // never claims otherwise.)
  assert.match(page, /proposing/)
  assert.match(page, /Proposal queued\. Labels and sounds will appear here when the job finishes\./)
  assert.doesNotMatch(page, /Retry resumes/)
})

test('a running proposal pauses edits, and says so on screen', () => {
  assert.match(page, /A proposal is running — edits are paused until it finishes\./)
  assert.match(page, /:disabled="saving \|\| jobActive"/, 'the save control is paused too')
})

test('a refused save keeps its issues and marks the rows at fault', () => {
  // The 422 body carries `issues`; the page puts them back beside the rows that
  // caused them instead of replacing everything with one sentence.
  assert.match(page, /Array\.isArray\(cause\?\.data\?\.issues\)/)
  assert.match(page, /validation\.value = \{ \.\.\.validation\.value, \[side\]: issues \}/)
  assert.match(page, /function rowNotes\(row: Row\): string\[\]/)
})

test('the preset auto-approve is announced, and never silently applied', () => {
  // AGENTS.md §5: `auto_approve` is preset data and the page announces it in
  // BOTH directions. The project-level switch it used to defer to is gone.
  assert.match(page, /storedPresetAutoApprove\(data\)/)
  assert.match(page, /switched on Auto-approve safe labels/)
  assert.match(page, /switched off Auto-approve safe labels/)
  assert.doesNotMatch(page, /config\.auto_approve_cues/, 'the retired project switch must not come back')
  // Sounds are never auto-approved — the card says so where the setting is.
  assert.match(page, /Sounds are NEVER auto-approved\./)
})

test('a failed on/off save puts the switch back, and errors are titled for what they are', () => {
  assert.match(page, /config\.value = previous/)
  assert.match(page, /\/Scene Plan\/\.test\(loadError\)/)
  assert.match(page, /Sound & Labels needs a Scene Plan/)
  assert.doesNotMatch(page, /Retry submission/)
})

test('an unanswered submit offers a real Retry with the shared sentence', () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  assert.match(read('pages/projects/[slug]/sound-and-labels.vue'), /showAction\(UNCONFIRMED_SUBMISSION, 'Retry', \(\) => propose\(\), 'error'\)/)
  assert.match(read('pages/projects/[slug]/introduction.vue'), /showAction\(UNCONFIRMED_SUBMISSION, 'Retry', \(\) => generateForEpisode\(\), 'error'\)/)
  assert.match(read('composables/useFreshGenerationAction.ts'), /Click Retry: it resends the same request, so nothing is made or charged twice\./)
})

test('the two old addresses are redirects, not deleted pages', () => {
  // A 404 dead-ends every bookmark and every older in-app link.
  for (const file of ['contextual-cues', 'sound-design']) {
    const redirect = readFileSync(new URL(`../pages/projects/[slug]/${file}.vue`, import.meta.url), 'utf8')
    assert.match(redirect, /navigateTo\(`\/projects\/\$\{encodeURIComponent\(slug\)\}\/sound-and-labels`/)
  }
})
