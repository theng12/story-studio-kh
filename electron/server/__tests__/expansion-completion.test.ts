/**
 * 1.4.359 — the "Chapters per request" setting, the completion rule that
 * chapter expansion didn't apply, and the `chapters_done` merge a scoped
 * chapter-only write was missing.
 *
 * THE PRODUCTION DEFECT THIS GUARDS (2026-10-25, Komsan, Khmer):
 *   - Expansion jobs ec973e7a / 71e2f3c3 asked for chapters 1-2 and chapter 2
 *     of KOM0003. The provider truncated the batch (`finish_reason:
 *     max_tokens`), `expandListicleParallel` swallowed the error as a log line,
 *     a filtered run skipped the completion rule, and both jobs ended `done`
 *     with 0 of 8 chapter files on disk. AGENTS.md §8: a provider failure must
 *     never read as done, and a missing chapter must be named.
 *   - A scoped chapter-only write in 1.4.357 wrote KOM3 Chapter 7 (all eight
 *     files present) and left `chapters_done` at [1,2,3,4,5,6,8].
 *
 * ZERO paid calls: the provider below never leaves the process.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import {
  expandChapters,
  inspectChunkedScriptCompletion,
  missingRequestedChapters,
  recordVerifiedChapter,
  readSidecar,
  sidecarPath,
  writeImportedOutline,
  type ChunkedNarrationParams,
  type ExpansionBatchSetting,
} from '../lib/chunked-narration.js'
import { chapterFilePath } from '../lib/narration-assembly.js'
import { GenStudioChatIncompleteError } from '../lib/genstudio-client.js'
import { registry } from '../providers/registry.js'
import type { Job, Format } from '../models/types.js'
import type { TextProvider, TextGenerationRequest } from '../providers/types.js'

// ── Fake provider ─────────────────────────────────────────────────────────

interface ExpansionCall { slots: number[]; callIndex: number }
let expansionCalls: ExpansionCall[] = []
let callIndex = 0
/** Answers one expansion request. Throwing simulates a provider failure. */
let answerExpansion: (slots: number[], callIndex: number) => string = slots =>
  slots.map(n => `## Chapter ${String(n).padStart(2, '0')}: Chapter ${n}\n\nBody for chapter ${n}. Lorem ipsum dolor sit amet.\n`).join('\n')

const FAKE_MODEL = 'genstudio-chat-test-expansion-completion-v1'
const DISPATCH_MODEL = `genstudio-chat:${FAKE_MODEL}`

const fakeProvider: TextProvider = {
  meta: { id: 'genstudio', name: 'Fake the Gateway', apiKeyField: 'genstudio_api_key' as any },
  supportsModel(m: string): boolean { return m === DISPATCH_MODEL },
  async callText(req: TextGenerationRequest): Promise<string> {
    if (req.signal?.aborted) throw new Error('Cancelled by user')
    const ordered: number[] = []
    const seen = new Set<number>()
    for (const match of req.userMessage.matchAll(/^\s*Chapter (\d+):/gm)) {
      const n = parseInt(match[1]!, 10)
      if (!seen.has(n)) { seen.add(n); ordered.push(n) }
    }
    const index = callIndex++
    expansionCalls.push({ slots: ordered, callIndex: index })
    return answerExpansion(ordered, index)
  },
}

before(() => { registry.registerText(fakeProvider) })
after(() => { /* registry has no de-register; tests share the singleton */ })
beforeEach(() => {
  expansionCalls = []
  callIndex = 0
  answerExpansion = slots => slots
    .map(n => `## Chapter ${String(n).padStart(2, '0')}: Chapter ${n}\n\nBody for chapter ${n}. Lorem ipsum dolor sit amet.\n`)
    .join('\n')
})

// ── Fixtures ──────────────────────────────────────────────────────────────

let tmpRoot: string
before(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-expansion-completion-')) })
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })
async function freshDir(): Promise<string> { return fs.mkdtemp(path.join(tmpRoot, 'ep-')) }

