/**
 * X-06 (owner decision 2026-09-22) — the two Scene Plan guidance boxes.
 *
 * The page has an episode-only box (`custom_instructions`) and a reusable box
 * whose text travels in Scene Plan presets. The backend accepts ONE guidance
 * input, so the two are composed here. These cases pin the part that matters:
 * a customer who never touches the reusable box sends exactly what this page
 * sent before the field existed, and a customer who uses both gets text in
 * which the model and the job log can tell the two apart.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { composeScenePlanGuidance } from '../utils/scene-plan-guidance.ts'

const pageSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)

test('no guidance at all stays absent, rather than an empty string', () => {
  assert.equal(composeScenePlanGuidance('', ''), undefined)
  assert.equal(composeScenePlanGuidance('   ', '\n'), undefined,
    'whitespace is not guidance — the backend must not receive a blank block')
  assert.equal(composeScenePlanGuidance(null, undefined), undefined)
})

test('episode guidance alone is sent byte-identically to the pre-X-06 payload', () => {
  assert.equal(
    composeScenePlanGuidance('keep the protagonist off-centre', ''),
    'keep the protagonist off-centre',
    'no label may be added when there is no reusable text to tell it apart from',
  )
})

test('reusable guidance alone reaches the backend', () => {
  assert.equal(composeScenePlanGuidance('', 'one subject per scene'), 'one subject per scene')
})

test('both boxes are composed with labels, episode first', () => {
  const composed = composeScenePlanGuidance('  keep the red scarf  ', '\n never render legible text \n')
  assert.equal(
    composed,
    'Episode-specific guidance:\nkeep the red scarf\n\nReusable guidance:\nnever render legible text',
  )
  assert.ok(composed!.indexOf('keep the red scarf') < composed!.indexOf('never render legible text'),
    'the episode’s own instruction is stated before the standing rule')
})

test('every Scene Plan request that carries guidance composes both boxes', () => {
  assert.match(pageSource, /import \{ composeScenePlanGuidance \} from '\.\.\/\.\.\/\.\.\/utils\/scene-plan-guidance\.js'/,
    'the page must use the shared composer rather than its own copy')
  assert.doesNotMatch(pageSource, /custom_instructions: form\.value\.custom_instructions\.trim\(\) \|\| undefined/,
    'a raw episode-only payload site would silently drop the reusable rule')
  const composed = pageSource.match(/custom_instructions: composeScenePlanGuidance\(/g) || []
  assert.ok(composed.length >= 3,
    `plan, prompt-pack and repair requests must all carry both boxes (found ${composed.length})`)
})
