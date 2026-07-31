/**
 * Tests for services/docx-normalizer.ts (Part 3 of mark-done plan).
 *
 * Coverage:
 *   - Idempotent on already-canonical narration → returns { skipped: true }
 *   - Calls the LLM mock on flat-text input + writes per-chapter docx files
 *   - Backup file is created BEFORE chapter writes
 *   - Throws when the LLM output produces zero chapters
 *
 * The normaliser exposes a `_callAiOverride` test hook so we can stub the
 * LLM without monkey-patching ESM module bindings (which are immutable).
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'

// Build a REAL Word .docx source (the app's builder now emits Markdown, so the
// normalizer's legacy-ingest path must be exercised with a genuine .docx that
// mammoth can read). Mirrors the pre-v1.0.228 docx-builder rendering.
async function writeRealDocx(md: string, outputPath: string, includeTitleBlock = true): Promise<void> {
  const paragraphs: Paragraph[] = []
  if (includeTitleBlock) {
    paragraphs.push(new Paragraph({ text: TITLE, heading: HeadingLevel.TITLE }))
    paragraphs.push(new Paragraph({ text: `Story Studio • Episode ${CODE}` }))
    paragraphs.push(new Paragraph({ text: '' }))
  }
  for (const line of md.trim().split('\n')) {
    const t = line.trim()
    if (t.startsWith('## ')) paragraphs.push(new Paragraph({ text: t.slice(3).trim(), heading: HeadingLevel.HEADING_2 }))
    else if (t.startsWith('# ')) paragraphs.push(new Paragraph({ text: t.slice(2).trim(), heading: HeadingLevel.HEADING_1 }))
    else if (t === '') paragraphs.push(new Paragraph({ text: '' }))
    else paragraphs.push(new Paragraph({ text: t }))
  }
  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buf = await Packer.toBuffer(doc)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, buf)
}

let normalizer: typeof import('../services/docx-normalizer.js')
let pm: typeof import('../services/project-manager.js')
let docxBuilder: typeof import('../lib/docx-builder.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

let mockResponse: string = ''
let lastUserPrompt = ''

const SLUG = 'normalize-test'
const CODE = 'EP0001'
const TITLE = 'Normalize Test'

interface DirHandles {
  projDir: string
  episodeDir: string
  scriptDir: string
}

async function makeProject(): Promise<DirHandles> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Normalize Test',
    episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: outputRoot, created_at: new Date().toISOString(),
    anthropic_api_key: 'sk-test-mock',
  }))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'i-1', title: TITLE, logline: 'l', themes: [], suggested_chapters: 4,
      suggested_length: '20 min', mood: 'm', status: 'accepted', episode_code: CODE,
      generated_at: '2026-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z',
      batch_id: 'imported', model_used: 'imported',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const episodeDir = path.join(outputRoot, 'Season 001', `${CODE} - ${TITLE}`)
  const scriptDir = path.join(episodeDir, `${CODE} - 01 Script`)
  await fs.mkdir(scriptDir, { recursive: true })
  return { projDir, episodeDir, scriptDir }
}

async function makeCanonicalDocx(p: string): Promise<void> {
  const md = `# Introduction

This is the intro paragraph that sets the mood for the listener.

# ${TITLE} — Narration

## Chapter 01: The Quiet Beginning

The first chapter unfolds slowly, with two paragraphs of gentle prose.

A second paragraph builds on the first, weaving the listener deeper into the world.

## Chapter 02: The Turning

The second chapter brings a subtle shift in pace and direction.

The protagonist makes a small but pivotal choice.
`
  await writeRealDocx(md, p)
}

async function makeLegacyDocx(p: string): Promise<void> {
  const paragraphs: string[] = []
  for (let i = 0; i < 30; i++) {
    paragraphs.push(`Paragraph ${i + 1}: this is a long-enough paragraph to ensure the source narration crosses the 200-character minimum that the normaliser requires for safety.`)
  }
  await writeRealDocx(paragraphs.join('\n\n'), p, false)
}

function makeMock(): (model: string, system: string, user: string, apiKeys: any) => Promise<string> {
  return async (_m, _s, user) => {
    lastUserPrompt = user
    return mockResponse
  }
}

describe('docx-normalizer', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    normalizer = await import('../services/docx-normalizer.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    mockResponse = ''
    lastUserPrompt = ''
  })

  test('idempotent: already-canonical source → skipped, file untouched', async () => {
    const { scriptDir } = await makeProject()
    const docxPath = path.join(scriptDir, `${CODE}_legacy.docx`)
    await makeCanonicalDocx(docxPath)
    const sizeBefore = (await fs.stat(docxPath)).size
    const r = await normalizer.normalizeNarrationDocx(SLUG, CODE, docxPath, {
      model: 'gpt-4o',
      apiKeys: { openai_api_key: 'sk-test' },
      _callAiOverride: makeMock(),
    })
    assert.equal(r.skipped, true)
    assert.equal(r.chapters_written, 0)
    assert.equal((await fs.stat(docxPath)).size, sizeBefore, 'file untouched')
    assert.equal(lastUserPrompt, '', 'LLM never called')
  })

  test('flat-text source: calls LLM, writes chapter files, creates backup', async () => {
    const { scriptDir } = await makeProject()
    const docxPath = path.join(scriptDir, `${CODE}_legacy.docx`)
    await makeLegacyDocx(docxPath)
    mockResponse = `# Introduction

This intro is the result of LLM restructuring.

# ${TITLE} — Narration

## Chapter 01: The First Beat

Paragraph one of chapter one sets the scene.

Paragraph two of chapter one continues the journey.

## Chapter 02: The Quiet Resolution

Paragraph one of chapter two reflects on the arc.

A final paragraph closes the loop.
`
    const r = await normalizer.normalizeNarrationDocx(SLUG, CODE, docxPath, {
      model: 'gpt-4o',
      apiKeys: { openai_api_key: 'sk-test' },
      _callAiOverride: makeMock(),
    })
    assert.equal(r.skipped, false)
    assert.equal(r.chapters_written, 2)
    assert.equal(r.introduction_written, true)
    assert.ok(r.backup_at, 'backup path returned')
    assert.ok(existsSync(r.backup_at!), 'backup file exists on disk')
    assert.ok(existsSync(path.join(scriptDir, `${CODE}_Chapter_01.md`)), 'chapter 1 file exists')
    assert.ok(existsSync(path.join(scriptDir, `${CODE}_Chapter_02.md`)), 'chapter 2 file exists')
    assert.ok(existsSync(path.join(scriptDir, `${CODE}_Introduction.md`)), 'intro file exists')
    assert.ok(existsSync(path.join(scriptDir, `${CODE}_Script_Narration.md`)), 'unified file written')
    assert.ok(lastUserPrompt.includes(TITLE), 'episode title injected into prompt')
    assert.ok(lastUserPrompt.length > 200, 'prompt includes the source text')
  })

  test('LLM produces zero chapters → throws with helpful detail', async () => {
    const { scriptDir } = await makeProject()
    const docxPath = path.join(scriptDir, `${CODE}_legacy.docx`)
    await makeLegacyDocx(docxPath)
    mockResponse = 'I cannot do that, sorry.'
    await assert.rejects(
      () => normalizer.normalizeNarrationDocx(SLUG, CODE, docxPath, {
        model: 'gpt-4o',
        apiKeys: { openai_api_key: 'sk-test' },
        _callAiOverride: makeMock(),
      }),
      /zero chapters/,
    )
    const files = await fs.readdir(scriptDir)
    assert.equal(files.some(f => /Chapter_\d+\.(?:md|docx)$/.test(f)), false, 'no chapter files written on bad LLM output')
  })

  test('source path not on disk → throws', async () => {
    await makeProject()
    await assert.rejects(
      () => normalizer.normalizeNarrationDocx(SLUG, CODE, '/tmp/does-not-exist.docx', {
        model: 'gpt-4o',
        apiKeys: { openai_api_key: 'sk-test' },
        _callAiOverride: makeMock(),
      }),
      /Source docx not found/,
    )
  })

  test('source too short → throws (avoid wasting tokens on a typo)', async () => {
    const { scriptDir } = await makeProject()
    const docxPath = path.join(scriptDir, `${CODE}_short.docx`)
    await writeRealDocx('hello', docxPath, false)
    await assert.rejects(
      () => normalizer.normalizeNarrationDocx(SLUG, CODE, docxPath, {
        model: 'gpt-4o',
        apiKeys: { openai_api_key: 'sk-test' },
        _callAiOverride: makeMock(),
      }),
      /too short/,
    )
  })

  test('unknown episode → throws', async () => {
    const { scriptDir } = await makeProject()
    const docxPath = path.join(scriptDir, 'somebody.docx')
    await makeLegacyDocx(docxPath)
    mockResponse = `# ${TITLE} — Narration\n\n## Chapter 01: Test\n\nbody.`
    await assert.rejects(
      () => normalizer.normalizeNarrationDocx(SLUG, 'EP9999', docxPath, {
        model: 'gpt-4o',
        apiKeys: { openai_api_key: 'sk-test' },
        _callAiOverride: makeMock(),
      }),
      /not found in accepted ideas/,
    )
  })

  // Dual-read regression guard (v1.0.228): new artifacts are .md, but legacy
  // projects still have real Word .docx on disk. parseNarrationDocx must read
  // those via mammoth (the .docx branch of readStructuredLines).
  test('legacy .docx narration still parses into chapter sections', async () => {
    const { scriptDir } = await makeProject()
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const md = `# Introduction

Intro paragraph for the legacy doc.

# ${TITLE} — Narration

## Chapter 01: The First

Body of chapter one, long enough to be a real section.

## Chapter 02: The Second

Body of chapter two, also a real section.
`
    const docxPath = path.join(scriptDir, `${CODE}_Script_Narration.docx`)
    await writeRealDocx(md, docxPath)
    const sections = await parseNarrationDocx(docxPath)
    assert.deepEqual(sections.map(s => s.slug), ['Introduction', 'Chapter_01', 'Chapter_02'])
    assert.ok(sections.find(s => s.slug === 'Chapter_02')!.text.includes('chapter two'))
  })
})
