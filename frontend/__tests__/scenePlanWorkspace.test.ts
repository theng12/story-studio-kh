import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const scenePlan = source('../pages/projects/[slug]/scene-plan.vue')

describe('Scene Plan workspace', () => {
  test('uses Character Sheet as the single continuity style source', () => {
    assert.doesNotMatch(scenePlan, /<StylePicker/)
    assert.doesNotMatch(scenePlan, /v-model="form\.style_prompt"/)
    assert.doesNotMatch(scenePlan, /style_prompt: form\.value\.style_prompt/)
    assert.match(scenePlan, /Style from Character Sheet/)
    assert.match(scenePlan, /Edit Character Sheet/)
    assert.match(scenePlan, /delete activeData\.style_prompt/)
  })

  test('keeps prompt batching and motion controls visible', () => {
    assert.match(scenePlan, /class="scene-workflow-grid/)
    assert.match(scenePlan, /Scenes per cloud pack/)
    assert.match(scenePlan, /PROMPT_PACK_PRESETS = \[1, 3, 5, 10, 15, 20, 25, 30, 50\]/)
    assert.match(scenePlan, /value="custom"/)
    assert.match(scenePlan, /customPromptPackSize/)
    assert.match(scenePlan, /prompt_pack_size: form\.value\.prompt_pack_size/)
    assert.doesNotMatch(scenePlan, /<details[^>]*advanced-panel/)
    assert.match(scenePlan, /class="scene-motion-controls"/)
    assert.match(scenePlan, /:disabled="!form\.generate_motion_prompts"/)
    assert.doesNotMatch(scenePlan, /v-if="form\.generate_motion_prompts" class="mt-2"/)
  })

  test('condenses configuration responsively without hiding controls', () => {
    assert.match(scenePlan, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
    assert.match(scenePlan, /@media \(max-width: 900px\)/)
    assert.match(scenePlan, /\.scene-workflow-grid \{ grid-template-columns: 1fr; \}/)
  })

  test('adds one-pass creative direction without restoring a second scene planner', () => {
    assert.match(scenePlan, />Visual interpretation</)
    assert.match(scenePlan, /one strategy is assigned to each scene before existing prompt packs run/)
    assert.match(scenePlan, /creative_direction: creativeDirectionPayload\.value/)
    assert.match(scenePlan, /snapshot: \(\) => \(\{[\s\S]*creative_direction: creativeDirectionPayload\.value/)
    assert.match(scenePlan, /delete activeData\.creative_direction/)
    assert.match(scenePlan, /class="scene-strategy-badge"/)
    assert.match(scenePlan, /CREATIVE_PROFILES/)
  })
})
