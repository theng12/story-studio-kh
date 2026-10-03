/**
 * DS-09 (E-01, E-02, E-06) — a failed read must not render as a confident,
 * specific, wrong answer.
 *
 * The frontend lane's convention for page behaviour is source analysis (the
 * pages need the Nuxt runtime to mount); the rendered halves live in the
 * mounted Jobs harness and the manual checks. These pin the distinctions the
 * pages must keep: read failure vs no data.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function page(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../pages/projects/[slug]/${name}`, import.meta.url)), 'utf8')
}

test('E-01: Scene Review keeps a read failure distinct from "no scene plan"', () => {
  const source = page('scene-review.vue')
  const load = source.slice(source.indexOf('async function loadReview()'), source.indexOf('async function generateOne'))
  assert.match(load, /reviewError\.value = .*Could not load/s, 'the read catch must retain the failure')
  assert.match(load, /reviewError\.value = ''/, 'a successful read or an empty episode must clear it')
  assert.match(source, /!stats && !plan && !loading && !reviewError/, 'the "No scene plan yet" card must not render after a failed read')
  assert.match(source, /Scene Review could not be loaded[\s\S]{0,400}@click="loadReview\(\)"/, 'the failure must offer a retry')
})

test('E-02: Research distinguishes a failed source read from an unconfigured API', () => {
  const source = page('research.vue')
  assert.match(source, /const sourcesError = ref\(''\)/, 'the page must track the source-read failure')
  const loader = source.slice(source.indexOf('async function loadSources('), source.indexOf('// Form state contains no provider selector'))
  assert.match(loader, /sourcesError\.value = .*Failed to load research sources/s)
  assert.match(loader, /sourcesError\.value = ''/, 'a successful read clears the failure')
  const reason = source.slice(source.indexOf('const runDisabledReason = computed'), source.indexOf('// ── Result state'))
  assert.match(reason, /if \(sourcesError\.value\) return 'Could not check Gateway access/, 'unknown must not read as "not configured"')
  assert.match(reason, /Gateway not configured — Settings → This Mac/, 'the genuine unconfigured case keeps its guidance')
  const sourcesAt = reason.indexOf('sourcesError.value')
  const configuredAt = reason.indexOf('Gateway not configured')
  assert.ok(sourcesAt >= 0 && configuredAt >= 0 && sourcesAt < configuredAt, 'the unknown reason must be checked before the unconfigured one')
})

test('E-06: Pipeline distinguishes a failed accepted-ideas read from zero accepted ideas', () => {
  const source = page('pipeline.vue')
  const errorBranch = source.indexOf('v-else-if="!episodes.length && epError"')
  const emptyBranch = source.indexOf('No accepted ideas yet.')
  assert.ok(errorBranch >= 0, 'the failed-read branch must exist')
  assert.ok(emptyBranch >= 0, 'the genuine-empty branch must exist')
  assert.ok(errorBranch < emptyBranch, 'the failed-read branch must precede the empty branch')
  assert.match(source.slice(errorBranch, emptyBranch), /@click="refreshEpisodes"/, 'the failure must offer a retry')
})

test('E-03: a failed Introduction read is unknown, never "this channel has no Introduction"', () => {
  for (const name of ['pipeline.vue', 'audio.vue']) {
    const source = page(name)
    assert.match(source, /const channelIntroEnabled = ref<boolean \| null>\(null\)/, `${name} must keep an explicit unknown state`)
    assert.match(source, /channelIntroEnabled\.value = null/, `${name} must clear to unknown on a failed read`)
    assert.match(source, /@click="loadChannelIntroduction"/, `${name} must offer a retry`)
  }
  const pipeline = page('pipeline.vue')
  // Only a KNOWN-true channel includes the Introduction step.
  assert.match(pipeline, /stepChecked\['introduction-only'\] = !!stepChecked\['script-only'\] && channelIntroEnabled\.value === true/)
  // And the step reason distinguishes "unknown" from "no opening".
  assert.match(pipeline, /if \(channelIntroEnabled\.value === null\)[\s\S]{0,200}could not check/i)
  assert.match(pipeline, /channelIntroUnknown/, 'the page must surface the unknown state')

  const audio = page('audio.vue')
  // The pre-spend warning must survive a failed check.
  assert.match(audio, /openingCheckUnknown/)
  assert.match(audio, /openingMissing = computed\(\(\) => channelIntroEnabled\.value === true/)
  assert.match(audio, /Could not check whether this channel opens with an Introduction/)
})

test('E-10: deleting a Scene Plan leaves an actionable empty state, not a heading-only card', () => {
  const source = page('scene-plan.vue')
  // The plan section renders only when a plan object actually exists (or one is
  // being built); a stale `status.scene_plan` after a delete no longer keeps the
  // heading on screen by itself.
  assert.match(source, /<section v-if="plan \|\| planBusy"/)
  const emptyAt = source.indexOf('<section v-else class="card mt-3">')
  assert.ok(emptyAt >= 0, 'the no-plan empty card must exist')
  const empty = source.slice(emptyAt, emptyAt + 700)
  assert.match(empty, /Build the Plan/, 'the empty state must name an action')
  assert.match(empty, /@click="planScenes"/, 'and that action must be reachable')
})
