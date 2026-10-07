/** Scene Review: the safe "Check Again" leads, and the attention chips stop at 12 + "+N more". */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url), 'utf8')

test('Check Again is the primary action; Replace Anyway stays the warning one', () => {
  assert.match(page, /class="btn btn-sm btn-primary" :disabled="checkingUncertain \|\| replacingUncertain" @click="checkUncertainAgain"/)
  assert.match(page, /class="btn btn-sm btn-warn" :disabled="replacingUncertain \|\| checkingUncertain" @click="replaceUncertainImages"/)
})

test('attention chips: first 12, then "+N more", reset on an episode change', () => {
  assert.match(page, /const PROBLEM_CHIP_LIMIT = 12/)
  assert.match(page, /v-for="p in shownProblemScenes"/)
  assert.match(page, /v-if="hiddenProblemCount > 0"[\s\S]*?@click="showAllProblems = true"[\s\S]*?>\+\{\{ hiddenProblemCount \}\} more</)
  assert.match(page, /watch\(episodeId, \(\) => \{ showAllProblems\.value = false \}\)/)
  assert.doesNotMatch(page, /v-for="p in problemScenes"/)
})
