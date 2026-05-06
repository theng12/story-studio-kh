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
import { resolveStepParams } from '../routes/pipeline.js'
import type { Format } from '../models/types.js'

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
    audioDefaults: { speed: 1.0, stability: 0.6, similarity: 0.8 },
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

  test('image_prompts step normalises scenes_per_chapter > 0 to drop stale total_scenes', () => {
    const preset = fakePreset({
      form: { scenes_per_chapter: 3, total_scenes: 30 },
    })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.scenes_per_chapter, 3)
    assert.equal(params.total_scenes, undefined,
      'total_scenes must be dropped when scenes_per_chapter > 0 (UI normalisation)')
    assert.equal(params.mode, 'all')
  })

  test('image_prompts step seeds defaults from imagePrompts when preset lacks them', () => {
    // Stale preset (saved before the user touched the form): empty form.
    // Pre-fix: backend hardcoded 10 scenes / 5 thumbs / 16:9 / storybook
    // — sleep-story values. Post-fix: listicle's format defaults flow
    // through unchanged (10 scenes from defaultScenesTotalRange[0]=10,
    // 3 thumbs from defaultThumbnails, 16:9 aspect, format-tuned style).
    const preset = fakePreset({ form: {} })
    const params = resolveStepParams('image_prompts', 'EP0042', 'Title', preset, LISTICLE_FORMAT)
    assert.equal(params.total_scenes, 10,
      'should seed listicle defaultScenesTotalRange[0]')
    assert.equal(params.scenes_per_chapter, 0,
      'scenes_per_chapter=0 signals "use total_scenes"')
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
    assert.equal(params.scenes_per_chapter, 4)
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
    // introduction-only, image_prompts, metadata, video, video_assembly);
    // images / audio / audio_merge resolve paths via the existing
    // folder structure and don't need title in their params.
    const STEPS_WITH_TITLE = [
      'script-only', 'introduction-only', 'image_prompts',
      'metadata', 'video', 'video_assembly',
    ] as const
    const STEPS_WITHOUT_TITLE = ['images', 'audio', 'audio_merge'] as const
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
})
