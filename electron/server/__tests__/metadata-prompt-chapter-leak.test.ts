/**
 * Metadata prompt — chapter heading leak prevention.
 *
 * User-reported defect: generated YouTube descriptions contained
 * "Chapters: 00:00 Chapter 01…" and "Chapter 01: The Mud Brick Walls
 * of Uruk" above the real finalizer CHAPTERS timeline, plus narrated
 * excerpts passed off as marketing copy. The unified narration file
 * carries `## Chapter NN: Title` headings as structural markers for
 * audio assembly — they are not viewer-facing content and must never
 * reach the description as chapter markers.
 *
 * Two-layer fix:
 *   1. `stripChapterHeadingsFromContext` removes the structural
 *      "Chapter NN:" prefix at the input boundary, keeping the
 *      semantic title so the model can reference topic names.
 *   2. The prompt carries a SUMMARY DIRECTIVE instructing the model
 *      to summarize/rephrase rather than copy, and forbidding a
 *      second timeline.
 *
 * A third layer: the description the model RETURNS is repaired before the
 * finalizer sees it. `repairGeneratedDescription` removes a chapter list the
 * model wrote itself, and the sentences that match the narration exactly.
 * The finalizer's managed block is never touched, and the operator's edited
 * copy never reaches this repair.
 *
 * A fourth layer: a description the repair empties is refused by the
 * generator before the finalizer runs, so the finalizer's own timeline can
 * never fill an empty description and leave the package looking complete.
 *
 * A fifth layer: the refused answer is recorded as a refused answer, so a
 * Retry asks the Gateway again instead of being handed the same text — the
 * legacy Pipeline policy path included, whose checkpoint would otherwise
 * reconnect the retry to the request that produced it.
 *
 * These tests pin all five layers.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildDescriptionPrompt,
  repairGeneratedDescription,
  stripChapterHeadingsFromContext,
} from '../lib/metadata-prompt.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

// ── stripChapterHeadingsFromContext ──────────────────────────────────────────

describe('stripChapterHeadingsFromContext — input boundary', () => {
  test('strips Chapter NN: prefix but preserves semantic title', () => {
    const input = [
      'The story begins at dawn.',
      '',
      '## Chapter 01: The Mud Brick Walls of Uruk',
      '',
      'In the ancient city, a potter shapes clay beneath the rising sun.',
      'The walls of Uruk have stood for three thousand years.',
      '',
      '## Chapter 02: The River Merchants',
      '',
      'Boats carry grain downstream while scribes tally their cargo.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    // Structural prefix removed
    assert.doesNotMatch(result, /## Chapter 01/)
    assert.doesNotMatch(result, /## Chapter 02/)
    // Semantic titles preserved as plain text
    assert.match(result, /The Mud Brick Walls of Uruk/)
    assert.match(result, /The River Merchants/)
    // Prose intact
    assert.match(result, /potter shapes clay/)
    assert.match(result, /Boats carry grain/)
    assert.match(result, /story begins at dawn/)
  })

  test('strips prefix with em-dash and en-dash separators', () => {
    const input = [
      '## Chapter 1 — The First Dawn',
      'Paragraph of narration here.',
      '## Chapter 2 – The Second Day',
      'More narration.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    assert.doesNotMatch(result, /## Chapter 1/)
    assert.doesNotMatch(result, /## Chapter 2/)
    assert.match(result, /The First Dawn/)
    assert.match(result, /The Second Day/)
    assert.match(result, /Paragraph of narration/)
    assert.match(result, /More narration/)
  })

  test('strips prefix from heading with no title after number', () => {
    const input = [
      '## Chapter 3',
      'The third chapter body text remains intact.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    assert.doesNotMatch(result, /## Chapter 3/)
    assert.match(result, /third chapter body text/)
  })

  test('strips prefix at h1 through h6 markdown levels', () => {
    const input = [
      '# Chapter 1: First',
      'Body A.',
      '## Chapter 2: Second',
      'Body B.',
      '### Chapter 3: Third',
      'Body C.',
      '#### Chapter 4: Fourth',
      'Body D.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    assert.doesNotMatch(result, /# Chapter 1/)
    assert.doesNotMatch(result, /## Chapter 2/)
    assert.doesNotMatch(result, /### Chapter 3/)
    assert.doesNotMatch(result, /#### Chapter 4/)
    // Titles preserved
    assert.match(result, /^First$/m)
    assert.match(result, /^Second$/m)
    assert.match(result, /^Third$/m)
    assert.match(result, /^Fourth$/m)
    // Body text intact
    assert.match(result, /Body A/)
    assert.match(result, /Body B/)
    assert.match(result, /Body C/)
    assert.match(result, /Body D/)
  })

  test('preserves educational headings (Topic, Section, Part) — only Chapter/ជំពូក stripped', () => {
    const input = [
      '## Topic 1: Ancient Mathematics',
      'The Babylonians developed a base-60 number system.',
      '## Section 2: The Golden Ratio',
      'Fibonacci sequences appear throughout nature.',
      '## Part 3: Modern Applications',
      'Cryptography relies on prime numbers.',
      '## Chapter 4: Summary',
      'Understanding history helps predict the future.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    // Educational headings intact
    assert.match(result, /## Topic 1: Ancient Mathematics/)
    assert.match(result, /## Section 2: The Golden Ratio/)
    assert.match(result, /## Part 3: Modern Applications/)
    // Chapter heading stripped, title kept
    assert.doesNotMatch(result, /## Chapter 4/)
    assert.match(result, /Summary/)
  })

  test('preserves Khmer chapter headings (ជំពូក) stripping structural prefix', () => {
    const input = [
      '## ជំពូក ១ — ការចាប់ផ្តើម',
      'រឿងរ៉ាវចាប់ផ្តើមនៅពេលព្រឹក។',
      '## ជំពូក ២: ដំណើរផ្សងព្រេង',
      'ពួកគេធ្វើដំណើរទៅកាន់ភ្នំ។',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    assert.doesNotMatch(result, /## ជំពូក/)
    assert.match(result, /ការចាប់ផ្តើម/)
    assert.match(result, /ដំណើរផ្សងព្រេង/)
    assert.match(result, /រឿងរ៉ាវចាប់ផ្តើម/)
  })

  test('preserves prose that mentions "chapter" mid-sentence', () => {
    const input = [
      '## Chapter 01: The Beginning',
      'This chapter of history changed the world forever.',
      'The Chapter 100 year war lasted decades.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    // Heading prefix stripped, title kept
    assert.doesNotMatch(result, /## Chapter 01/)
    assert.match(result, /The Beginning/)
    // Prose with "chapter" mid-sentence untouched
    assert.match(result, /This chapter of history/)
    assert.match(result, /The Chapter 100 year war/)
  })

  test('preserves empty input unchanged', () => {
    assert.equal(stripChapterHeadingsFromContext(''), '')
  })

  test('preserves text that contains no chapter headings', () => {
    const input = 'A story about ancient Mesopotamia, where scribes recorded the harvest.'
    const result = stripChapterHeadingsFromContext(input)
    assert.equal(result, input)
  })

  test('preserves narration prose containing timestamps', () => {
    // A narration paragraph that mentions a time of day is kept —
    // only the structural heading prefix is removed.
    const input = [
      '## Chapter 01: The Midnight Watch',
      'At 03:00 the guard changed shift and the temple fell silent.',
    ].join('\n')

    const result = stripChapterHeadingsFromContext(input)

    assert.doesNotMatch(result, /## Chapter 01/)
    assert.match(result, /The Midnight Watch/)
    assert.match(result, /03:00 the guard changed/)
  })
})

// ── buildDescriptionPrompt SUMMARY DIRECTIVE contract ────────────────────────

describe('buildDescriptionPrompt — SUMMARY DIRECTIVE contract', () => {
  const minSections = [
    { id: 'hook', label: 'Hook / Intro Paragraph', enabled: true, config: { characters: 220 } },
  ]

  test('prompt contains SUMMARY DIRECTIVE requiring rephrasing, forbidding chapter markers and second timeline', () => {
    const prompt = buildDescriptionPrompt('EP0001', 'Test Episode', 'some story context', minSections, 5000)

    // The directive block exists
    assert.match(prompt, /SUMMARY DIRECTIVE:/)

    // Key contract elements present
    assert.match(prompt, /Summarize or rephrase/)
    assert.match(prompt, /do not copy narrated passages verbatim/)
    assert.match(prompt, /Do not include chapter headings, chapter numbers, timestamps, or a chapter list/)
    assert.match(prompt, /finalizer owns the only chapter timeline/)
    assert.match(prompt, /no second timeline may appear/)

    assert.match(prompt, /Shorten the prose to fit; the real chapter timeline is added separately\./)
    assert.doesNotMatch(prompt, /Keep every chapter mark/)
  })
})

// ── repairGeneratedDescription — output repair ─────────────────────────────
//
// The repair removes a chapter list the model wrote itself, and the sentences
// that match the narration exactly. These tests pin the narrowness as much as
// the repair: prose that mentions a chapter or a time of day, a rewritten
// passage, the finalizer's managed block and the operator's own words all
// survive.

const NARRATION = [
  '## Chapter 01: The Mud Brick Walls of Uruk',
  '',
  'The first walls of Uruk rose from river mud, laid by hands that knew the flood would come.',
  'Scribes counted the reeds while the river rose higher against the gate.',
  '',
  '## Chapter 02: The River Merchants',
  '',
  'Boats carried grain downstream while the scribes tallied every basket that arrived.',
].join('\n')

describe('repairGeneratedDescription — the model\'s own chapter list', () => {
  test('removes a chapter list the model wrote beside the real timeline', () => {
    // The owner's EP0008 shape: a "Chapters:" block above the finalizer's own
    // timeline.
    const description = [
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
      '',
      'Chapters:',
      "00:00 Chapter 01: Introduction to the K'iche' Tradition",
      '00:45 Chapter 02: The Popol Vuh',
      '',
      'AI DISCLOSURE',
      'Created with the help of AI tools and reviewed before publishing.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, true)
    assert.doesNotMatch(result.description, /Chapters:/i)
    assert.doesNotMatch(result.description, /00:00/)
    assert.doesNotMatch(result.description, /K'iche/)
    // The rest of the description is untouched.
    assert.match(result.description, /Tonight we walk the walls of Uruk/)
    assert.match(result.description, /AI DISCLOSURE/)
  })

  test('keeps a bare run of timestamped lines with no chapter evidence', () => {
    // A timestamp alone is not evidence of a chapter list: "0:00 Opening" and
    // "03:00 the guard changed shift" look the same from here, and prose has
    // to survive. Only a label, or the word "chapter", turns a timestamp into
    // an entry — so a list the model wrote with neither stays where it is.
    const description = [
      'A short introduction to the tradition.',
      '0:00 Opening',
      '0:07 Introduction',
      '1:02 The deeper story',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.description, description)
  })

  test('removes a lone timestamped chapter entry with no label above it', () => {
    // A timestamp on a line that names a chapter is a chapter entry whatever
    // else surrounds it, so it does not need a label or a second line to
    // confirm it.
    const description = [
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
      '',
      "00:00 Chapter 01: Introduction to the K'iche' Tradition",
      '',
      'Subscribe for more stories like this one.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, true)
    assert.doesNotMatch(result.description, /00:00/)
    assert.match(result.description, /Subscribe for more stories like this one\./)
  })

  test('removes a chapter heading and the narration sentence under it', () => {
    // The owner's EP0009 shape: a chapter heading, then a narration sentence
    // that matches the context the model was given.
    const description = [
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
      '',
      'Chapter 01: The Mud Brick Walls of Uruk',
      '',
      'The first walls of Uruk rose from river mud, laid by hands that knew the flood would come.',
      '',
      'Subscribe for more stories like this one.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, true)
    assert.equal(result.removed_copied_sentences, 1)
    assert.doesNotMatch(result.description, /Chapter 01/)
    assert.doesNotMatch(result.description, /first walls of Uruk rose from river mud/)
    // The summary and the CTA are still there.
    assert.match(result.description, /Tonight we walk the walls of Uruk/)
    assert.match(result.description, /Subscribe for more stories like this one\./)
  })

  test('removes a Khmer chapter heading and a Khmer sentence matching the narration', () => {
    const narration = [
      '## ជំពូក ១ — ការចាប់ផ្តើម',
      '',
      'នៅពេលព្រឹក សិត្សនៃក្រុងអំបាងបានដាក់ប្រាក់លុយលើកំពុងធំមួយ ដោយសន្និដ្ឋានព្រួយពាណិជ្ជក្សរដ៏ធំមួយ។',
    ].join('\n')
    const description = [
      'សូមស្វាគមន៍នៅត្រាការចាប់ផ្តើមរបស់ក្រុងអំបាង។',
      '',
      'ជំពូក ១ — ការចាប់ផ្តើម',
      'នៅពេលព្រឹក សិត្សនៃក្រុងអំបាងបានដាក់ប្រាក់លុយលើកំពុងធំមួយ ដោយសន្និដ្ឋានព្រួយពាណិជ្ជក្សរដ៏ធំមួយ។',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: narration })

    assert.equal(result.removed_chapter_list, true)
    assert.equal(result.removed_copied_sentences, 1)
    assert.doesNotMatch(result.description, /ជំពូក ១/)
    assert.match(result.description, /សូមស្វាគមន៍នៅត្រាការចាប់ផ្តើមរបស់ក្រុងអំបាង។/)
  })
})

describe('repairGeneratedDescription — what it must NOT touch', () => {
  test('leaves a clean description exactly as it is', () => {
    const description = [
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
      '',
      'Subscribe for more stories like this one.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.description, description)
    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.removed_copied_sentences, 0)
  })

  test('keeps prose that merely mentions a chapter or a time of day', () => {
    const description = [
      'The Chapter 100 year war lasted decades, and this episode follows the river trade that followed it.',
      '',
      'Chapter 3 of the book covers the flood itself.',
      '',
      '03:00 the guard changed shift and the temple fell silent.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.removed_copied_sentences, 0)
    assert.match(result.description, /Chapter 100 year war/)
    assert.match(result.description, /Chapter 3 of the book/)
    assert.match(result.description, /03:00 the guard changed shift/)
  })

  test('keeps a sentence that opens with a chapter number and no separator', () => {
    // "Chapter 3 is where the story turns" is prose about a chapter, not a
    // heading: only a number followed by a separator makes a heading.
    const description = [
      'Chapter 3 is where the story turns, and everything after it lands differently.',
      '',
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.removed_copied_sentences, 0)
    assert.match(result.description, /Chapter 3 is where the story turns/)
    assert.match(result.description, /Tonight we walk the walls of Uruk/)
  })

  test('keeps a timeline label over the model\'s own prose', () => {
    // The label alone does not authorise taking the lines under it away.
    const description = [
      'Timeline:',
      '- The old bridge was rebuilt after the flood.',
      '- The river changed course in the winter.',
      '',
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, false)
    assert.match(result.description, /Timeline:/)
    assert.match(result.description, /old bridge was rebuilt/)
    assert.match(result.description, /river changed course/)
    assert.match(result.description, /Tonight we walk the walls of Uruk/)
  })

  test('keeps time-of-day lines', () => {
    // Two timestamps in a row are not a chapter list: "3:00 the guard changed
    // shift" is prose, and the line under it is prose too.
    const description = [
      '3:00 the guard changed shift',
      '7:00 the bells rang for evening',
      'Sleep well tonight.',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.removed_copied_sentences, 0)
    assert.match(result.description, /3:00 the guard changed shift/)
    assert.match(result.description, /7:00 the bells rang for evening/)
    assert.match(result.description, /Sleep well tonight\./)
  })

  test('keeps a rewritten passage of the narration', () => {
    // A rewritten passage does not match the narration exactly, so it stays.
    const description = 'Beneath the reed walls of ancient Uruk, potters shaped clay beside a river that never stopped rising.'

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.description, description)
    assert.equal(result.removed_copied_sentences, 0)
  })

  test('never touches the finalizer\'s managed block', () => {
    // The authoritative timeline is rendered by the finalizer, inside these
    // markers. The repair runs before it, but it must stay safe if it is
    // ever applied to a finalized description.
    const description = [
      'Tonight we walk the walls of Uruk as they were first raised from river mud.',
      '',
      '<!-- youtube:chapters:start -->',
      'CHAPTERS',
      '0:00 Opening',
      '0:07 Introduction',
      '<!-- youtube:chapters:end -->',
    ].join('\n')

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    assert.equal(result.description, description)
    assert.equal(result.removed_chapter_list, false)
    assert.equal(result.removed_copied_sentences, 0)
  })

  test('a music episode has its chapter list removed and no copy check', () => {
    // No narration to copy — a music episode's tracklist belongs to the
    // finalizer, and its description is never measured against a narration
    // it never had.
    const description = [
      'A calm hour of original instrumental music for sleep.',
      '',
      'Chapters:',
      '0:00 First Light',
      '3:20 River Stones',
    ].join('\n')

    const result = repairGeneratedDescription(description)

    assert.equal(result.removed_chapter_list, true)
    assert.equal(result.removed_copied_sentences, 0)
    assert.equal(result.description, 'A calm hour of original instrumental music for sleep.')
  })
})

describe('repairGeneratedDescription — the failure case', () => {
  test('leaves nothing when the whole description matched the narration', () => {
    const description = 'The first walls of Uruk rose from river mud, laid by hands that knew the flood would come.'

    const result = repairGeneratedDescription(description, { narrationContext: NARRATION })

    // Nothing usable is left. The generator refuses the run before the
    // finalizer rather than saving an empty one — see the generator contract
    // below.
    assert.equal(result.description, '')
    assert.equal(result.removed_copied_sentences, 1)
  })
})

// ── the generator's use of it ───────────────────────────────────────────────
//
// Source-level, and only for what a run cannot show from the outside: the
// repair runs on the description this run generated, it runs BEFORE the
// finalizer writes the authoritative timeline, and the operator's own edited
// description never reaches it. The refusal itself is proved by a real run
// further down.

describe('generators/metadata.ts — where the repair runs', () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const source = fs.readFileSync(path.resolve(here, '..', 'generators', 'metadata.ts'), 'utf-8')

  test('repairs the generated description before the finalizer writes the real timeline', () => {
    const repair = source.indexOf('repairGeneratedDescription(description')
    const finalizer = source.indexOf('finalizeYouTubeDescription({')
    assert.ok(repair > 0, 'the generator must call the repair')
    assert.ok(finalizer > 0, 'the generator must call the finalizer')
    assert.ok(repair < finalizer, 'the repair must run before the finalizer')
  })

  test('never repairs the operator\'s own edited description', () => {
    const preserved = source.indexOf('existingPackage!.description!.trim()')
    const repair = source.indexOf('repairGeneratedDescription(description')
    assert.ok(preserved > 0)
    assert.ok(preserved < repair, 'the preserved copy is taken before the repair, and is not repaired')
  })

  test('a music episode is measured against no narration', () => {
    assert.match(source, /narrationContext: musicStitch\.music \? '' : rawStoryContext/)
  })

  test('an emptied description is refused before the finalizer writes a timeline', () => {
    const refusal = source.indexOf('The generated description was empty after the repair')
    const finalizer = source.indexOf('finalizeYouTubeDescription({')
    assert.ok(refusal > 0, 'the generator must refuse an emptied description')
    assert.ok(refusal < finalizer, 'the refusal must come before the finalizer')
  })
})

// ── the generator refuses an emptied description ───────────────────────────
//
// A real run, not a source reading: the mock Gateway answers the description
// with the narration word for word, the repair empties it, and the generator
// must stop BEFORE the finalizer — otherwise the finalizer's own timeline
// fills the empty description and the package looks complete with no prose in
// it. Nothing may be written, and a Retry has to ask for a fresh answer.

describe('generators/metadata.ts — the empty description refusal', () => {
  const CODE = 'EP0001'
  const TITLE = 'The Lighthouse Ledger'
  const NARRATION_LINE = 'The first walls of Uruk rose from river mud, laid by hands that knew the flood would come.'

  /**
   * A project with its narration on disk, and a mock Gateway that answers the
   * description with `answer`. The generator must refuse the run.
   */
  async function refuseEmptyDescription(t: any, answer: string) {
    const temporary = await useTempDataDir()
    const mock = await startMockGenStudioService()
    t.after(async () => {
      await mock.close()
      await temporary.cleanup()
    })
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const projects = await import('../services/project-manager.js')
    const { resolveEpisodePaths } = await import('../services/utils.js')
    await settings.setGenStudioUrl(mock.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const project = await projects.createProject({ name: 'Metadata empty description', episode_prefix: 'EP', episode_digits: 4 })
    await projects.updateConfig(project.slug, { safety_checks: { chapter_marks: 'warn' } } as any)
    const paths = await resolveEpisodePaths(project.slug, CODE, TITLE)
    const narration = paths.narration_docx.replace(/\.docx$/i, '.md')
    const metadataDir = paths.metadata_json.replace(/[/\\][^/\\]*$/, '')
    await fs.promises.mkdir(metadataDir, { recursive: true })
    await fs.promises.mkdir(narration.replace(/[/\\][^/\\]*$/, ''), { recursive: true })
    await fs.promises.writeFile(narration, NARRATION_LINE)

    mock.queueScenario('chat', { outputText: answer })

    await import('../providers/text/genstudio.js')
    const { generateMetadata } = await import('../generators/metadata.js')
    const job: any = {
      job_id: 'metadata-empty-description', project_slug: project.slug, type: 'metadata', episode_id: CODE,
      title: 'YouTube Finalizer', output_lines: [],
      params: { episode_id: CODE, title: TITLE, model: 'mock-chat-v1', title_mode: 'use_idea_title', tag_count: 5 },
    }

    let refusal = ''
    await assert.rejects(generateMetadata(job), (error: any) => {
      refusal = String(error?.message || error)
      return /empty after the repair/.test(refusal)
    })
    return { job, refusal, paths, narration, metadataDir }
  }

  test('a description that is only the narration is refused before the finalizer', async t => {
    // The model hands the narration back word for word: the repair takes all
    // of it out and nothing usable is left.
    const { job, refusal, paths, narration, metadataDir } = await refuseEmptyDescription(t, NARRATION_LINE)

    // The message says what was actually taken out.
    assert.match(refusal, /no usable prose remained in the generated description after the narration it copied was removed/)
    // A Retry asks for a fresh answer instead of replaying the rejected one.
    assert.equal(job.result?.chat_answer_rejected, true)
    // Nothing was written: no metadata package, and the narration is untouched.
    assert.equal(fs.existsSync(paths.metadata_json), false)
    assert.deepEqual(fs.readdirSync(metadataDir).filter(name => /^EP0001_Metadata(_v\d+)?\.(json|txt)$/.test(name)), [])
    assert.equal(await fs.promises.readFile(narration, 'utf8'), NARRATION_LINE)
  })

  test('a description that is only a chapter list is refused with the chapter wording', async t => {
    // The model wrote a second timeline and nothing else. The repair takes the
    // chapter list out, so the message must not blame the narration.
    const answer = [
      'Chapters:',
      "00:00 Chapter 01: Introduction to the K'iche' Tradition",
    ].join('\n')
    const { job, refusal } = await refuseEmptyDescription(t, answer)

    assert.match(refusal, /no usable prose remained in the generated description after the generated chapter entries were removed/)
    assert.doesNotMatch(refusal, /narration it copied/)
    assert.equal(job.result?.chat_answer_rejected, true)
  })
})

