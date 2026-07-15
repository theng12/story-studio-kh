import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const pipeline = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)),
  'utf8',
)

describe('Pipeline stage selection', () => {
  test('starts empty and exposes safe bulk-selection shortcuts', () => {
    const initialSelection = pipeline.match(/const stepChecked = reactive<Record<StepId, boolean>>\(\{([\s\S]*?)\n\}\)/)?.[1] || ''
    assert.ok(initialSelection, 'step selection initializer is missing')
    assert.doesNotMatch(initialSelection, /:\s*true/)

    assert.match(pipeline, /function clearSelectedSteps\(\)/)
    assert.match(pipeline, /function selectRequiredSteps\(\)/)
    assert.match(pipeline, /if \(!step\.optional\) stepChecked\[step\.id\] = true/)
    assert.match(pipeline, /function selectAllSteps\(\)/)
    assert.match(pipeline, />Required stages<\/button>/)
    assert.match(pipeline, />Select all<\/button>/)
    assert.match(pipeline, />Clear<\/button>/)
  })
})
