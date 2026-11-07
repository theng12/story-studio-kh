/**
 * Sleep Video Title Placement (v1.4.386).
 * Owner requirement (2026-11-07): "Sleep videos: show the video title once, after the intro."
 *
 * Pins:
 *   1. Only sleep videos are affected (non-sleep channels keep behavior byte-for-byte).
 *   2. Exactly ONE title presentation: title card XOR title image / cover frame (deduplicated).
 *   3. After the intro: placement follows intro video / spoken Introduction chapter sequentially.
 *   4. Opening suppression (video.ts lines 3851-3857) does not drop sleep titles.
 *   5. Explicit choices preserved (disabled episodes remain disabled).
 *
 * Standalone logic tests — does not execute Story backend lanes or FFmpeg.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLEEP_FORMULA_IDS,
  isSleepVideo,
  resolveSleepTitlePlacement,
  applySleepTitlePlacementToRequest,
  type SleepVideoContext,
  type SleepTitlePlacementInput,
} from '../lib/sleep-title-placement.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────
const SLEEP_PROJECT: SleepVideoContext = {
  niche_id: 'sleep',
  formula_id: 'com.storystudio.formula.sleep-story',
  formulaFamily: 'Calm stories',
}

const NON_SLEEP_PROJECT: SleepVideoContext = {
  niche_id: 'history',
  format_id: 'narrated-scenes',
  formula_id: 'com.storystudio.formula.a-world-before-us',
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

// ── isSleepVideo ────────────────────────────────────────────────────────────
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

  test('identifies sleep by niche id', () => {
    assert.equal(isSleepVideo({ niche_id: 'sleep' }), true)
    assert.equal(isSleepVideo({ niche: 'Sleep Stories' }), true)
    assert.equal(isSleepVideo({ niche_id: 'sleep-history' }), true)
    assert.equal(isSleepVideo({ niche_id: 'illustriated-history-for-sleep' }), true)
    assert.equal(isSleepVideo({ niche_id: 'history' }), false)
    assert.equal(isSleepVideo({ niche_id: 'faith' }), false)
  })

  test('identifies sleep by format id (legacy alias)', () => {
    assert.equal(isSleepVideo({ format_id: 'sleep-story' }), true)
    assert.equal(isSleepVideo({ format_id: 'narrated-scenes' }), false)
    assert.equal(isSleepVideo({ format_id: 'broll-narration' }), false)
  })

  test('identifies sleep by formula id (pinned pack aliases)', () => {
    for (const id of SLEEP_FORMULA_IDS) {
      assert.equal(isSleepVideo({ formula_id: id }), true, `expected sleep: ${id}`)
    }
    assert.equal(isSleepVideo({ formula_id: 'kh.owner.formula.illustrated-history-for-sleep' }), true)
    assert.equal(isSleepVideo({ formula_id: 'sleep-history-compilation' }), true)
    assert.equal(isSleepVideo({ formula_id: 'com.storystudio.formula.quotes-shorts' }), false)
  })

  test('identifies sleep by formula family name', () => {
    assert.equal(isSleepVideo({ formulaFamily: 'Calm stories' }), true)
    assert.equal(isSleepVideo({ formulaFamily: 'calm stories' }), true)
    assert.equal(isSleepVideo({ formulaFamily: 'History' }), false)
    assert.equal(isSleepVideo({ formulaFamily: 'Evidence & systems' }), false)
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
    assert.equal(result.prevent_opening_suppression, false, 'no opening-suppression bypass for non-sleep')
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
    assert.equal(result.prevent_opening_suppression, true, 'branded opening must NOT drop sleep titles')
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

// ── Request mutation helper ────────────────────────────────────────────────
describe('applySleepTitlePlacementToRequest helper', () => {
  test('mutates a sleep request to carry exactly one title config', () => {
    const req: any = {
      title_image: { enabled: true, image_path: '/episodes/EP0001/title.webp', duration: 5 },
      title_card: { enabled: true, text: 'EP0001 — A Quiet Tale', duration: 5 },
      intro: { enabled: true, video_path: '/intro/opening.mp4', duration: 12 },
    }
    const result = applySleepTitlePlacementToRequest(req, SLEEP_PROJECT)
    assert.equal(result.is_sleep, true)
    assert.equal(result.title_type, 'title_card')
    assert.equal(req.title_card.enabled, true)
    assert.equal(req.title_image.enabled, false, 'title image demoted to prevent duplication')
    assert.equal(result.prevent_opening_suppression, true)
  })

  test('leaves non-sleep requests untouched', () => {
    const req: any = {
      title_image: { enabled: true, image_path: '/x.webp' },
      title_card: { enabled: false, text: '' },
    }
    applySleepTitlePlacementToRequest(req, NON_SLEEP_PROJECT)
    assert.equal(req.title_image.enabled, true, 'unchanged')
    assert.equal(req.title_card.enabled, false, 'unchanged')
  })
})

// ── Caller contract / integration patch notes (source-level pin) ────────────
describe('caller integration contract (source-level pin)', () => {
  test('generators/video.ts exposes the integration points we patch', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const videoPath = path.resolve(here, '..', 'generators', 'video.ts')
    const source = fs.readFileSync(videoPath, 'utf8')
    // The existing duplication / timing sites the lead integrates with:
    assert.match(source, /req\.title_image\?\.enabled/, 'title image conditional exists')
    assert.match(source, /prepareTitleClip/, 'prepareTitleClip exists')
    assert.match(source, /prepareTextCardClip\(req\.title_card, 'title'/, 'title card clip exists')
    assert.match(source, /if \(req\.title_image\?\.enabled\)/, 'opening suppression site exists (line 3851)')
    assert.match(source, /if \(titleClipPath\)/, 'concat title insertion site exists')
  })

  test('frontend/pages/projects/[slug]/video-assembly.vue exposes title controls', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const pagePath = path.resolve(here, '..', '..', '..', 'frontend', 'pages', 'projects', '[slug]', 'video-assembly.vue')
    const source = fs.readFileSync(pagePath, 'utf8')
    assert.match(source, /titleMotion\.timeline\.title_image\.enabled/, 'title image toggle exists')
    assert.match(source, /titleMotion\.effects\.title_card\.enabled/, 'title card toggle exists')
    assert.match(source, /introHold/, 'introHold (spoken Introduction) state exists')
  })
})