function makeJob(): Job {
  return {
    job_id: 'test-job',
    project_slug: 'test-slug',
    type: 'expand_chapters' as any,
    status: 'running',
    output_lines: [],
    params: {} as any,
    created_at: new Date().toISOString(),
  } as any
}

function makeFormat(chaptersIndependent: boolean): Format {
  return {
    id: 'test-format', name: 'Test Format', description: '', builtin: false, schemaVersion: 1,
    idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
    script: {
      systemPromptRole: 'role', additionalRules: [],
      pacingArc: ['Chapter 1: open', 'Chapters 2..{lastButOne}: develop', 'Chapter {last}: close'],
      closingHint: 'end clean',
      defaultChapterCount: 10, chapterCountRange: [3, 100],
      defaultLengthMinutes: 30, lengthMinutesRange: [10, 90],
      narratorStyles: [], defaultNarratorStyleId: '', chaptersIndependent,
    },
    imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [10, 10], defaultThumbnails: 3, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
    metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: '', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 12 } },
  }
}

async function seedOutline(
  scriptDir: string, chapters: number, mode: 'narrative' | 'listicle',
): Promise<void> {
  await writeImportedOutline(
    scriptDir,
    'EP0900',
    Array.from({ length: chapters }, (_, i) => ({ title: `Chapter ${i + 1}` })),
    { mode },
  )
}

function makeParams(
  scriptDir: string,
  expansionBatch?: ExpansionBatchSetting,
  chapterCount = 4,
): ChunkedNarrationParams {
  return {
    episode_id: 'EP0900',
    title: 'Expansion Completion',
    totalChapters: chapterCount,
    wordsPerChapter: 600,
    format: makeFormat(true),
    systemPrompt: 'sys',
    scriptDir,
    model: FAKE_MODEL,
    apiKeys: {},
    ...(expansionBatch ? { expansionBatch } : {}),
  }
}

const fixed = (chapters: number): ExpansionBatchSetting => ({ mode: 'count', chapters, words: 1_800 })

// ── "Chapters per request" respected end to end ───────────────────────────

describe('chapters per request — the channel setting is what runs', () => {
  test('a fixed 1 sends one chapter per request', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 4, 'listicle')
    await expandChapters(makeJob(), makeParams(scriptDir, fixed(1)), { auto_approve: true })
    assert.deepEqual(expansionCalls.map(call => call.slots), [[1], [2], [3], [4]])
  })

  test('a fixed 5 sends five chapters per request, with the remainder last', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 11, 'listicle')
    await expandChapters(makeJob(), makeParams(scriptDir, fixed(5), 11), { auto_approve: true })
    assert.deepEqual(
      expansionCalls.map(call => call.slots),
      [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11]],
    )
  })

  test('by-length groups by the outline\'s own word targets', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 6, 'listicle')
    // 600-word chapters and a 1,200-word budget → two per request.
    await expandChapters(
      makeJob(),
      makeParams(scriptDir, { mode: 'length', chapters: null, words: 1_200 }, 6),
      { auto_approve: true },
    )
    assert.deepEqual(expansionCalls.map(call => call.slots), [[1, 2], [3, 4], [5, 6]])
  })

  test('the run says how it grouped the chapters', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 2, 'listicle')
    const job = makeJob()
    await expandChapters(job, makeParams(scriptDir, fixed(1), 2), { auto_approve: true })
    assert.ok(
      job.output_lines.some(line => /Chapters per request: 1/.test(line)),
      job.output_lines.join('\n'),
    )
  })
})

// ── Provider failure must never read as done ──────────────────────────────

