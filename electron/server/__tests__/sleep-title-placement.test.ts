/**
 * Sleep Video Title Placement (v1.4.386, item 15).
 * Owner requirement (2026-11-07): "Sleep videos: show the video title once, after the intro."
 *
 * Pins:
 *   1. Only sleep videos are affected (non-sleep channels keep behavior byte-for-byte).
 *   2. Exactly ONE title presentation: title card XOR title image / cover frame (deduplicated),
 *      and never twice — the head slot keeps its duration (scene 1's picture) while the title
 *      itself is drawn once, over the composed video, after the intro.
 *   3. Placement follows the spoken Introduction chapter's end (computeStoryStartSec) and the
 *      branded intro clip, on the composed clock — without adding any duration.
 *   4. Sleep detection reads authoritative Formula facts (id / family / starting_scene_pacing),
 *      never a name, id substring or regex guess.
 *   5. Explicit choices preserved (disabled episodes remain disabled; no hidden default title).
 *
 * Standalone logic tests — does not execute Story backend lanes or FFmpeg.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSleepVideo,
  isSleepNiche,
  resolveSleepTitlePlacement,
  sleepTitleOpeningPlan,
  sleepTitleOverlayWindow,
  type SleepVideoContext,
  type SleepTitlePlacementInput,
} from '../lib/sleep-title-placement.js'

// ── Fixtures ────────────────────────────────────────────────────────────────
const SLEEP_PROJECT: SleepVideoContext = {
  niche_id: 'sleep',
  formulaFamily: 'Calm stories',
}

const NON_SLEEP_PROJECT: SleepVideoContext = {
  niche_id: 'history',
  formulaFamily: 'History',
}

const baseInput = (overrides: Partial<SleepTitlePlacementInput> = {}): SleepTitlePlacementInput => ({
  project: SLEEP_PROJECT,
  title_image: { enabled: true, image_path: '/episodes/EP0001/title.webp', duration: 5 },
  title_card: { enabled: true, text: 'EP0001 — A Quiet Tale', duration: 5 },
  intro: { enabled: false },
  intro_audio: { has_intro_chapter: false, story_start_sec: 0 },
  can_drawtext: true,
  ...overrides,
})

// ── isSleepVideo / isSleepNiche: authoritative Formula facts only ───────────
describe('isSleepVideo', () => {
  test('null/undefined/malformed input returns false', () => {
    assert.equal(isSleepVideo(null), false)
    assert.equal(isSleepVideo(undefined), false)
    assert.equal(isSleepVideo({} as any), false)
    assert.equal(isSleepVideo('sleep' as any), false)
  })

  test('explicit is_sleep flag wins over everything', () => {
    assert.equal(isSleepVideo({ is_sleep: true }), true)
    assert.equal(isSleepVideo({ is_sleep: false, niche_id: 'sleep' }), false)
  })

  test('the built-in sleep Formula id is a metadata fact', () => {
    assert.equal(isSleepVideo({ id: 'sleep' }), true)
    assert.equal(isSleepVideo({ niche_id: 'sleep' }), true)
    assert.equal(isSleepVideo({ niche_id: 'history' }), false)
    assert.equal(isSleepVideo({ niche_id: 'faith' }), false)
  })

  test('a name-like id string alone is NOT authority (no name-derived routing)', () => {
    // These used to match `/sleep/i` / `includes('sleep')`. The id string by
    // itself says nothing; the loaded Formula document's facts decide.
    assert.equal(isSleepVideo({ niche_id: 'sleep-history' }), false)
    assert.equal(isSleepVideo({ niche_id: 'com.storystudio.formula.illustrated-history-for-sleep' }), false)
    assert.equal(isSleepVideo({ niche: 'Sleep Stories' } as any), false)
    assert.equal(isSleepVideo({ format_id: 'sleep-story' } as any), false)
    assert.equal(isSleepVideo({ formula_id: 'com.storystudio.formula.sleep-story' } as any), false)
  })

  test('pacing alone (snake_case or camelCase) does NOT infer sleep title', () => {
    assert.equal(isSleepVideo({
      niche_id: 'com.storystudio.formula.sleep-history-compilation',
      formulaFamily: 'Calm documentary',
      starting_scene_pacing: { tiers: [] },
    } as any), false, 'starting_scene_pacing alone must not decide title')
    assert.equal(isSleepVideo({
      id: 'com.storystudio.formula.calm-science-for-sleep',
      formulaFamily: 'Calm documentary',
      startingScenePacing: { mode: 'variable' },
    } as any), false, 'startingScenePacing alone must not decide title')
  })

  test('identifies sleep by formula openingProfile metadata fact without pacing', () => {
    assert.equal(isSleepVideo({
      niche_id: 'com.storystudio.formula.mythology-for-sleep',
      formulaFamily: 'Calm documentary',
      openingProfile: { id: 'sleep-landing', label: 'Sleep landing', description: 'gentle welcome' },
    }), true, 'openingProfile.id === sleep-landing identifies sleep documentary formulas without pacing')
    assert.equal(isSleepVideo({
      id: 'kh.owner.formula.illustrated-history-for-sleep',
      formulaFamily: 'Calm documentary',
      openingProfile: { id: 'sleep-landing', label: 'Sleep landing', description: 'gentle welcome' },
    }), true, 'openingProfile.id === sleep-landing identifies sleep formulas')
    assert.equal(isSleepVideo({
      id: 'com.storystudio.formula.khmer-folk-horror',
      formulaFamily: 'Folk horror',
      openingProfile: { id: 'folk-welcome', label: 'Folk welcome', description: 'greeting' },
    }), false, 'non-sleep openingProfile does not match')
  })

  test('explicit is_sleep false overrides openingProfile sleep-landing', () => {
    assert.equal(isSleepVideo({
      is_sleep: false,
      openingProfile: { id: 'sleep-landing' },
    }), false, 'explicit is_sleep: false wins over openingProfile metadata')
  })

  test('identifies sleep by declared formula family', () => {
    assert.equal(isSleepVideo({ formulaFamily: 'Calm stories' }), true)
    assert.equal(isSleepVideo({ formulaFamily: 'Calm documentary' }), false, 'family alone is not sleep-specific')
    assert.equal(isSleepVideo({ formulaFamily: 'History' }), false)
    assert.equal(isSleepVideo({ formulaFamily: 'Evidence & systems' }), false)
  })

  test('isSleepNiche is the same authority video.ts asks', () => {
    assert.equal(isSleepNiche({ id: 'sleep', formulaFamily: 'Calm stories' }), true)
    assert.equal(isSleepNiche({ id: 'history', formulaFamily: 'Evidence & systems' }), false)
    assert.equal(isSleepNiche(null), false)
  })
})

// ── Non-sleep behavior preserved (AGENTS §4 / §5) ────────────────────────────
describe('non-sleep videos keep existing title behavior byte-for-byte', () => {
  test('non-sleep video with title card AND title image both enabled is NOT deduplicated', () => {
    const result = resolveSleepTitlePlacement(baseInput({ project: NON_SLEEP_PROJECT }))
    assert.equal(result.is_sleep, false)
    assert.equal(result.display_title, true)
    assert.equal(result.title_type, 'title_card', 'text card wins as before')
    assert.equal(result.anchor, 'start', 'non-sleep: placement unchanged')
    // Both configs preserved exactly as provided (no deduplication for non-sleep)
    assert.equal(result.effective_title_image.enabled, true)
    assert.equal(result.effective_title_card.enabled, true)
    assert.match(result.explanation, /Non-sleep video/)
  })

  test('non-sleep video with title card disabled still shows title image', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      project: NON_SLEEP_PROJECT,
      title_card: { enabled: false, text: '' },
    }))
    assert.equal(result.is_sleep, false)
    assert.equal(result.display_title, true)
    assert.equal(result.title_type, 'title_image')
    assert.equal(result.effective_title_image.enabled, true)
  })

  test('non-sleep video with no title image and card disabled shows no title', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      project: NON_SLEEP_PROJECT,
      title_image: { enabled: false, image_path: '' },
      title_card: { enabled: false, text: '' },
    }))
    assert.equal(result.display_title, false)
    assert.equal(result.title_type, 'none')
  })

  test('non-sleep render plan is a complete no-op (no suppression, no overlay)', () => {
    const placement = resolveSleepTitlePlacement(baseInput({ project: NON_SLEEP_PROJECT }))
    const opening = sleepTitleOpeningPlan(placement, { head_title_would_play: true, head_title_duration_sec: 5 })
    assert.deepEqual(opening, { suppress_opening_title: false, opening_slot_keep_sec: 0 })
    assert.equal(sleepTitleOverlayWindow(placement, { pre_scene_sec: 12, narration_lead_in_sec: 0 }), null)
  })
})

// ── Sleep video deduplication (EXACTLY ONE title) ───────────────────────────
describe('sleep videos show exactly ONE title presentation (deduplicated)', () => {
  test('title_card takes precedence over title_image when both are enabled', () => {
    const result = resolveSleepTitlePlacement(baseInput())
    assert.equal(result.is_sleep, true)
    assert.equal(result.display_title, true)
    assert.equal(result.title_type, 'title_card')
    assert.equal(result.effective_title_card.enabled, true, 'title card active')
    assert.equal(result.effective_title_image.enabled, false, 'title image disabled to prevent duplication')
  })

  test('falls back to title_image when drawtext is unavailable', () => {
    const result = resolveSleepTitlePlacement(baseInput({ can_drawtext: false }))
    assert.equal(result.title_type, 'title_image')
    assert.equal(result.effective_title_card.enabled, false)
    assert.equal(result.effective_title_image.enabled, true)
    assert.equal(result.effective_title_image.image_path, '/episodes/EP0001/title.webp')
  })

  test('falls back to title_image when card text is missing', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: true, text: '' },
    }))
    assert.equal(result.title_type, 'title_image')
    assert.equal(result.effective_title_image.enabled, true)
    assert.equal(result.effective_title_card.enabled, false)
  })

  test('auto-selects title_card from default title text when neither slot is configured', () => {
    // Absent (undefined) slots mean "never configured", distinct from an
    // explicit enabled:false, which is a deliberate off-choice (AGENTS §5).
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: undefined,
      title_image: undefined,
      thumbnail_path: '/episodes/EP0001/cover.webp',
      default_title_text: 'The Lantern Keeper’s Last Light',
    }))
    assert.equal(result.display_title, true)
    assert.equal(result.title_type, 'title_card')
    assert.equal(result.effective_title_card.text, 'The Lantern Keeper’s Last Light')
    assert.equal(result.effective_title_image.enabled, false)
  })

  test('auto-selects title_image from thumbnail when no text is available', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: undefined,
      title_image: undefined,
      thumbnail_path: '/episodes/EP0001/cover.webp',
      default_title_text: '',
    }))
    assert.equal(result.title_type, 'title_image')
    assert.equal(result.effective_title_image.enabled, true)
    assert.equal(result.effective_title_image.image_path, '/episodes/EP0001/cover.webp')
    assert.equal(result.effective_title_card.enabled, false)
  })

  test('an explicit enabled:false off-choice is never overridden by auto-selection', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: false, text: '' },
      title_image: { enabled: false, image_path: '' },
      thumbnail_path: '/episodes/EP0001/cover.webp',
      default_title_text: 'Would otherwise auto-select',
    }))
    assert.equal(result.display_title, false, 'both slots explicitly off = the episode chose no title')
    assert.equal(result.title_type, 'none')
    assert.equal(result.effective_title_card.text, undefined, 'no invented title text')
    assert.notEqual(result.effective_title_card.text, 'Episode Title', 'never a hidden default title')
  })

  test('user override prefers title_image even when card text is available', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      user_override: { preferred_type: 'title_image' },
    }))
    assert.equal(result.title_type, 'title_image')
    assert.equal(result.effective_title_image.enabled, true)
    assert.equal(result.effective_title_card.enabled, false)
  })

  test('user override preferred_type: none disables title', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      user_override: { preferred_type: 'none' },
    }))
    assert.equal(result.display_title, false)
    assert.equal(result.title_type, 'none')
  })
})

// ── Sleep video placement: AFTER THE INTRO ─────────────────────────────────
describe('sleep video title placement follows the intro sequence', () => {
  test('no intro detected: title starts at 0:00', () => {
    const result = resolveSleepTitlePlacement(baseInput())
    assert.equal(result.anchor, 'start')
    assert.equal(result.start_sec, 0)
    assert.equal(result.timing.intro_duration_sec, 0)
    assert.match(result.explanation, /shown once at the start/)
  })

  test('intro video only: title follows intro video', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      intro: { enabled: true, video_path: '/intro/opening.mp4', duration: 12 },
    }))
    assert.equal(result.anchor, 'after_intro_video')
    assert.equal(result.start_sec, 12)
    assert.equal(result.timing.intro_duration_sec, 12)
    assert.match(result.explanation, /after the 12\.0s intro video/)
  })

  test('spoken Introduction chapter only: title follows story start', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      intro_audio: { has_intro_chapter: true, story_start_sec: 85.5 },
    }))
    assert.equal(result.anchor, 'after_intro_audio')
    assert.equal(result.start_sec, 85.5)
    assert.equal(result.timing.intro_duration_sec, 85.5)
    assert.match(result.explanation, /after the 85\.5s spoken Introduction/)
  })

  test('both intro video AND spoken chapter: title follows the LONGER of the two', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      intro: { enabled: true, video_path: '/intro/opening.mp4', duration: 12 },
      intro_audio: { has_intro_chapter: true, story_start_sec: 85.5 },
    }))
    assert.equal(result.anchor, 'after_combined_intro')
    assert.equal(result.timing.intro_duration_sec, 85.5, 'max(12, 85.5)')
    assert.equal(result.start_sec, 85.5)
    assert.match(result.explanation, /combined intro video.*spoken welcome/)
  })

  test('timing is contiguous: story starts exactly after title ends', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      intro: { enabled: true, video_path: '/intro/opening.mp4', duration: 12 },
      title_card: { enabled: true, text: 'EP0001', duration: 6 },
    }))
    assert.equal(result.timing.title_start_sec, 12)
    assert.equal(result.timing.title_duration_sec, 6)
    assert.equal(result.timing.story_scenes_start_sec, 18, '12 + 6 = 18s')
  })
})

// ── Render plan: head slot timing unchanged + one overlay window ────────────
describe('sleep title render plan (integration contract)', () => {
  test('title range sits after the spoken Introduction end on the composed clock', () => {
    const placement = resolveSleepTitlePlacement(baseInput({
      intro_audio: { has_intro_chapter: true, story_start_sec: 85.5 },
      title_card: { enabled: true, text: 'EP0001', duration: 5 },
    }))
    const window = sleepTitleOverlayWindow(placement, { pre_scene_sec: 40, narration_lead_in_sec: 0 })
    assert.ok(window, 'a displayed sleep title always gets a window')
    assert.equal(window.start_s, 85.5, 'opens exactly where the spoken Introduction ends')
    assert.ok(window.start_s >= 85.5, 'never before the spoken intro ends')
    assert.equal(window.end_s, 90.5, 'window length = configured title duration (no extra duration)')
  })

  test('the title never starts inside the branded opening, and follows a narration lead-in', () => {
    const placement = resolveSleepTitlePlacement(baseInput({
      intro_audio: { has_intro_chapter: true, story_start_sec: 10 },
      title_card: { enabled: true, text: 'EP0001', duration: 5 },
    }))
    const dominates = sleepTitleOverlayWindow(placement, { pre_scene_sec: 40, narration_lead_in_sec: 0 })
    assert.equal(dominates!.start_s, 40, 'opening end wins when it is later than story start')

    const lead = sleepTitleOverlayWindow(placement, { pre_scene_sec: 0, narration_lead_in_sec: 3.5 })
    assert.equal(lead!.start_s, 13.5, 'story start + narration lead-in = composed time')
  })

  test('timing unchanged: the head slot keeps exactly the duration today’s title had', () => {
    const placement = resolveSleepTitlePlacement(baseInput())
    const wouldPlay = sleepTitleOpeningPlan(placement, { head_title_would_play: true, head_title_duration_sec: 7 })
    assert.equal(wouldPlay.suppress_opening_title, true, 'head title disabled — no header duplicate')
    assert.equal(wouldPlay.opening_slot_keep_sec, 7, 'same seconds stay in the opening clock')

    const neverPlayed = sleepTitleOpeningPlan(placement, { head_title_would_play: false, head_title_duration_sec: 7 })
    assert.equal(neverPlayed.opening_slot_keep_sec, 0, 'a slot today never filled is not invented')
  })

  test('explicit off: no suppression, no window, no hidden default title', () => {
    const placement = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: false, text: '' },
      title_image: { enabled: false, image_path: '' },
    }))
    assert.equal(placement.display_title, false)
    const opening = sleepTitleOpeningPlan(placement, { head_title_would_play: true, head_title_duration_sec: 5 })
    assert.deepEqual(opening, { suppress_opening_title: false, opening_slot_keep_sec: 0 })
    assert.equal(sleepTitleOverlayWindow(placement, { pre_scene_sec: 10, narration_lead_in_sec: 0 }), null)
  })

  test('no header duplicate: whenever a window exists, the head title is suppressed', () => {
    for (const overrides of [
      {},
      { intro: { enabled: true, video_path: '/intro/opening.mp4', duration: 12 } },
      { intro_audio: { has_intro_chapter: true, story_start_sec: 85.5 } },
      { can_drawtext: false },
    ] as Partial<SleepTitlePlacementInput>[]) {
      const placement = resolveSleepTitlePlacement(baseInput(overrides))
      const window = sleepTitleOverlayWindow(placement, { pre_scene_sec: 30, narration_lead_in_sec: 0 })
      const opening = sleepTitleOpeningPlan(placement, { head_title_would_play: true, head_title_duration_sec: 5 })
      if (window) {
        assert.equal(opening.suppress_opening_title, true, 'one title only: head must be suppressed')
      }
    }
  })
})

// ── Explicit choices preserved (AGENTS §4 / §5) ──────────────────────────────
describe('explicit episode choices are preserved', () => {
  test('episode with both titles disabled stays disabled', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: false, text: '' },
      title_image: { enabled: false, image_path: '' },
    }))
    assert.equal(result.display_title, false)
    assert.equal(result.title_type, 'none')
    assert.match(result.explanation, /explicitly disabled/)
  })

  test('user override enabled: false explicitly disables title', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      user_override: { enabled: false },
    }))
    assert.equal(result.display_title, false)
    assert.match(result.explanation, /disabled by user override/)
  })

  test('duration is clamped between 2 and 15 seconds', () => {
    const result = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: true, text: 'EP0001', duration: 99 },
    }))
    assert.equal(result.duration_sec, 15, 'clamped to max 15')

    const tooShort = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: true, text: 'EP0001', duration: 1 },
    }))
    assert.equal(tooShort.duration_sec, 2, 'clamped to min 2')

    const defaultDur = resolveSleepTitlePlacement(baseInput({
      title_card: { enabled: true, text: 'EP0001', duration: 0 },
    }))
    assert.equal(defaultDur.duration_sec, 5, 'invalid value falls back to default 5s')
  })
})

// ── Caller contract / integration pins (source-level) ───────────────────────
describe('caller integration contract (source-level pin)', () => {
  test('generators/video.ts wires the sleep title through the existing machinery', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const videoPath = path.resolve(here, '..', 'generators', 'video.ts')
    const source = fs.readFileSync(videoPath, 'utf8')
    // The existing sites the integration rides on:
    assert.match(source, /req\.title_image\?\.enabled/, 'title image conditional exists')
    assert.match(source, /prepareTitleClip/, 'prepareTitleClip exists')
    assert.match(source, /prepareTextCardClip\(req\.title_card, 'title'/, 'title card clip exists')
    assert.match(source, /if \(req\.title_image\?\.enabled\)/, 'opening suppression site exists')
    assert.match(source, /if \(titleClipPath\)/, 'concat title insertion site exists')
    // The sleep integration itself:
    assert.match(source, /resolveSleepTitlePlacement\(/, 'placement resolved from the helper')
    assert.match(source, /computeStoryStartSec\(/, 'spoken Introduction end from the ONE story-start clock')
    assert.match(source, /sleepTitleOpeningPlan\(/, 'head slot plan applied')
    assert.match(source, /sleepTitleOverlayWindow\(/, 'composed-clock window computed')
    assert.match(source, /sleepTitle,/, 'window handed to the final composition')
    assert.match(source, /id: 'sleep-title'/, 'title image rides the existing overlay layer path')
  })

  test('frontend/pages/projects/[slug]/video-assembly.vue exposes title controls', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pagePath = path.resolve(here, '..', '..', '..', 'frontend', 'pages', 'projects', '[slug]', 'video-assembly.vue')
    const source = fs.readFileSync(pagePath, 'utf8')
    assert.match(source, /titleMotion\.timeline\.title_image\.enabled/, 'title image toggle exists')
    assert.match(source, /titleMotion\.effects\.title_card\.enabled/, 'title card toggle exists')
    assert.match(source, /introHold/, 'introHold (spoken Introduction) state exists')
  })
})
