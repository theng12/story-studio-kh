/**
 * Tests for the Format loader (services/format-loader.ts).
 *
 * Coverage:
 *   - Built-in Continuity Engine loads with required fields
 *   - The sole active presentation shell loads + validates
 *   - listFormats() returns at least the built-ins
 *   - mergeFormatOverrides() deep-merges objects, replaces arrays wholesale
 *   - getEffectiveFormat() defaults to 'continuity-chain' when project has no format_id
 *   - getEffectiveFormat() applies project.format_overrides
 *   - Missing/unknown format_id falls back to default with warning (no throw)
 *   - Saved or arbitrary format ids resolve to the Continuity Engine without
 *     rewriting project metadata
 *   - POLARITY FLIP: applyNicheToFormat overlays niche CONTENT onto a
 *     presentation shell (niche owns idea/script/metadata persona)
 *   - NEUTRAL FALLBACK: a format-only project (no niche) still yields a usable,
 *     builder-acceptable Format from the shell's neutral content
 *   - User-custom format in ${PROJECTS_ROOT}/.formats/ shadows built-in
 *   - fillPacingArcPlaceholders substitutes {last} and {lastButOne}
 *
 * IMPORTANT — module-load ordering: project-manager.ts evaluates PROJECTS_ROOT
 * at module-load time, so we must set STORY_STUDIO_DATA_DIR BEFORE the
 * loader (or its dependencies) imports. All loader imports happen inside
 * before() to guarantee env-first init.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import type { Niche } from '../models/types.js'

let loader: typeof import('../services/format-loader.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

/** Minimal project.json body shared by the getEffectiveFormat tests. */
function projectJson(slug: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: slug, slug,
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
    ...extra,
  })
}

