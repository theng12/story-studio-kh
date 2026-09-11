import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  STEP_STATUS_FIELD,
  flowForVisualSource,
  isEpisodeDone,
  requiredStatusFields,
  type VisualSource,
} from '../composables/useProjectFlow.js'

/**
 * v1.4.82 — the "Pending only / Steps 10 of 12" vs "Greenlit 100%" split-brain.
 *
 * Two causes, both fixed here. The first was a stale server-side status cache
 * (see useEpisodes' `?invalidate=CODE`, guarded below). The second was that
 * three surfaces each kept a private copy of the step → status-field map and a
 * private "is it done" loop — and the copies had drifted: the Dashboard's was
 * missing Research and Introduction entirely. Same episode, different answers.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const board = read('../pages/projects/[slug]/board.vue')
const dashboard = read('../pages/projects/[slug]/index.vue')
const selector = read('../components/EpisodeSelector.vue')
const useEpisodes = read('../composables/useEpisodes.ts')

describe('one definition of a finished episode', () => {
  test('optional steps never hold an episode back', () => {
    for (const vs of ['continuity-chain', 'timestamp-driven', 'narrated-scenes'] as VisualSource[]) {
      const optionalFields = flowForVisualSource(vs)
        .filter(step => step.optional)
        .map(step => STEP_STATUS_FIELD[step.key])
        .filter(Boolean)
      assert.ok(optionalFields.length > 0, `${vs} should have optional steps with a status field`)
      for (const field of optionalFields) {
        assert.ok(
          !requiredStatusFields(vs).includes(field!),
          `${field} is optional for ${vs} and must not be required`,
        )
      }
    }
  })

  test('an episode with every required step done reads done, whatever the optional steps say', () => {
    const vs: VisualSource = 'continuity-chain'
    const allRequired: Record<string, boolean> = {}
    for (const field of requiredStatusFields(vs)) allRequired[field] = true

    assert.equal(isEpisodeDone(allRequired, vs), true, 'required steps alone must be enough')
    assert.equal(
      isEpisodeDone({ ...allRequired, research: false, introduction: false, 'motion_review': false }, vs),
      true,
      'unfinished OPTIONAL steps must not make an episode read pending',
    )
  })

  test('one missing required step makes it pending', () => {
    const vs: VisualSource = 'continuity-chain'
    const fields = requiredStatusFields(vs)
    for (const held of fields) {
      const status: Record<string, boolean> = {}
      for (const field of fields) status[field] = field !== held
      assert.equal(isEpisodeDone(status, vs), false, `${held} missing must read pending`)
    }
  })

  test('missing or empty status is never "done"', () => {
    assert.equal(isEpisodeDone(null, 'continuity-chain'), false)
    assert.equal(isEpisodeDone(undefined, 'continuity-chain'), false)
    assert.equal(isEpisodeDone({}, 'continuity-chain'), false)
  })

  test('the Board and the Dashboard both answer through the shared test', () => {
    assert.match(board, /isEpisodeDone\(ep\?\.status, visualSource\.value, episodeVisualSource\(ep\)\)/)
    assert.match(dashboard, /isEpisodeDone\(ep\?\.status as Record<string, unknown>, visualSource\.value\)/)
    // And neither may keep a private copy of the map any more.
    assert.doesNotMatch(board, /const STEP_FIELD: Record/)
    assert.doesNotMatch(dashboard, /const STATUS_FIELD: Record<string, keyof EpisodeRow\['status'\]> = \{/)
  })

  test('the selector takes its chip fields from the shared map, not a re-typed copy', () => {
    assert.match(selector, /import \{ STEP_STATUS_FIELD \} from '~\/composables\/useProjectFlow'/)
    assert.match(selector, /const F = STEP_STATUS_FIELD/)
    assert.match(selector, /\{ field: F\['scene-review'\]/)
    // Introduction was returned per episode and rendered on no chip at all.
    assert.match(selector, /\{ field: F\.introduction,\s+label: 'Introduction', conditional: true/)
  })

  test('the selector presents Script Generator immediately before optional Introduction', () => {
    const start = selector.indexOf('const STEP_CHIPS')
    const end = selector.indexOf('\n]', start)
    assert.ok(start > -1 && end > start, 'selector chip list must remain discoverable')
    const chips = selector.slice(start, end).replace(/^\s*\/\/.*$/gm, '')
    assert.match(chips, /\{ field: F\.script,\s+label: 'Script' \},\s*\n\s*\{ field: F\.introduction,\s+label: 'Introduction'/)
  })
})

describe('a mutation invalidates the episode it mutated', () => {
  test('the post-mutation read asks the server to drop that episode entry', () => {
    // `?mutation=<timestamp>` was only a browser cache-buster: the server read
    // it as a plain request and answered from a status computed BEFORE the
    // mutation. `?invalidate=CODE` is the handler that actually drops the entry.
    assert.doesNotMatch(useEpisodes, /episodes\?mutation=/)
    assert.match(useEpisodes, /\?invalidate=\$\{encodeURIComponent\(force\.invalidate\)\}/)
    assert.match(useEpisodes, /async function revalidateAfterMutation\(episodeCode\?: string\)/)
    assert.match(useEpisodes, /fetchOnce\(episodeCode \? \{ invalidate: episodeCode \} : true\)/)
  })

  test('every caller passes the code of the episode it just changed', () => {
    const research = read('../pages/projects/[slug]/research.vue')
    const sceneReview = read('../pages/projects/[slug]/scene-review.vue')
    assert.match(board, /revalidateAfterMutation\(ep\.episode_code\)/)
    assert.match(selector, /revalidateAfterMutation\(ep\.episode_code\)/)
    assert.match(sceneReview, /revalidateAfterMutation\(episodeCode\)/)
    assert.match(research, /const ep = episodeId\.value[\s\S]*?await refreshEpisodes\(ep\)/)
    // A code-less call cannot fix a stale entry, so none may remain.
    assert.doesNotMatch(board, /revalidateAfterMutation\(\)/)
    assert.doesNotMatch(selector, /revalidateAfterMutation\(\)/)
    assert.doesNotMatch(sceneReview, /revalidateAfterMutation\(\)/)
  })
})

describe('Pending only explains why a finished episode is still listed', () => {
  test('the selected episode keeps its row, and the row says why', () => {
    // Keeping it is deliberate: a step you just finished must not vanish from
    // under you mid-edit. It just has to stop reading as pending.
    assert.match(selector, /list\.filter\(ep => !ep\.status\[field\] \|\| ep\.episode_code === props\.modelValue\)/)
    assert.match(selector, /function retainedSuffix\(ep: any\): string/)
    assert.match(selector, /still listed because it is open/)
    assert.match(selector, /\{\{ statusSuffix\(ep\) \}\}\{\{ retainedSuffix\(ep\) \}\}/)
  })
})
