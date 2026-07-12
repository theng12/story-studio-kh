/**
 * End-to-end smoke test for chunked narration (v1.0.71+).
 *
 * Registers a fake text provider that returns canned responses for
 * outline + expansion calls, then runs `generateNarrativeChunked` /
 * `generateListicleChunked` against a temp working dir. Verifies:
 *   - outline JSON parsed into the sidecar
 *   - per-batch expansion calls are issued in the right shape
 *   - per-chapter docx files land on disk after each batch
 *   - sidecar.chapters_done updates incrementally
 *   - resume skips chapters already on disk + uses cached outline
 *   - cancel mid-run stops further calls; sidecar reflects partial work
 *
 * No real LLM cost. Locks the load-bearing seams of the chunked
 * pipeline so the bulk path doesn't drift in silence.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import {
  generateNarrativeChunked,
  generateListicleChunked,
  inspectChunkedScriptCompletion,
  sidecarPath,
  writeImportedOutline,
} from '../lib/chunked-narration.js'
import { registry } from '../providers/registry.js'
import type { Job, Format } from '../models/types.js'
import type { TextProvider, TextGenerationRequest } from '../providers/types.js'

// ── Fake text provider ────────────────────────────────────────────────────
//
// Records every call and returns whatever the test queued under the
// matching `kind`. Outline calls are detected by "Plan the chapter
// structure" / "Plan a listicle"; expansion calls by "Write N chapter(s)".

interface FakeCall { kind: 'outline' | 'expansion'; userMessage: string }

let fakeCalls: FakeCall[] = []
let fakeOutlineResponse: string = '[]'
let fakeExpansionFor: (firstChapterN: number, batchSize: number) => string = () => ''
let fakeAbortAfterNCalls: number = Infinity

const FAKE_MODEL = 'fake-test-model'

const fakeProvider: TextProvider = {
  meta: {
    id: 'fake-test-provider',
    name: 'Fake Test Provider',
    apiKeyField: 'anthropic_api_key' as any,
  },
  supportsModel(modelId: string): boolean { return modelId === FAKE_MODEL },
  async callText(req: TextGenerationRequest): Promise<string> {
    if (req.signal?.aborted) throw new Error('Cancelled by user')
    if (fakeCalls.length >= fakeAbortAfterNCalls) throw new Error('Cancelled by user')
    const isOutline = /Plan the chapter structure|Plan a listicle/.test(req.userMessage)
    if (isOutline) {
      fakeCalls.push({ kind: 'outline', userMessage: req.userMessage })
      return fakeOutlineResponse
    }
    fakeCalls.push({ kind: 'expansion', userMessage: req.userMessage })
    // Parse the SLOTS block — narrative + listicle prompts both render
    // their batch slots as "  Chapter N: Title" lines (no ##) under a
    // "SLOTS TO WRITE NOW:" / "SLOTS TO WRITE:" heading. The OUTPUT
    // template at the bottom of the prompt only shows the first 2
    // anchors literally, so counting `## Chapter N:` anchors would
    // under-report batch size.
    const slotMatches = [...req.userMessage.matchAll(/^\s*Chapter (\d+):/gm)]
    // De-dupe by chapter number so synopsis lines / repeat references
    // don't inflate the count.
    const seen = new Set<number>()
    const ordered: number[] = []
    for (const m of slotMatches) {
      const n = parseInt(m[1]!, 10)
      if (!seen.has(n)) { seen.add(n); ordered.push(n) }
    }
    if (!ordered.length) return ''
    const firstN = ordered[0]!
    const batchSize = ordered.length
    return fakeExpansionFor(firstN, batchSize)
  },
}

before(() => { registry.registerText(fakeProvider) })
after(() => { /* registry has no de-register; tests share the singleton */ })
beforeEach(() => {
  fakeCalls = []
  fakeAbortAfterNCalls = Infinity
})

// ── Test fixtures ─────────────────────────────────────────────────────────

function makeJob(scriptDir: string): Job {
  return {
    job_id: 'test-job',
    project_slug: 'test-slug',
    type: 'script-only' as any,
    status: 'running',
    output_lines: [],
    params: {} as any,
    created_at: new Date().toISOString(),
  } as any
}

