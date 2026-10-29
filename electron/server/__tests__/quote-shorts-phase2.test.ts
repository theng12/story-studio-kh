/**
 * Quote Shorts PHASE 2 tests (owner, 2026-10-26/27).
 *
 * Verifies all seven Phase 2 deliverables:
 * 1. Many moods per channel (ideaAxes with mood, prompt instructions, vocabulary).
 * 2. Old-film / grain overlay option using existing effects system (stack-old-film).
 * 3. Cover frame (title image / cover frame with short duration and batch auto-resolve).
 * 4. Caption animation with fun fonts kept inside 9:16 safe area (Anton bounce/electric, Moul, Battambang slide).
 * 5. Background music at 50-60% starting level for this Formula only.
 * 6. Making Shorts in batches (aspect ratio inheritance, cover frame resolution).
 * 7. A Short's own length: 10–60 s per episode, written to the episode's target (1.4.369).
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { useTempDataDir } from './_helpers.js'
import { loadNiche, _clearNicheCaches } from '../services/niche-loader.js'
import { getEffectiveFormatFor } from '../services/format-loader.js'
import { systemPrompt } from '../generators/episode.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { BUILT_IN_EFFECT_STACKS, sceneEffectCatalog } from '../contracts/scene-effect-presets.js'
import { contentPackDocumentToNiche } from '../content-packs/legacy-adapters.js'
import { resolveStepParams, flattenVideoAssemblyBundle } from '../routes/pipeline.js'
import { buildSubtitleAssDocument } from '../lib/subtitle-builder.js'
import { parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import type { Format } from '../models/types.js'

const project = { slug: 'quote-shorts-test-p2', format_id: 'continuity-chain', niche_id: 'quote-shorts' } as any
const preset = (data: Record<string, unknown>) => ({ id: 'p1', name: 'Test Preset', data })

let temp: Awaited<ReturnType<typeof useTempDataDir>>
before(async () => { temp = await useTempDataDir() })
after(async () => { await temp.cleanup() })

async function effective() {
  _clearNicheCaches()
  return await getEffectiveFormatFor(project)
}

describe('1. Many moods per channel', () => {
  test('the Formula declares ideaAxes with mood values', async () => {
    _clearNicheCaches()
    const niche = await loadNiche('quote-shorts')
    assert.ok(niche?.ideaAxes?.length, 'Formula has ideaAxes')
    const moodAxis = niche.ideaAxes.find(a => a.id === 'mood')
    assert.ok(moodAxis, 'has mood axis')
    assert.ok(moodAxis.values.length >= 8, `declares ${moodAxis.values.length} moods`)
    assert.ok(moodAxis.values.includes('heartbreak'))
    assert.ok(moodAxis.values.includes('quiet motivation'))
    assert.ok(moodAxis.values.includes('late-night calm'))
    assert.ok(moodAxis.values.includes('resolve and self-respect'))
  })

  test('idea guidance instructs multi-mood variety across batch', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    assert.match(raw.ideaSystemPromptRole, /A channel is not restricted to one mood/i)
    assert.match(raw.ideaGuidanceText, /an episode may be heartbreak, the next resolve/i)
  })

  test('example topics cover multiple distinct moods as concrete moments', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    assert.ok(raw.exampleTopics.length >= 15, `has ${raw.exampleTopics.length} example topics`)
    for (const topic of raw.exampleTopics as string[]) {
      assert.ok(!/^how to\b/i.test(topic), `"${topic}" is a how-to`)
      assert.ok(!/\?$/.test(topic), `"${topic}" is a question`)
    }
  })
})

describe('2. Old-film and grain overlay option', () => {
  test('built-in effect stacks include Old Film & Grain', () => {
    const stack = BUILT_IN_EFFECT_STACKS.find(s => s.id === 'stack-old-film')
    assert.ok(stack, 'stack-old-film exists in BUILT_IN_EFFECT_STACKS')
    assert.equal(stack.name, 'Old Film & Grain')
    const effectIds = stack.effects.map(e => e.id)
    assert.ok(effectIds.includes('film-dust'), 'includes film dust')
    assert.ok(effectIds.includes('film-grain-fine'), 'includes fine film grain')
    assert.ok(effectIds.includes('vignette-soft'), 'includes soft vignette')
  })

  test('sceneEffectCatalog exports the old-film stack to the UI picker', () => {
    const catalog = sceneEffectCatalog()
    const found = catalog.effect_stacks.find(s => s.id === 'stack-old-film')
    assert.ok(found, 'stack-old-film present in sceneEffectCatalog')
  })

  test('Quote Shorts Formula provides a visual style hint featuring film grain', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    assert.match(raw.visualStyleHint, /film grain/i)
  })
})

describe('3. Cover frame', () => {
  test('pipeline resolveStepParams forwards title_image when enabled even if image_path is empty', () => {
    const format = { imagePrompts: { recommendedAspect: '9:16' } } as any
    const params = resolveStepParams('video_assembly', 'EP0001', 'Test', preset({
      fallback: {
        timeline: {
          title_image: { enabled: true, duration: 1 },
        },
      },
    }), format)
    assert.ok(params.title_image, 'title_image is passed to generator params')
    assert.equal((params.title_image as any).enabled, true)
    assert.equal((params.title_image as any).duration, 1)
  })

  test('flattenVideoAssemblyBundle preserves title_image duration for cover frames', () => {
    const bundle = {
      fallback: {
        timeline: {
          title_image: { enabled: true, duration: 0.5 },
        },
      },
    }
    const flat = flattenVideoAssemblyBundle(bundle, 'EP0001', 'Short')
    assert.equal((flat.title_image as any)?.duration, 0.5)
  })
})

describe('4. Caption animation with fun fonts in 9:16 safe area', () => {
  const newVerticalPresetIds = [
    'shorts-vertical-bounce',
    'shorts-vertical-electric',
    'shorts-vertical-moul',
    'shorts-vertical-battambang',
  ]

  test('all four new vertical presets exist and are registered', () => {
    for (const id of newVerticalPresetIds) {
      const p = BUILT_IN_SUBTITLE_PRESETS.find(item => item.id === id)
      assert.ok(p, `preset ${id} exists in BUILT_IN_SUBTITLE_PRESETS`)
    }
  })

  test('every vertical preset is anchored in the 9:16 safe area clear of Shorts chrome', () => {
    const allShortsPresets = BUILT_IN_SUBTITLE_PRESETS.filter(p => p.id.startsWith('shorts-vertical'))
    assert.equal(allShortsPresets.length, 8, '2 from phase 1 + 4 from phase 2 + 2 hand-lettered')

    for (const p of allShortsPresets) {
      const placement = p.style.placement
      assert.equal(placement.position_x_pct, 50, `${p.id} centered horizontally`)
      assert.equal(placement.position_y_pct, 62, `${p.id} placed at 62% to clear Shorts buttons and title`)
      assert.equal(placement.safe_margin_pct, 10, `${p.id} uses 10% safe margin for vertical long edge`)
    }
  })

  test('Anton bounce and electric highlight presets use punchy display font', () => {
    const bounce = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'shorts-vertical-bounce')!
    assert.equal(bounce.style.typography.font_family, 'Anton')
    assert.equal(bounce.style.typography.all_caps, true)
    assert.equal(bounce.style.word.mode, 'pop')
    assert.equal(bounce.wordLevel, true)

    const electric = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'shorts-vertical-electric')!
    assert.equal(electric.style.typography.font_family, 'Anton')
    assert.equal(electric.style.word.mode, 'highlight')
    assert.equal(electric.style.word.active_color_hex, '#00E5FF')
  })

  test('Moul display preset uses ornate Khmer face with fade animation', () => {
    const moul = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'shorts-vertical-moul')!
    assert.equal(moul.style.typography.font_family, 'Moul')
    assert.equal(moul.style.animation.type, 'fade')
  })

  test('Battambang slide preset uses bold Khmer sans with slide-up animation', () => {
    const battambang = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'shorts-vertical-battambang')!
    assert.equal(battambang.style.typography.font_family, 'Battambang')
    assert.equal(battambang.style.animation.type, 'slide-up')
  })

  test('all vertical presets build valid ASS documents without unbalanced braces', () => {
    for (const id of newVerticalPresetIds) {
      const p = BUILT_IN_SUBTITLE_PRESETS.find(item => item.id === id)!
      assert.doesNotThrow(() => parseSubtitleStyleDocument(p.style))
      const doc = buildSubtitleAssDocument(
        [{ index: 1, start_sec: 0, end_sec: 2.5, text: 'One thought held for a moment.' }],
        p.style,
        { width: 1080, height: 1920 },
      )
      assert.ok(doc.ass.includes('PlayResX: 1080'), '1080 width')
      assert.ok(doc.ass.includes('PlayResY: 1920'), '1920 height')
      assert.ok(doc.events > 0, `${id} emits events`)
    }
  })
})

describe('5. Background music at 50-60% starting level', () => {
  test('Quote Shorts Formula declares startingMusicVolume in 50-60% range', async () => {
    _clearNicheCaches()
    const niche = await loadNiche('quote-shorts')
    assert.ok(typeof niche?.startingMusicVolume === 'number', 'declares startingMusicVolume')
    assert.ok(niche.startingMusicVolume >= 50 && niche.startingMusicVolume <= 60,
      `startingMusicVolume ${niche.startingMusicVolume}% is within 50-60%`)
  })

  test('contentPackDocumentToNiche maps starting_music_volume to camelCase', () => {
    const doc = {
      kind: 'series-formula',
      schema_version: 1,
      id: 'com.test.formula',
      name: 'Test',
      description: 'Test',
      channel_promise: 'Promise',
      audience: 'Audience',
      narrative_rules: ['Rule'],
      title_rules: ['Rule'],
      script_structure: {
        default_chapter_count: 1, chapter_count_range: [1, 1],
        default_length_minutes: 1, length_minutes_range: [1, 1],
        duration_presets: [1], default_words_per_minute: 120,
        chapters_independent: true, pacing_arc: [], additional_rules: [],
      },
      compatible_topic_pack_ids: [],
      recommended_visual_style_ids: [],
      recommended_thumbnail_recipe_ids: [],
      starting_music_volume: 55,
    }
    const mapped = contentPackDocumentToNiche(doc as any)
    assert.equal(mapped.startingMusicVolume, 55)
  })

  test('applyNicheToFormat keeps the format gap while adding the Formula music level', async () => {
    // The loader integration above proves the end result. This pins the merge
    // itself: a Formula that states only music volume must not drop the
    // format's own chapter pause.
    _clearNicheCaches()
    const niche = await loadNiche('quote-shorts')
    const format = await getEffectiveFormatFor(project)
    assert.equal(format.script.audioMergeDefaults?.musicVolume, niche!.startingMusicVolume)
    assert.equal(format.script.audioMergeDefaults?.gapDurationSec, 3, 'the continuity-chain shell gap is preserved')
  })

  test('the effective format surfaces the 55% start as audioMergeDefaults.musicVolume', async () => {
    const format = await effective()
    assert.equal(format.script.audioMergeDefaults?.musicVolume, 55)
  })

  test('pipeline audio_merge falls back to format.script.audioMergeDefaults.musicVolume when unset', () => {
    const format: Format = {
      script: { audioMergeDefaults: { musicVolume: 55, gapDurationSec: 0 } },
    } as any
    const params = resolveStepParams('audio_merge', 'EP0001', 'Test', preset({
      music: { enabled: true, source: 'manual', files: [] },
    }), format)
    assert.equal(params.music?.volume, 0.55, '55% converted to 0.55 linear gain')
  })
})

describe('6. Making Shorts in batches', () => {
  test('batch video assembly inherits 9:16 from format when export preset omits aspect_ratio', () => {
    const format: Format = {
      imagePrompts: { recommendedAspect: '9:16' },
      script: {},
    } as any
    const bundleData = {
      fallback: {
        export: { resolution: '1080p', quality: 'high' },
        timeline: {},
        effects: {},
      },
    }
    const flat = flattenVideoAssemblyBundle(bundleData, 'EP0001', 'Test', format)
    assert.equal(flat.aspect_ratio, '9:16', 'inherited 9:16 aspect ratio')
  })

  test('batch video assembly preserves explicit preset aspect_ratio when provided', () => {
    const format: Format = {
      imagePrompts: { recommendedAspect: '9:16' },
      script: {},
    } as any
    const bundleData = {
      fallback: {
        export: { resolution: '1080p', aspect_ratio: '1:1' },
        timeline: {},
        effects: {},
      },
    }
    const flat = flattenVideoAssemblyBundle(bundleData, 'EP0001', 'Test', format)
    assert.equal(flat.aspect_ratio, '1:1', 'explicit preset ratio wins (§5)')
  })
})

describe('7. A Short’s length belongs to the episode (10–60 s)', () => {
  test('script context says the length varies per episode inside the range', async () => {
    const raw = JSON.parse(await readFile(new URL('../niches/quote-shorts.json', import.meta.url), 'utf8'))
    assert.match(raw.scriptContext, /10 to 60 seconds/i)
    assert.match(raw.scriptContext, /exact target length/i)
    assert.match(raw.scriptStructure.additionalRules.join(' '), /10 to 60 seconds/i)
    assert.match(raw.scriptStructure.additionalRules.join(' '), /exact target length/i)
    // The old hard figure is gone: it contradicted the fields (1 min × 120 wpm
    // = 120 words) and the owner rejected the too-long duration.
    assert.doesNotMatch(raw.scriptStructure.additionalRules.join(' '), /suggested around 45 seconds/i)
  })

  test('script prompt tells the writer to write to the episode’s own target', async () => {
    const prompt = systemPrompt(await effective(), '')
    assert.match(prompt, /10 to 60 seconds/i)
    assert.match(prompt, /exact target length/i)
  })
})