describe('a chapter that was asked for and not written fails the run', () => {
  test('a failed request is reported by name, and the chapters that landed are kept', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 2, 'listicle')
    answerExpansion = (slots) => {
      if (slots.includes(2)) throw new Error('anthropic-direct: the provider returned no content')
      return `## Chapter 01: Chapter 1\n\nBody for chapter 1. Lorem ipsum dolor sit amet.\n`
    }

    await assert.rejects(
      expandChapters(makeJob(), makeParams(scriptDir, fixed(1), 2), { auto_approve: true }),
      /Chapter expansion did not finish: requested chapter\(s\) 2 are missing/,
      'a provider failure must throw, naming the chapter it lost',
    )

    assert.equal(existsSync(chapterFilePath(scriptDir, 'EP0900', 1)), true,
      'the chapter that WAS written stays on disk')
    assert.equal(existsSync(chapterFilePath(scriptDir, 'EP0900', 2)), false)

    const sidecar = await readSidecar(scriptDir, 'EP0900')
    assert.deepEqual(sidecar?.chapters_done, [1], 'only the verified chapter is recorded as done')
  })

  test('Retry asks only for the chapter that is still missing', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 2, 'listicle')
    answerExpansion = (slots) => {
      if (slots.includes(2)) throw new Error('provider down')
      return `## Chapter 01: Chapter 1\n\nBody for chapter 1. Lorem ipsum dolor sit amet.\n`
    }
    await assert.rejects(expandChapters(makeJob(), makeParams(scriptDir, fixed(1), 2), { auto_approve: true }))

    expansionCalls = []
    callIndex = 0
    answerExpansion = slots => slots
      .map(n => `## Chapter ${String(n).padStart(2, '0')}: Chapter ${n}\n\nBody for chapter ${n}. Lorem ipsum dolor sit amet.\n`)
      .join('\n')
    await expandChapters(makeJob(), makeParams(scriptDir, fixed(1), 2), { auto_approve: true })

    assert.deepEqual(expansionCalls.map(call => call.slots), [[2]],
      'the finished chapter is not requested again and cannot be charged again')
    const completion = await inspectChunkedScriptCompletion(scriptDir, 'EP0900')
    assert.deepEqual(completion.missing, [])
  })

  test('a truncated answer keeps the chapters it finished and splits the rest', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 4, 'listicle')
    // Chapters 1 and 2 are closed by their headings and are proof-complete.
    // Chapter 3's block has no closing boundary, so it must not be kept.
    answerExpansion = (_slots, index) => {
      if (index === 0) {
        throw new GenStudioChatIncompleteError({
          id: 'provider-job-truncated-1',
          model_id: FAKE_MODEL,
          output_text: [
            '## Chapter 01: Chapter 1\n\nBody one. Lorem ipsum dolor sit amet.\n',
            '## Chapter 02: Chapter 2\n\nBody two. Lorem ipsum dolor sit amet.\n',
            '## Chapter 03: Chapter 3\n\nBody three, cut off mid-sen',
          ].join('\n'),
          finish_reason: 'max_tokens',
          failure_code: 'CHAT_PROVIDER_INCOMPLETE',
        })
      }
      return _slots
        .map(n => `## Chapter ${String(n).padStart(2, '0')}: Chapter ${n}\n\nBody for chapter ${n}. Lorem ipsum dolor sit amet.\n`)
        .join('\n')
    }

    const job = makeJob()
    await expandChapters(job, makeParams(scriptDir, fixed(4), 4), { auto_approve: true })

    // 1, 2 kept; 3 and 4 re-requested as two smaller requests.
    assert.deepEqual(expansionCalls.map(call => call.slots), [[1, 2, 3, 4], [3], [4]])
    assert.ok(job.output_lines.some(line => /did not fit one answer/.test(line) && /split into smaller requests/.test(line)))
    const completion = await inspectChunkedScriptCompletion(scriptDir, 'EP0900')
    assert.deepEqual(completion.missing, [])
    assert.match(await fs.readFile(chapterFilePath(scriptDir, 'EP0900', 1), 'utf8'), /Body one/)
  })

  test('a single chapter that keeps truncating is named, not silently dropped', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 1, 'listicle')
    answerExpansion = () => {
      throw new GenStudioChatIncompleteError({
        id: 'provider-job-truncated-2',
        model_id: FAKE_MODEL,
        output_text: '## Chapter 01: Chapter 1\n\nCut off mid-sen',
        finish_reason: 'max_tokens',
        failure_code: 'CHAT_PROVIDER_INCOMPLETE',
      })
    }
    await assert.rejects(
      expandChapters(makeJob(), makeParams(scriptDir, fixed(1), 1), { auto_approve: true }),
      /requested chapter\(s\) 1 are missing/,
    )
    assert.equal(existsSync(chapterFilePath(scriptDir, 'EP0900', 1)), false,
      'a chapter with no proven end is never written')
  })
})

