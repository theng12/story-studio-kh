/**
 * NEW-02 — the text job types have a completion auditor again.
 *
 * DS-02 made a settled-but-unverifiable restart fail loudly instead of running
 * forever, which was right. But `metadata`, `image_prompts` and `research_run`
 * had NO auditor, so every restart of those types became an error even when the
 * output was complete — and the error said so ("no completion audit is
 * registered for this job type").
 *
 * The fix reuses each generator's own proof. These tests pin BOTH directions for
 * every type, because an auditor that always answered `repair-required` would
 * otherwise pass every "not complete" assertion while being just as useless as
 * no auditor at all (AGENTS.md §6). Fixtures are written into the REAL resolved
 * episode paths, because the auditors resolve them from the job — a temp file
 * somewhere else would prove nothing.
 *
 * THE SIX WRITING TYPES. `outline_only`, `expand_chapters`,
 * `introduction-only`, `chapter-only`, `contextual_cues` and
 * `music_scene_polish` had no auditor either, and the queue reads the auditor
 * BEFORE it offers to pick a settled writing job up again — so those six
 * failed loudly instead of resuming. Each proves its OWN artifact: they do not
 * share one generic "is there a file" guess.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import JSZip from 'jszip'

import {
  getJobCancellationAuditor,
  hasJobCancellationAuditor,
  readCancellationAudit,
} from '../services/job-cancellation-auditors.js'
import {
  inspectChapterCompletion,
  inspectIntroductionCompletion,
  scenePolishInputFingerprint,
} from '../services/text-completion.js'
import { writePromptCompletionManifest } from '../services/prompt-completion.js'
import { writeMetadataCompletionManifest } from '../services/metadata-completion.js'
import { resolveResearchPaths } from '../lib/research-paths.js'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

const CODE = 'EP0044'
const TYPES = ['image_prompts', 'metadata', 'research_run'] as const
/** The six writing types that had no auditor at all. */
const WRITING_TYPES = [
  'outline_only', 'expand_chapters', 'introduction-only', 'chapter-only',
  'contextual_cues', 'music_scene_polish',
] as const

let cleanup: () => Promise<void>
let projectSlug: string
let paths: {
  episode_dir: string
  script_dir: string
  thumb_prompts_dir: string
  metadata_dir: string
  scene_plan_path: string
}
/** The artifacts the writing auditors read. */
let chapterOnePath: string
let introductionPath: string
let unifiedPath: string

const CHAPTER_BODY = 'The lantern was found in a quiet archive.'
const INTRO_BODY = 'Welcome to another quiet night.'
const EPISODE_TITLE = 'The Quiet Archive'

/**
 * The assembled narration, in the shape the assembler actually writes it.
 *
 * `assembleUnifiedNarration` (lib/narration-assembly.ts) writes the title
 * block as PLAIN TEXT — `buildNarrationDocx` puts `{title}` and
 * `Episode {code}` above the body without a `#`, because a leading level-1
 * line would manufacture a phantom Introduction in the narration parsers
 * (lib/docx-builder.ts:41-55) — and then the `# {title} — Narration`
 * separator and the chapter headings. The fixture keeps that shape so the
 * audit reads the same document the audio reads.
 */
function unifiedNarration(chapterBody = CHAPTER_BODY, introBody = ''): string {
  return [
    EPISODE_TITLE,
    `Episode ${CODE}`,
    '',
    ...(introBody ? ['# Introduction', '', introBody, ''] : []),
    `# ${EPISODE_TITLE} — Narration`,
    '',
    '## Chapter 01: The Lantern',
    '',
    chapterBody,
    '',
  ].join('\n')
}

/**
 * A minimal but GENUINE .docx, for the legacy-artifact case.
 *
 * A legacy episode kept `_Chapter_01.docx` — a real Word file — and no `.md`
 * sibling. The readers resolve that pair through `resolveReadPath`, and the
 * docx reader takes a `.docx` through mammoth, so the fixture has to be a
 * real package rather than markdown with the wrong extension.
 *
 * The package carries a real `word/styles.xml`: mammoth maps a paragraph to a
 * heading by the STYLE NAME in the style sheet, not by the style id, so
 * without it the "Chapter 02: The Ledger" paragraph would come back as an
 * ordinary paragraph and the fixture would prove nothing.
 */