// ── the refused answer must not be handed back to a Retry ───────────────────
//
// A metadata job that still carries the legacy `pipeline_model_policy` runs its
// calls through the policy path, which saves the key of the request it accepted
// and reconnects a later attempt to it. A Retry was therefore handed the very
// answer the run had refused, and the promise "Retry asks for a fresh
// description" was false.
//
// The refused run must leave two things behind: the refused key recorded the
// way every other locally-refused answer is recorded, and no checkpoint entry
// the policy path could reconnect to — while the checkpoints of the step's
// OTHER requests stay exactly as they were.

describe('generators/metadata.ts — the legacy policy retry', () => {
  const CODE = 'EP0002'
  const TITLE = 'The River Merchants'
  const NARRATION_LINE = 'The first walls of Uruk rose from river mud, laid by hands that knew the flood would come.'
  // A second timeline and nothing else: the repair empties it.
  const REFUSED_ANSWER = ['Chapters:', "00:00 Chapter 01: Introduction to the K'iche' Tradition"].join('\n')
  const GOOD_ANSWER = 'Tonight the river trade carries grain downstream, and the scribes tally every basket that arrives.'

  /** The description requests only — the tag request of a later attempt is not one. */
  function descriptionRequests(mock: { submissions: Array<{ operation: string; idempotencyKey: string; bodyText: string }> }) {
    return mock.submissions.filter(entry => entry.operation === 'chat' && entry.bodyText.includes('SUMMARY DIRECTIVE'))
  }

  async function legacyPolicyRun(t: any) {
    const temporary = await useTempDataDir()
    const mock = await startMockGenStudioService()
    t.after(async () => {
      await mock.close()
      await temporary.cleanup()
    })
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const projects = await import('../services/project-manager.js')
    const { resolveEpisodePaths } = await import('../services/utils.js')
    await settings.setGenStudioUrl(mock.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const project = await projects.createProject({ name: 'Metadata legacy policy retry', episode_prefix: 'EP', episode_digits: 4 })
    await projects.updateConfig(project.slug, { safety_checks: { chapter_marks: 'warn' } } as any)
    const paths = await resolveEpisodePaths(project.slug, CODE, TITLE)
    const narration = paths.narration_docx.replace(/\.docx$/i, '.md')
    const metadataDir = paths.metadata_json.replace(/[/\\][^/\\]*$/, '')
    await fs.promises.mkdir(metadataDir, { recursive: true })
    await fs.promises.mkdir(narration.replace(/[/\\][^/\\]*$/, ''), { recursive: true })
    await fs.promises.writeFile(narration, NARRATION_LINE)

    mock.queueScenario('chat', { outputText: REFUSED_ANSWER })
    mock.queueScenario('chat', { outputText: GOOD_ANSWER })

    await import('../providers/text/genstudio.js')
    const { generateMetadata } = await import('../generators/metadata.js')
    const templateCheckpointKey = `${project.slug}:${CODE}:metadata:template`
    const job: any = {
      job_id: 'metadata-legacy-policy', project_slug: project.slug, type: 'metadata', episode_id: CODE,
      title: 'YouTube Finalizer', output_lines: [],
      params: {
        episode_id: CODE, title: TITLE, title_mode: 'use_idea_title', tag_count: 1,
        // The legacy Pipeline policy: one writing model for this step.
        pipeline_model_policy: {
          metadata: { mode: 'single', models: ['mock-chat-v1'], assigned_model: 'mock-chat-v1' },
        },
        // Another request of the same step, already accepted. It is not this
        // run's business and must survive the refusal untouched.
        pipeline_model_checkpoints: {
          [templateCheckpointKey]: {
            input_fingerprint: 'seeded-template-fingerprint',
            candidates: ['mock-chat-v1'],
            candidate_index: 0,
            candidate_model: 'mock-chat-v1',
            status: 'succeeded',
            idempotency_key: 'story-chat-seeded-template-key',
            updated_at: new Date().toISOString(),
          },
        },
      },
    }
    return { mock, job, generateMetadata, project, paths, narration, metadataDir, templateCheckpointKey }
  }

  test('the refused key is recorded and this run\'s own checkpoint is dropped', async t => {
    const { mock, job, generateMetadata, templateCheckpointKey } = await legacyPolicyRun(t)

    await assert.rejects(generateMetadata(job), (error: any) => /empty after the repair/.test(String(error?.message || error)))

    const requests = descriptionRequests(mock)
    assert.equal(requests.length, 1, 'the run asked the Gateway once')
    // The refused key is recorded the way every other refused answer is.
    assert.deepEqual(job.rejected_idempotency_keys, [requests[0].idempotencyKey])
    // This run's own description checkpoint is gone, so the policy path cannot
    // reconnect to the answer that was refused.
    const descriptionCheckpointKey = `${job.project_slug}:${CODE}:metadata:description`
    assert.equal(job.params.pipeline_model_checkpoints[descriptionCheckpointKey], undefined)
    // Another request of the same step keeps its checkpoint.
    assert.equal(job.params.pipeline_model_checkpoints[templateCheckpointKey]?.idempotency_key, 'story-chat-seeded-template-key')
  })

  test('a Retry asks the Gateway again instead of replaying the refused answer', async t => {
    const { mock, job, generateMetadata } = await legacyPolicyRun(t)

    await assert.rejects(generateMetadata(job), (error: any) => /empty after the repair/.test(String(error?.message || error)))
    const refusedKey = descriptionRequests(mock)[0].idempotencyKey

    // The Retry the Jobs page mints for a refused answer: a fresh generation
    // action, so the request identity — and with it the key — is new.
    const { stampFreshGenerationAction } = await import('../lib/fresh-generation-action.js')
    const { randomUUID } = await import('node:crypto')
    const minted = stampFreshGenerationAction(job.params, randomUUID())
    job.params = { ...job.params, ...minted, generation_action: { ...minted.generation_action, origin: 'retry' } }

    let secondFailure: any = null
    await generateMetadata(job).catch(error => { secondFailure = error })

    const requests = descriptionRequests(mock)
    assert.equal(requests.length, 2, 'the retry asked the Gateway again instead of replaying the refused answer')
    assert.notEqual(requests[1].idempotencyKey, refusedKey)
    assert.doesNotMatch(String(secondFailure?.message || ''), /empty after the repair/)
  })
})
