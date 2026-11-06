/**
 * Video Assembly Step 3 — the title / motion / chapter popup.
 *
 * What this pins: the popup edits a detached draft (never the live form),
 * Apply is the only write, it lands in the captured episode's own saved
 * settings (not the channel starting point), Cancel/Escape/browse write
 * nothing, and the chapter font field samples this episode's REAL heading —
 * never an invented one. The chapter font is only ever offered from an actual
 * saved channel pool, and no font/pool is chosen automatically.
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
} from '../utils/assembly-step-draft.ts'
import { pickLastUsedSettings, recordLastUsedSettings } from '../utils/video-assembly-last-used.js'

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

interface StepThreeSettings {
  timeline: {
    title_image: { enabled: boolean; image_path: string; duration: number }
    transition: { type: string; duration: number; pool: string[] }
    scene_reveal: { enabled: boolean; seed: number }
  }
  effects: {
    title_card: { text: string; background_media_path: string }
    chapter_titles: { enabled: boolean; chapter_title_presentation?: { font_id?: string } | null }
  }
}

function live(): StepThreeSettings {
  return {
    timeline: {
      title_image: { enabled: true, image_path: '/episodes/EP0007/title.webp', duration: 5 },
      transition: { type: 'crossfade', duration: 1.5, pool: [] },
      scene_reveal: { enabled: false, seed: 7 },
    },
    effects: {
      title_card: { text: 'EP0007', background_media_path: '' },
      chapter_titles: { enabled: true, chapter_title_presentation: null },
    },
  }
}

describe('step 3 popup draft', () => {
  test('editing is detached: title image, transition and chapter font stay out of the live form', () => {
    const current = live()
    const draft = beginAssemblyStepDraft(current, { channel: 'dreamlands', episode: 'EP0007' })

    draft.value.timeline.title_image.image_path = '/episodes/EP0007/other.webp'
    draft.value.timeline.transition.type = 'dissolve'
    draft.value.effects.chapter_titles.chapter_title_presentation = { font_id: 'anton' }

    assert.equal(current.timeline.title_image.image_path, '/episodes/EP0007/title.webp')
    assert.equal(current.timeline.transition.type, 'crossfade')
    assert.equal(current.effects.chapter_titles.chapter_title_presentation, null)
    // The draft keeps the episode's own file and heading text — it is not a preset.
    assert.equal(draft.value.timeline.title_image.image_path, '/episodes/EP0007/other.webp')
    assert.equal(draft.value.effects.title_card.text, 'EP0007')
  })

  test('Cancel writes nothing; an episode switch refuses Apply and keeps the draft', async () => {
    let writes = 0
    const draft = beginAssemblyStepDraft(live(), { channel: 'dreamlands', episode: 'EP0007' })
    draft.value.timeline.transition.type = 'none'

    cancelAssemblyStepDraft(draft)
    const cancelled = await applyAssemblyStepDraft(draft, draft.scope, async () => { writes += 1 })
    assert.equal(cancelled.ok, false)
    assert.equal(writes, 0)

    const other = beginAssemblyStepDraft(live(), { channel: 'dreamlands', episode: 'EP0007' })
    other.value.timeline.transition.type = 'none'
    const refused = await applyAssemblyStepDraft(other, { channel: 'dreamlands', episode: 'EP0008' }, async () => { writes += 1 })
    assert.equal(refused.ok, false)
    assert.equal(writes, 0)
    assert.equal(other.value.timeline.transition.type, 'none')
  })
})

describe('step 3 popup wiring', () => {
  test('the editor opens a detached draft and never a preset snapshot', () => {
    const open = section('function openTitleMotionEditor', 'function toggleTitleMotionRevealPool')
    assert.match(open, /beginAssemblyStepDraft<TitleMotionDraftSettings>/, 'the popup uses the detached draft helper')
    assert.match(open, /reactive\(beginAssemblyStepDraft/, 'the draft must be reactive so its controls update')
    assert.match(open, /title_image: titleImage/, 'the full title-image state, including the episode file, is copied')
    assert.match(open, /chapter_titles: chapterTitles/, 'the full chapter state, including the font presentation, is copied')
    assert.doesNotMatch(open, /snapshotTitleImagePreset|timelinePresets|excludeKeys/, 'a draft is not a preset sanitizer')
  })

  test('Apply is the single write and targets only the captured episode', async () => {
    const apply = section('async function applyTitleMotion', 'function closeTitleMotionEditor')
    assert.match(apply, /applyAssemblyStepDraft\(/, 'Apply goes through the one-write helper')
    assert.match(apply, /\{ channel: slug\.value, episode: episodeId\.value \}/, 'Apply validates the scope open now')
    assert.match(apply, /saveTitleMotionDraft/, 'Apply calls the existing persistence callback')
    assert.match(apply, /commitTitleMotionDraft/, 'a saved draft reaches the live form only after Apply')
    assert.match(apply, /sameAssemblyStepScope\(draft\.scope/, 'a late answer cannot write EP0007 values into EP0008')

    const save = section('async function saveTitleMotionDraft', 'function commitTitleMotionDraft')
    assert.match(save, /persistEpisodeStepSettings\(scope, settingsBaseline/, 'the captured scope and baseline reach the shared episode writer')
    const persist = section('async function persistEpisodeStepSettings', '// ── Step 5')
    assert.match(persist, /episodes: \{/, 'the shared writer updates the episode entry')
    assert.match(persist, /\[episode\]/, 'the captured episode is the key')
    assert.doesNotMatch(save, /recordLastUsedSettings/, 'the channel starting point is not rewritten')
    assert.doesNotMatch(save, /channel:\s*\{/, 'only the episode entry is written')
  })

  test('Cancel, close and Escape discard the draft without a write', () => {
    const close = section('function closeTitleMotionEditor', '// The draft belongs to the episode')
    assert.match(close, /cancelAssemblyStepDraft\(/, 'Cancel discards the draft')
    assert.match(close, /titleMotionDraft\.value = null/, 'the popup closes')
    assert.match(page, /@close="closeTitleMotionEditor"/, 'Escape, backdrop and Close all use the cancelling path')
    assert.match(page, /@click="closeTitleMotionEditor">Cancel<\/button>/, 'the Cancel button uses the same path')
    assert.match(page, /watch\(\[slug, episodeId\], \(\) => closeTitleMotionEditor\(\)\)/, 'an episode change cannot carry the draft')
  })

  test('controls are disabled while Apply is in flight', () => {
    assert.match(page, /:inert="titleMotionApplying \? true : undefined"/, 'the draft controls are inert while saving')
    assert.match(page, /:disabled="titleMotionApplying \|\| !episodeId"[\s\S]{0,80}@click="applyTitleMotion"/, 'Apply cannot fire twice')
    assert.match(page, /:disabled="titleMotionApplying" @click="closeTitleMotionEditor">Cancel/, 'Cancel waits for the write')
  })

  test('the chapter font samples the episode\'s own heading and background', () => {
    const sample = section('const titleMotionChapterSample', 'async function loadTitleMotionPool')
    assert.match(sample, /scenes\.value\.find\(entry => entry\.title\?\.trim\(\)\)/, 'the sample is a real scene heading')
    assert.match(sample, /getImagePreviewUrl\(scene\.image_path\)/, 'the background is the selected scene image')
    assert.match(page, /:sample-text="titleMotionChapterSample\.text"/, 'the editor receives the real heading')
    assert.match(page, /:background="titleMotionChapterSample\.background"/, 'the editor receives the real background')
    assert.match(page, /This episode has no saved chapter heading to preview yet/, 'no heading reads as no data, not an invented sample')
  })

  test('the font field is bound to the draft and never picks a font or pool by itself', () => {
    assert.match(
      page,
      /v-model="titleMotion\.effects\.chapter_titles\.chapter_title_presentation"/,
      'the font field edits the draft chapter presentation',
    )
    assert.match(page, /:pool="titleMotionPool"/, 'only the saved channel pool is offered')
    assert.match(page, /\/still-posts/, 'the pool comes from the channel\'s saved Still Posts preset')
    assert.doesNotMatch(page, /chapter_title_presentation\s*=\s*\{/, 'nothing assigns a font automatically')
    assert.doesNotMatch(page, /resolved_font_id\s*:/, 'nothing resolves a pool face on the customer\'s behalf')
  })

  test('Browse never adopts a file; Apply adopts only the files the draft changed', () => {
    const popup = section('<!-- Per-episode step 3 editor (1.4.384)', '</Modal>')
    assert.match(popup, /<FilePicker/, 'the popup still uses the existing file control')
    assert.doesNotMatch(popup, /:episodes-root=/, 'Browse must not adopt while the draft is being edited')

    const save = section('async function saveTitleMotionDraft', 'function commitTitleMotionDraft')
    assert.match(save, /collapseToPortablePath\(path, true, adoptRoot, true\)/, 'Apply uses strict adoption with the captured channel root')
    assert.match(save, /path === String\(original \|\| ''\)\.trim\(\)/, 'an unchanged selection is left alone')
    assert.match(save, /adoptBaseline\?\.titleImage/, 'only the captured title image is compared')
    assert.match(save, /adoptBaseline\?\.titleCardMedia/, 'only the captured title-card media is compared')
  })

  test('a stale lettering-pool answer is dropped after the draft or episode changes', () => {
    const pool = section('async function loadTitleMotionPool', 'function openTitleMotionEditor')
    assert.match(pool, /const stale = \(\) => slug\.value !== channel \|\| episodeId\.value !== episode \|\| titleMotionDraft\.value !== draft/)
    assert.match(pool, /if \(stale\(\)\) return[\s\S]*if \(stale\(\)\) return/, 'both the success path and its assignment are fenced')
    assert.match(pool, /if \(!stale\(\)\) titleMotionPool\.value = null/, 'a stale failure cannot clear the current popup\'s pool')
  })

  test('a first per-episode Apply keeps every untouched slot from the channel fallback', () => {
    const open = section('function openTitleMotionEditor', 'function toggleTitleMotionRevealPool')
    assert.match(open, /snapshotAllSettings\(\)/, 'the popup captures the full settings it opened on')
    assert.match(open, /titleMotionSettingsBaseline\.value/, 'that snapshot is kept for Apply')

    const persist = section('async function persistEpisodeStepSettings', '// ── Step 5')
    assert.match(persist, /const own = store\.episodes\?\.\[episode\]\?\.settings/, 'an existing own entry is honoured')
    assert.match(persist, /JSON\.parse\(JSON\.stringify\(baseline \|\| \{\}\)\)/, 'a first Apply starts from the full baseline')
    assert.match(persist, /base\[slot\] === undefined && baseline\?\.\[slot\] !== undefined/, 'missing own slots are seeded, not left partial')
    assert.doesNotMatch(persist, /channel:\s*\{/, 'the channel starting point is untouched')

    // The shared picker prefers an own entry over the channel fallback, so the
    // entry written above must already be full.
    const full = {
      intro: { enabled: true, video_path: '${CHANNEL}/intro.mp4' },
      timeline: { transition: { type: 'crossfade' } },
      effects: { color_grading: { enabled: true }, title_card: { text: 'EP0001' } },
      subtitles: { enabled: true },
      export: { quality: 'high' as const },
    }
    const channelStore = recordLastUsedSettings(null, 'EP0001', full)
    const base: any = JSON.parse(JSON.stringify(channelStore.channel!.settings))
    base.timeline = { ...base.timeline, transition: { type: 'none' } }
    base.effects = { ...base.effects, title_card: { enabled: true } }
    const picked = pickLastUsedSettings({
      channel: channelStore.channel,
      episodes: { EP0007: { episode_id: 'EP0007', saved_at: 'now', settings: base } },
    }, 'EP0007')

    assert.equal(picked?.scope, 'episode')
    assert.deepEqual(picked?.settings.intro, full.intro, 'intro is unchanged')
    assert.deepEqual(picked?.settings.subtitles, full.subtitles, 'subtitles are unchanged')
    assert.deepEqual(picked?.settings.export, full.export, 'export is unchanged')
    assert.deepEqual(picked?.settings.effects?.color_grading, full.effects.color_grading, 'untouched effects are unchanged')
    assert.equal((picked?.settings.timeline as any)?.transition.type, 'none', 'the Step 3 slot is the one that changed')
  })
})

describe('step 3 outro video & timeline clips popup wiring', () => {
  test('the editor opens a detached draft and captures adoption inputs before Apply', () => {
    const open = section('function openOutroTimelineEditor', 'async function saveOutroTimelineDraft')
    assert.match(open, /beginAssemblyStepDraft<OutroTimelineDraftSettings>/, 'the popup uses the detached draft helper')
    assert.match(open, /reactive\(beginAssemblyStepDraft/, 'the draft must be reactive so its controls update')
    assert.match(open, /outro: \{ \.\.\.outro \}/, 'the full outro state is copied')
    assert.match(open, /timeline_clips: JSON\.parse\(JSON\.stringify\(timelineClips\.value\)\)/, 'the clip list is deep-copied')
    assert.match(open, /snapshotAllSettings\(\)/, 'the popup captures the full settings it opened on')
    assert.match(open, /outroVideoPath: outro\.video_path/, 'the original outro file is captured for adoption')
    assert.match(open, /outroTimelineAdoptRoot\.value = episodesRoot\.value/, 'the channel root is captured before any browse')
    assert.match(open, /\{ channel: slug\.value, episode: episodeId\.value \}/, 'the draft is scoped to the open episode')
  })

  test('Apply is the single write, lands in base.intro, and adopts only changed files', () => {
    const apply = section('async function applyOutroTimelineDraft', 'function closeOutroTimelineEditor')
    assert.match(apply, /applyAssemblyStepDraft\(/, 'Apply goes through the one-write helper')
    assert.match(apply, /saveOutroTimelineDraft/, 'Apply calls the existing persistence callback')
    assert.match(apply, /commitOutroTimelineDraft/, 'a saved draft reaches the live form only after Apply')
    assert.match(apply, /sameAssemblyStepScope\(draft\.scope/, 'a late answer cannot write EP0007 values into EP0008')

    const save = section('async function saveOutroTimelineDraft', 'function commitOutroTimelineDraft')
    assert.match(save, /persistEpisodeStepSettings\(scope, baseline/, 'the captured scope and baseline reach the shared episode writer')
    assert.match(save, /base\.intro = \{/, 'the save targets the episode\'s intro slot')
    assert.match(save, /outro: \{ \.\.\.value\.outro \}/, 'the outro settings are written')
    assert.match(save, /timeline_clips: value\.timeline_clips\.map/, 'the clip list is written')
    assert.match(save, /collapseToPortablePath\(path, true, adoptRoot, true\)/, 'Apply uses strict adoption with the captured channel root')
    assert.match(save, /path === String\(original \|\| ''\)\.trim\(\)/, 'an unchanged selection is left alone')

    // Every input the save depends on is captured before the first await, so a
    // slow adoption answer cannot read a baseline meant for another draft.
    const firstAwait = save.indexOf('await ')
    for (const capture of ['const baseline', 'const adoptRoot', 'const originals']) {
      assert.ok(save.indexOf(capture) < firstAwait, `${capture} must be captured before the first await`)
    }
    assert.doesNotMatch(save, /recordLastUsedSettings/, 'the channel starting point is not rewritten')
    assert.doesNotMatch(save, /channel:\s*\{/, 'only the episode entry is written')
  })

  test('Cancel, Close and an episode change discard the draft without a write', () => {
    const close = section('function closeOutroTimelineEditor', '// ── Step 4 render appearance popup')
    assert.match(close, /cancelAssemblyStepDraft\(/, 'Cancel discards the draft')
    assert.match(close, /outroTimelineDraft\.value = null/, 'the popup closes')
    assert.match(close, /watch\(\[slug, episodeId\], \(\) => closeOutroTimelineEditor\(\)\)/, 'an episode change cannot carry the draft')
    assert.match(close, /watch\(currentStep, \(step\) => \{ if \(step !== 3\) closeOutroTimelineEditor\(\) \}\)/, 'leaving Step 3 cannot carry the draft')
    assert.match(page, /@click="closeOutroTimelineEditor">Cancel<\/button>/, 'the Cancel button uses the cancelling path')
    assert.match(page, /:inert="outroTimelineApplying \? true : undefined"/, 'the draft controls are inert while saving')
    assert.match(page, /:disabled="outroTimelineApplying \|\| !episodeId" @click="applyOutroTimelineDraft"/, 'Apply cannot fire twice')

    const popup = section('<!-- Outro video & timeline clips', '</Modal>')
    assert.match(popup, /v-model="outroTimeline\.outro\.enabled"/, 'the outro switch edits the draft')
    assert.match(popup, /v-model="outroTimeline\.outro\.video_path"/, 'the outro path edits the draft')
    assert.match(popup, /v-model="clip\.video_path"/, 'timeline clips edit the draft')
    assert.doesNotMatch(popup, /:episodes-root=/, 'Browse must not adopt while the draft is being edited')
  })
})