async function writeLegacyDocx(
  file: string,
  paragraphs: Array<{ text: string; heading?: boolean }>,
): Promise<void> {
  const escape = (value: string) => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs.map(paragraph => (
    '<w:p>'
    + (paragraph.heading ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' : '')
    + `<w:r><w:t xml:space="preserve">${escape(paragraph.text)}</w:t></w:r>`
    + '</w:p>'
  )).join('')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '</Types>',
  ].join(''))
  zip.folder('_rels')!.file('.rels', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join(''))
  zip.folder('word')!.file('styles.xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:styleId="Heading2">',
    '<w:name w:val="heading 2"/>',
    '<w:basedOn w:val="Normal"/>',
    '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>',
    '<w:rPr><w:b/></w:rPr>',
    '</w:style>',
    '</w:styles>',
  ].join(''))
  zip.folder('word')!.folder('_rels')!.file('document.xml.rels', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>',
  ].join(''))
  zip.folder('word')!.file('document.xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    body,
    '</w:body></w:document>',
  ].join(''))
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  // Auditors are registered at boot; a test process must do the same or it is
  // asserting against an empty registry (the same call the app makes).
  const { registerAllExecutors } = await import('../boot/executors.js')
  registerAllExecutors({ loadSettings: false })
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Text completion auditors' })
  projectSlug = project.slug
  const resolved = await resolveEpisodePathsByCode(projectSlug, CODE)
  const scenePlanPath = await resolveScenePlanPath(projectSlug, CODE, resolved.episode_dir)
  paths = {
    episode_dir: resolved.episode_dir,
    script_dir: resolved.script_dir,
    thumb_prompts_dir: resolved.thumb_prompts_dir,
    metadata_dir: resolved.metadata_dir,
    scene_plan_path: scenePlanPath,
  }
  chapterOnePath = path.join(resolved.script_dir, `${CODE}_Chapter_01.md`)
  introductionPath = path.join(resolved.script_dir, `${CODE}_Introduction.md`)
  unifiedPath = path.join(resolved.script_dir, `${CODE}_Script_Narration.md`)
  await Promise.all([
    fs.mkdir(paths.thumb_prompts_dir, { recursive: true }),
    fs.mkdir(paths.metadata_dir, { recursive: true }),
    fs.mkdir(paths.script_dir, { recursive: true }),
    fs.mkdir(path.dirname(scenePlanPath), { recursive: true }),
    fs.mkdir(paths.episode_dir, { recursive: true }),
  ])
})

after(async () => {
  await cleanup()
})

/**
 * A job fixture.
 *
 * `started_at` is fixed in the past so a fixture stays comparable. It is NOT
 * how the music polish proves its output: that proof is the run's own record
 * of the request it made, checked against the document — a timestamp says when
 * a file was written, not which run wrote it.
 */
function job(type: Job['type'], params: Record<string, unknown> = {}, overrides: Partial<Job> = {}): Job {
  return {
    job_id: `audit-${type}`,
    project_slug: projectSlug,
    type,
    episode_id: CODE,
    title: 'Auditor fixture',
    status: 'running',
    created_at: '2026-10-22T03:00:00.000Z',
    started_at: '2026-10-22T03:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params,
    ...overrides,
  } as unknown as Job
}

describe('every text type that can settle after a restart has an auditor', () => {
  test('the three types register one', () => {
    for (const type of TYPES) {
      assert.equal(hasJobCancellationAuditor(type), true,
        `${type} must have a completion auditor, or a restart errors over complete output`)
    }
  })

  test('the six writing types register one', () => {
    for (const type of WRITING_TYPES) {
      assert.equal(hasJobCancellationAuditor(type), true,
        `${type} must have a completion auditor, or a settled writing job fails instead of resuming`)
    }
  })
})

