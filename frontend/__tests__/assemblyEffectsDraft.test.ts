/**
 * Video Assembly Step 4 — the render appearance popup.
 *
 * What this pins: the legacy global controls (video layout, logo, colour
 * grading, aged archive film, frame, single green-screen overlay and overlay
 * layers) edit a detached draft, never the live form; Apply is the only write
 * and lands in the captured episode's own `video_assembly_last_used` entry
 * (never the channel starting point or a preset); Browse never adopts, Apply
 * adopts only the files the draft changed; and Cancel/Escape/episode changes
 * discard without a write.
 *
 * The page half is pinned by source analysis (it needs the Nuxt runtime to
 * mount); the draft rules are exercised behaviourally through the shared
 * helper the popup uses.
 *
 * Not run here by instruction — the lead coordinates suite runs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  applyAssemblyStepDraft,
  beginAssemblyStepDraft,
  cancelAssemblyStepDraft,
  type AssemblyStepApplyResult,
} from '../utils/assembly-step-draft.ts'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)),
  'utf8',
)

function section(start: string, end: string): string {
  const from = page.indexOf(start)
  assert.ok(from >= 0, `missing: ${start}`)
  const to = page.indexOf(end, from + start.length)
  assert.ok(to > from, `missing: ${end}`)
  return page.slice(from, to)
}

interface RenderAppearance {
  logo: { enabled: boolean; image_path: string }
  colorGrading: { enabled: boolean; preset: string; brightness: number }
  frame: { enabled: boolean; background_path: string }
  chromaKey: { enabled: boolean; source_path: string }
  overlays: { enabled: boolean; layers: Array<{ id: string; source_path: string; time_range: { start_s: number; end_s: number | null } | null }> }
  compilationLayout: { layout: 'standard' | 'compilation'; backgroundPlate: { source_path: string } }
}

function live(): RenderAppearance {
  return {
    logo: { enabled: true, image_path: '${CHANNEL}/assets/logo.png' },
    colorGrading: { enabled: false, preset: 'none', brightness: 0 },
    frame: { enabled: false, background_path: '' },
    chromaKey: { enabled: false, source_path: '' },
    overlays: { enabled: true, layers: [{ id: 'ov_1', source_path: '${PROJECT}/overlays/fire.webm', time_range: { start_s: 0, end_s: 10 } }] },
    compilationLayout: { layout: 'standard', backgroundPlate: { source_path: '' } },
  }
}

const DREAMLANDS = { channel: 'dreamlands', episode: 'EP0007' }

function failure(result: AssemblyStepApplyResult): string {
  if (result.ok) assert.fail('expected Apply to be refused')
  return result.error
}

describe('step 4 render appearance draft', () => {
  test('editing is detached: logo, grading, frame and overlay windows stay out of the live form', () => {
    const current = live()
    const draft = beginAssemblyStepDraft(current, DREAMLANDS)

    draft.value.logo.image_path = '/raw/other-logo.png'
    draft.value.colorGrading.enabled = true
    draft.value.colorGrading.preset = 'warm'
    draft.value.frame.enabled = true
    draft.value.overlays.layers[0]!.time_range = { start_s: 4, end_s: 8 }

    assert.equal(current.logo.image_path, '${CHANNEL}/assets/logo.png')
    assert.equal(current.colorGrading.enabled, false)
    assert.equal(current.frame.enabled, false)
    assert.deepEqual(current.overlays.layers[0]!.time_range, { start_s: 0, end_s: 10 })
    // The draft keeps the episode's own file and its window — it is not a preset.
    assert.deepEqual(draft.value.overlays.layers[0]!.time_range, { start_s: 4, end_s: 8 })
    assert.equal(draft.value.logo.image_path, '/raw/other-logo.png')
  })

  test('Cancel discards without calling the save callback', async () => {
    let calls = 0
    const draft = beginAssemblyStepDraft(live(), DREAMLANDS)
    draft.value.logo.enabled = false

    cancelAssemblyStepDraft(draft)
    const refused = await applyAssemblyStepDraft(draft, draft.scope, async () => { calls += 1 })

    assert.match(failure(refused), /cancelled/i)
    assert.equal(calls, 0)
  })

  test('Apply saves the draft once, against the captured episode', async () => {
    const seen: RenderAppearance[] = []
    let scopes = 0
    const draft = beginAssemblyStepDraft(live(), DREAMLANDS)
    draft.value.chromaKey.enabled = true
    draft.value.chromaKey.source_path = '/raw/green.mp4'

    const result = await applyAssemblyStepDraft(draft, draft.scope, (value, scope) => {
      assert.deepEqual(scope, { ...DREAMLANDS, scene: undefined })
      seen.push(value)
      scopes += 1
    })

    assert.equal(result.ok, true)
    assert.equal(scopes, 1)
    assert.equal(seen[0]!.chromaKey.source_path, '/raw/green.mp4')
  })

  test('an Apply after switching episode is refused and writes nothing', async () => {
    let calls = 0
    const draft = beginAssemblyStepDraft(live(), DREAMLANDS)
    draft.value.frame.enabled = true

    const refused = await applyAssemblyStepDraft(
      draft,
      { channel: 'dreamlands', episode: 'EP0008' },
      async () => { calls += 1 },
    )

    assert.match(failure(refused), /EP0007/)
    assert.match(failure(refused), /EP0008/)
    assert.equal(calls, 0)
    assert.equal(draft.value.frame.enabled, true)
  })
})

describe('step 4 popup wiring', () => {
  const popup = section('<!-- Per-episode render appearance (1.4.384)', '<!-- Background picker modal -->')

  test('the page keeps one summary and one Edit entry, and the controls live in the popup', () => {
    assert.match(page, /<h4>Render appearance<\/h4>/, 'the inline section is a summary')
    assert.match(page, /\{\{ renderAppearanceSummary \}\}/, 'the summary describes the applied look')
    assert.match(page, />\s*Edit render appearance\s*<\/button>/, 'one obvious entry')
    assert.match(page, /@click="openRenderAppearanceEditor"/, 'the entry opens the popup')
    assert.match(page, /Open episode effects editor/, 'the episode editor keeps its own entry')
    assert.equal(page.match(/<EpisodeEffectsEditor\b/g)?.length, 1, 'there is no duplicate episode editor')
    assert.doesNotMatch(popup, /id="episode-effects-title"/, 'the render popup does not copy the episode editor')
  })

  test('every legacy control edits the detached draft', () => {
    assert.match(popup, /v-model="renderAppearanceEdit\.logo\.enabled"/)
    assert.match(popup, /v-model="renderAppearanceEdit\.colorGrading\.enabled"/)
    assert.match(popup, /v-model="renderAppearanceEdit\.agedArchiveFilm\.enabled"/)
    assert.match(popup, /v-model="renderAppearanceEdit\.frame\.enabled"/)
    assert.match(popup, /v-model="renderAppearanceEdit\.chromaKey\.enabled"/)
    assert.match(popup, /v-model="renderAppearanceEdit\.overlays\.enabled"/)
    assert.match(popup, /renderAppearanceEdit\.compilationLayout\.layout/)
    assert.match(popup, /renderAppearanceEdit\.excludeIntroFromEffects/)
    assert.match(popup, /@click="applyColorPreset\(cp\.id, renderAppearanceEdit\.colorGrading\)"/)
    assert.doesNotMatch(popup, /v-model="logo\./, 'no control still writes the live logo')
    assert.doesNotMatch(popup, /v-model="colorGrading\./, 'no control still writes live grading')
  })

  test('Browse never adopts; Apply adopts only the files the draft changed', () => {
    assert.match(popup, /<FilePicker/, 'the popup still uses the existing file control')
    assert.doesNotMatch(popup, /:episodes-root=/, 'Browse must not adopt while the draft is being edited')

    const open = section('function openRenderAppearanceEditor', 'async function saveRenderAppearanceDraft')
    assert.match(open, /snapshotAllSettings\(\)/, 'the popup captures the full settings it opened on')
    assert.match(open, /reactive\(beginAssemblyStepDraft/, 'the draft must be reactive so its controls update')
    assert.match(open, /episodesRoot\.value/, 'the output root is captured when the popup opens')

    const save = section('async function saveRenderAppearanceDraft', 'function commitRenderAppearanceDraft')
    assert.match(save, /const adoptRoot = renderAppearanceAdoptRoot\.value/, 'the save reads the captured root before awaiting')
    assert.match(save, /path === String\(original \|\| ''\)\.trim\(\)/, 'an unchanged selection is left alone')
    assert.match(save, /collapseToPortablePath\(path, true, adoptRoot, true\)/, 'only a changed raw path is adopted, strictly')
    assert.match(save, /originals\.logo/, 'the logo is compared with the state captured on open')
    assert.match(save, /originals\.chroma/, 'the green-screen source is compared with the state captured on open')
  })

  test('Apply is the only write, and it lands in the captured episode entry', () => {
    const save = section('async function saveRenderAppearanceDraft', 'function commitRenderAppearanceDraft')
    assert.match(save, /persistEpisodeStepSettings\(/, 'the save uses the existing per-episode writer')
    assert.match(save, /base\.effects = \{/, 'the legacy effects are the slot that changes')
    assert.match(save, /logo: \{ \.\.\.value\.logo \}/)
    assert.match(save, /color_grading: \{ \.\.\.value\.colorGrading \}/)
    assert.match(save, /overlays: \{/, 'overlay layers, windows included, are in the saved look')
    assert.match(save, /compilation_layout: \{/, 'video layout is saved with the episode')
    assert.match(save, /overlay_time_ranges: timings/, 'overlay windows are saved against the captured episode')
    assert.doesNotMatch(save, /recordLastUsedSettings|effectsPresets|channel:\s*\{/, 'no preset or channel starting point is rewritten')
    assert.doesNotMatch(save, /persistEpisodeOverlayTimings/, 'no debounced edit watcher writes during the draft')

    const apply = section('async function applyRenderAppearanceDraft', 'function closeRenderAppearanceEditor')
    assert.match(apply, /applyAssemblyStepDraft\(/)
    assert.match(apply, /sameAssemblyStepScope\(draft\.scope/, 'a late answer cannot write EP0007 values into EP0008')
    assert.match(apply, /commitRenderAppearanceDraft\(draft\.value\)/, 'the live form changes only after Apply')
    assert.match(page, /:inert="renderAppearanceApplying \? true : undefined"/, 'controls are inert while saving')
    assert.match(page, /:disabled="renderAppearanceApplying \|\| !episodeId"[\s\S]{0,80}@click="applyRenderAppearanceDraft"/, 'Apply cannot fire twice')
  })

  test('Cancel, Escape and an episode change discard the draft', () => {
    const close = section('function closeRenderAppearanceEditor', 'watch([slug, episodeId], () => closeRenderAppearanceEditor())')
    assert.match(close, /cancelAssemblyStepDraft\(/)
    assert.match(close, /renderAppearanceDraft\.value = null/)
    assert.match(page, /@close="closeRenderAppearanceEditor"/, 'Escape, backdrop and Close use the cancelling path')
    assert.match(page, />Cancel<\/button>/, 'the Cancel button uses the same path')
    assert.match(page, /watch\(\[slug, episodeId\], \(\) => closeRenderAppearanceEditor\(\)\)/)
    assert.match(page, /watch\(currentStep, \(step\) => \{ if \(step !== 4\) closeRenderAppearanceEditor\(\) \}\)/)
  })

  test('the preview is labelled approximate while the popup edits a draft', () => {
    assert.match(page, /Preview of the look already applied to this episode/)
    assert.match(page, /Changes made in\s+Edit render appearance appear after Apply/)
  })

  test('overlay drag and timing edits stage into the draft instead of writing a watcher', () => {
    const helpers = section('function setOverlayTimeRangeEnabled', '// Render timeline ticks every 60s')
    assert.doesNotMatch(helpers, /persistEpisodeOverlayTimings/, 'time-range edits do not write while the popup is open')
    assert.match(popup, /renderAppearanceEdit\.overlays\.layers/, 'the popup passes its draft layers to the existing handlers')
  })
})
