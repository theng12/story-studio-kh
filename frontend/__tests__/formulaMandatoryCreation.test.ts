/**
 * The Formula is a required creation step with an explicit Generic choice.
 *
 * Owner ruling, 2026-10-25. The step is enforced in the wizard's own submit
 * gate: a Formula must be picked, or Generic must be chosen deliberately. The
 * payload always carries the choice so the backend can tell "chose Generic"
 * from "never chose" (AGENTS §6).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const home = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')

test('the create form makes the Formula a required, explicit choice', () => {
  // One form, no wizard steps — the 2026-08-08 collapse stands.
  assert.doesNotMatch(home, /v-for="s in 2"|currentStep/)
  // The shared picker stays bound exactly as before; the choice sits around it.
  assert.match(home, /<NichePicker v-model="form\.niche_id"/)
  assert.match(home, /<form class="create-form" @submit\.prevent="createProject">/)

  assert.match(home, /formula-choice/, 'the explicit choice UI must exist')
  assert.match(home, /value="formula"/)
  assert.match(home, /value="generic"/)
  assert.match(home, /Generic — no Formula/)
  // Not merely optional any more.
  assert.doesNotMatch(home, /optionally choose its repeatable formula/i)
})

test('submit is impossible until a Formula or Generic is chosen', () => {
  assert.match(home, /const formulaChoiceMade = computed/)
  assert.match(home, /form\.formula_choice === 'formula' && !!form\.niche_id/)
  // v1.4.374: a saved starting point carries its own Formula, so it stands in for the choice.
  assert.match(home, /!!form\.name\.trim\(\) && \(startingFromDefault\.value \? true : formulaChoiceMade\.value\)/)
  assert.match(home, /:disabled="!canCreateChannel \|\| creating"/)
})

test('the create payload records which choice was made', () => {
  const start = home.indexOf("await post<any>('/projects'")
  assert.ok(start > 0)
  const payload = home.slice(start, start + 900)
  assert.match(payload, /formula_choice: form\.formula_choice === 'generic' \? 'generic' : 'selected'/)
  assert.match(payload, /niche_id: form\.formula_choice === 'formula' \? form\.niche_id \|\| undefined : undefined/)
  // The create payload still says nothing about an episodes folder.
  assert.doesNotMatch(payload, /output_root/)
})

test('Generic replaces any half-picked Formula rather than leaving it standing', () => {
  assert.match(home, /function chooseGeneric\(\)[\s\S]*?form\.niche_id = ''/)
})

test('the creation copy gives the rhythm back to the episode', () => {
  assert.match(home, /rhythm is never decided here; it stays an episode choice in Scene Plan/i)
  assert.doesNotMatch(home, /Formula[^.]{0,80}locks? (the )?(episode|scene) rhythm/i)
})