describe('the auditors verify output in both directions', () => {
  test('image_prompts: complete manifest + prompts is complete; empty is not', async () => {
    const auditor = getJobCancellationAuditor('image_prompts')!
    assert.equal(await auditor(job('image_prompts')), 'repair-required',
      'nothing on disk must never be reported complete')

    // The shape the generator writes, plus the completion manifest naming two
    // expected prompts.
    await fs.writeFile(path.join(paths.thumb_prompts_dir, `${CODE}_Thumbnail_Prompts.md`), [
      '# Thumbnail Prompts',
      '',
      '## Thumbnail 1: Lantern',
      '',
      'A lantern in a quiet archive, warm light, deep shadow.',
      '',
      '## Thumbnail 2: Ledger',
      '',
      'An open ledger on a desk, cold morning light.',
      '',
    ].join('\n'))
    await writePromptCompletionManifest(paths.thumb_prompts_dir, CODE, 'thumbnail', 2)

    assert.equal(await auditor(job('image_prompts')), 'complete',
      'a complete two-prompt document with its manifest must be verified complete')
  })

  test('metadata: description + every expected title and tag is complete; a missing field is not', async () => {
    const auditor = getJobCancellationAuditor('metadata')!

    await writeMetadataCompletionManifest(paths.metadata_dir, CODE, 'metadata.json', 2, 2)
    await fs.writeFile(path.join(paths.metadata_dir, 'metadata.json'), JSON.stringify({
      description: 'A complete description of the episode.',
      title_options: ['First title', 'Second title'],
      tags: ['one', 'two'],
    }))
    assert.equal(await auditor(job('metadata')), 'complete')

    await fs.writeFile(path.join(paths.metadata_dir, 'metadata.json'), JSON.stringify({
      description: '',
      title_options: ['First title'],
      tags: ['one'],
    }))
    assert.equal(await auditor(job('metadata')), 'repair-required',
      'a partial package must stay repair-required, never a verified done')
  })

  test('research_run: real evidence is complete; an empty sidecar is not', async () => {
    const { jsonPath } = await resolveResearchPaths(paths.episode_dir, CODE)
    await fs.mkdir(path.dirname(jsonPath), { recursive: true })
    const auditor = getJobCancellationAuditor('research_run')!
    assert.equal(await auditor(job('research_run')), 'repair-required',
      'no sidecar at all must be repair-required')

    await fs.writeFile(jsonPath, JSON.stringify({
      episode_code: CODE,
      summary: 'An evidence summary the script may use.',
      claims: [{ id: 'c1', text: 'A claim with real text.', status: 'unreviewed' }],
    }))
    assert.equal(await auditor(job('research_run')), 'complete',
      'artifact-based evidence is what makes research complete (AGENTS.md §9)')

    await fs.writeFile(jsonPath, JSON.stringify({ episode_code: CODE, summary: '', claims: [] }))
    assert.equal(await auditor(job('research_run')), 'repair-required',
      'an empty result is not evidence')
  })
})

// ── The six writing types ────────────────────────────────────────────────
//
// Each one proves ITS OWN artifact, and each one is checked in both
// directions: the real artifact is complete, and a missing/partial one is not.

const OUTLINE_SIDECAR = {
  schema_version: 3,
  episode_id: CODE,
  mode: 'narrative',
  total_chapters: 2,
  outline: [
    { n: 1, title: 'The Lantern', synopsis: 'A lantern is found in a quiet archive.', key_beats: ['A finding', 'A keeper'] },
    { n: 2, title: 'The Ledger', synopsis: 'An open ledger lists what was taken.', key_beats: ['A reckoning'] },
  ],
  outline_completed_at: '2020-01-01T00:00:00.000Z',
  outline_approved_at: '2020-01-02T00:00:00.000Z',
  outline_edited_at: null,
  generation_params: null,
  chapters_done: [],
  params_hash: 'fixture',
  last_updated: '2020-01-01T00:00:00.000Z',
}

describe('outline_only proves the outline sidecar', () => {
  test('a saved outline is complete; no sidecar is not', async () => {
    const auditor = getJobCancellationAuditor('outline_only')!
    const sidecarPath = path.join(paths.script_dir, `${CODE}_chunked-progress.json`)

    await fs.rm(sidecarPath, { force: true })
    assert.equal(await auditor(job('outline_only', { chapters: 2 })), 'repair-required',
      'no outline at all must be repair-required')

    await fs.writeFile(sidecarPath, JSON.stringify(OUTLINE_SIDECAR))
    assert.equal(await auditor(job('outline_only', { chapters: 2 })), 'complete',
      'a saved outline with every chapter titled is complete — approval is the owner\'s next step, not this job\'s output')

    // Fewer chapters than were asked for is a shortfall the generator would
    // have refused too.
    assert.equal(await auditor(job('outline_only', { chapters: 3 })), 'repair-required',
      'an outline shorter than the request is not complete')

    // The count the run was ACTUALLY asked for is the one the run itself
    // resolved and declared (`requireJobCompletion({ expected:
    // params.totalChapters })`, generators/episode.ts:1011-1014) — not only
    // the request's `chapters` field, which the generator reads only when the
    // request names one (episode.ts:889).
    assert.equal(await auditor(job('outline_only', {}, {
      result: { complete: false, completion: { complete: false, expected: 3, completed: 2, missing: ['Chapter 3'] } },
    })), 'repair-required',
      'a run that recorded asking for three chapters and saved two is short, whatever the request said')
  })
})