function makeFormat(id: string, chaptersIndependent = false): Format {
  return {
    id, name: id, description: '', builtin: false, schemaVersion: 1,
    idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
    script: {
      systemPromptRole: 'role',
      additionalRules: [],
      pacingArc: ['Chapter 1: open', 'Chapters 2..{lastButOne}: develop', 'Chapter {last}: close'],
      closingHint: 'end clean',
      defaultChapterCount: 10, chapterCountRange: [3, 100],
      defaultLengthMinutes: 30, lengthMinutesRange: [10, 90],
      narratorStyles: [], defaultNarratorStyleId: '',
      chaptersIndependent,
    },
    imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [10, 10], defaultThumbnails: 3, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
    metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: 'MUSIC', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 12 } },
  }
}

function buildOutlineJson(n: number, mode: 'narrative' | 'listicle'): string {
  const entries = Array.from({ length: n }, (_, i) => {
    if (mode === 'listicle') {
      return { n: i + 1, title: `Topic ${i + 1}`, hook_line: `Hook for ${i + 1}` }
    }
    return { n: i + 1, title: `Chapter ${i + 1}`, synopsis: `Synopsis ${i + 1}`, key_beats: ['a', 'b'] }
  })
  return JSON.stringify(entries)
}

function buildExpansionFor(firstN: number, batchSize: number): string {
  const blocks: string[] = []
  for (let i = 0; i < batchSize; i++) {
    const n = firstN + i
    blocks.push(`## Chapter ${String(n).padStart(2, '0')}: Chapter ${n}\n\nThe quick brown fox jumps over the lazy dog. Lorem ipsum.\n`)
  }
  return blocks.join('\n')
}

let tmpRoot: string

before(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-chunked-smoke-')) })
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'ep-'))
  return dir
}

// ── Smoke tests ────────────────────────────────────────────────────────────