// ── The filtered-run rule itself ───────────────────────────────────────────

test('the requested-chapter rule names only chapters this run asked for', () => {
  // A filtered run is allowed to leave the REST of the script unwritten; it is
  // not allowed to leave its own selection unwritten.
  assert.deepEqual(missingRequestedChapters([1, 2], [1, 2, 3, 4, 5, 6, 7, 8]), [1, 2])
  assert.deepEqual(missingRequestedChapters([2], [1, 3]), [])
  assert.deepEqual(missingRequestedChapters([5, 3], [3]), [3], 'the selection\'s own order is kept')
})

// ── chapter-only: a verified write must reach chapters_done ───────────────

describe('a scoped chapter-only write records itself', () => {
  test('a verified chapter is merged into chapters_done', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 8, 'narrative')
    const file = chapterFilePath(scriptDir, 'EP0900', 7)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(file, '## Chapter 7: Seven\n\nA real chapter body worth keeping.\n')

    const job = makeJob()
    const result = await recordVerifiedChapter(job, scriptDir, 'EP0900', 7)
    assert.equal(result.recorded, true)
    const sidecar = await readSidecar(scriptDir, 'EP0900')
    assert.deepEqual(sidecar?.chapters_done, [7], 'KOM3 Chapter 7 was written and left out of this list')
    assert.ok(job.output_lines.some(line => /Chapter 7 is recorded as written/.test(line)))
  })

  test('an empty chapter file is never marked done', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 8, 'narrative')
    const file = chapterFilePath(scriptDir, 'EP0900', 7)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(file, '')

    const job = makeJob()
    const result = await recordVerifiedChapter(job, scriptDir, 'EP0900', 7)
    assert.equal(result.recorded, false)
    assert.match(result.reason || '', /empty or missing/)
    const sidecar = await readSidecar(scriptDir, 'EP0900')
    assert.deepEqual(sidecar?.chapters_done, [])
    assert.equal(job.output_lines.length, 0, 'an unverified write says nothing about progress')
  })

  test('a chapter outside the current outline is never marked done', async () => {
    const scriptDir = await freshDir()
    await seedOutline(scriptDir, 3, 'narrative')
    const file = chapterFilePath(scriptDir, 'EP0900', 9)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(file, '## Chapter 9: Nine\n\nA body from another outline.\n')

    const result = await recordVerifiedChapter(makeJob(), scriptDir, 'EP0900', 9)
    assert.equal(result.recorded, false)
    assert.match(result.reason || '', /not in this episode's outline/)
    assert.deepEqual((await readSidecar(scriptDir, 'EP0900'))?.chapters_done, [])
  })

  test('an episode with no outline sidecar is left alone rather than given one', async () => {
    const scriptDir = await freshDir()
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(chapterFilePath(scriptDir, 'EP0900', 1), '## Chapter 1: One\n\nA body.\n')
    const result = await recordVerifiedChapter(makeJob(), scriptDir, 'EP0900', 1)
    assert.equal(result.recorded, false)
    assert.match(result.reason || '', /no outline progress record/)
    assert.equal(existsSync(sidecarPath(scriptDir, 'EP0900')), false,
      'no outline means nothing to merge into — and no invented sidecar')
  })
})