describe('expand_chapters proves the chapter files and the assembled narration', () => {
  test('every approved chapter present is complete; a missing chapter is not', async () => {
    const auditor = getJobCancellationAuditor('expand_chapters')!
    const sidecarPath = path.join(paths.script_dir, `${CODE}_chunked-progress.json`)
    const chapterOne = path.join(paths.script_dir, `${CODE}_Chapter_01.md`)
    const chapterTwo = path.join(paths.script_dir, `${CODE}_Chapter_02.md`)
    const narration = path.join(paths.script_dir, `${CODE}_Script_Narration.md`)

    await fs.writeFile(sidecarPath, JSON.stringify(OUTLINE_SIDECAR))
    await fs.writeFile(chapterOne, '## Chapter 01: The Lantern\n\nThe lantern was found in a quiet archive.\n')
    await fs.writeFile(chapterTwo, '## Chapter 02: The Ledger\n\nThe ledger listed everything that was taken.\n')
    await fs.writeFile(narration, '# EP0044 — Narration\n\nThe lantern was found in a quiet archive.\n')

    assert.equal(await auditor(job('expand_chapters')), 'complete',
      'an approved outline with every chapter and the assembled narration is complete')

    await fs.rm(chapterTwo, { force: true })
    assert.equal(await auditor(job('expand_chapters')), 'repair-required',
      'a missing chapter must never be reported complete')
    await fs.writeFile(chapterTwo, '## Chapter 02: The Ledger\n\nThe ledger listed everything that was taken.\n')
  })

  test('a filtered expansion only requires the chapters it was asked for', async () => {
    const auditor = getJobCancellationAuditor('expand_chapters')!
    const chapterTwo = path.join(paths.script_dir, `${CODE}_Chapter_02.md`)
    const narration = path.join(paths.script_dir, `${CODE}_Script_Narration.md`)

    await fs.rm(chapterTwo, { force: true })
    assert.equal(await auditor(job('expand_chapters', { chapters_to_expand: [1] })), 'complete',
      'a manual run that expanded only chapter 1 is complete when chapter 1 is on disk')
    assert.equal(await auditor(job('expand_chapters', { chapters_to_expand: [1, 2] })), 'repair-required',
      'a chapter that was asked for and is not on disk is not complete')

    await fs.writeFile(chapterTwo, '## Chapter 02: The Ledger\n\nThe ledger listed everything that was taken.\n')
    await fs.writeFile(narration, '# EP0044 — Narration\n\nThe lantern was found in a quiet archive.\n')
  })
})

describe('introduction-only proves the introduction AND the assembled narration that carries it', () => {
  test('the written introduction, assembled into the narration, is complete; a missing one is not', async () => {
    const auditor = getJobCancellationAuditor('introduction-only')!

    await fs.rm(introductionPath, { force: true })
    await fs.rm(unifiedPath, { force: true })
    assert.equal(await auditor(job('introduction-only')), 'repair-required',
      'no introduction at all must be repair-required')

    await fs.writeFile(introductionPath, `# Introduction\n\n${INTRO_BODY}\n`)
    assert.equal(await auditor(job('introduction-only')), 'repair-required',
      'an introduction that never reached the assembled narration is not this job\'s output')

    await fs.writeFile(unifiedPath, unifiedNarration(CHAPTER_BODY, INTRO_BODY))
    assert.equal(await auditor(job('introduction-only')), 'complete')

    await fs.writeFile(introductionPath, '# Introduction\n\n')
    assert.equal(await auditor(job('introduction-only')), 'repair-required',
      'a heading with no text under it is not an introduction')
    await fs.rm(introductionPath, { force: true })
  })

  test('a narration that predates the introduction is stale, not complete', async () => {
    const auditor = getJobCancellationAuditor('introduction-only')!
    await fs.writeFile(introductionPath, `# Introduction\n\n${INTRO_BODY}\n`)
    await fs.writeFile(unifiedPath, unifiedNarration(CHAPTER_BODY, 'An older opening.'))
    assert.equal(await auditor(job('introduction-only')), 'repair-required',
      'a narration that does not carry this introduction is stale')
    await fs.writeFile(unifiedPath, unifiedNarration(CHAPTER_BODY, INTRO_BODY))
  })
})

