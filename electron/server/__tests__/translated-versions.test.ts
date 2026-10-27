/**
 * Tests for Episode Translation (English ↔ Khmer) — the queued job.
 *
 * Verifies:
 * - AGENTS.md §1: the writing model is the caller's live selection; an empty
 *   one is refused and no model is ever picked here.
 * - AGENTS.md §4: the target is a distinct episode in the target channel,
 *   carrying its own provenance and reusing only visuals + scene plan.
 * - AGENTS.md §8: verified completion — done only when every chapter is
 *   translated and non-empty; complete, partial, empty and provider-failure.
 * - A Retry keeps what an earlier attempt finished and redoes only the rest.
 * - The episode title is translated by the same model, once.
 * - The downstream chain uses the target channel's presets, and leaves a step
 *   out with a plain message when it has no usable preset.
 * - HTTP route POST /api/projects/:slug/episodes/:episodeId/translate queues
 *   the `translate_episode` job.
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
  buildTitleTranslationPrompt,
  parseTranslatedChapter,
  parseTranslatedIntro,
  parseTranslatedTitle,
  verifyTranslatedCompletion,
  translateEpisodeScript,
  buildTranslateDownstreamChain,
  generateTranslateEpisode,
  resolveTranslationTarget,
  TRANSLATION_SIDECAR,
} from '../services/translation.js'
import * as pm from '../services/project-manager.js'
import * as ideas from '../services/idea-manager.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath, SCENE_PLAN_SIDECAR } from '../services/utils.js'
import { writeChapterFiles, assembleUnifiedNarration } from '../lib/narration-assembly.js'
import { resolveArtifact, resolveReadPath } from '../lib/episode-artifacts.js'
import { parseNarrationDocx } from '../lib/docx-parser.js'
import type { Job, ScenePlan } from '../models/types.js'

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

const KH_TITLE = 'ប្រាសាទអង្គរវត្តដ៏អស្ចារ្យ'
const KH_INTRO = 'សូមស្វាគមន៍មកកាន់អង្គរ ដែលជាត្បូងពេជ្រនៃចក្រភពខ្មែរ។'
const KH_CH1 = '## Chapter 01: ថ្មនិងមេឃ\n\nនៅសតវត្សរ៍ទីដប់ពីរ ព្រះបាទសូរ្យវរ្ម័នបានចាប់ផ្តើមកសាងប្រាសាទអង្គរវត្ត។'
const KH_CH2 = '## Chapter 02: គូទឹកសក្ការៈ\n\nនៅជុំវិញប្រាសាទមានកសិន្ធុដ៏ធំល្វឹងល្វើយ ដែលជះស្រមោលព្រះអាទិត្យរះយ៉ាងស្រស់ស្អាត។'

/**
 * The shape every translation prompt takes, answered with Khmer text. Counts
 * calls so the retry test can prove nothing was asked twice.
 */
function khmerCaller(overrides: Record<string, string> = {}) {
  const calls: string[] = []
  const callAi = async (_model: string, _system: string, user: string): Promise<string> => {
    calls.push(user)
    if (user.startsWith('Episode title:')) return overrides.title ?? KH_TITLE
    if (user.includes('Source Introduction Text:')) return overrides.intro ?? `# Introduction\n\n${KH_INTRO}`
    if (user.includes('Chapter 01')) return overrides.ch1 ?? KH_CH1
    if (user.includes('Chapter 02')) return overrides.ch2 ?? KH_CH2
    throw new Error(`Unexpected translation prompt: ${user}`)
  }
  return { callAi, callsCount: () => calls.length }
}

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
    assert.throws(() => resolveTranslationLanguages('fr', 'km'), (err: any) => err.statusCode === 400)
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
  })

  test('builds the title prompt and parses a clean one-line answer', () => {
    const prompt = buildTitleTranslationPrompt('en', 'km', 'The Great Temple of Angkor')
    assert.ok(prompt.system.includes('Khmer'))
    assert.ok(prompt.user.includes('Episode title: The Great Temple of Angkor'))
    assert.equal(parseTranslatedTitle(`"${KH_TITLE}"\n`), KH_TITLE)
    assert.equal(parseTranslatedTitle(`Title: ${KH_TITLE}`), KH_TITLE)
    assert.throws(() => parseTranslatedTitle('   '), /Translated title output was empty/)
  })
})

