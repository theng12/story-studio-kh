import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')
const stylePicker = source('../components/StylePicker.vue')
const continuityRoute = source('../../electron/server/routes/continuity.ts')
// The config shape, defaults, and preset boundary moved out of the SFC so
// tests can import and exercise them — see continuityPresetPacing.test.ts.
const continuityConfig = source('../composables/useContinuityConfig.ts')
const scenePlanGenerator = source('../../electron/server/generators/scene-plan.ts')
const scenePlanPacing = source('../../electron/server/services/scene-plan-pacing.ts')
const scenePlanRoute = source('../../electron/server/routes/scene-plan.ts')
const assetStatus = source('../../electron/server/services/asset-status.ts')
const videoRoute = source('../../electron/server/routes/video.ts')
const scenePlanPage = source('../pages/projects/[slug]/scene-plan.vue')
const pacingConstant = source('../../electron/server/contracts/pacing.ts')

describe('Character Sheet workspace', () => {
  test('uses compact visual anchors and style controls, with Scene Plan owning timing and motion', () => {
    assert.match(characterSheet, /<h3>Visual anchors<\/h3>/)
    assert.match(characterSheet, /<h3>Visual art style<\/h3>/)
    assert.match(characterSheet, /<h3>Visual timing & motion<\/h3>/)
    assert.match(characterSheet, /Open Scene Plan/)
    assert.match(characterSheet, /Episode visual anchor/)
    assert.doesNotMatch(characterSheet, />3\. Style reference</)
    assert.doesNotMatch(characterSheet, />4\. Continuity settings</)
    assert.doesNotMatch(characterSheet, /Guide character appearance/)
    assert.doesNotMatch(characterSheet, /Each scene references/)
    assert.doesNotMatch(characterSheet, /Variation per scene/)
    assert.doesNotMatch(characterSheet, />5\. Visual Recipe</)
    assert.doesNotMatch(characterSheet, /config\.recipe/)
  })

  /**
   * Composition template — DELIBERATELY REVERSED on 2026-08-27.
   *
   * These three functions used to be asserted ABSENT by the test above. The
   * owner asked for the feature back in as many words ("composition UI, yeah
   * we should restore it"), and the backend had never actually gone away: the
   * config flag, the POST normalizer, the generate and delete routes, the
   * job type and `generators/composition-template.ts` all stayed live the
   * whole time. What was missing was any control at all, plus the
   * `composition` key in `normalizeContinuityConfig`'s rebuilt `references`
   * object — and because that normalizer rebuilds field by field, one missing
   * line silently dropped the flag on every load and every save.
   *
   * So the assertions are inverted rather than deleted: a flag that
   * round-trips but has no control is not restored, and a control that exists
   * while the normalizer drops the flag is not restored either. Both halves
   * are checked here so neither can rot away again on its own.
   */
  test('reaches the composition template end to end — control, flag, and generate path', () => {
    assert.match(characterSheet, /Composition template/)
    assert.match(characterSheet, /onCompositionFiles/)
    assert.match(characterSheet, /removeComposition/)
    assert.match(characterSheet, /generateComposition/)
    // The checkbox that makes the flag the customer's, not an upload's side effect.
    assert.match(characterSheet, /v-model="config\.references\.composition"/)
    // The generate path needs a model, so the picker has to be on the page too.
    assert.match(characterSheet, /<ImageModelPicker v-model="compositionModel"/)
    assert.match(characterSheet, /img2img-references\/composition\/generate/)
    // The other half: the flag must survive a load and a save.
    assert.match(continuityConfig, /composition: boolean/)
    assert.match(continuityConfig, /composition: value\?\.references\?\.composition \?\? d\.references\.composition/)
  })

  test('uses Content Pack styles without project custom-style authoring', () => {
    assert.match(characterSheet, /:show-custom-styles="false"/)
    assert.match(stylePicker, /v-if="showCustomStyles !== false"/)
    assert.match(stylePicker, /showCustomStyles\?: boolean/)
    assert.match(characterSheet, /:active-style-bible="config\.style_bible"/)
  })

  test('keeps uploaded episode anchors comfortably inspectable and synchronizes legacy sheet flags', () => {
    assert.match(characterSheet, /target="_blank"/)
    assert.match(characterSheet, /View full size/)
    assert.match(characterSheet, /object-fit: contain/)
    assert.match(characterSheet, /const episodeAnchorEnabled = computed/)
    assert.match(characterSheet, /config\.value\.references\.sheet = enabled/)
    assert.match(continuityConfig, /const useEpisodeSheet = value\?\.use_episode_sheet === true \|\| value\?\.references\?\.sheet === true/)
  })

  test('filters the retired recipe field from saved configs and presets', () => {
    assert.match(continuityConfig, /export function normalizeContinuityConfig/)
    assert.doesNotMatch(continuityConfig, /interface ContinuityConfig \{[^}]*recipe:/s)
  })

  test('defaults new continuity sheets to dense one-to-three-second scenes', () => {
    assert.match(pacingConstant, /export const DEFAULT_SCENE_PACING = \{ min_sec: 1, max_sec: 3 \} as const/)
  })
})