describe('chapter-only proves the chapter AND the assembled narration that carries it', () => {
  test('the written chapter, assembled into the narration, is complete; a missing one is not', async () => {
    const auditor = getJobCancellationAuditor('chapter-only')!

    await fs.rm(chapterOnePath, { force: true })
    await fs.rm(unifiedPath, { force: true })
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'no chapter file must be repair-required')

    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'a chapter that never reached the assembled narration is not this job\'s output')

    await fs.writeFile(unifiedPath, unifiedNarration())
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'complete')

    await fs.writeFile(chapterOnePath, '## Chapter 01: The Lantern\n\n')
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'a heading with no body is a partial chapter')
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)
  })

  test('a narration that predates the chapter is stale, not complete', async () => {
    const auditor = getJobCancellationAuditor('chapter-only')!
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)
    await fs.writeFile(unifiedPath, unifiedNarration('An older opening line.'))
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'a narration that does not carry this chapter is stale')
    await fs.writeFile(unifiedPath, unifiedNarration())
  })

  test('a missing, empty or malformed narration is never complete', async () => {
    const auditor = getJobCancellationAuditor('chapter-only')!
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)

    await fs.rm(unifiedPath, { force: true })
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'no narration at all is not complete')

    await fs.writeFile(unifiedPath, '')
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'an empty narration is not complete')

    await fs.writeFile(unifiedPath, 'this file is not a narration at all\n')
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'repair-required',
      'a malformed narration is not complete')

    await fs.writeFile(unifiedPath, unifiedNarration())
  })
})

describe('a chapter that carries its own heading is not a stale chapter', () => {
  test('a level-2 subheading inside the chapter does not truncate it', async () => {
    const auditor = getJobCancellationAuditor('chapter-only')!
    const chapter = [
      '## Chapter 01: The Lantern',
      '',
      '## A quiet detail',
      '',
      CHAPTER_BODY,
      '',
    ].join('\n')
    await fs.writeFile(chapterOnePath, chapter)
    await fs.writeFile(unifiedPath, unifiedNarration('## A quiet detail\n\n' + CHAPTER_BODY))
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'complete',
      'a subheading inside the chapter is part of the chapter, not the end of it')
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)
    await fs.writeFile(unifiedPath, unifiedNarration())
  })

  test('a level-1 heading inside the chapter does not truncate it either', async () => {
    const auditor = getJobCancellationAuditor('chapter-only')!
    // The audio path keeps a heading inside a chapter as part of that
    // chapter's text (parseNarrationDocx), and the narration the customer
    // hears is the audio path's document. The bulk-source splitter treated a
    // level-1 heading as a section break, so this fresh chapter read as
    // "older than chapter 1" and the queue went round the chapter generator
    // again for a chapter that was already written.
    const body = '# A quiet detail\n\n' + CHAPTER_BODY
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${body}\n`)
    await fs.writeFile(unifiedPath, unifiedNarration(body))
    assert.equal(await auditor(job('chapter-only', { chapter_number: 1 })), 'complete',
      'the assembled narration carries the chapter, subheading and all')
    await fs.writeFile(chapterOnePath, `## Chapter 01: The Lantern\n\n${CHAPTER_BODY}\n`)
    await fs.writeFile(unifiedPath, unifiedNarration())
  })
})

describe('a legacy episode is FOUND, not reported missing', () => {
  test('a legacy .docx chapter is resolved instead of being called absent', async () => {
    const legacyChapter = path.join(paths.script_dir, `${CODE}_Chapter_02.docx`)
    const modernChapter = path.join(paths.script_dir, `${CODE}_Chapter_02.md`)
    await fs.rm(legacyChapter, { force: true })
    await fs.rm(modernChapter, { force: true })
    await fs.rm(unifiedPath, { force: true })

    // Nothing at all is still missing.
    const nothingThere = await inspectChapterCompletion(paths.script_dir, CODE, 2)
    assert.equal(nothingThere.complete, false)
    assert.equal(nothingThere.detail, 'Chapter 2 is not on disk.')

    await writeLegacyDocx(legacyChapter, [
      { text: 'Chapter 02: The Ledger', heading: true },
      { text: 'The ledger listed everything that was taken.' },
    ])

    // The legacy file IS on disk. The audit must not call it absent — that
    // was the defect: only the modern `.md` name was looked for, so a
    // perfectly good legacy chapter was reported as missing.
    const audit = await inspectChapterCompletion(paths.script_dir, CODE, 2)
    assert.equal(audit.detail, 'The assembled narration is not on disk.',
      'the legacy chapter must be READ (the audit got past the chapter and failed on the narration it is not in)')
    assert.equal(audit.complete, false,
      'a chapter that never reached the assembled narration is still not complete')
    await fs.rm(legacyChapter, { force: true })
  })

  test('a legacy .docx introduction is resolved instead of being called absent', async () => {
    const legacyIntroduction = path.join(paths.script_dir, `${CODE}_Introduction.docx`)
    await fs.rm(legacyIntroduction, { force: true })
    await fs.rm(introductionPath, { force: true })
    await fs.rm(unifiedPath, { force: true })

    await writeLegacyDocx(legacyIntroduction, [
      { text: 'Introduction', heading: true },
      { text: 'Welcome to another quiet night.' },
    ])

    const audit = await inspectIntroductionCompletion(paths.script_dir, CODE)
    assert.equal(audit.detail, 'The assembled narration is not on disk.',
      'the legacy introduction must be READ (the audit got past the introduction and failed on the narration it is not in)')
    assert.equal(audit.complete, false,
      'an introduction that never reached the assembled narration is still not complete')
    await fs.rm(legacyIntroduction, { force: true })
  })
})