describe('Response parser (§8 verified completion)', () => {
  test('parses valid markdown chapter into number, title, and body text', () => {
    const parsed = parseTranslatedChapter(KH_CH1, 1)
    assert.equal(parsed.number, 1)
    assert.equal(parsed.title, 'ថ្មនិងមេឃ')
    assert.ok(parsed.text.includes('ព្រះបាទសូរ្យវរ្ម័ន'))
  })

  test('strips code fences from chapter translation', () => {
    const raw = '```markdown\n## Chapter 02: The Ancient Forest\n\nDeep in the jungle, tall trees stood like sentinels.\n```'
    const parsed = parseTranslatedChapter(raw, 2)
    assert.equal(parsed.number, 2)
    assert.equal(parsed.title, 'The Ancient Forest')
    assert.equal(parsed.text, 'Deep in the jungle, tall trees stood like sentinels.')
  })

  test('refuses empty chapter output', () => {
    assert.throws(() => parseTranslatedChapter('   ', 1), /Translated Chapter 1 output was empty/)
  })

  test('refuses chapter with empty body text (§8)', () => {
    assert.throws(
      () => parseTranslatedChapter('## Chapter 01: Only Title\n\n   ', 1),
      /Translated Chapter 1 has empty body text/,
    )
  })

  test('parses valid introduction text and refuses an empty one (§8)', () => {
    const parsed = parseTranslatedIntro('# Introduction\n\nWelcome to our journey through the ancient kingdom.')
    assert.equal(parsed.text, 'Welcome to our journey through the ancient kingdom.')
    assert.throws(() => parseTranslatedIntro('# Introduction\n\n   '), /Translated Introduction has empty body text/)
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
    await fs.writeFile(path.join(temp, 'EP0001_Chapter_01.md'), '## Chapter 01: Test\n\nContent here.')
    await fs.writeFile(path.join(temp, 'EP0001_Chapter_02.md'), '   \n\n  ')
    await fs.writeFile(path.join(temp, 'EP0001_Script_Narration.md'), 'Narration content')
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
    const enProj = await pm.createProject({
      name: 'English History Series',
      content_language: 'en',
      episode_prefix: 'EP',
      episode_digits: 4,
    })
    enSlug = enProj.slug

    const kmProj = await pm.createProject({
      name: 'Khmer History Channel',
      content_language: 'km',
      episode_prefix: 'KH',
      episode_digits: 4,
    })
    kmSlug = kmProj.slug

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

    await fs.mkdir(sourcePaths.bg_dir, { recursive: true })
    await fs.mkdir(sourcePaths.thumb_dir, { recursive: true })
    await fs.writeFile(path.join(sourcePaths.bg_dir, 'scene_01.webp'), Buffer.from('fake-image-1'))
    await fs.writeFile(path.join(sourcePaths.thumb_dir, 'thumb_01.webp'), Buffer.from('fake-thumb-1'))

    const mockScenePlan: ScenePlan = {
      schema_version: 1,
      total_duration_sec: 10,
      research_used: false,
      generated_at: new Date().toISOString(),
      scenes: [{
        id: 'sc-1',
        scene_index: 1,
        start_sec: 0,
        end_sec: 10,
        transcript_segment: 'In the twelfth century, King Suryavarman began building Angkor Wat.',
        visual_prompt: 'Cinematic wide shot of sandstone towers rising through morning mist.',
        approved: true,
        image_path: path.join(sourcePaths.bg_dir, 'scene_01.webp'),
      }],
    }
    await fs.mkdir(sourcePaths.scene_prompts_dir, { recursive: true })
    await fs.writeFile(path.join(sourcePaths.scene_prompts_dir, SCENE_PLAN_SIDECAR), JSON.stringify(mockScenePlan, null, 2))
  })

  test('refuses translation when model is missing (§1 live model)', async () => {
    await assert.rejects(
      translateEpisodeScript({ sourceSlug: enSlug, sourceEpisodeId, targetSlug: kmSlug, model: '' }),
      (err: any) => err.statusCode === 400 && /Writing model is required/.test(err.message),
    )
  })

  test('translates English episode into Khmer (complete outcome, title, visual reuse)', async () => {
    const { callAi } = khmerCaller()
    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0001',
      callAi,
    })

    assert.equal(result.targetEpisodeId, 'KH0001')
    assert.equal(result.sourceLanguage, 'en')
    assert.equal(result.targetLanguage, 'km')
    assert.deepEqual(result.translatedChapters, [1, 2])
    assert.deepEqual(result.reusedChapters, [])
    assert.equal(result.hasIntro, true)
    assert.equal(result.titleTranslated, true)
    assert.equal(result.targetTitle, KH_TITLE)
    assert.equal(result.visualsReused, true)
    assert.equal(result.scenePlanReused, true)

    // The episode record AND its folder carry the translated title.
    const idea = (await ideas.getIdeas(kmSlug)).find(i => i.episode_code === 'KH0001')
    assert.equal(idea?.title, KH_TITLE)

    const targetPaths = await resolveEpisodePathsByCode(kmSlug, 'KH0001')
    assert.ok(targetPaths.episode_dir.includes(KH_TITLE), targetPaths.episode_dir)

    const ch1 = resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_01')
    const ch2 = resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_02')
    const intro = resolveArtifact(targetPaths.script_dir, 'KH0001_Introduction')
    const narration = resolveReadPath(targetPaths.narration_docx)
    assert.ok(ch1 && (await fs.readFile(ch1, 'utf-8')).includes('ថ្មនិងមេឃ'))
    assert.ok(ch2 && (await fs.readFile(ch2, 'utf-8')).includes('គូទឹកសក្ការៈ'))
    assert.ok(intro && (await fs.readFile(intro, 'utf-8')).includes('សូមស្វាគមន៍មកកាន់អង្គរ'))
    assert.ok(narration && (await fs.stat(narration)).size > 0)

    const sections = await parseNarrationDocx(narration)
    assert.equal(sections.length, 3)
    assert.equal(sections[0]?.slug, 'Introduction')

    assert.ok(await fs.stat(path.join(targetPaths.bg_dir, 'scene_01.webp')).then(() => true).catch(() => false))
    assert.ok(await fs.stat(path.join(targetPaths.thumb_dir, 'thumb_01.webp')).then(() => true).catch(() => false))

    // Scene plan copied, image path remapped into THIS episode's folder.
    const targetPlanPath = await resolveScenePlanPath(kmSlug, 'KH0001', targetPaths.episode_dir)
    const plan = JSON.parse(await fs.readFile(targetPlanPath, 'utf-8')) as ScenePlan
    assert.equal(plan.scenes[0]?.image_path, path.join(targetPaths.bg_dir, 'scene_01.webp'))

    // Provenance sidecar.
    const sidecar = JSON.parse(await fs.readFile(path.join(targetPaths.episode_dir, TRANSLATION_SIDECAR), 'utf-8'))
    assert.equal(sidecar.source_slug, enSlug)
    assert.equal(sidecar.source_episode_id, sourceEpisodeId)
    assert.equal(sidecar.title_translated, true)
  })

  test('a Retry keeps what was already translated and asks the model for nothing', async () => {
    const { callAi, callsCount } = khmerCaller()
    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0001',
      callAi,
    })
    assert.equal(callsCount(), 0, 'nothing on disk should be translated again')
    assert.deepEqual(result.translatedChapters, [])
    assert.deepEqual(result.reusedChapters, [1, 2])
    assert.equal(result.hasIntro, true)
    assert.equal(result.titleTranslated, true)
  })

  test('a Retry redoes only the missing chapter', async () => {
    // Remove chapter 2, as a failed attempt would leave it.
    const targetPaths = await resolveEpisodePathsByCode(kmSlug, 'KH0001')
    const ch2 = resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_02')!
    await fs.rm(ch2, { force: true })

    const { callAi, callsCount } = khmerCaller()
    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0001',
      callAi,
    })
    assert.equal(callsCount(), 1, 'only the missing chapter is asked for')
    assert.deepEqual(result.translatedChapters, [2])
    assert.deepEqual(result.reusedChapters, [1])
    assert.ok(resolveArtifact(targetPaths.script_dir, 'KH0001_Chapter_02'))
  })

  test('translates subset of chapters (partial outcome)', async () => {
    const { callAi } = khmerCaller()
    const result = await translateEpisodeScript({
      sourceSlug: enSlug,
      sourceEpisodeId,
      targetSlug: kmSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'KH0002',
      chapters: [2],
      callAi,
    })
    assert.equal(result.targetEpisodeId, 'KH0002')
    assert.deepEqual(result.translatedChapters, [2])
    assert.equal(result.hasIntro, false)

    const targetPaths = await resolveEpisodePathsByCode(kmSlug, 'KH0002')
    const ch2 = resolveArtifact(targetPaths.script_dir, 'KH0002_Chapter_02')
    assert.ok(ch2 && (await fs.readFile(ch2, 'utf-8')).includes('កសិន្ធុដ៏ធំល្វឹងល្វើយ'))
  })

  test('provider failure outcome fails loudly (§8)', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('503 Service Unavailable: Gateway quota limit reached')
    }
    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0003',
        callAi: failing,
      }),
      (err: any) => err.code === 'TRANSLATION_PROVIDER_ERROR' && /503 Service Unavailable/.test(err.message),
    )
  })

  test('empty model output fails loudly (§8)', async () => {
    const empty = async (): Promise<string> => ''
    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0004',
        callAi: empty,
      }),
      (err: any) => /Translated title output was empty|output was empty/.test(err.message),
    )
  })

  test('a requested chapter the source does not have is named, not skipped', async () => {
    const shouldNotRun = async (): Promise<string> => {
      throw new Error('the model must not be called for a missing chapter')
    }
    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId,
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0005',
        chapters: [1, 9],
        callAi: shouldNotRun,
      }),
      (err: any) => err.statusCode === 400 && /has no Chapter 9 to translate/.test(err.message),
    )
  })

  test('translates Khmer episode back to English (km -> en)', async () => {
    const englishCaller = async (_model: string, _system: string, user: string): Promise<string> => {
      if (user.startsWith('Episode title:')) return 'The Great Temple of Angkor'
      if (user.includes('Chapter 01')) return '## Chapter 01: Stone and Sky\n\nIn the twelfth century, King Suryavarman began building Angkor Wat.'
      throw new Error(`Unexpected translation prompt: ${user}`)
    }
    const result = await translateEpisodeScript({
      sourceSlug: kmSlug,
      sourceEpisodeId: 'KH0001',
      targetSlug: enSlug,
      model: 'mock-writing-v1',
      targetEpisodeId: 'EP0002',
      chapters: [1],
      callAi: englishCaller,
    })
    assert.equal(result.sourceLanguage, 'km')
    assert.equal(result.targetLanguage, 'en')
    assert.deepEqual(result.translatedChapters, [1])

    const targetPaths = await resolveEpisodePathsByCode(enSlug, 'EP0002')
    const ch1 = resolveArtifact(targetPaths.script_dir, 'EP0002_Chapter_01')
    assert.ok(ch1 && (await fs.readFile(ch1, 'utf-8')).includes('King Suryavarman began building Angkor Wat'))
  })

  test('a source episode with no script at all is refused, not treated as empty translation', async () => {
    const [blankIdea] = await ideas.addIdeas(enSlug, [{
      title: 'Blank Source Episode',
      logline: 'Accepted but never written.',
      themes: [],
      suggested_chapters: 1,
      suggested_length: 'short',
      mood: 'neutral',
    }], 'test-model')
    const accepted = await ideas.acceptIdea(enSlug, blankIdea!.id, false, { override_code: 'EP0009' })
    assert.equal(accepted.episode_code, 'EP0009')

    const shouldNotRun = async (): Promise<string> => {
      throw new Error('the model must not be called for an empty source')
    }
    await assert.rejects(
      translateEpisodeScript({
        sourceSlug: enSlug,
        sourceEpisodeId: 'EP0009',
        targetSlug: kmSlug,
        model: 'mock-writing-v1',
        targetEpisodeId: 'KH0006',
        callAi: shouldNotRun,
      }),
      (err: any) => err.statusCode === 400 && /has no script chapters to translate/.test(err.message),
    )
  })
})