/**
 * Regression: commit a3d0925 changed the Continuity Engine's default scene
 * pacing from 1-4s to 1-3s in two places (this generator and this route) and
 * claimed, in its own commit message, that those were "both places that
 * decided it." They weren't — `useContinuityConfig.ts` and `scene-plan.vue`
 * carried independent hardcoded copies of the same decision and were left
 * behind at 1-4s, so a fresh Character Sheet and a fresh Scene Plan page
 * disagreed about a project's own pacing.
 *
 * DEFAULT_SCENE_PACING (electron/server/contracts/pacing.ts) fixes the
 * disagreement, but a shared constant only prevents drift for as long as
 * every consumer actually imports it. The tests below cover the two failure
 * modes that would silently reopen this bug:
 *
 *  1. One of the four known consumers gets edited back to a hardcoded
 *     literal (e.g. someone "simplifies" an import away). The per-file
 *     assertions catch this with a precise, file-named failure.
 *  2. A new consumer is added anywhere else in electron/server or frontend
 *     and hardcodes the pair instead of importing it — the exact shape of
 *     the original defect, just in a fifth location nobody wrote a targeted
 *     test for. The source-tree sweep below catches that case: it does not
 *     know the file will exist, only that a hardcoded `min_sec: <n>,
 *     max_sec: <n>` pair may not exist anywhere except the one constant
 *     module that is allowed to declare it.
 *
 * A test that only asserts "the default is 3" (as the pre-a3d0925 version of
 * this file did, for exactly the value that then drifted) would pass on a
 * second hardcoded copy just as happily as on the shared import. These tests
 * assert the IMPORT, not just the value, plus the sweep asserts there is no
 * second copy left to drift.
 */