describe('contextual_cues proves the cue timeline beside the scene plan', () => {
  test('a timeline built from THIS plan is complete; one from an earlier plan is not', async () => {
    const auditor = getJobCancellationAuditor('contextual_cues')!
    const planPath = paths.scene_plan_path
    const cuePath = path.join(path.dirname(planPath), 'contextual_cues.json')
    const generatedAt = '2026-10-20T10:00:00.000Z'

    await fs.writeFile(planPath, JSON.stringify({ generated_at: generatedAt, scenes: [] }))
    await fs.rm(cuePath, { force: true })
    assert.equal(await auditor(job('contextual_cues')), 'repair-required',
      'no cue timeline at all must be repair-required')

    await fs.writeFile(cuePath, JSON.stringify({
      schema_version: 1,
      generated_at: generatedAt,
      source_scene_plan_generated_at: generatedAt,
      cues: [],
    }))
    assert.equal(await auditor(job('contextual_cues')), 'complete',
      'a timeline built from this plan is complete — an empty cue list is a legitimate result')

    await fs.writeFile(cuePath, JSON.stringify({
      schema_version: 1,
      generated_at: '2026-10-19T10:00:00.000Z',
      source_scene_plan_generated_at: '2026-10-19T10:00:00.000Z',
      cues: [],
    }))
    assert.equal(await auditor(job('contextual_cues')), 'repair-required',
      'a timeline left over from an earlier plan is not this run\'s output')
  })
})