describe('format-loader', () => {
  before(async () => {
    tmp = await useTempDataDir()
    loader = await import('../services/format-loader.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(() => {
    loader._clearFormatCaches()
  })

  test("built-in Continuity Engine loads with all required fields", async () => {
    const fmt = await loader.loadFormat('continuity-chain')
    assert.ok(fmt, 'continuity-chain must exist')
    assert.equal(fmt!.id, 'continuity-chain')
    assert.equal(fmt!.builtin, true)
    assert.equal(fmt!.schemaVersion, 1)
    assert.equal(fmt!.visualSource, 'continuity-chain')
    assert.equal(fmt!.sceneAlignment, 'sentence', 'Continuity Engine uses narration-timed Scene Plan alignment')
    assert.ok(fmt!.script.systemPromptRole.length > 0, 'system prompt should be non-empty')
    assert.ok(fmt!.script.narratorStyles.length >= 1, 'shell keeps a narrator picker')
    assert.ok(fmt!.script.defaultNarratorStyleId.length > 0)
  })

  test('loadFormat() returns null for unknown id', async () => {
    const fmt = await loader.loadFormat('nope-this-does-not-exist')
    assert.equal(fmt, null)
  })

  // Shape parity across all active presentation shells. A shell is presentation-
  // only: it carries the structural/picker fields the pipeline + UI need, and
  // leaves voice/content fields neutral (the niche fills those).
  const ALL_BUILTIN_FORMATS = ['continuity-chain']
  for (const id of ALL_BUILTIN_FORMATS) {
    test(`built-in shell '${id}' loads with all required presentation fields`, async () => {
      const fmt = await loader.loadFormat(id)
      assert.ok(fmt, `${id} must exist`)
      assert.equal(fmt!.id, id)
      assert.equal(fmt!.builtin, true)
      assert.equal(fmt!.schemaVersion, 1)
      // Required non-empty roles (validator invariants the builders depend on)
      assert.ok(fmt!.script.systemPromptRole.length > 0, `${id}: script.systemPromptRole non-empty`)
      assert.ok(fmt!.idea.systemPromptRole.length > 0, `${id}: idea.systemPromptRole non-empty`)
      // Presentation: pacing / structure
      assert.ok(Array.isArray(fmt!.script.pacingArc))
      assert.ok(typeof fmt!.script.defaultChapterCount === 'number' && fmt!.script.defaultChapterCount > 0)
      assert.ok(Array.isArray(fmt!.script.chapterCountRange) && fmt!.script.chapterCountRange.length === 2)
      assert.ok(typeof fmt!.script.defaultLengthMinutes === 'number' && fmt!.script.defaultLengthMinutes > 0)
      // Narrator picker — used by scripts.vue's narrator-style picker
      assert.ok(Array.isArray(fmt!.script.narratorStyles) && fmt!.script.narratorStyles.length > 0,
        `${id}: needs at least one narrator style for the picker`)
      assert.ok(fmt!.script.defaultNarratorStyleId, `${id}: defaultNarratorStyleId is set`)
      // Image-prompt presentation defaults
      assert.ok(Array.isArray(fmt!.imagePrompts.defaultScenesTotalRange) &&
        fmt!.imagePrompts.defaultScenesTotalRange.length === 2,
        `${id}: imagePrompts.defaultScenesTotalRange [lo, hi]`)
      assert.ok(typeof fmt!.imagePrompts.defaultThumbnails === 'number' &&
        fmt!.imagePrompts.defaultThumbnails > 0, `${id}: imagePrompts.defaultThumbnails > 0`)
      assert.ok(typeof fmt!.imagePrompts.recommendedAspect === 'string' &&
        fmt!.imagePrompts.recommendedAspect.length > 0, `${id}: imagePrompts.recommendedAspect set`)
      // Metadata presentation defaults
      assert.ok(fmt!.metadata.purposeNote.length > 0)
      assert.ok(Array.isArray(fmt!.metadata.broadKeywords))
      assert.ok(fmt!.metadata.youtubeDescriptionStructure,
        `${id}: youtubeDescriptionStructure required for description rendering`)
    })
  }

  // Presentation shells must NOT carry voice content — the content moved to
  // niches. We pin a couple of high-signal fields to empty to keep the polarity
  // honest (a future edit that re-stuffs format content fails loudly here).
  test('presentation shells carry no voice content (vocab / title rules empty)', async () => {
    for (const id of ALL_BUILTIN_FORMATS) {
      const fmt = await loader.loadFormat(id)
      assert.deepEqual(fmt!.idea.moodVocabulary, [], `${id}: idea.moodVocabulary stripped`)
      assert.deepEqual(fmt!.idea.themeVocabulary, [], `${id}: idea.themeVocabulary stripped`)
      assert.deepEqual(fmt!.metadata.broadKeywords, [], `${id}: metadata.broadKeywords stripped`)
      assert.ok(!fmt!.idea.titleShapeRules?.length, `${id}: idea.titleShapeRules stripped`)
      assert.ok(!fmt!.idea.exampleIdeas?.length, `${id}: idea.exampleIdeas stripped`)
    }
  })

  test('audioDefaults: pace only — a format may not seed a model control', async () => {
    for (const id of ALL_BUILTIN_FORMATS) {
      const fmt = await loader.loadFormat(id)
      const ad = fmt!.script.audioDefaults
      if (!ad) continue
      assert.ok(typeof ad.speed === 'number' && ad.speed > 0 && ad.speed <= 2, `${id}: audioDefaults.speed in (0, 2]`)
      // Which controls a TTS model takes, and what they accept, is published
      // per model and read live. A format shipping a default for one would be
      // Story Studio asserting a capability GenStudio never published for the
      // model the customer actually selected.
      assert.deepEqual(Object.keys(ad), ['speed'], `${id}: audioDefaults carries pace and nothing else`)
    }
  })

  test('audioMergeDefaults: shape is valid on every format that ships them', async () => {
    for (const id of ALL_BUILTIN_FORMATS) {
      const fmt = await loader.loadFormat(id)
      const md = fmt!.script.audioMergeDefaults
      if (!md) continue
      assert.ok(typeof md.gapDurationSec === 'number' && md.gapDurationSec >= 0, `${id}: audioMergeDefaults.gapDurationSec >= 0`)
      assert.ok(typeof md.normalizeVolume === 'boolean', `${id}: audioMergeDefaults.normalizeVolume is boolean`)
    }
  })

  test('listFormats() exposes only the active built-in shells', async () => {
    const list = await loader.listFormats()
    const ids = list.map(f => f.id)
    assert.deepEqual(ids.sort(), ['continuity-chain'])
    assert.ok(!ids.includes('stock-footage'))
    assert.ok(!ids.includes('image-pool'))
  })

  test('mergeFormatOverrides: deep-merges objects', async () => {
    const base = (await loader.loadFormat('continuity-chain'))!
    const merged = loader.mergeFormatOverrides(base, {
      script: { closingHint: 'Ride into the sunset, hero.' },
    })
    assert.equal(merged.script.closingHint, 'Ride into the sunset, hero.')
    assert.equal(merged.script.systemPromptRole, base.script.systemPromptRole)
    assert.deepEqual(merged.script.narratorStyles, base.script.narratorStyles)
  })

  test('mergeFormatOverrides: arrays REPLACE wholesale (not element-merge)', async () => {
    const base = (await loader.loadFormat('continuity-chain'))!
    const merged = loader.mergeFormatOverrides(base, {
      metadata: { broadKeywords: ['adventure', 'thriller'] },
    })
    assert.deepEqual(merged.metadata.broadKeywords, ['adventure', 'thriller'])
    assert.equal(merged.metadata.purposeNote, base.metadata.purposeNote)
  })

  test('getEffectiveFormat: default when project has no format_id', async () => {
    const projDir = path.join(pm.projectsRoot(), 'no-format-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), projectJson('no-format-project'))
    const fmt = await loader.getEffectiveFormat('no-format-project')
    assert.equal(fmt.id, 'continuity-chain', 'should default to continuity')
  })

  test('getEffectiveFormat: applies project.format_overrides', async () => {
    const projDir = path.join(pm.projectsRoot(), 'override-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), projectJson('override-project', {
      format_id: 'continuity-chain',
      format_overrides: {
        script: { closingHint: 'Custom closing.' },
        metadata: { broadKeywords: ['custom-kw'] },
      },
    }))
    const fmt = await loader.getEffectiveFormat('override-project')
    assert.equal(fmt.id, 'continuity-chain')
    assert.equal(fmt.script.closingHint, 'Custom closing.')
    assert.deepEqual(fmt.metadata.broadKeywords, ['custom-kw'])
    assert.ok(fmt.script.systemPromptRole.length > 0)
  })

  test('getEffectiveFormat: missing format_id falls back to default (no throw)', async () => {
    const projDir = path.join(pm.projectsRoot(), 'bad-format-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), projectJson('bad-format-project', {
      format_id: 'this-format-id-does-not-exist',
    }))
    const fmt = await loader.getEffectiveFormat('bad-format-project')
    assert.equal(fmt.id, 'continuity-chain', 'falls back to continuity on bad id')
  })

  test('getEffectiveFormat: saved legacy ids use continuity without rewriting project metadata', async () => {
    for (const [slug, formatId] of [['saved-stock-footage', 'stock-footage'], ['saved-scenes', 'scenes']] as const) {
      const projDir = path.join(pm.projectsRoot(), slug)
      await fs.mkdir(projDir, { recursive: true })
      const projectPath = path.join(projDir, 'project.json')
      const saved = projectJson(slug, { format_id: formatId })
      await fs.writeFile(projectPath, saved)

      const fmt = await loader.getEffectiveFormat(slug)

      assert.equal(fmt.id, 'continuity-chain')
      assert.equal(fmt.visualSource, 'continuity-chain')
      assert.equal(fmt.sceneAlignment, 'sentence')
      assert.equal(await fs.readFile(projectPath, 'utf8'), saved)
    }
  })

  test('getEffectiveFormat: only live visual sources pass through', async () => {
    for (const visualSource of ['timestamp-driven', 'continuity-chain', 'narrated-scenes'] as const) {
      const slug = `live-${visualSource}`
      const projDir = path.join(pm.projectsRoot(), slug)
      await fs.mkdir(projDir, { recursive: true })
      await fs.writeFile(path.join(projDir, 'project.json'), projectJson(slug, {
        format_overrides: { visualSource },
      }))
      assert.equal((await loader.getEffectiveFormat(slug)).visualSource, visualSource)
    }
  })

  test('getEffectiveFormat: unknown visual-source overrides collapse to continuity timing', async () => {
    const projDir = path.join(pm.projectsRoot(), 'unknown-visual-source')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), projectJson('unknown-visual-source', {
      format_overrides: { visualSource: 'broll' },
    }))

    const fmt = await loader.getEffectiveFormat('unknown-visual-source')

    assert.equal(fmt.visualSource, 'continuity-chain')
    assert.equal(fmt.sceneAlignment, 'sentence')
  })

  // ── POLARITY FLIP: niche provides content into the shell ───────────────────
  test('applyNicheToFormat: niche OWNS idea/script/metadata persona on the shell', async () => {
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche: Niche = {
      id: 'demo-niche', name: 'Demo', description: 'd', builtin: true, schemaVersion: 1,
      exampleTopics: ['Topic One', 'Topic Two'],
      vocabulary: { mood: ['serene'], theme: ['stillness'] },
      ideaSystemPromptRole: 'NICHE IDEA ROLE',
      scriptSystemPromptRole: 'NICHE SCRIPT ROLE',
      scriptClosingHint: 'NICHE CLOSING',
      metadataTitleStyleHint: 'NICHE TITLE STYLE',
      metadataTitleHookRules: ['hook A'],
      metadataTagsHookRules: ['tag rule A'],
      visualStyleHint: 'NICHE VISUAL HINT',
      youtubeTagsHint: ['demo-tag'],
    }
    const merged = loader.applyNicheToFormat(shell, niche)
    // Niche-owned content REPLACES the shell's neutral defaults
    assert.equal(merged.idea.systemPromptRole, 'NICHE IDEA ROLE')
    assert.equal(merged.script.systemPromptRole, 'NICHE SCRIPT ROLE')
    assert.equal(merged.script.closingHint, 'NICHE CLOSING')
    assert.equal(merged.metadata.titleStyleHint, 'NICHE TITLE STYLE')
    assert.deepEqual(merged.metadata.titleHookRules, ['hook A'])
    assert.deepEqual(merged.metadata.tagsHookRules, ['tag rule A'])
    assert.equal(merged.imagePrompts.visualStyleHint, 'NICHE VISUAL HINT')
    // Niche vocab fills the (empty) shell pools
    assert.ok(merged.idea.moodVocabulary.includes('serene'))
    assert.ok(merged.idea.themeVocabulary.includes('stillness'))
    // Niche tags merge into the broadKeywords pool
    assert.ok(merged.metadata.broadKeywords.includes('demo-tag'))
    // Presentation fields are untouched by the niche
    assert.equal(merged.visualSource, 'continuity-chain')
    assert.equal(merged.sceneAlignment, 'sentence')
    assert.deepEqual(merged.script.narratorStyles, shell.script.narratorStyles)
  })

  test('applyNicheToFormat: thin niche (scriptContext only) composes over shell role', async () => {
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche: Niche = {
      id: 'thin', name: 'Thin', description: 'd', builtin: true, schemaVersion: 1,
      exampleTopics: [], scriptContext: 'Speak calmly.',
    }
    const merged = loader.applyNicheToFormat(shell, niche)
    // No explicit persona → scriptContext is composed onto the shell role
    assert.ok(merged.script.systemPromptRole.includes(shell.script.systemPromptRole),
      'shell role preserved as backbone')
    assert.ok(merged.script.systemPromptRole.includes('Speak calmly.'),
      'niche scriptContext folded in')
    // closingHint falls back to the shell's neutral value (niche silent)
    assert.equal(merged.script.closingHint, shell.script.closingHint)
  })

  test('applyNicheToFormat: Formula narrative-quality contract reaches every script route', async () => {
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche: Niche = {
      id: 'quality-contract-test', name: 'Quality contract', description: 'test', builtin: false, schemaVersion: 1,
      exampleTopics: [],
      perspectivePolicy: 'Third-person evidence-led narration.',
      narrativeQualityContract: {
        openingPolicy: 'Open on a concrete constraint.',
        forbiddenPatterns: ['Imagine this', 'Watch what happens next'],
        requiredHabits: ['Use causal links.'],
        closingPolicy: 'Close the actual thought.',
      },
    }
    const merged = loader.applyNicheToFormat(shell, niche)
    const rules = merged.script.additionalRules.join('\n')
    assert.match(rules, /OPENING POLICY — Open on a concrete constraint/)
    assert.match(rules, /Imagine this/)
    assert.match(rules, /FORMULA-OWNED PERSPECTIVE — Third-person evidence-led narration/)
  })

  // ── NEUTRAL FALLBACK: format-only project still produces a usable Format ────
  test('getEffectiveFormat: no-niche project yields a builder-acceptable Format', async () => {
    const projDir = path.join(pm.projectsRoot(), 'neutral-fallback')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), projectJson('neutral-fallback', { format_id: 'continuity-chain' }))
    const fmt = await loader.getEffectiveFormat('neutral-fallback')
    // The shell's neutral content IS the fallback: required roles are non-empty
    // (so prompt assembly never crashes), and content pools are empty (so the
    // builders take their lenient defaults rather than a stale sleep-story voice).
    assert.ok(fmt.idea.systemPromptRole.length > 0)
    assert.ok(fmt.script.systemPromptRole.length > 0)
    assert.ok(fmt.script.narratorStyles.length > 0)
    assert.deepEqual(fmt.idea.moodVocabulary, [])
    assert.deepEqual(fmt.metadata.broadKeywords, [])
  })

  // ── PHASE B: built-in niches are COMPLETE content profiles ────────────────
  test('Phase B: built-in sleep niche yields a complete profile on the Continuity Engine', async () => {
    const shell = (await loader.loadFormat('continuity-chain'))!
    const nicheLoader = await import('../services/niche-loader.js')
    const sleep = await nicheLoader.loadNiche('sleep')
    assert.ok(sleep, 'sleep niche must ship as a built-in')
    assert.deepEqual(sleep!.openingProfile, {
      id: 'sleep-landing',
      label: 'Sleep landing',
      description: 'A gentle branded welcome and settling ritual before the story begins.',
    }, 'sleep owns the only current opening profile')
    const merged = loader.applyNicheToFormat(shell, sleep!)
    // Niche owns the personas (not the shell's generic role)
    assert.notEqual(merged.idea.systemPromptRole, shell.idea.systemPromptRole, 'sleep owns the idea role')
    assert.notEqual(merged.script.systemPromptRole, shell.script.systemPromptRole, 'sleep owns the script role')
    // Niche fills the (empty) vocab pools
    assert.ok(merged.idea.moodVocabulary.length > 0, 'sleep provides mood vocab')
    assert.ok(merged.idea.themeVocabulary.length > 0, 'sleep provides theme vocab')
    // Niche owns the narrator picker (sleep ships 10 literary voices vs the shell's 1)
    assert.ok(merged.script.narratorStyles.length >= 5, 'sleep replaces the shell narrator picker')
    assert.ok(merged.script.narratorStyles.some(s => s.id === merged.script.defaultNarratorStyleId),
      'defaultNarratorStyleId resolves to a real niche style')
    // Niche owns title shape
    assert.ok((merged.idea.titleShapeRules?.length || 0) > 0, 'sleep provides title shape rules')
  })

  test('Phase B: every built-in niche loads + is a complete content profile', async () => {
    const nicheLoader = await import('../services/niche-loader.js')
    const shell = (await loader.loadFormat('continuity-chain'))!
    // The niches the refactor explicitly authored/upgraded to own their voice.
    const COMPLETE_NICHES = [
      'sleep', 'listicle-explainer', 'pov-hustle', 'prayer', 'devotional',
      'preaching', 'history-narration', 'mindfulness', 'motivation',
      'animals', 'plants', 'fungi', 'insects', 'philosophy', 'psychology',
      'business-economics', 'hidden-mechanics-history',
    ]
    for (const id of COMPLETE_NICHES) {
      const niche = await nicheLoader.loadNiche(id)
      assert.ok(niche, `${id} must load`)
      assert.ok(niche!.scriptSystemPromptRole && niche!.scriptSystemPromptRole.length > 0,
        `${id}: owns a script persona`)
      assert.ok(niche!.ideaSystemPromptRole && niche!.ideaSystemPromptRole.length > 0,
        `${id}: owns an idea persona`)
      assert.ok(Array.isArray(niche!.narratorStyles) && niche!.narratorStyles.length > 0,
        `${id}: ships its own narrator picker`)
      // Applying it to the shell must not crash and must replace the generic role.
      const merged = loader.applyNicheToFormat(shell, niche!)
      assert.equal(merged.script.systemPromptRole, niche!.scriptSystemPromptRole,
        `${id}: script persona wins on the shell`)
      assert.equal(merged.idea.systemPromptRole, niche!.ideaSystemPromptRole,
        `${id}: idea persona wins on the shell`)
    }
  })

  test('Business Economics owns its case-study structure and annotated thumbnail layout', async () => {
    const nicheLoader = await import('../services/niche-loader.js')
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche = await nicheLoader.loadNiche('business-economics')
    assert.ok(niche, 'business-economics must ship as a built-in niche')

    const merged = loader.applyNicheToFormat(shell, niche!)
    assert.equal(merged.script.defaultChapterCount, 10)
    assert.deepEqual(merged.script.chapterCountRange, [8, 12])
    assert.match(merged.script.pacingArc[0] || '', /owner's position/i)
    assert.ok(merged.script.additionalRules.some(rule => /unit economics|revenue or cost number/i.test(rule)))
    assert.ok((merged.idea.titleShapeRules || []).some(rule => /The Economics of Owning/i.test(rule)))

    const thumbnail = merged.imagePrompts.thumbnail
    assert.equal(thumbnail?.layout, 'annotated-collage')
    assert.match(thumbnail?.conceptGuidance || '', /six to eight small/i)
    assert.doesNotMatch(thumbnail?.conceptGuidance || '', /single dramatic focal subject/i)
    assert.ok(thumbnail?.compositionRules?.some(rule => /red underline/i.test(rule)))
    assert.equal(thumbnail?.defaultFontStyle, 'bold')
  })

  // 40-50 minutes is the owner's decision of 2026-08-21, replacing 30-45. The
  // NINE PARTS ARE NOT HIS TO CHANGE CASUALLY and were left alone deliberately:
  // the pacing arc names all nine (Chapter 1 "The familiar story" through
  // Chapter 9 "The changed world"), so the range stays pinned at [9, 9] and the
  // extra runtime lands as longer chapters, not more of them.
  test('Hidden Mechanics of History owns a nine-part, 40-50 minute causal reconstruction', async () => {
    const nicheLoader = await import('../services/niche-loader.js')
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche = await nicheLoader.loadNiche('hidden-mechanics-history')
    assert.ok(niche, 'Hidden Mechanics of History Formula must ship as a built-in niche')

    const merged = loader.applyNicheToFormat(shell, niche!)
    assert.equal(merged.script.defaultChapterCount, 9)
    assert.deepEqual(merged.script.chapterCountRange, [9, 9])
    assert.equal(merged.script.defaultLengthMinutes, 45)
    assert.deepEqual(merged.script.lengthMinutesRange, [40, 50])
    assert.match(merged.script.pacingArc[0] || '', /familiar story/i)
    assert.ok(merged.script.additionalRules.some(rule => /Never treat correlation/i.test(rule)))
    assert.ok((merged.idea.titleShapeRules || []).some(rule => /Hidden Mechanics/i.test(rule)))
    assert.equal(niche!.defaultThumbnailTemplateId, 'archival-map-investigation')
    assert.equal(niche!.productionKit?.recommendedVisualStyleId, 'builtin-archival-documentary-reconstruction')
  })

  test('Deep Time Documentary owns feature-length duration, calm evidence rules, and two-phase visual pacing', async () => {
    const nicheLoader = await import('../services/niche-loader.js')
    const shell = (await loader.loadFormat('continuity-chain'))!
    const niche = await nicheLoader.loadNiche('deep-time-documentary')
    assert.ok(niche, 'deep-time documentary Formula must ship')

    const merged = loader.applyNicheToFormat(shell, niche!)
    assert.equal(merged.script.defaultChapterCount, 18)
    assert.deepEqual(merged.script.chapterCountRange, [16, 24])
    assert.equal(merged.script.defaultLengthMinutes, 150)
    assert.deepEqual(merged.script.durationPresets, [120, 150, 180])
    assert.equal(merged.script.defaultWordsPerMinute, 120)
    assert.equal(merged.script.chaptersIndependent, true)
    assert.deepEqual(merged.script.visualPacingProfile, {
      opening_duration_sec: 900,
      opening: { min_sec: 4, max_sec: 8 },
      settled: { min_sec: 12, max_sec: 20 },
    })
    assert.deepEqual(merged.script.motionProfile, {
      id: 'ambient-documentary',
      label: 'Ambient documentary',
      description: 'Follows scene role first, then uses a calm stable mix: evidence views hold still, landscapes drift gently, and only genuine phenomena receive limited animation.',
      opening_duration_sec: 900,
      opening: { still: 20, gentle: 55, limited: 25 },
      settled: { still: 40, gentle: 50, limited: 10 },
    })
    assert.match(merged.script.systemPromptRole, /evidence-led/i)
    assert.ok(merged.script.additionalRules.some(rule => /evidence checkpoints/i.test(rule)))
    assert.equal(merged.imagePrompts.thumbnail?.layout, 'hero')
    assert.equal(niche!.defaultThumbnailTemplateId, 'documentary-label-tableau')
    assert.equal(niche!.productionKit?.recommendedVisualStyleId, 'builtin-paleo-documentary-tableau')
    assert.equal(niche!.productionKit?.episodeProfiles?.length, 2)
  })

  test('legacy custom format files remain readable but cannot become the active engine', async () => {
    const userFormatsDir = path.join(pm.projectsRoot(), '.formats')
    await fs.mkdir(userFormatsDir, { recursive: true })
    const forged = {
      id: 'legacy-custom-format',
      name: 'Scenes (custom)',
      description: 'forged',
      builtin: false,
      schemaVersion: 1,
      visualSource: 'scene-images',
      sceneAlignment: 'chapter',
      idea: { systemPromptRole: 'You generate forged ideas.', audienceDefault: 'test', moodVocabulary: [], themeVocabulary: [], guidanceText: 'Test rules.' },
      script: {
        systemPromptRole: 'You are the forged narrator.',
        additionalRules: [], pacingArc: [], closingHint: 'forged.',
        defaultChapterCount: 1, chapterCountRange: [1, 1],
        defaultLengthMinutes: 1, lengthMinutesRange: [1, 1],
        narratorStyles: [{ id: 'X', label: 'X', description: 'forged style' }],
        defaultNarratorStyleId: 'X',
      },
      imagePrompts: { purposeNote: 'forged', visualStyleHint: 'forged', defaultScenesTotalRange: [1, 1], defaultThumbnails: 1, defaultStyleTag: 'forged', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
      metadata: { purposeNote: 'forged', titleStyleHint: 'forged', titleHookRules: [], tagsContext: 'forged', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: 'X', booksSectionLabel: 'X', supportSection: 'X', aiDisclosure: 'X', defaultHashtags: [], totalHashtagCount: 0 } },
    }
    await fs.writeFile(path.join(userFormatsDir, 'legacy-custom-format.json'), JSON.stringify(forged))
    loader._clearFormatCaches()
    const fmt = await loader.loadFormat('legacy-custom-format')
    assert.equal(fmt!.name, 'Scenes (custom)', 'user format must shadow built-in')
    assert.equal(fmt!.builtin, false)
    // Cleanup after confirming the legacy file can still be inspected.
    await fs.rm(path.join(userFormatsDir, 'legacy-custom-format.json'), { force: true })
    loader._clearFormatCaches()
  })

  test('fillPacingArcPlaceholders substitutes {last} and {lastButOne}', () => {
    const arc = ['Chapters 1-3: setup', 'Chapters 7-{lastButOne}: slow', 'Chapter {last}: end']
    const filled = loader.fillPacingArcPlaceholders(arc, 10)
    assert.equal(filled[1], 'Chapters 7-9: slow')
    assert.equal(filled[2], 'Chapter 10: end')
  })
})