describe('generateNarrativeChunked — end-to-end with fake provider', () => {
  test('outline + 4 batches × 3 chapters lands all 12 chapters on disk', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(12, 'narrative')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job, {
      episode_id: 'EP0001',
      title: 'Test Episode',
      totalChapters: 12,
      wordsPerChapter: 500,
      format: makeFormat('narrative'),
      systemPrompt: 'system',
      scriptDir,
      model: FAKE_MODEL,
      apiKeys: { anthropic_api_key: 'fake' },
    })

    // 12 chapters / batch size 3 = 4 expansion calls + 1 outline call.
    assert.equal(fakeCalls.filter(c => c.kind === 'outline').length, 1)
    assert.equal(fakeCalls.filter(c => c.kind === 'expansion').length, 4)
    assert.equal(result.chaptersWritten, 12)
    assert.equal(result.totalBatches, 4)
    // Every chapter docx is on disk.
    for (let n = 1; n <= 12; n++) {
      assert.equal(existsSync(path.join(scriptDir, `EP0001_Chapter_${String(n).padStart(2, '0')}.md`)), true,
        `chapter ${n} docx should exist`)
    }
    // Sidecar reflects the final state.
    const sidecar = JSON.parse(await fs.readFile(sidecarPath(scriptDir, 'EP0001'), 'utf-8'))
    assert.equal(sidecar.mode, 'narrative')
    assert.equal(sidecar.chapters_done.length, 12)
    assert.equal(sidecar.outline.length, 12)
  })

  test('resume skips chapters already on disk + reuses cached outline', async () => {
    const scriptDir = await freshDir()
    // First run: generate 6 chapters fresh.
    fakeOutlineResponse = buildOutlineJson(6, 'narrative')
    fakeExpansionFor = buildExpansionFor
    const job1 = makeJob(scriptDir)
    await generateNarrativeChunked(job1, {
      episode_id: 'EP0042', title: 'Resume Test', totalChapters: 6, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    const callsRun1 = fakeCalls.length
    assert.ok(callsRun1 > 0, 'first run made calls')

    // Simulate a crash after chapter 6 landed but before its sidecar update.
    // Disk must win: resume heals progress instead of overwriting chapter 6.
    const progressPath = sidecarPath(scriptDir, 'EP0042')
    const staleProgress = JSON.parse(await fs.readFile(progressPath, 'utf-8'))
    staleProgress.chapters_done = staleProgress.chapters_done.filter((n: number) => n !== 6)
    await fs.writeFile(progressPath, JSON.stringify(staleProgress, null, 2))

    // Reset call log; second run must NOT call the LLM (everything's done on disk).
    fakeCalls = []
    const job2 = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job2, {
      episode_id: 'EP0042', title: 'Resume Test', totalChapters: 6, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    assert.equal(fakeCalls.length, 0, 'fully-completed run does no LLM calls on resume')
    assert.equal(result.fromResume, true)
    assert.equal(result.chaptersWritten, 6)
    const healedProgress = JSON.parse(await fs.readFile(progressPath, 'utf-8'))
    assert.deepEqual(healedProgress.chapters_done, [1, 2, 3, 4, 5, 6])
  })

  test('completion rejects a unified 12/15 script and identifies exact missing chapters', async () => {
    const scriptDir = await freshDir()
    const episodeId = 'EP0035'
    await writeImportedOutline(
      scriptDir,
      episodeId,
      Array.from({ length: 15 }, (_, i) => ({ title: `Chapter ${i + 1}` })),
    )
    await fs.writeFile(path.join(scriptDir, `${episodeId}_Script_Narration.md`), '# partial narration')
    for (let n = 1; n <= 12; n++) {
      await fs.writeFile(
        path.join(scriptDir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}.md`),
        `## Chapter ${n}: Chapter ${n}\n\nBody`,
      )
    }

    const partial = await inspectChunkedScriptCompletion(scriptDir, episodeId)
    assert.equal(partial.complete, false)
    assert.equal(partial.expected, 15)
    assert.equal(partial.present, 12)
    assert.deepEqual(partial.missing, [13, 14, 15])
    assert.equal(partial.resumable, true)

    for (let n = 13; n <= 15; n++) {
      await fs.writeFile(
        path.join(scriptDir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}.md`),
        `## Chapter ${n}: Chapter ${n}\n\nBody`,
      )
    }
    const complete = await inspectChunkedScriptCompletion(scriptDir, episodeId)
    assert.equal(complete.complete, true)
    assert.deepEqual(complete.missing, [])
  })

  test('resume re-generates a chapter whose docx is zero-byte (crash mid-write guard)', async () => {
    // Regression: A crash / ENOSPC / kill -9 mid-write can leave a 0-byte
    // chapter docx on disk while the sidecar still claims the chapter is
    // done. Pre-fix, resume's `existsSync` would revive the empty file as
    // "done" and the assembler would silently ship an empty chapter.
    // Post-fix, the resume verification rejects the 0-byte file, drops it
    // from chapters_done, and re-issues the expansion call.
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(6, 'narrative')
    fakeExpansionFor = buildExpansionFor
    const job1 = makeJob(scriptDir)
    await generateNarrativeChunked(job1, {
      episode_id: 'EP0500', title: 'Zero Byte Test', totalChapters: 6, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    // Truncate chapter 4's docx — simulates the file system flushing the
    // metadata but not the content before the crash. File exists but is
    // 0 bytes.
    const ch4Path = path.join(scriptDir, 'EP0500_Chapter_04.md')
    assert.equal(existsSync(ch4Path), true, 'chapter 4 should exist after first run')
    await fs.writeFile(ch4Path, '')
    const truncatedSize = (await fs.stat(ch4Path)).size
    assert.equal(truncatedSize, 0)

    fakeCalls = []
    const job2 = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job2, {
      episode_id: 'EP0500', title: 'Zero Byte Test', totalChapters: 6, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    // Post-fix: resume notices chapter 4 is 0 bytes, drops it, re-runs
    // exactly that batch (chapters 4-6 in batch size 3).
    assert.equal(fakeCalls.filter(c => c.kind === 'outline').length, 0,
      'outline is cached in the sidecar — no fresh outline call on resume')
    assert.ok(fakeCalls.filter(c => c.kind === 'expansion').length >= 1,
      'at least one expansion call must re-run for the missing chapter')
    // Chapter 4 is non-zero again after the re-run.
    const finalSize = (await fs.stat(ch4Path)).size
    assert.ok(finalSize > 0, `chapter 4 should be re-written; size now ${finalSize}`)
    assert.equal(result.chaptersWritten, 6)
  })

  test('partial cancel + resume: aborted after batch 2 picks up at batch 3', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(9, 'narrative')
    fakeExpansionFor = buildExpansionFor
    // Outline call (1) + 2 expansion calls = 3 total before "cancel".
    fakeAbortAfterNCalls = 3

    const job1 = makeJob(scriptDir)
    await assert.rejects(
      generateNarrativeChunked(job1, {
        episode_id: 'EP0099', title: 'Cancel Test', totalChapters: 9, wordsPerChapter: 500,
        format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
        model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
      }),
      /Cancelled by user/,
    )
    // Sidecar should record the 6 chapters from the 2 successful batches.
    const sidecar = JSON.parse(await fs.readFile(sidecarPath(scriptDir, 'EP0099'), 'utf-8'))
    assert.equal(sidecar.chapters_done.length, 6)

    // Resume: removes the abort, lets all remaining calls run.
    fakeAbortAfterNCalls = Infinity
    fakeCalls = []
    const job2 = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job2, {
      episode_id: 'EP0099', title: 'Cancel Test', totalChapters: 9, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    // 9 - 6 = 3 chapters left, batch size 3 = 1 expansion call. NO outline
    // call (cached in the sidecar from run 1).
    assert.equal(fakeCalls.filter(c => c.kind === 'outline').length, 0)
    assert.equal(fakeCalls.filter(c => c.kind === 'expansion').length, 1)
    assert.equal(result.chaptersWritten, 9)
    assert.equal(result.fromResume, true)
  })
})

describe('generateListicleChunked — end-to-end with fake provider', () => {
  test('parallel batches produce all chapters in deterministic on-disk order', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(24, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    const result = await generateListicleChunked(job, {
      episode_id: 'EP1001', title: 'Listicle Test',
      totalChapters: 24, wordsPerChapter: 400,
      format: makeFormat('listicle', /* chaptersIndependent */ true),
      systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    // 24 / 8 = 3 expansion batches.
    assert.equal(fakeCalls.filter(c => c.kind === 'outline').length, 1)
    assert.equal(fakeCalls.filter(c => c.kind === 'expansion').length, 3)
    assert.equal(result.chaptersWritten, 24)
    // Every chapter docx exists. Order is irrelevant for correctness
    // (assembly sorts by `n`); we assert presence not call sequence.
    for (let n = 1; n <= 24; n++) {
      assert.equal(existsSync(path.join(scriptDir, `EP1001_Chapter_${String(n).padStart(2, '0')}.md`)), true)
    }
  })

  test('listicle batch prompt encodes a binding word floor, not a soft target', async () => {
    // Regression: pre-fix, the prompt said "Per-chapter target: ${N} words"
    // with a "[~${N} words]" sentinel and structural rules (1-2 sentence hook,
    // 2-4 beats, 1-2 sentence payoff). LLMs treated those as soft hints and
    // shipped 200-250 word chapters when asked for 500. The fix encodes a
    // hard minimum, an explicit per-section budget, and a beat count that
    // scales with the target so the structure can actually accommodate the
    // requested length. This test locks the new shape in so a "cleanup"
    // refactor can't silently revert to the soft-target prompt.
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(8, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    await generateListicleChunked(job, {
      episode_id: 'EP1500', title: 'Word Budget Test',
      totalChapters: 8, wordsPerChapter: 500,
      format: makeFormat('listicle', /* chaptersIndependent */ true),
      systemPrompt: 'sys', scriptDir,
      model: FAKE_MODEL, apiKeys: { anthropic_api_key: 'fake' },
    })
    const expansionCall = fakeCalls.find(c => c.kind === 'expansion')
    assert.ok(expansionCall, 'expected at least one expansion call')
    const userMsg = expansionCall.userMessage
    // Hard floor: 90% of 500 = 450
    assert.match(userMsg, /Minimum:\s*450 words/, 'must encode hard 450-word floor')
    // Budget breakdown should appear, with hook + body + payoff allocations
    assert.match(userMsg, /Hook \(open\)/, 'must allocate words to the hook')
    assert.match(userMsg, /Body \(\d+ supporting beats\)/, 'must allocate words across N body beats')
    assert.match(userMsg, /Micro-payoff \(close\)/, 'must allocate words to the close')
    // The bracketed [~N words] sentinel that confused the model must be gone
    assert.doesNotMatch(userMsg, /\[~\d+ words\]/,
      'the bracketed [~N words] sentinel must not appear — it confused the LLM into shipping stub chapters')
    // Floor must be reiterated in the rules block
    assert.match(userMsg, /at least 450 words/i, 'rules block must restate the 450-word floor')
  })
})