describe('Downstream chain (target channel presets)', () => {
  const preset = (list: string, active: string, data: Record<string, unknown>) =>
    ({ [list]: [{ id: `${list}-1`, name: 'P', data }], [active]: `${list}-1` })

  async function channelWith(name: string, config: Record<string, unknown> = {}) {
    const project = await pm.createProject({ name, content_language: 'km', episode_prefix: 'KH', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'Chain target', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'test-model')
    const accepted = await ideas.acceptIdea(project.slug, idea!.id, false)
    await pm.updateConfig(project.slug, config as any)
    return { slug: project.slug, episodeId: accepted.episode_code }
  }

  const ALL_PRESETS = {
    ...preset('audio_generator_presets', 'audio_generator_last_preset', { form: { voice: 'voice-kh-1' } }),
    ...preset('audio_merge_presets', 'audio_merge_last_preset', { gap_duration: 1 }),
    ...preset('subtitles_generator_presets', 'subtitles_generator_last_preset', {}),
    ...preset('video_bundle_presets', 'video_bundle_last_preset', {}),
    ...preset('metadata_presets', 'metadata_last_preset', { model: 'writing-v1' }),
  }

  test('uses the target channel presets, in order, with Khmer script timing', async () => {
    const { slug, episodeId } = await channelWith('Chain full', ALL_PRESETS)
    const { chain, leftOut } = await buildTranslateDownstreamChain(slug, episodeId, 'Title', 'km')
    assert.deepEqual(chain.map(l => l.type), ['audio', 'audio_merge', 'subtitles_transcribe', 'video_assembly', 'metadata'])
    assert.deepEqual(leftOut, [])
    assert.equal(chain[2]!.params.method, 'script')
    assert.equal(chain[4]!.params.model, 'writing-v1')
    assert.equal(chain[0]!.params.pipeline_step, 'audio')
  })

  test('leaves each step out with a plain message when the channel has no usable preset', async () => {
    const { slug, episodeId } = await channelWith('Chain empty')
    const { chain, leftOut } = await buildTranslateDownstreamChain(slug, episodeId, 'Title', 'km')
    assert.deepEqual(chain, [])
    assert.equal(leftOut.length, 5)
    assert.ok(leftOut.some(l => /^Audio: .*[Nn]o active preset/.test(l)), leftOut.join('\n'))
    assert.ok(leftOut.some(l => /YouTube Finalizer/.test(l)), leftOut.join('\n'))
    assert.ok(leftOut.every(l => !/_\w/.test(l)), 'no internal slugs in the message')
  })

  test('an audio preset with no voice is left out, not silently voiced by us', async () => {
    const { slug, episodeId } = await channelWith('Chain no voice', {
      ...preset('audio_generator_presets', 'audio_generator_last_preset', { form: { voice: '' } }),
      ...preset('audio_merge_presets', 'audio_merge_last_preset', {}),
    })
    const { chain, leftOut } = await buildTranslateDownstreamChain(slug, episodeId, 'Title', 'km')
    assert.deepEqual(chain.map(l => l.type), ['audio_merge'])
    assert.ok(leftOut.some(l => /Audio: the preset has no voice selected/.test(l)), leftOut.join('\n'))
  })

  test('a metadata preset with no writing model is left out with the picker instruction', async () => {
    const { slug, episodeId } = await channelWith('Chain no model', {
      ...preset('metadata_presets', 'metadata_last_preset', { sections: [] }),
    })
    const { chain, leftOut } = await buildTranslateDownstreamChain(slug, episodeId, 'Title', 'km')
    assert.deepEqual(chain, [])
    assert.ok(leftOut.some(l => /YouTube Finalizer: the preset has no writing model saved/.test(l)), leftOut.join('\n'))
  })
})

describe('The translate_episode job', () => {
  test('translates, verifies, and hands the target channel its continued Pipeline', async () => {
    const en = await pm.createProject({ name: 'Job source EN', content_language: 'en', episode_prefix: 'EP', episode_digits: 4 })
    const km = await pm.createProject({ name: 'Job target KM', content_language: 'km', episode_prefix: 'KH', episode_digits: 4 })
    await pm.updateConfig(km.slug, {
      audio_generator_presets: [{ id: 'a1', name: 'A', data: { form: { voice: 'voice-kh-1' } } }],
      audio_generator_last_preset: 'a1',
    } as any)

    const [sourceIdea] = await ideas.addIdeas(en.slug, [{
      title: 'Job Source Episode', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'test-model')
    const accepted = await ideas.acceptIdea(en.slug, sourceIdea!.id, false, { override_code: 'EP0001' })
    const enPaths = await resolveEpisodePathsByCode(en.slug, 'EP0001')
    await writeChapterFiles(enPaths.script_dir, 'EP0001', 'Job Source Episode', {
      chapters: [{ number: 1, title: 'One', text: 'A short chapter to translate.' }],
    }, { normalizeSpokenProse: true })
    assert.equal(accepted.episode_code, 'EP0001')

    const target = await resolveTranslationTarget({
      sourceSlug: en.slug, sourceEpisodeId: 'EP0001', targetSlug: km.slug, model: 'mock-writing-v1',
    }, 'Job Source Episode')

    const caller = async (_model: string, _system: string, user: string): Promise<string> => {
      if (user.startsWith('Episode title:')) return 'ចំណងជើងថ្មី'
      if (user.includes('Chapter 01')) return '## Chapter 01: មួយ\n\nជំពូកខ្លីមួយដើម្បីបកប្រែ។'
      throw new Error(`Unexpected prompt: ${user}`)
    }

    const job = {
      job_id: 'job-translate-1',
      project_slug: km.slug,
      episode_id: target.code,
      type: 'translate_episode',
      status: 'running',
      title: 'Translate',
      params: {
        source_slug: en.slug,
        source_episode_id: 'EP0001',
        model: 'mock-writing-v1',
      },
      output_lines: [],
      created_at: new Date().toISOString(),
    } as unknown as Job

    await generateTranslateEpisode(job, { callAi: caller })

    const result = job.result as any
    assert.equal(result.targetEpisodeId, target.code)
    assert.deepEqual(result.translatedChapters, [1])
    assert.equal(job.progress, 100)
    const chain = (job.params as any).pipeline_chain as Array<{ type: string }>
    assert.deepEqual(chain.map(l => l.type), ['audio'], 'only the channel preset the test gave it')
    assert.ok(job.output_lines.some(line => /Left out — Audio Assembly/.test(line)), job.output_lines.join('\n'))
    assert.ok(job.output_lines.some(line => /Continuing in/.test(line)))
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
    await writeChapterFiles(paths.script_dir, 'EP0001', 'HTTP Route Episode', {
      chapters: [{ number: 1, title: 'Chapter 01', text: 'Some text to translate.' }],
    })
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
      .send({ target_slug: kmSlug, model: 'writing-v1' })
    assert.equal(res.status, 404)
  })

  test('returns 400 if target and source channel have same language', async () => {
    const res = await request(app)
      .post(`/api/projects/${enSlug}/episodes/EP0001/translate`)
      .send({ target_slug: enSlug, model: 'writing-v1' })
    assert.equal(res.status, 400)
    assert.ok(/Translation requires different languages/.test(res.body.detail || res.body.message))
  })

  test('queues the translate_episode job instead of running it inside the request', async () => {
    // Dynamic import: job-queue resolves its projects root at module load, so
    // it must not be imported before useTempDataDir() has claimed a data dir.
    const jq = await import('../services/job-queue.js')
    // The queue would otherwise pick the job up and call the Gateway for real.
    const restore = jq._setExecutorForTesting('translate_episode', async () => {})
    try {
      const res = await request(app)
        .post(`/api/projects/${enSlug}/episodes/EP0001/translate`)
        .send({ target_slug: kmSlug, model: 'writing-v1', target_episode_id: 'KH0001' })
      assert.equal(res.status, 202, JSON.stringify(res.body))
      assert.equal(res.body.target_episode_id, 'KH0001')
      assert.equal(res.body.job.type, 'translate_episode')
      assert.equal(res.body.job.project_slug, kmSlug, 'the job lives in the TARGET channel so its chain runs there')
      assert.equal(res.body.job.episode_id, 'KH0001')
      assert.equal(res.body.job.params.source_slug, enSlug)
      // The row exists in the target channel's queue, owned by this episode.
      assert.equal(jq.getJob(res.body.job.job_id)?.type, 'translate_episode')
    } finally {
      restore()
    }
  })
})
