import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

function fn(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `expected ${name}`)
  const next = source.indexOf('\nasync function ', start + 10)
  const nextSync = source.indexOf('\nfunction ', start + 10)
  const ends = [next, nextSync].filter(index => index > 0)
  return source.slice(start, Math.min(...ends))
}

// Gate limits: source assertions cannot see that the grid really keeps its scroll position or
// that the confirm dialog renders; they pin the wiring that makes both true.

test('a refresh never replaces the grid with the loading placeholder', () => {
  assert.match(source, /v-else-if="loading && !scenes\.length"/)
  assert.doesNotMatch(source, /v-else-if="loading" class="card mt-3 empty-state"/)
})

test('cache buster moves only when a clip changed, an upload landed, or a clip job finished', () => {
  const body = fn('loadReview')
  assert.match(body, /options\.bustCache \|\| clipsChanged/)
  assert.doesNotMatch(body, /^\s*cacheBuster\.value = Date\.now\(\)/m)
  assert.match(source, /await loadReview\(\{ bustCache: true \}\)\n\s*success\(`External clip uploaded/)
  assert.match(source, /watch\(clipJobsActive, \(active, wasActive\) => \{\s*if \(wasActive && !active\) void loadReview\(\{ bustCache: true \}\)/)
})

test('a failed load shows a retryable error instead of the false empty plan', () => {
  assert.match(source, /const loadError = ref\(''\)/)
  assert.match(source, /v-else-if="loadError && !scenes\.length"[\s\S]*@click="loadReview\(\)"[\s\S]*Try again/)
  assert.ok(source.indexOf('loadError && !scenes.length') < source.indexOf('No scene plan is available yet'))
  assert.match(fn('loadReview'), /loadError\.value = error\?\.data\?\.detail/)
  assert.match(fn('resetEpisodeScopedMotionState'), /loadError\.value = ''/)
})

test('replacing an existing clip and keeping all stills ask first', () => {
  assert.match(source, /const \{ ask \} = useConfirm\(\)/)
  assert.match(fn('generateOne'), /scene\.clip_exists && !await ask\(\{[\s\S]*charged again/)
  assert.match(fn('uploadClipOne'), /scene\.clip_exists && !await ask\(\{[\s\S]*replaces the current clip/)
  assert.match(source, /async function keepAllStills\(\) \{\s*if \(!await ask\(/)
  assert.doesNotMatch(source, /const keepAllStills = \(\) => setAll/)
})

test('Generate missing clips confirms the count and says so when nothing was queued', () => {
  const body = fn('generateMissing')
  assert.ok(body.indexOf('await ask(') > 0 && body.indexOf('await ask(') < body.indexOf('queuing.value = true'))
  assert.match(body, /Estimated total: \$\{formatCredits\(batchListedTotal\.value\)\}/)
  assert.match(body, /videoHasUsdPrice\.value \? ''/, 'no credit price is invented when the model has a USD price')
  assert.match(body, /Nothing new to queue/)
  assert.doesNotMatch(body, /success\(`\$\{result\.queued \|\| 0\}/)
})

test('owner-facing wording is plain English', () => {
  assert.doesNotMatch(source, /provider quote is authoritative|Listed total|Listed cost|Published aspect ratio|published aspect ratio|No published resolution|Choose a published/)
  assert.match(source, /Price is confirmed when each clip starts\./)
  assert.match(source, /aria-label="Aspect ratio"/)
  assert.match(source, /aria-label="Resolution"/)
})

test('the Generate button and its status fit at 1280px (tracks may shrink; own row below 1400px)', () => {
  assert.doesNotMatch(source, /minmax\(350px, auto\) minmax\(420px, 1fr\)/)
  assert.match(source, /\.motion-command-bar :deep\(\.top-action-bar\) \{ display: grid; grid-template-columns: minmax\(0, auto\) minmax\(0, 1fr\) minmax\(0, auto\);/)
  assert.match(source, /@media \(max-width: 1400px\) \{\n  \.motion-command-bar :deep\(\.top-action-bar\)/)
})