describe('music_scene_polish proves THIS RUN\'S OWN prompts, on the document', () => {
  const SCENE = 'ms-0a1b2c3d4e5f'
  const OTHER = 'ms-111111111111'
  const POLISHED = 'A quiet archive lit by one lantern, dust turning in the beam.'
  const docPath = () => path.join(paths.episode_dir, 'music_episode.json')
  const artifactPath = (runId: string) => path.join(paths.episode_dir, 'runs', 'music_scene_polish', `${runId}.json`)

  function writeDoc(overrides: Record<string, unknown> = {}, updatedAt = '2026-10-22T04:00:00.000Z') {
    return fs.writeFile(docPath(), JSON.stringify({
      schema_version: 1,
      episode_code: CODE,
      settings: {},
      songs: [],
      draw_round: 0,
      scene_breaks: [],
      updated_at: updatedAt,
      prompt_overrides: { [SCENE]: POLISHED },
      ...overrides,
    }))
  }

  /**
   * Fixed request fields for the fixture artifact. The validator checks each
   * of these exists and is the right type; the exact values do not matter as
   * long as they are consistent between the artifact and the fingerprint.
   */
  const FIXTURE_REQUEST = {
    model: 'genstudio-chat:mock-chat-v1',
    system: 'You polish scene prompts.',
    user_message: 'Polish these scenes.',
    temperature: 0.7,
    output_budget: '2000',
    output_contract: { type: 'scene-polish' },
    request_identity: 'audit-fixture-identity',
  }

  /** Compute the exact fingerprint the validator will recompute from the artifact. */
  function computeFingerprint(sceneIds: string[], baselinePrompts: Record<string, string>): string {
    return scenePolishInputFingerprint({
      model: FIXTURE_REQUEST.model,
      system: FIXTURE_REQUEST.system,
      userMessage: FIXTURE_REQUEST.user_message,
      temperature: FIXTURE_REQUEST.temperature,
      outputBudget: FIXTURE_REQUEST.output_budget,
      outputContract: FIXTURE_REQUEST.output_contract as any,
      requestIdentity: FIXTURE_REQUEST.request_identity,
      sceneIds,
      baselinePrompts,
    })
  }

  /** SHA-256 hex digest of a text, matching the validator's output digest check. */
  function digest(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  /**
   * The run's OWN record: what it asked for, what it sent, and what it got.
   *
   * The job id has to be the fixture's own (`audit-music_scene_polish`), because
   * the boundary checks that the record belongs to the run that reads it.
   * The project_slug must match the test's actual project, and the artifact
   * must be written to disk so the auditor can read it.
   */
  function record(over: Record<string, unknown> = {}) {
    const sceneIds = (over.scene_ids as string[]) || [SCENE]
    const baseline = (over.baseline_prompts as Record<string, string>) || Object.fromEntries(sceneIds.map(id => [id, '']))
    const outputs = (over.outputs as Record<string, string>) || {}
    const outputDigests: Record<string, string> = {}
    for (const [id, text] of Object.entries(outputs)) {
      outputDigests[id] = digest(text)
    }
    return {
      version: 2,
      run_id: 'a'.repeat(32),
      project_slug: projectSlug,
      episode_code: CODE,
      owner_job_id: 'audit-music_scene_polish',
      scene_ids: sceneIds,
      input_fingerprint: computeFingerprint(sceneIds, baseline),
      baseline_prompts: baseline,
      output_digests: outputDigests,
      ...over,
    }
  }

  async function writeArtifact(artifactData: Record<string, unknown>) {
    const runId = artifactData.run_id as string
    const sceneIds = (artifactData.scene_ids as string[]) || [SCENE]
    const baseline = (artifactData.baseline_prompts as Record<string, string>) || Object.fromEntries(sceneIds.map(id => [id, '']))
    const fullArtifact = {
      ...artifactData,
      request: FIXTURE_REQUEST,
      input_fingerprint: computeFingerprint(sceneIds, baseline),
    }
    await fs.mkdir(path.dirname(artifactPath(runId)), { recursive: true })
    await fs.writeFile(artifactPath(runId), JSON.stringify(fullArtifact))
  }

  /** A run that polished every scene it was asked to polish. */
  function polishJob(params: Record<string, unknown> = {}, over: Partial<Job> = {}): Job {
    return job('music_scene_polish', {
      scene_ids: [SCENE],
      music_scene_polish: record({ outputs: { [SCENE]: POLISHED }, missing: [] }),
      ...params,
    }, {
      result: {
        polished: 1,
        missing: [],
        complete: true,
        completion: { complete: true, expected: 1, completed: 1, missing: [] },
      },
      ...over,
    })
  }

  test('the prompts this run recorded are complete; a scene it did not polish is not', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc()
    const completeRecord = record({ outputs: { [SCENE]: POLISHED }, missing: [] })
    await writeArtifact(completeRecord)
    assert.equal(await auditor(polishJob()), 'complete')
    const partialRecord = record({
      scene_ids: [SCENE, OTHER],
      baseline_prompts: { [SCENE]: '', [OTHER]: '' },
      outputs: { [SCENE]: POLISHED },
      missing: [OTHER],
    })
    await writeArtifact(partialRecord)
    const partialAudit = readCancellationAudit(await auditor(polishJob({
      scene_ids: [SCENE, OTHER],
      music_scene_polish: partialRecord,
    })))
    assert.equal(partialAudit.verdict, 'repair-required',
      'a scene whose polished prompt never came back is not complete, however good the document looks')
    assert.match(partialAudit.detail || '', /did not polish scene ms-111111111111/,
      'the detail names the scene the run did not polish')
  })

  test('a run with NO record of its own output is not complete', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc()
    // No artifact written on disk — the auditor reads from disk, not from params.
    assert.equal(await auditor(job('music_scene_polish', { scene_ids: [SCENE] })), 'repair-required',
      'a prompt on the document is not proof that THIS run wrote it')
  })

  test('a run whose record cannot be read is not complete', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc()
    assert.equal(await auditor(job('music_scene_polish', {
      scene_ids: [SCENE],
      music_scene_polish: { version: 1, job_id: 'audit-music_scene_polish' },
    })), 'repair-required',
    'a record that cannot be read must never read as a run that never made a request')
    const foreignRecord = record({ owner_job_id: 'some-other-run' })
    // Write the artifact so the auditor gets past the disk read, but the
    // owner_job_id mismatch still refuses it.
    await writeArtifact(foreignRecord)
    assert.equal(await auditor(job('music_scene_polish', {
      scene_ids: [SCENE],
      music_scene_polish: foreignRecord,
    })), 'repair-required',
    'another run\'s record is not this run\'s output')
  })

  test('old prompts plus an unrelated fresh save are not this run\'s output', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    // The document was written after this job began, but its prompt is an
    // earlier run's: this run recorded a DIFFERENT text for this scene.
    await writeDoc({ prompt_overrides: { [SCENE]: 'An older polish of the same scene.' } })
    const rec = record({ outputs: { [SCENE]: POLISHED }, missing: [] })
    await writeArtifact(rec)
    const oldAudit = readCancellationAudit(await auditor(polishJob()))
    assert.equal(oldAudit.verdict, 'repair-required',
      'a fresh document carrying somebody else\'s prompt is not this run\'s output')
    assert.match(oldAudit.detail || '', /changed after this run/,
      'the detail names that the prompt was changed after the run')
    await writeDoc()
  })

  test('a partial save made before the result was written is not complete', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    // The run's own record says it answered two of three scenes; the document
    // carries the two it answered. The third was never polished, and the run
    // never recorded its result — the state the old rule read as complete.
    await writeDoc({ prompt_overrides: { [SCENE]: POLISHED, [OTHER]: 'A second polished scene.' } })
    const partialRec = record({
      scene_ids: [SCENE, OTHER, 'ms-222222222222'],
      baseline_prompts: { [SCENE]: '', [OTHER]: '', 'ms-222222222222': '' },
      outputs: { [SCENE]: POLISHED, [OTHER]: 'A second polished scene.' },
      missing: ['ms-222222222222'],
    })
    await writeArtifact(partialRec)
    const partialSaveAudit = readCancellationAudit(await auditor(job('music_scene_polish', {
      scene_ids: [SCENE, OTHER, 'ms-222222222222'],
      music_scene_polish: partialRec,
    })))
    assert.equal(partialSaveAudit.verdict, 'repair-required',
    'the scene the answer never came back for is named, not quietly accepted')
    assert.match(partialSaveAudit.detail || '', /did not polish scene ms-222222222222/,
    'the detail names the scene whose answer never came back')
    await writeDoc()
  })

  test('a prompt changed after the run is not this run\'s output, and is not overwritten', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc({ prompt_overrides: { [SCENE]: 'A prompt the owner typed by hand.' } })
    const rec = record({ outputs: { [SCENE]: POLISHED }, missing: [] })
    await writeArtifact(rec)
    const changedAudit = readCancellationAudit(await auditor(polishJob()))
    assert.equal(changedAudit.verdict, 'repair-required',
      'the owner\'s own text is not this run\'s output, and this run must not claim it')
    assert.match(changedAudit.detail || '', /changed after this run/,
      'the detail names that the prompt was changed after the run')
    await writeDoc()
  })

  test('a scene that still holds the prompt this run started from is not complete', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc({ prompt_overrides: { [SCENE]: 'The song\'s own scene idea.' } })
    const rec = record({
      outputs: { [SCENE]: POLISHED },
      missing: [],
      baseline_prompts: { [SCENE]: 'The song\'s own scene idea.' },
    })
    await writeArtifact(rec)
    const baselineAudit = readCancellationAudit(await auditor(polishJob({
      music_scene_polish: rec,
    })))
    assert.equal(baselineAudit.verdict, 'repair-required',
      'the run\'s output is not on the document, so the run is not finished')
    assert.match(baselineAudit.detail || '', /still holds the prompt this run started from/,
      'the detail names that the scene still holds the starting prompt')
    await writeDoc()
  })

  test('a run that declared itself incomplete is not complete', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc()
    const rec = record({ outputs: { [SCENE]: POLISHED }, missing: [] })
    await writeArtifact(rec)
    const declared = job('music_scene_polish', {
      scene_ids: [SCENE],
      music_scene_polish: rec,
    }, {
      result: {
        polished: 1,
        missing: [],
        complete: false,
        // The generator's own verdict: it called this run incomplete.
        completion: { complete: false, expected: 1, completed: 1, missing: [] },
      },
    })
    const declaredAudit = readCancellationAudit(await auditor(declared))
    assert.equal(declaredAudit.verdict, 'repair-required',
      'a run that recorded itself as incomplete is not complete, however good the document looks')
    assert.match(declaredAudit.detail || '', /recorded an incomplete set/,
      'the detail names that the run declared itself incomplete')
  })

  test('a run interrupted before it recorded its result is judged on its own outputs', async () => {
    const auditor = getJobCancellationAuditor('music_scene_polish')!
    await writeDoc()
    // The run's answers are on record and on the document; only the
    // declaration is missing, and the generator rebuilds that from the record.
    const rec = record({ outputs: { [SCENE]: POLISHED }, missing: [] })
    await writeArtifact(rec)
    assert.equal(await auditor(job('music_scene_polish', {
      scene_ids: [SCENE],
      music_scene_polish: rec,
    })), 'complete',
    'the durable outputs are the proof; a missing declaration is rebuilt, not guessed')
  })
})