describe('Continuity Engine default scene pacing — single source of truth', () => {
  test('routes/continuity.ts imports the shared default instead of hardcoding it', () => {
    assert.match(continuityRoute, /import \{[^}]*\bDEFAULT_SCENE_PACING\b[^}]*\} from '\.\.\/contracts\/pacing\.js'/)
    assert.match(continuityRoute, /pacing: \{ \.\.\.DEFAULT_SCENE_PACING \}/)
    // The PUT coercion fallback (an omitted min_sec/max_sec) must fall back
    // to the SAME default, not a second hardcoded number -- this is the
    // "coercion fallback of the form `|| 4`" instance of the bug.
    assert.match(continuityRoute, /parseScenePacing\(b\.pacing\)/)
    assert.doesNotMatch(continuityRoute, /Number\(b\.pacing\?\./)
    assert.doesNotMatch(continuityRoute, /pacing:\s*\{\s*min_sec:\s*\d+,\s*max_sec:\s*\d+\s*\}/)
  })

  test('Scene Plan resolves the shared default through its readiness pacing service', () => {
    assert.match(scenePlanPacing, /import \{[^}]*\bDEFAULT_SCENE_PACING\b[^}]*\} from '\.\.\/contracts\/pacing\.js'/)
    assert.match(scenePlanPacing, /pacing: ScenePlanPacing = \{ \.\.\.DEFAULT_SCENE_PACING, mode: 'live' \}/)
    assert.match(scenePlanGenerator, /import \{ allowedSubtitleCueGapSec, resolveScenePlanPacing/)
    assert.match(scenePlanGenerator, /await resolveScenePlanPacing\(job\.project_slug, paths\.episode_dir\)/)
    assert.doesNotMatch(scenePlanGenerator, /pacing\s*=\s*\{\s*min_sec:\s*\d+,\s*max_sec:\s*\d+/)
  })

  test('snapshotless repair uses a named legacy band without becoming a planning default', () => {
    assert.match(pacingConstant, /export const LEGACY_SNAPSHOTLESS_REPAIR_PACING = \{ min_sec: 3, max_sec: 12 \} as const/)
    assert.match(scenePlanPacing, /import \{[^}]*\bLEGACY_SNAPSHOTLESS_REPAIR_PACING\b[^}]*\} from '\.\.\/contracts\/pacing\.js'/)
    assert.equal((scenePlanPacing.match(/return \{ \.\.\.LEGACY_SNAPSHOTLESS_REPAIR_PACING \}/g) || []).length, 2)
    assert.doesNotMatch(continuityRoute, /LEGACY_SNAPSHOTLESS_REPAIR_PACING/)
    assert.doesNotMatch(continuityConfig, /LEGACY_SNAPSHOTLESS_REPAIR_PACING/)
    assert.doesNotMatch(scenePlanGenerator, /LEGACY_SNAPSHOTLESS_REPAIR_PACING/)
  })

  test('all four planning and readiness surfaces share the fixed subtitle cue-gap guard', () => {
    assert.match(scenePlanPacing, /export function allowedSubtitleCueGapSec\(\): number \{\s*return 30\s*\}/)
    for (const [name, consumer] of [
      ['Scene Plan generator', scenePlanGenerator],
      ['Scene Plan status', scenePlanRoute],
      ['episode asset status', assetStatus],
      ['video preflight', videoRoute],
    ] as const) {
      assert.match(consumer, /max_cue_gap_sec: allowedSubtitleCueGapSec\(\)/, `${name} must use the fixed shared guard`)
      assert.doesNotMatch(consumer, /allowedSubtitleCueGapSec\([^)]/, `${name} must not couple subtitle admission to visual pacing`)
    }
  })

  test('useContinuityConfig.ts imports the shared default instead of hardcoding it', () => {
    assert.match(continuityConfig, /import \{[^}]*\bDEFAULT_SCENE_PACING\b[^}]*\} from '@shared\/pacing'/)
    assert.match(continuityConfig, /pacing: \{ \.\.\.DEFAULT_SCENE_PACING \}/)
    assert.doesNotMatch(continuityConfig, /pacing:\s*\{\s*min_sec:\s*\d+,\s*max_sec:\s*\d+\s*\}/)
  })

  test('scene-plan.vue uses the normalized episode pacing instead of hardcoding a default', () => {
    assert.match(scenePlanPage, /continuityPacing\.value = config\.pacing/)
    assert.doesNotMatch(scenePlanPage, /\{\s*min_sec:\s*\d+,\s*max_sec:\s*\d+\s*\}/)
  })

  test('no file outside contracts/pacing.ts hardcodes a min_sec/max_sec default pair', () => {
    // Walks the real source tree rather than a fixed file list, so a NEW
    // hardcoded copy -- in a file nobody thought to name here -- fails this
    // test the same way the four known ones do above. Excludes test files:
    // fixtures legitimately pass explicit min_sec/max_sec into generic
    // splitting/repair functions (e.g. scene-planner-salvage.test.ts) and
    // that is not this defect.
    const EXCLUDE_DIRS = new Set([
      'node_modules', '.git', '.nuxt', '.claude', '__tests__',
      'dist', 'build', 'out', 'coverage', 'worktrees',
      'frontend', // frontend/frontend/ is a stray generated build dir (gitignored)
    ])
    const EXTS = ['.ts', '.vue']
    const HARDCODED_PACING_PAIR = /min_sec:\s*\d+\s*,\s*max_sec:\s*\d+/

    function collectSourceFiles(rootDir: string): string[] {
      const results: string[] = []
      function walk(dir: string): void {
        let entries: import('node:fs').Dirent[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name)) continue
            walk(join(dir, entry.name))
          } else if (entry.isFile() && EXTS.some(ext => entry.name.endsWith(ext))) {
            results.push(join(dir, entry.name))
          }
        }
      }
      walk(rootDir)
      return results
    }

    const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
    const files = [
      ...collectSourceFiles(join(repoRoot, 'electron', 'server')),
      ...collectSourceFiles(join(repoRoot, 'frontend')),
    ]
    // Sanity check on the walker itself: a path typo that made it scan an
    // empty directory would make every assertion below vacuously true.
    assert.ok(files.length > 200, `expected to scan hundreds of source files, found ${files.length}`)

    const matches = files.filter(f => HARDCODED_PACING_PAIR.test(readFileSync(f, 'utf8')))
    const canonical = join(repoRoot, 'electron', 'server', 'contracts', 'pacing.ts')
    assert.deepEqual(
      matches,
      [canonical],
      'a hardcoded min_sec/max_sec default pair may only live in electron/server/contracts/pacing.ts — ' +
      'every other site must import DEFAULT_SCENE_PACING instead',
    )
  })
})
