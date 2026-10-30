/**
 * Pipeline integration — full multi-step batch resolution (v1.0.71+).
 *
 * Walks every step of a typical batch chain (script-only →
 * introduction-only → image_prompts → metadata → audio → audio_merge →
 * video_assembly) against a synthetic listicle config + format, and
 * asserts the resolved params look correct end-to-end. This is the
 * "everything composes" test — the existing focused tests
 * (pipeline-flatten-bundle, pipeline-preset-resolution,
 * pipeline-metadata-format-defaults, pipeline-ambient-volume) cover
 * each seam, this one locks them in concert.
 *
 * Provider boundaries (LLM / FFmpeg) are NOT exercised — that's what
 * chunked-narration-smoke.test.ts is for. This test runs entirely
 * inside resolveStepParams, so it's fast and deterministic.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { flattenVideoAssemblyBundle, resolveStepParams } from '../routes/pipeline.js'
import type { Format } from '../models/types.js'

test('Contextual Cues pipeline params preserve the preset review decision', () => {
  const review = resolveStepParams('contextual_cues' as any, 'EP0042', 'Berlin story', {
    id: 'cue-review', name: 'Editorial review', data: {
      model: 'genstudio-text', density: 'restrained', placement: 'top-right', auto_approve: false,
    },
  } as any, null)
  assert.deepEqual(review, {
    episode_id: 'EP0042', model: 'genstudio-text', density: 'restrained', placement: 'top-right',
    // v1.3.0 — a preset may now carry a precise default anchor. Absent here,
    // so it stays null and the corner answers.
    position_x_pct: null, position_y_pct: null, auto_approve: false,
  })
  const trusted = resolveStepParams('contextual_cues' as any, 'EP0042', 'Berlin story', {
    id: 'cue-auto', name: 'Trusted automated', data: { model: 'genstudio-text', auto_approve: true },
  } as any, null)
  assert.equal(trusted.auto_approve, true)
  assert.equal('label_themes' in trusted, false)
  assert.equal('label_motions' in trusted, false)
  const designed = resolveStepParams('contextual_cues' as any, 'EP0042', 'Berlin story', {
    id: 'cue-design', name: 'Designed labels', data: {
      model: 'genstudio-text', label_themes: ['comedy', 'exploration'], label_motions: ['slide', 'wipe'],
    },
  } as any, null)
  assert.deepEqual(designed.label_themes, ['comedy', 'exploration'])
  assert.deepEqual(designed.label_motions, ['slide', 'wipe'])
})

/**
 * v1.3.0 regression guard. Pipeline used to collapse anything that was not
 * 'top-left' to 'top-right' in its own separate copy of that rule, so a preset
 * placing cues at the bottom worked by hand and silently moved back to the top
 * the moment the same preset was run as a batch.
 */
test('Contextual Cues pipeline params keep a bottom corner and a precise anchor', () => {
  const bottom = resolveStepParams('contextual_cues' as any, 'EP0042', 'Berlin story', {
    id: 'cue-bottom', name: 'Below the logo', data: {
      model: 'genstudio-text', placement: 'bottom-left', auto_approve: false,
    },
  } as any, null)
  assert.equal(bottom.placement, 'bottom-left')

  const placed = resolveStepParams('contextual_cues' as any, 'EP0042', 'Berlin story', {
    id: 'cue-placed', name: 'Hand placed', data: {
      model: 'genstudio-text', position_x_pct: 24, position_y_pct: 68, auto_approve: false,
    },
  } as any, null)
  assert.equal(placed.position_x_pct, 24)
  assert.equal(placed.position_y_pct, 68)
})

