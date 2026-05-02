/**
 * Tests for the Format loader (services/format-loader.ts).
 *
 * Coverage:
 *   - Built-in 'sleep-story' format loads with required fields
 *   - listFormats() returns at least the built-in
 *   - mergeFormatOverrides() deep-merges objects, replaces arrays wholesale
 *   - getEffectiveFormat() defaults to sleep-story when project has no format_id
 *   - getEffectiveFormat() applies project.format_overrides
 *   - Missing format_id falls back to default with warning (no throw)
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

let loader: typeof import('../services/format-loader.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('format-loader', () => {
  before(async () => {
    tmp = await useTempDataDir()
    loader = await import('../services/format-loader.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(() => {
    loader._clearFormatCaches()
  })

  test("built-in 'sleep-story' loads with all required fields", async () => {
    const fmt = await loader.loadFormat('sleep-story')
    assert.ok(fmt, 'sleep-story must exist')
    assert.equal(fmt!.id, 'sleep-story')
    assert.equal(fmt!.builtin, true)
    assert.equal(fmt!.schemaVersion, 1)
    assert.ok(fmt!.script.systemPromptRole.includes('sleep story'),
      'system prompt should mention sleep story')
    assert.ok(fmt!.script.narratorStyles.length >= 10,
      'should have all 10 narrator styles preserved')
    assert.equal(fmt!.script.defaultNarratorStyleId, 'A')
    assert.deepEqual(fmt!.imagePrompts.defaultScenesTotalRange, [24, 30])
    assert.equal(fmt!.imagePrompts.defaultThumbnails, 5)
    assert.ok(fmt!.metadata.broadKeywords.includes('sleep story'))
  })

  test('loadFormat() returns null for unknown id', async () => {
    const fmt = await loader.loadFormat('nope-this-does-not-exist')
    assert.equal(fmt, null)
  })

  test('listFormats() includes the built-in sleep-story', async () => {
    const list = await loader.listFormats()
    const ids = list.map(f => f.id)
    assert.ok(ids.includes('sleep-story'), `sleep-story must appear; got ${ids.join(',')}`)
  })

  test('mergeFormatOverrides: deep-merges objects', async () => {
    const base = (await loader.loadFormat('sleep-story'))!
    const merged = loader.mergeFormatOverrides(base, {
      script: { closingHint: 'Ride into the sunset, hero.' },
    })
    assert.equal(merged.script.closingHint, 'Ride into the sunset, hero.')
    // Other script fields untouched
    assert.equal(merged.script.systemPromptRole, base.script.systemPromptRole)
    assert.deepEqual(merged.script.narratorStyles, base.script.narratorStyles)
  })

  test('mergeFormatOverrides: arrays REPLACE wholesale (not element-merge)', async () => {
    const base = (await loader.loadFormat('sleep-story'))!
    const merged = loader.mergeFormatOverrides(base, {
      metadata: { broadKeywords: ['adventure', 'thriller'] },
    })
    assert.deepEqual(merged.metadata.broadKeywords, ['adventure', 'thriller'])
    // Other metadata fields untouched
    assert.equal(merged.metadata.purposeNote, base.metadata.purposeNote)
  })

  test('getEffectiveFormat: default when project has no format_id', async () => {
    // Create a minimal project without format_id
    const projDir = path.join(pm.PROJECTS_ROOT, 'no-format-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'No Format', slug: 'no-format-project',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
    }))

    const fmt = await loader.getEffectiveFormat('no-format-project')
    assert.equal(fmt.id, 'sleep-story', 'should default to sleep-story')
  })

  test('getEffectiveFormat: applies project.format_overrides', async () => {
    const projDir = path.join(pm.PROJECTS_ROOT, 'override-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'Overrides', slug: 'override-project',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
      format_id: 'sleep-story',
      format_overrides: {
        script: { closingHint: 'Custom closing.' },
        metadata: { broadKeywords: ['custom-kw'] },
      },
    }))

    const fmt = await loader.getEffectiveFormat('override-project')
    assert.equal(fmt.id, 'sleep-story')
    assert.equal(fmt.script.closingHint, 'Custom closing.')
    assert.deepEqual(fmt.metadata.broadKeywords, ['custom-kw'])
    // Untouched fields survive
    assert.ok(fmt.script.systemPromptRole.length > 0)
  })

  test('getEffectiveFormat: missing format_id falls back to default (no throw)', async () => {
    const projDir = path.join(pm.PROJECTS_ROOT, 'bad-format-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'Bad Format', slug: 'bad-format-project',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
      format_id: 'this-format-id-does-not-exist',
    }))

    const fmt = await loader.getEffectiveFormat('bad-format-project')
    assert.equal(fmt.id, 'sleep-story', 'falls back to default on bad id')
  })

  test('user-custom format in .formats/ shadows built-in by id', async () => {
    const userFormatsDir = path.join(pm.PROJECTS_ROOT, '.formats')
    await fs.mkdir(userFormatsDir, { recursive: true })
    // Forge a "sleep-story" override with a different name
    const forged = {
      id: 'sleep-story',
      name: 'Sleep Story (custom)',
      description: 'forged',
      builtin: false,
      schemaVersion: 1,
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
    await fs.writeFile(path.join(userFormatsDir, 'sleep-story.json'), JSON.stringify(forged))

    loader._clearFormatCaches()
    const fmt = await loader.loadFormat('sleep-story')
    assert.equal(fmt!.name, 'Sleep Story (custom)', 'user format must shadow built-in')
    assert.equal(fmt!.builtin, false)
  })

  test('getEffectiveFormat: brand format_overrides apply between format and project', async () => {
    // Set up a brand with format_overrides on broadKeywords + closingHint
    const brandsDir = path.join(pm.PROJECTS_ROOT, '.brands')
    await fs.mkdir(brandsDir, { recursive: true })
    await fs.writeFile(path.join(brandsDir, 'demo.json'), JSON.stringify({
      id: 'demo', name: 'Demo Brand', schemaVersion: 1,
      format_overrides: {
        script: { closingHint: 'BRAND closing.' },
        metadata: { broadKeywords: ['brand-kw'] },
      },
    }))

    // Drop brand-loader's cache so the new file is read fresh
    const brandLoader = await import('../services/brand-loader.js')
    brandLoader._clearBrandCaches()

    // Project has only brand_id, no project-level overrides
    const projDir = path.join(pm.PROJECTS_ROOT, 'brand-only-project')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'Brand Only', slug: 'brand-only-project',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
      format_id: 'sleep-story',
      brand_id: 'demo',
    }))

    const fmt = await loader.getEffectiveFormat('brand-only-project')
    assert.equal(fmt.script.closingHint, 'BRAND closing.', 'brand override should win over base format')
    assert.deepEqual(fmt.metadata.broadKeywords, ['brand-kw'], 'brand keywords replace base')
  })

  test('getEffectiveFormat: project overrides win over brand', async () => {
    // Same brand as previous test, but the project also has overrides
    const brandsDir = path.join(pm.PROJECTS_ROOT, '.brands')
    await fs.mkdir(brandsDir, { recursive: true })
    await fs.writeFile(path.join(brandsDir, 'demo.json'), JSON.stringify({
      id: 'demo', name: 'Demo Brand', schemaVersion: 1,
      format_overrides: {
        script: { closingHint: 'BRAND closing.' },
        metadata: { broadKeywords: ['brand-kw'] },
      },
    }))
    const brandLoader = await import('../services/brand-loader.js')
    brandLoader._clearBrandCaches()

    const projDir = path.join(pm.PROJECTS_ROOT, 'brand-and-project-override')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'Both', slug: 'brand-and-project-override',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
      format_id: 'sleep-story',
      brand_id: 'demo',
      format_overrides: {
        script: { closingHint: 'PROJECT closing.' },
        // metadata.broadKeywords intentionally NOT overridden — brand value should survive
      },
    }))

    const fmt = await loader.getEffectiveFormat('brand-and-project-override')
    assert.equal(fmt.script.closingHint, 'PROJECT closing.', 'project override wins over brand')
    assert.deepEqual(fmt.metadata.broadKeywords, ['brand-kw'], 'brand keywords survive when project does not override')
  })

  test('getEffectiveFormat: dangling brand_id falls back gracefully', async () => {
    const projDir = path.join(pm.PROJECTS_ROOT, 'dangling-brand')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      name: 'Dangling', slug: 'dangling-brand',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: 'episodes', created_at: new Date().toISOString(),
      format_id: 'sleep-story',
      brand_id: 'this-brand-does-not-exist',
    }))

    // Should not throw — generators must keep working with literal defaults
    const fmt = await loader.getEffectiveFormat('dangling-brand')
    assert.equal(fmt.id, 'sleep-story')
    assert.ok(fmt.script.closingHint.length > 0, 'falls back to base format closing hint')
  })

  test('fillPacingArcPlaceholders substitutes {last} and {lastButOne}', () => {
    const arc = [
      'Chapters 1-3: setup',
      'Chapters 7-{lastButOne}: slow',
      'Chapter {last}: end',
    ]
    const filled = loader.fillPacingArcPlaceholders(arc, 10)
    assert.equal(filled[1], 'Chapters 7-9: slow')
    assert.equal(filled[2], 'Chapter 10: end')
  })
})
