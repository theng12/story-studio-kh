/**
 * Tests for Episode Translation (English ↔ Khmer).
 *
 * Verifies:
 * - AGENTS.md §1: Writing model is required from live picker / preset (never hardcoded).
 * - AGENTS.md §4: Target episode is created in the target channel, preserving source provenance.
 * - AGENTS.md §8: Verified completion: done only when every chapter is translated and non-empty.
 * - Complete, partial, empty, and provider-failure outcomes.
 * - Language pair validation (English ↔ Khmer only).
 * - Asset reuse: visual stills and scene plan remapped to target episode.
 * - HTTP route POST /api/projects/:slug/episodes/:episodeId/translate.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import {
  resolveTranslationLanguages,
  buildChapterTranslationPrompt,
  buildIntroductionTranslationPrompt,
  parseTranslatedChapter,
  parseTranslatedIntro,
  verifyTranslatedCompletion,
  copyVisualAssetsAndScenePlan,
  translateEpisodeScript,
} from '../services/translation.js'
import * as pm from '../services/project-manager.js'
import * as ideas from '../services/idea-manager.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath, SCENE_PLAN_SIDECAR } from '../services/utils.js'
import { writeChapterFiles, assembleUnifiedNarration } from '../lib/narration-assembly.js'
import { resolveArtifact, resolveReadPath } from '../lib/episode-artifacts.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import type { ScenePlan } from '../models/types.js'

let cleanup: () => Promise<void>
let app: any

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const mod = await import('../app.js')
  app = mod.app
})

after(async () => {
  await cleanup?.()
})

describe('Language pair validation', () => {
  test('accepts en -> km and km -> en', () => {
    assert.deepEqual(resolveTranslationLanguages('en', 'km'), { sourceLanguage: 'en', targetLanguage: 'km' })
    assert.deepEqual(resolveTranslationLanguages('km', 'en'), { sourceLanguage: 'km', targetLanguage: 'en' })
  })

  test('refuses same-language translation', () => {
    assert.throws(
      () => resolveTranslationLanguages('en', 'en'),
      (err: any) => err.statusCode === 400 && /both have language "en"/.test(err.message),
    )
    assert.throws(
      () => resolveTranslationLanguages('km', 'km'),
      (err: any) => err.statusCode === 400 && /both have language "km"/.test(err.message),
    )
  })

  test('refuses missing or unsupported languages', () => {
    assert.throws(
      () => resolveTranslationLanguages(null, 'km'),
      (err: any) => err.statusCode === 400 && /Source channel content_language must be "en" or "km"/.test(err.message),
    )
    assert.throws(
      () => resolveTranslationLanguages('en', undefined),
      (err: any) => err.statusCode === 400 && /Target channel content_language must be "en" or "km"/.test(err.message),
    )
    assert.throws(
      () => resolveTranslationLanguages('fr', 'km'),
      (err: any) => err.statusCode === 400,
    )
  })
})

describe('Prompt construction', () => {
  test('builds chapter translation prompt with heading and language rules', () => {
    const prompt = buildChapterTranslationPrompt(
      'en',
      'km',
      { number: 1, title: 'The Sacred Mountain', text: 'Long ago in the highlands, mist covered the green valleys.' },
      'Legend of Angkor',
    )
    assert.ok(prompt.system.includes('English and Khmer'))
    assert.ok(prompt.system.includes('## Chapter 01: <translated chapter title>'))
    assert.ok(prompt.system.includes('Khmer grammar, spacing, and punctuation (such as ។ and ៕)'))
    assert.ok(prompt.user.includes('Legend of Angkor'))
    assert.ok(prompt.user.includes('Chapter 01: The Sacred Mountain'))
    assert.ok(prompt.user.includes('mist covered the green valleys'))
  })

  test('builds introduction translation prompt with # Introduction heading', () => {
    const prompt = buildIntroductionTranslationPrompt(
      'km',
      'en',
      'សូមស្វាគមន៍មកកាន់ដំណើររឿងព្រេងបុរាណ។',
      'រឿងនិទានខ្មែរ',
    )
    assert.ok(prompt.system.includes('Khmer and English'))
    assert.ok(prompt.system.includes('# Introduction'))
    assert.ok(prompt.user.includes('រឿងនិទានខ្មែរ'))
    assert.ok(prompt.user.includes('សូមស្វាគមន៍មកកាន់ដំណើររឿងព្រេងបុរាណ។'))
  })
})

describe('Response parser (§8 verified completion)', () => {
  test('parses valid markdown chapter into number, title, and body text', () => {
    const raw = `## Chapter 01: ភ្នំពិសិដ្ឋ

កាលពីព្រេងនាយ នៅតំបន់ខ្ពង់រាប អ័ព្ទបានគ្របដណ្តប់លើជ្រលងភ្នំពណ៌បៃតង។

មនុស្សជំនាន់មុនតែងតែគោរពបូជាទីកន្លែងនេះ។`

    const parsed = parseTranslatedChapter(raw, 1)
    assert.equal(parsed.number, 1)
    assert.equal(parsed.title, 'ភ្នំពិសិដ្ឋ')
    assert.ok(parsed.text.includes('កាលពីព្រេងនាយ'))
    assert.ok(parsed.text.includes('មនុស្សជំនាន់មុន'))
  })

  test('strips code fences from chapter translation', () => {
    const raw = '```markdown\n## Chapter 02: The Ancient Forest\n\nDeep in the jungle, tall trees stood like sentinels.\n```'
    const parsed = parseTranslatedChapter(raw, 2)
    assert.equal(parsed.number, 2)
    assert.equal(parsed.title, 'The Ancient Forest')
    assert.equal(parsed.text, 'Deep in the jungle, tall trees stood like sentinels.')
  })

  test('refuses empty chapter output', () => {
    assert.throws(
      () => parseTranslatedChapter('   ', 1),
      /Translated Chapter 1 output was empty/,
    )
  })

  test('refuses chapter with empty body text (§8)', () => {
    assert.throws(
      () => parseTranslatedChapter('## Chapter 01: Only Title\n\n   ', 1),
      /Translated Chapter 1 has empty body text/,
    )
  })

  test('parses valid introduction text', () => {
    const raw = '# Introduction\n\nWelcome to our journey through the ancient kingdom.'
    const parsed = parseTranslatedIntro(raw)
    assert.equal(parsed.text, 'Welcome to our journey through the ancient kingdom.')
  })

  test('refuses empty introduction output (§8)', () => {
    assert.throws(
      () => parseTranslatedIntro('# Introduction\n\n   '),
      /Translated Introduction has empty body text/,
    )
  })
})

describe('Verified completion contract (§8)', () => {
  test('rejects missing chapter file', async () => {
    const temp = await fs.mkdtemp(path.join(process.env.STORY_STUDIO_DATA_DIR!, 'verify-missing-'))
    await assert.rejects(
      verifyTranslatedCompletion(temp, 'EP0001', [1, 2], false),
      (err: any) => err.code === 'TRANSLATION_INCOMPLETE' && /Chapter 1 file is missing/.test(err.message),
    )
    await fs.rm(temp, { recursive: true, force: true })
  })

  test('rejects empty chapter file (0 bytes or whitespace only)', async () => {
    const temp = await fs.mkdtemp(path.join(process.env.STORY_STUDIO_DATA_DIR!, 'verify-empty-'))
    const ch1 = path.join(temp, 'EP0001_Chapter_01.md')
    const ch2 = path.join(temp, 'EP0001_Chapter_02.md')
    const narration = path.join(temp, 'EP0001_Script_Narration.md')
    await fs.writeFile(ch1, '## Chapter 01: Test\n\nContent here.')
    await fs.writeFile(ch2, '   \n\n  ') // whitespace only
    await fs.writeFile(narration, 'Narration content')

    await assert.rejects(
      verifyTranslatedCompletion(temp, 'EP0001', [1, 2], false),
      (err: any) => err.code === 'TRANSLATION_INCOMPLETE' && /Chapter 2 file contains only whitespace/.test(err.message),
    )
    await fs.rm(temp, { recursive: true, force: true })
  })
})

describe('End-to-end Translation Workflow (English ↔ Khmer)', () => {
  let enSlug: string
  let kmSlug: string
  const sourceEpisodeId = 'EP0001'

  before(async () => {
    // 1. Create English source project
    const enProj = await pm.createProject({
      name: 'English History Series',
      content_language: 'en',
      episode_prefix: 'EP',
      episode_digits: 4,
    })
    enSlug = enProj.slug

    // 2. Create Khmer target project
    const kmProj = await pm.createProject({
      name: 'Khmer History Channel',
      content_language: 'km',
      episode_prefix: 'KH',
      episode_digits: 4,
    })
    kmSlug = kmProj.slug

    // 3. Seed source episode in English channel
    const [sourceIdea] = await ideas.addIdeas(enSlug, [{
      title: 'The Great Temple of Angkor',
      logline: 'The architecture and spiritual life of ancient Khmer civilization.',
      themes: ['history', 'monuments'],
      suggested_chapters: 2,
      suggested_length: 'short',
      mood: 'inspiring',
    }], 'test-model')
    const accepted = await ideas.acceptIdea(enSlug, sourceIdea!.id, false, { override_code: sourceEpisodeId })
    assert.equal(accepted.episode_code, sourceEpisodeId)

    const sourcePaths = await resolveEpisodePathsByCode(enSlug, sourceEpisodeId)

    // Write source intro and chapters
    await writeChapterFiles(
      sourcePaths.script_dir,
      sourceEpisodeId,
      'The Great Temple of Angkor',
      {
        intro: { text: 'Welcome to Angkor, the jewel of the Khmer Empire.' },
        chapters: [
          { number: 1, title: 'Stone and Sky', text: 'In the twelfth century, King Suryavarman began building Angkor Wat.' },
          { number: 2, title: 'The Sacred Moat', text: 'Surrounding the temple is a massive reservoir reflecting the sunrise.' },
        ],
      },
      { normalizeSpokenProse: true },
    )
    await assembleUnifiedNarration(sourcePaths.script_dir, sourceEpisodeId, 'The Great Temple of Angkor')

    // Seed visual images and scene plan in source episode
    await fs.mkdir(sourcePaths.bg_dir, { recursive: true })
    await fs.mkdir(sourcePaths.thumb_dir, { recursive: true })
    await fs.writeFile(path.join(sourcePaths.bg_dir, 'scene_01.webp'), Buffer.from('fake-image-1'))
    await fs.writeFile(path.join(sourcePaths.thumb_dir, 'thumb_01.webp'), Buffer.from('fake-thumb-1'))

    const mockScenePlan: ScenePlan = {
      schema_version: 1,
      total_duration_sec: 10,
      research_used: false,
      generated_at: new Date().toISOString(),
      scenes: [
        {
          id: 'sc-1',
          scene_index: 1,
          start_sec: 0,
          end_sec: 10,
          transcript_segment: 'In the twelfth century, King Suryavarman began building Angkor Wat.',
          visual_prompt: 'Cinematic wide shot of sandstone towers rising through morning mist.',
          approved: true,
          image_path: path.join(sourcePaths.bg_dir, 'scene_01.webp'),
        },
      ],
    }
    await fs.mkdir(sourcePaths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(
      path.join(sourcePaths.scene_prompts_dir, SCENE_PLAN_SIDECAR),
      JSON.stringify(mockScenePlan, null, 2),
    )
  })

  test('refuses translation when model is missing (§1 live model)', async () => {
    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: '', // Empty model
      }),
      (err: any) => err.statusCode === 400 && /Writing model is required/.test(err.message),
    )
  })

  test('translates English episode into Khmer (complete outcome + visual reuse)', async () => {
    const mockCallAi = async (_model: string, system: string, user: string): Promise<string> => {
      if (user.includes('Source Introduction Text:')) {
        return '# Introduction\n\nសូមស្វាគមន៍មកកាន់អង្គរ ដែលជាត្បូងពេជ្រនៃចក្រភពខ្មែរ។'
      }
      if (user.includes('Chapter 01: Stone and Sky')) {
        return '## Chapter 01: ថ្មនិងមេឃ\n\nនៅសតវត្សរ៍ទីដប់ពីរ ព្រះបាទសូរ្យវរ្ម័នបានចាប់ផ្តើមកសាងប្រាសាទអង្គរវត្ត។'
      }
      if (user.includes('Chapter 02: The Sacred Moat')) {
        return '## Chapter 02: គូទឹកសក្ការៈ\n\nនៅជុំវិញប្រាសាទមានកសិន្ធុដ៏ធំល្វឹងល្វើយ ដែលជះស្រមោលព្រះអាទិត្យរះយ៉ាងស្រស់ស្អាត។'
      }
      throw new Error(`Unexpected user prompt: ${user}`)
    }

    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0001',
      callAi: mockCallAi,
    })

    assert.equal(result.targetSlug, kmSlug)
    assert.equal(result.targetEpisodeId, 'KH0001')
    assert.equal(result.sourceLanguage, 'en')
    assert.equal(result.targetLanguage, 'km')
    assert.deepEqual(result.translatedChapters, [1, 2])
    assert.equal(result.hasIntro, true)
    assert.equal(result.visualsReused, true)
    assert.equal(result.scenePlanReused, true)

    // Inspect files written to target episode on disk
    const targetPaths = await resolveEpisodePathsByCode(kmSlug, 'KH0001')
    const ch1 = resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_01')
    const ch2 = resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_02')
    const intro = resolveArtifact(targetPaths.script_dir, 'KH0001_Introduction')
    const narration = resolveReadPath(targetPaths.narration_docx)

    assert.ok(ch1 && (await fs.readFile(ch1, 'utf-8')).includes('ថ្មនិងមេឃ'))
    assert.ok(ch2 && (await fs.readFile(ch2, 'utf-8')).includes('គូទឹកសក្ការៈ'))
    assert.ok(intro && (await fs.readFile(intro, 'utf-8')).includes('សូមស្វាគមន៍មកកាន់អង្គរ'))
    assert.ok(narration && (await fs.stat(narration)).size > 0)

    // Check parsed narration sections
    const sections = await parseNarrationDocx(narration)
    assert.equal(sections.length, 3)
    assert.equal(sections[0]?.slug, 'Introduction')
    assert.ok(sections[1]?.title?.includes('ថ្មនិងមេឃ') || sections[1]?.label.includes('Chapter 01'))

    // Check copied visual stills
    assert.ok(await fs.stat(path.join(targetPaths.bg_dir, 'scene_01.webp')).then(() => true).catch(() => false))
    assert.ok(await fs.stat(path.join(targetPaths.thumb_dir, 'thumb_01.webp')).then(() => true).catch(() => false))

    // Check remapped scene plan
    const targetPlanPath = await resolveScenePlanPath(kmSlug, 'KH0001', targetPaths.episode_dir)
    assert.ok(await fs.stat(targetPlanPath).then(() => true).catch(() => false))
    const plan = JSON.parse(await fs.readFile(targetPlanPath, 'utf-8')) as ScenePlan
    assert.equal(plan.scenes.length, 1)
    assert.equal(plan.scenes[0]?.image_path, path.join(targetPaths.bg_dir, 'scene_01.webp'))
  })

  test('translates subset of chapters (partial outcome)', async () => {
    const mockCallAi = async (_model: string, _system: string, user: string): Promise<string> => {
      if (user.includes('Chapter 02')) {
        return '## Chapter 02: គូទឹកសក្ការៈ\n\nកសិន្ធុដ៏ធំល្វឹងល្វើយ។'
      }
      throw new Error(`Unexpected user prompt: ${user}`)
    }

    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0002',
      chapters: [2], // Translate only Chapter 2
      callAi: mockCallAi,
    })

    assert.equal(result.targetEpisodeId, 'KH0002')
    assert.deepEqual(result.translatedChapters, [2])
    assert.equal(result.hasIntro, false)

    const targetPaths = await resolveEpisodePathsByCode(kmSlug, 'KH0002')
    const ch2 = resolveArtifact(targetPaths.script_dir, 'KH0002_Chapter_02')
    assert.ok(ch2 && (await fs.readFile(ch2, 'utf-8')).includes('កសិន្ធុដ៏ធំល្វឹងល្វើយ'))
  })

  test('provider failure outcome fails loudly (§8)', async () => {
    const failingCallAi = async (): Promise<string> => {
      throw new Error('503 Service Unavailable: Gateway quota limit reached')
    }

    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0003',
        callAi: failingCallAi,
      }),
      (err: any) => err.code === 'TRANSLATION_PROVIDER_ERROR' && /503 Service Unavailable/.test(err.message),
    )
  })

  test('empty model output fails loudly (§8)', async () => {
    const emptyCallAi = async (): Promise<string> => {
      return ''
    }

    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0004',
        callAi: emptyCallAi,
      }),
      (err: any) => /Translated Introduction output was empty|output was empty/.test(err.message),
    )
  })

  test('translates Khmer episode back to English (km -> en)', async () => {
    const mockCallAi = async (_model: string, _system: string, user: string): Promise<string> => {
      if (user.includes('Chapter 01')) {
        return '## Chapter 01: Stone and Sky\n\nIn the twelfth century, King Suryavarman began building Angkor Wat.'
      }
      return '## Chapter 02: The Moat\n\nSurrounding the temple.'
    }

    const result = await translateEpisodeScript({
      sourceSlug: kmSlug,
      sourceEpisodeId: 'KH0001',
      targetSlug: enSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'EP0002',
      chapters: [1],
      callAi: mockCallAi,
    })

    assert.equal(result.sourceLanguage, 'km')
    assert.equal(result.targetLanguage, 'en')
    assert.deepEqual(result.translatedChapters, [1])

    const targetPaths = await resolveEpisodePathsByCode(enSlug, 'EP0002')
    const ch1 = resolveArtifact(targetPaths.script_dir, 'EP0002_Chapter_01')
    assert.ok(ch1 && (await fs.readFile(ch1, 'utf-8')).includes('King Suryavarman began building Angkor Wat'))
  })
})

describe('HTTP Route Integration (POST /api/projects/:slug/episodes/:episodeId/translate)', () => {
  let enSlug: string
  let kmSlug: string

  before(async () => {
    const enProj = await pm.createProject({
      name: 'HTTP Route Source EN',
      content_language: 'en',
      episode_prefix: 'EP',
      episode_digits: 4,
    })
    enSlug = enProj.slug

    const kmProj = await pm.createProject({
      name: 'HTTP Route Target KM',
      content_language: 'km',
      episode_prefix: 'KH',
      episode_digits: 4,
    })
    kmSlug = kmProj.slug

    const [idea] = await ideas.addIdeas(enSlug, [{
      title: 'HTTP Route Episode',
      logline: 'Testing HTTP route.',
      themes: [],
      suggested_chapters: 1,
      suggested_length: 'short',
      mood: 'neutral',
    }], 'test-model')
    await ideas.acceptIdea(enSlug, idea!.id, false, { override_code: 'EP0001' })

    const paths = await resolveEpisodePathsByCode(enSlug, 'EP0001')
    await writeChapterFiles(
      paths.script_dir,
      'EP0001',
      'HTTP Route Episode',
      {
        chapters: [{ number: 1, title: 'Chapter 01', text: 'Some text to translate.' }],
      },
    )
    await assembleUnifiedNarration(paths.script_dir, 'EP0001', 'HTTP Route Episode')
  })

  test('validates request body: rejects missing target_slug or model with 400', async () => {
    const res1 = await request(app)
      .post(`/api/projects/${enSlug}/episodes/EP0001/translate`)
      .send({ model: 'writing-v1' })
    assert.equal(res1.status, 400)

    const res2 = await request(app)
      .post(`/api/projects/${enSlug}/episodes/EP0001/translate`)
      .send({ target_slug: kmSlug })
    assert.equal(res2.status, 400)
  })

  test('returns 404 if source episode not found', async () => {
    const res = await request(app)
      .post(`/api/projects/${enSlug}/episodes/EP9999/translate`)
      .send({
        target_slug: kmSlug,
        model: 'writing-v1',
      })
    assert.equal(res.status, 404)
  })

  test('returns 400 if target and source channel have same language', async () => {
    const res = await request(app)
      .post(`/api/projects/${enSlug}/episodes/EP0001/translate`)
      .send({
        target_slug: enSlug,
        model: 'writing-v1',
      })
    assert.equal(res.status, 400)
    assert.ok(/Translation requires different languages/.test(res.body.detail || res.body.message))
  })
})