test('subtitles pipeline params preserve the preset language without guessing English', () => {
  const explicit = resolveStepParams('subtitles' as any, 'EP0042', 'Berlin story', {
    id: 'subtitle-language', name: 'Khmer transcript', data: {
      model: 'published-stt', language: 'km', force: true,
    },
  } as any, null)
  assert.deepEqual(explicit, {
    episode_id: 'EP0042',
    per_chapter: true,
    engine: 'genstudio',
    model: 'published-stt',
    language: 'km',
    force: true,
  })

  const unspecified = resolveStepParams('subtitles' as any, 'EP0042', 'Berlin story', {
    id: 'subtitle-language-missing', name: 'Legacy transcript', data: { model: 'published-stt' },
  } as any, null)
  assert.equal('language' in unspecified, false, 'a missing legacy choice must block at live validation, not become English')
})

// ── Test fixtures ─────────────────────────────────────────────────────────

const LISTICLE_FORMAT: Format = {
  id: 'listicle',
  name: 'Listicle',
  description: '',
  builtin: true,
  schemaVersion: 1,
  idea: { systemPromptRole: '', audienceDefault: 'curious adults', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
  script: {
    systemPromptRole: '',
    additionalRules: [],
    pacingArc: [],
    closingHint: '',
    defaultChapterCount: 10,
    chapterCountRange: [3, 20],
    defaultLengthMinutes: 30,
    lengthMinutesRange: [10, 90],
    narratorStyles: [],
    defaultNarratorStyleId: '',
    chaptersIndependent: true,
    videoDefaults: { secondsPerScene: 6, transitionType: 'fade', transitionDurationSec: 0.5 },
    audioDefaults: { speed: 1.0 },
    audioMergeDefaults: { normalizeVolume: true, gapDurationSec: 2 },
  },
  imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [10, 10], defaultThumbnails: 3, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
  metadata: {
    purposeNote: '', titleStyleHint: '', titleHookRules: [],
    tagsContext: '', tagsHookRules: [], broadKeywords: [],
    youtubeDescriptionStructure: { musicLabel: 'MUSIC', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: ['#explained'], totalHashtagCount: 12 },
    defaultMaxChars: 3500,
    defaultTitleCount: 5,
    defaultTitleMaxLength: 70,
    defaultTagCount: 12,
  },
}

const SLEEP_STORY_FORMAT: Format = {
  ...LISTICLE_FORMAT,
  id: 'sleep-story',
  name: 'Sleep Story',
  script: { ...LISTICLE_FORMAT.script, chaptersIndependent: false, videoDefaults: undefined },
  metadata: {
    ...LISTICLE_FORMAT.metadata,
    defaultMaxChars: 5000,
    defaultTitleCount: 5,
    defaultTitleMaxLength: 100,
    defaultTagCount: 15,
  },
}

const TIMESTAMP_FORMAT: Format = {
  ...LISTICLE_FORMAT,
  id: 'timestamp-driven',
  name: 'Timestamp Driven',
  visualSource: 'timestamp-driven',
}

const SENTENCE_SCENES_FORMAT: Format = {
  ...LISTICLE_FORMAT,
  id: 'scenes',
  name: 'Scenes',
  visualSource: 'scene-images' as any,
  sceneAlignment: 'sentence',
}

const fakePreset = (data: any) => ({ id: 'p1', name: 'Test', data })

// ── Integration tests ─────────────────────────────────────────────────────

describe('pipeline integration — full chain resolution for listicle batch', () => {
  test('script-only step preserves the idea title and chapter count', () => {
    const preset = fakePreset({
      form: {
        title: 'STALE PRESET TITLE',  // must be overridden by the idea title
        episode_id: 'STALE',
        chapters: 12,
        words_per_chapter: 500,
      },
    })
    const params = resolveStepParams('script-only', 'EP0042', '7 historical cold cases still unsolved', preset, LISTICLE_FORMAT)
    assert.equal(params.title, '7 historical cold cases still unsolved',
      'idea title must override the stale preset title')
    assert.equal(params.episode_id, 'EP0042')
    assert.equal(params.chapters, 12)
    assert.equal(params.words_per_chapter, 500)
  })

  test('image_prompts step strips every retired scene-planning field', () => {
    const preset = fakePreset({
      form: {
        scenes_per_chapter: 3,
        total_scenes: 30,
        chapter_count: 10,
        chapter_count_override: 12,
        scene: { visual_detail: 4 },
        thumb_count: 3,
      },
    })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.scenes_per_chapter, undefined)
    assert.equal(params.total_scenes, undefined)
    assert.equal(params.chapter_count, undefined)
    assert.equal(params.chapter_count_override, undefined)
    assert.equal(params.scene, undefined)
    assert.equal(params.thumb_count, 3)
    assert.equal(params.mode, 'thumbnails')
  })

  test('image_prompts step always uses thumbnail-only mode', () => {
    const preset = fakePreset({
      form: { scenes_per_chapter: 3, total_scenes: 30, thumb_count: 3 },
    })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, TIMESTAMP_FORMAT)
    assert.equal(params.mode, 'thumbnails')
  })

  test('thumb_images always uses automatic Gateway quality', () => {
    const params = resolveStepParams('thumb_images', 'EP0042', 'Title', fakePreset({
      form: {
        model: 'genstudio-image-studio-v1',
        image_steps: 4,
        image_quality: 'maximum',
      },
    }), LISTICLE_FORMAT)
    assert.equal(params.image_steps, undefined)
    assert.equal(params.image_quality, undefined)
    assert.equal(params.model, 'genstudio-image-studio-v1')
    assert.equal(params.mode, 'thumbs')
  })

  test('image_prompts step seeds defaults from imagePrompts when preset lacks them', () => {
    // Stale preset (saved before the user touched the thumbnail form).
    // Only thumbnail defaults may be healed here; scene timing belongs to
    // Scene Plan and is deliberately absent.
    const preset = fakePreset({ form: {} })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.total_scenes, undefined)
    assert.equal(params.scenes_per_chapter, undefined)
    assert.equal(params.thumb_count, 3,
      'should seed listicle defaultThumbnails')
    assert.equal(params.aspect_ratio, '16:9',
      'should seed recommendedAspect')
  })

  test('image_prompts step does not overwrite preset values with format defaults', () => {
    // Active preset with explicit values must survive — format only fills
    // gaps, never clobbers.
    const preset = fakePreset({
      form: {
        scenes_per_chapter: 4, thumb_count: 8, aspect_ratio: '9:16',
        style_tag: 'My personal style',
      },
    })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.scenes_per_chapter, undefined)
    assert.equal(params.thumb_count, 8)
    assert.equal(params.aspect_ratio, '9:16')
    assert.equal(params.style_tag, 'My personal style')
  })

  test('metadata step pulls listicle defaults (3500/5/70/12) from format', () => {
    const preset = fakePreset({ sections: [] })
    const params = resolveStepParams('metadata', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.max_chars, 3500)
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 70)
    assert.equal(params.tag_count, 12)
  })

  test('metadata step pulls sleep-story defaults (5000/5/100/15) from format', () => {
    const preset = fakePreset({ sections: [] })
    const params = resolveStepParams('metadata', 'EP0042', 'Title', preset, SLEEP_STORY_FORMAT)
    assert.equal(params.max_chars, 5000)
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 100)
    assert.equal(params.tag_count, 15)
  })

  test('audio_merge step normalises ambient_tracks volume from 0-100 to 0-1', () => {
    const preset = fakePreset({
      ambient_tracks: [
        { id: 'a', enabled: true, source_path: '/tmp/rain.mp3', volume: 50 },
        { id: 'b', enabled: true, source_path: '/tmp/wind.mp3', volume: 100 },
      ],
    })
    const params = resolveStepParams('audio_merge', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    const tracks = params.ambient_tracks as any[]
    assert.equal(tracks.length, 2)
    assert.equal(tracks[0].volume, 0.5)
    assert.equal(tracks[1].volume, 1.0)
  })

  test('audio_merge step pulls listicle gap/normalize defaults from format when preset omits them', () => {
    // Stale preset (saved before the user touched gap/normalize): both
    // fields absent. Pre-fix the pipeline forwarded undefined and the
    // generator route hardcoded 5s/no-normalize (sleep-story flavour).
    // Post-fix, listicle gets its tuned 2s/normalize from the format.
    const preset = fakePreset({})
    const params = resolveStepParams('audio_merge', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.gap_duration, 2, 'listicle audioMergeDefaults.gapDurationSec wins')
    assert.equal(params.normalize_volume, true, 'listicle audioMergeDefaults.normalizeVolume wins')
  })

  test('audio_merge step honours preset values over format defaults', () => {
    const preset = fakePreset({ gap_duration: 7, normalize_volume: false })
    const params = resolveStepParams('audio_merge', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.gap_duration, 7, 'explicit preset value beats format default')
    assert.equal(params.normalize_volume, false, 'explicit preset value beats format default')
  })

  test('audio step never inherits an episode-specific section list from its preset', () => {
    const preset = fakePreset({
      form: {
        model: 'genaipro-flash-v2.5',
        voice: 'voice-1',
        sections: 'Chapter_01,Chapter_02',
        max_chunk_chars: 500,
        generation_mode: 'skip',
      },
    })
    const params = resolveStepParams('audio', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.sections, 'all')
    assert.equal(params.force, false)
    assert.equal(params.no_overwrite, false)
    assert.equal('generation_mode' in params, false)
    assert.equal('max_chunk_chars' in params, false, 'legacy presets cannot override the active model limit')
  })

  test('video_assembly bundle preset flattens to generator-shape request', () => {
    const preset = fakePreset({
      fallback: {
        export: { resolution: '1920x1080', quality: 'high' },
        timeline: { scene_recycling: { seconds_per_scene: 6 } },
        effects: { logo: { enabled: true, image_path: '/tmp/logo.png', opacity: 80 } },
      },
    })
    const params = resolveStepParams('video_assembly', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.resolution, '1920x1080')
    assert.equal(params.quality, 'high')
    assert.deepEqual(params.scene_recycling, { seconds_per_scene: 6 })
    // Logo opacity 80 (0-100 scale) divided to 0.8
    assert.equal((params.logo as any).opacity, 0.8)
  })

  test('full batch chain: every step returns episode_id', () => {
    // Smoke check that every step in a typical batch resolves cleanly
    // and carries episode_id through. Title is only needed by steps
    // that build episode-folder names from the title (script-only,
    // introduction-only, image_prompts, metadata, video_assembly);
    // images / audio / audio_merge resolve paths via the existing
    // folder structure and don't need title in their params.
    const STEPS_WITH_TITLE = [
      'script-only', 'introduction-only', 'image_prompts',
      'metadata', 'video_assembly',
    ] as const
    const STEPS_WITHOUT_TITLE = ['thumb_images', 'audio', 'audio_merge'] as const
    const minimalPreset = fakePreset({
      form: { chapters: 10, words_per_chapter: 500 },
      sections: [],
      intro: {},
      ambient_tracks: [],
      promptsForm: {},
    })
    for (const step of STEPS_WITH_TITLE) {
      const params = resolveStepParams(step as any, 'EP0042', 'My Title', minimalPreset, LISTICLE_FORMAT)
      assert.equal(params.episode_id, 'EP0042', `${step} must carry episode_id`)
      assert.equal(params.title, 'My Title', `${step} must carry title`)
    }
    for (const step of STEPS_WITHOUT_TITLE) {
      const params = resolveStepParams(step as any, 'EP0042', 'My Title', minimalPreset, LISTICLE_FORMAT)
      assert.equal(params.episode_id, 'EP0042', `${step} must carry episode_id`)
      // title NOT asserted — these steps resolve via episode folders
    }
  })

  test('format-less call falls back to legacy hardcoded defaults', () => {
    // Defensive: a project with no resolvable format (e.g. format JSON
    // file got deleted) shouldn't crash — resolveStepParams accepts
    // a null format and falls through to the legacy hardcoded
    // sleep-story values.
    const preset = fakePreset({ sections: [] })
    const params = resolveStepParams('metadata', 'EP0042', 'Title', preset, null)
    assert.equal(params.max_chars, 5000)  // legacy default
    assert.equal(params.title_count, 5)
    assert.equal(params.title_max_length, 100)
    assert.equal(params.tag_count, 15)
  })

  test('scene_plan ignores obsolete window planner settings', () => {
    const preset = fakePreset({
      model: 'chatstudio:test-model',
      use_research: true,
      style_prompt: 'storybook',
      target_scene_count: 30,
      window_size: 'full',
      planning_mode: 'two-pass',
      cross_window_context: true,
      generate_motion_prompts: true,
      prompt_max_tokens: 6144,
      prompt_pack_size: 10,
      opening_mode: 'branded-opening',
      opening_reserved_sec: 18,
    })
    const params = resolveStepParams('scene_plan', 'EP0042', 'Title', preset, TIMESTAMP_FORMAT)
    assert.equal(params.model, 'chatstudio:test-model')
    assert.equal(params.detail_level, 4)
    assert.equal('style_prompt' in params, false,
      'legacy free-form style text is outside the exact reusable Scene Plan preset contract')
    assert.equal(params.prompt_max_tokens, 6144)
    assert.equal(params.prompt_pack_size, 10)
    assert.equal('model_cost_tier' in params, false)
    // v1.3.1 — the opening's length is measured from the project's real clips
    // at plan time, so a preset asserting one is ignored rather than obeyed.
    // The owner's live preset said "from first second, 15s" against a real
    // 10.0s intro, and it won: every scene landed ~10s after its narration.
    for (const obsolete of [
      'target_scene_count', 'window_size', 'planning_mode', 'cross_window_context',
      'generate_motion_prompts', 'style_prompt', 'opening_mode', 'opening_reserved_sec',
    ]) {
      assert.equal(obsolete in params, false, `${obsolete} must not leak into the staged planner`)
    }

    // An off-ladder allowance is NO LONGER discarded. It is a legal request on
    // a product that publishes at least that much, and is clamped to the live
    // maximum at resolve time on one that does not — so the pipeline carries it
    // through rather than silently resetting the user's choice to auto.
    const offLadderPreset = fakePreset({ prompt_max_tokens: 32000 })
    const safeParams = resolveStepParams('scene_plan', 'EP0042', 'Title', offLadderPreset, TIMESTAMP_FORMAT)
    assert.equal(safeParams.prompt_max_tokens, 32000)
    // A genuinely malformed allowance still heals.
    const malformedPreset = fakePreset({ prompt_max_tokens: -1 })
    assert.equal(
      resolveStepParams('scene_plan', 'EP0042', 'Title', malformedPreset, TIMESTAMP_FORMAT).prompt_max_tokens,
      'auto',
    )
    assert.equal(safeParams.prompt_pack_size, 'auto')
    assert.equal('opening_mode' in safeParams, false)
  })

  test('a batch render keeps the user timeline clips a single-episode render would play', () => {
    // These live on the intro slot preset and were silently dropped by the
    // bundle flattener, so Pipeline rendered a different video from the one the
    // Video Assembly page produced. Since v1.3.1 it also breaks opening timing:
    // Scene Plan counts before_intro / after_intro clips in the reserve.
    const bundle = {
      fallback: {
        intro: {
          enabled: true,
          video_path: '/assets/intro.mp4',
          timeline_clips: [
            { id: 'a', anchor: 'before_intro', enabled: true, kind: 'video', video_path: '/assets/pre.mp4' },
            { id: 'b', anchor: 'after_outro', enabled: true, kind: 'video', video_path: '/assets/tail.mp4' },
          ],
        },
      },
    }
    const out = flattenVideoAssemblyBundle(bundle, 'EP0042', 'Title') as any
    assert.equal(out.timeline_clips.length, 2)
    assert.equal(out.timeline_clips[0].anchor, 'before_intro')

    const withoutClips = flattenVideoAssemblyBundle(
      { fallback: { intro: { enabled: true, video_path: '/assets/intro.mp4', timeline_clips: [] } } },
      'EP0042', 'Title',
    ) as any
    assert.equal('timeline_clips' in withoutClips, false, 'an empty list must not turn the feature on')
  })
})
