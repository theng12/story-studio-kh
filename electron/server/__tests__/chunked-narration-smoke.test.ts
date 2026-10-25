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
  expandChapters,
  inspectChunkedScriptCompletion,
  sidecarPath,
  writeImportedOutline,
} from '../lib/chunked-narration.js'
import { GenStudioChatIncompleteError } from '../lib/genstudio-client.js'
import { registry } from '../providers/registry.js'
import type { Job, Format } from '../models/types.js'
import type { TextProvider, TextGenerationRequest } from '../providers/types.js'

// ── Fake text provider ────────────────────────────────────────────────────
//
// Records every call and returns whatever the test queued under the
// matching `kind`. Outline calls are detected by "Plan the chapter
// structure" / "Plan a listicle"; expansion calls by "Write N chapter(s)".

interface FakeCall {
  kind: 'outline' | 'expansion'
  userMessage: string
  outputBudget?: TextGenerationRequest['outputBudget']
  requestIdentity?: string
  recoverByIdempotencyKey?: boolean
  allowUncreatedRecovery?: boolean
  idempotencyKey?: string
  allowedRecoveryKeys?: string[]
}

let fakeCalls: FakeCall[] = []
let fakeOutlineResponse: string = '[]'
let fakeExpansionFor: (firstChapterN: number, batchSize: number) => string = () => ''
let fakeAbortAfterNCalls: number = Infinity
let fakeIncompleteExpansion: { partialText: string, finishReason: string } | null = null

const FAKE_MODEL = 'genstudio-chat-test-chunked-v1'
const DISPATCH_MODEL = `genstudio-chat:${FAKE_MODEL}`

const fakeProvider: TextProvider = {
  meta: {
    id: 'genstudio',
    name: 'Fake Gateway Provider',
    apiKeyField: 'genstudio_api_key' as any,
  },
  supportsModel(modelId: string): boolean { return modelId === DISPATCH_MODEL },
  async callText(req: TextGenerationRequest): Promise<string> {
    if (req.signal?.aborted) throw new Error('Cancelled by user')
    if (fakeCalls.length >= fakeAbortAfterNCalls) throw new Error('Cancelled by user')
    const isOutline = /Plan the chapter structure|Plan a listicle/.test(req.userMessage)
    if (isOutline) {
      fakeCalls.push({
        kind: 'outline', userMessage: req.userMessage, outputBudget: req.outputBudget, requestIdentity: req.requestIdentity,
        recoverByIdempotencyKey: req.recoverByIdempotencyKey,
        allowUncreatedRecovery: req.allowUncreatedRecovery,
        idempotencyKey: req.idempotencyKey, allowedRecoveryKeys: req.allowedRecoveryKeys,
      })
      return fakeOutlineResponse
    }
    fakeCalls.push({
      kind: 'expansion', userMessage: req.userMessage, outputBudget: req.outputBudget, requestIdentity: req.requestIdentity,
      recoverByIdempotencyKey: req.recoverByIdempotencyKey,
      allowUncreatedRecovery: req.allowUncreatedRecovery,
      idempotencyKey: req.idempotencyKey, allowedRecoveryKeys: req.allowedRecoveryKeys,
    })
    if (fakeIncompleteExpansion) {
      const incomplete = fakeIncompleteExpansion
      fakeIncompleteExpansion = null
      throw new GenStudioChatIncompleteError({
        id: 'chat_incomplete',
        state: 'failed',
        model_id: FAKE_MODEL,
        output_text: incomplete.partialText,
        finish_reason: incomplete.finishReason,
        failure_code: 'CHAT_PROVIDER_INCOMPLETE',
      })
    }
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
  fakeIncompleteExpansion = null
})

// ── Test fixtures ─────────────────────────────────────────────────────────

function makeJob(scriptDir: string): Job {
  return {
    job_id: 'test-job',
    project_slug: 'test-slug',
    type: 'chapter-only' as any,
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
  test('a queue-stamped terminal chat retry scope reaches the replacement expansion request', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    job.genstudio_chat_retry_scope = 'terminal:job-old:story-old'

    await generateNarrativeChunked(job, {
      episode_id: 'EP0001',
      title: 'Test Episode',
      totalChapters: 3,
      wordsPerChapter: 500,
      format: makeFormat('narrative'),
      systemPrompt: 'system',
      scriptDir,
      model: FAKE_MODEL,
      apiKeys: {},
    })

    const expansion = fakeCalls.find(call => call.kind === 'expansion')
    assert.equal(
      expansion?.requestIdentity,
      'test-slug:manual-retry:terminal:job-old:story-old',
      'a deliberate replacement must not replay the terminal provider key',
    )
  })

  test('a queue-stamped exact replay reaches the text provider as recovery-only', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    job.genstudio_chat_recovery = true

    await generateNarrativeChunked(job, {
      episode_id: 'EP0002', title: 'Recovery-only Episode', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'system', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    assert.equal(
      fakeCalls.find(call => call.kind === 'expansion')?.recoverByIdempotencyKey,
      true,
      'an unresolved exact replay must reach the provider as a read-only recovery',
    )
  })

  test('a verified absent normal batch resumes once, preserves completed chapters, then starts later batches normally', async () => {
    const scriptDir = await freshDir()
    const episodeId = 'EPNOTCREATED'
    await writeImportedOutline(scriptDir, episodeId, Array.from({ length: 9 }, (_, index) => ({ title: `Chapter ${index + 1}` })))
    for (const chapter of [1, 2, 3]) {
      await fs.writeFile(path.join(scriptDir, `${episodeId}_Chapter_${String(chapter).padStart(2, '0')}.md`), `## Chapter ${String(chapter).padStart(2, '0')}: Chapter ${chapter}\n\nCompleted before Retry.\n`)
    }
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    job.genstudio_chat_recovery_key = 'story-chat-ss0175-chapters-21-23'
    job.genstudio_chat_recovery_purpose = 'narrative-batch'
    job.genstudio_chat_recovery_chapters = [4, 5, 6]
    job.genstudio_chat_recovery_preview = {
      method: 'POST', path: '/v1/chat/responses', idempotency_key: job.genstudio_chat_recovery_key,
      captured_at: new Date().toISOString(),
    }

    await expandChapters(job, {
      episode_id: episodeId, title: 'Retry continuation', totalChapters: 9, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'system', scriptDir, model: FAKE_MODEL, apiKeys: {},
      genstudioChatRecoveryPreview: job.genstudio_chat_recovery_preview,
    })

    const expansions = fakeCalls.filter(call => call.kind === 'expansion')
    assert.equal(expansions.length, 2)
    assert.equal(expansions[0]?.allowUncreatedRecovery, true)
    assert.equal(expansions[0]?.recoverByIdempotencyKey, false)
    assert.equal(expansions[0]?.idempotencyKey, job.genstudio_chat_recovery_key)
    assert.equal(expansions[1]?.allowUncreatedRecovery, false)
    assert.equal(expansions[1]?.recoverByIdempotencyKey, false)
    assert.match(await fs.readFile(path.join(scriptDir, `${episodeId}_Chapter_01.md`), 'utf8'), /Completed before Retry/)
    for (const chapter of [4, 5, 6, 7, 8, 9]) {
      assert.equal(existsSync(path.join(scriptDir, `${episodeId}_Chapter_${String(chapter).padStart(2, '0')}.md`)), true)
    }
  })

  test('a recovered narrative repair rewrites its original slots even when one partial chapter is already on disk', async () => {
    const scriptDir = await freshDir()
    const episodeId = 'EPREPAIR-RECOVERY'
    await writeImportedOutline(scriptDir, episodeId, [
      { title: 'Chapter 1' }, { title: 'Chapter 2' }, { title: 'Chapter 3' },
    ])
    await fs.writeFile(
      path.join(scriptDir, `${episodeId}_Chapter_01.md`),
      '## Chapter 01: Chapter 1\n\nPartial first chapter from the incomplete original response.\n',
    )
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    job.genstudio_chat_recovery = true
    job.genstudio_chat_recovery_key = 'repair-historic-key'
    job.genstudio_chat_recovery_purpose = 'narrative-repair'
    job.genstudio_chat_recovery_chapters = [1, 2, 3]
    job.genstudio_chat_recovery_keys = ['repair-historic-key']

    await expandChapters(job, {
      episode_id: episodeId, title: 'Recovered repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'system', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    assert.equal(fakeCalls.length, 1, 'recovery makes one exact repair call, not a normal replacement batch')
    assert.equal(fakeCalls[0]?.recoverByIdempotencyKey, true)
    assert.equal(fakeCalls[0]?.idempotencyKey, 'repair-historic-key')
    assert.deepEqual(fakeCalls[0]?.allowedRecoveryKeys, ['repair-historic-key'])
    for (const chapter of [1, 2, 3]) {
      assert.equal(existsSync(path.join(scriptDir, `${episodeId}_Chapter_${String(chapter).padStart(2, '0')}.md`)), true)
    }
  })

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
      apiKeys: {},
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

  test('repairs only omitted chapters after a normal provider finish', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    let expansions = 0
    fakeExpansionFor = (firstN, batchSize) => {
      expansions++
      return expansions === 1
        ? buildExpansionFor(firstN, 1)
        : buildExpansionFor(firstN, batchSize)
    }
    const job = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job, {
      episode_id: 'EPREPAIR1', title: 'Omitted Chapter Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    assert.equal(fakeCalls.filter(call => call.kind === 'expansion').length, 2)
    assert.match(fakeCalls.filter(call => call.kind === 'expansion')[1]!.userMessage, /Chapter 2: Chapter 2/)
    assert.match(fakeCalls.filter(call => call.kind === 'expansion')[1]!.userMessage, /Chapter 3: Chapter 3/)
    assert.doesNotMatch(fakeCalls.filter(call => call.kind === 'expansion')[1]!.userMessage, /Chapter 1: Chapter 1/)
    assert.ok(job.output_lines.some(line => /re-requesting chapters 2, 3 in 1 smaller request/.test(line)))
    assert.equal(result.chaptersWritten, 3)
  })

  test('repairs an uncharged provider-declared truncation without retaining its unproven final block', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    fakeIncompleteExpansion = {
      partialText: buildExpansionFor(1, 1),
      finishReason: 'max_tokens',
    }
    const job = makeJob(scriptDir)
    const result = await generateNarrativeChunked(job, {
      episode_id: 'EPREPAIR2', title: 'Incomplete Provider Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    // 1.4.359 — a truncated batch is HALVED rather than sent one chapter at a
    // time: [1,2,3] becomes [1,2] + [3], so the initial request plus two
    // re-requests. Both smaller requests carry the same published cap.
    assert.equal(fakeCalls.filter(call => call.kind === 'expansion').length, 3)
    assert.deepEqual(
      fakeCalls.filter(call => call.kind === 'expansion').map(call =>
        [...call.userMessage.matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1])).slice(0, 3)),
      [[1, 2, 3], [1, 2], [3]],
      'the unfinished chapters are split, never re-asked as the same batch',
    )
    assert.ok(job.output_lines.some(line => /the provider stopped this answer early \(max_tokens\)/.test(line)))
    assert.ok(job.output_lines.some(line => /Preserved 0 complete chapter\(s\)/.test(line)))
    assert.equal(result.chaptersWritten, 3)
    for (let n = 1; n <= 3; n++) {
      assert.equal(existsSync(path.join(scriptDir, `EPREPAIR2_Chapter_${String(n).padStart(2, '0')}.md`)), true)
    }
  })

  test('does not resubmit a non-truncation provider failure as a chapter repair', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    fakeIncompleteExpansion = {
      partialText: buildExpansionFor(1, 1),
      finishReason: 'content_filter',
    }
    const job = makeJob(scriptDir)

    await assert.rejects(
      generateNarrativeChunked(job, {
        episode_id: 'EPREPAIR-NO-RETRY', title: 'No Provider Retry', totalChapters: 3, wordsPerChapter: 500,
        format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
      }),
      /incomplete chat output \(content_filter\)/i,
    )

    assert.equal(
      fakeCalls.filter(call => call.kind === 'expansion').length,
      1,
      'a non-truncation provider result remains terminal instead of buying a replacement request',
    )
    assert.equal(existsSync(path.join(scriptDir, 'EPREPAIR-NO-RETRY_Chapter_01.md')), false,
      'a terminal provider outcome does not write or preserve partial customer-facing output')
  })

  test('length-truncated batches preserve only proven chapters and repair the final partial slot plus later slots once', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    fakeIncompleteExpansion = {
      // Chapter 1 ends before the next heading, so it is proven complete.
      // The parser can also make a non-empty Chapter 2 block from this cut
      // response, but no response-completion boundary proves that block safe.
      partialText: [
        '## Chapter 01: Chapter 1\n\nCOMPLETE ORIGINAL CHAPTER ONE.\n',
        '## Chapter 02: Chapter 2\n\nUNPROVEN PARTIAL CHAPTER TWO ends mid-sentence',
      ].join('\n'),
      finishReason: 'length',
    }
    const job = makeJob(scriptDir)

    await generateNarrativeChunked(job, {
      episode_id: 'EPREPAIR-LENGTH', title: 'Length Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    const expansionCalls = fakeCalls.filter(call => call.kind === 'expansion')
    assert.equal(expansionCalls.length, 3, 'initial batch plus one bounded repair per unproven or missing chapter')
    const slots = expansionCalls.map(call =>
      [...call.userMessage.matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1])),
    )
    assert.deepEqual(slots, [[1, 2, 3], [2], [3]])
    assert.deepEqual(
      expansionCalls.slice(1).map(call => call.outputBudget),
      ['maximum', 'maximum'],
      'each re-request asks for everything the selected product publishes — never an 8,192 stump (Khmer, 2026-10-25)',
    )
    assert.match(
      await fs.readFile(path.join(scriptDir, 'EPREPAIR-LENGTH_Chapter_01.md'), 'utf8'),
      /COMPLETE ORIGINAL CHAPTER ONE/,
      'the complete chapter from the original response remains on disk and is not overwritten',
    )
    const repairedSecond = await fs.readFile(path.join(scriptDir, 'EPREPAIR-LENGTH_Chapter_02.md'), 'utf8')
    assert.match(repairedSecond, /quick brown fox/)
    assert.doesNotMatch(repairedSecond, /UNPROVEN PARTIAL CHAPTER TWO/)
    assert.ok(job.output_lines.some(line => /the provider stopped this answer early \(length\)/.test(line)))
    assert.ok(job.output_lines.some(line => /re-requesting chapters 2, 3 in 2 smaller request/.test(line)))
  })

  test('a heading-only truncation retains the preceding boundary-proven chapter', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    fakeIncompleteExpansion = {
      // The next heading closes Chapter 1, but Chapter 2 has no body. The
      // parser returns only Chapter 1, which is proven complete and must not
      // be mistaken for the unproven final chapter.
      partialText: [
        '## Chapter 01: Chapter 1\n\nCOMPLETE ORIGINAL CHAPTER ONE.\n',
        '## Chapter 02: Chapter 2',
      ].join('\n'),
      finishReason: 'length',
    }

    await generateNarrativeChunked(makeJob(scriptDir), {
      episode_id: 'EPREPAIR-HEADING', title: 'Heading Boundary Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    const expansionCalls = fakeCalls.filter(call => call.kind === 'expansion')
    const slots = expansionCalls.map(call =>
      [...call.userMessage.matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1])),
    )
    assert.deepEqual(slots, [[1, 2, 3], [2], [3]],
      'Chapter 1 is retained; only the heading-only slot and later missing slot are repaired once')
    assert.match(
      await fs.readFile(path.join(scriptDir, 'EPREPAIR-HEADING_Chapter_01.md'), 'utf8'),
      /COMPLETE ORIGINAL CHAPTER ONE/,
    )
  })

  test('a title-less heading prefix with trailing whitespace closes the preceding chapter', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    fakeExpansionFor = buildExpansionFor
    fakeIncompleteExpansion = {
      // This exact trailing space is normalized away by the chapter parser.
      // It must still be a recognized boundary rather than Chapter 1 prose.
      partialText: '## Chapter 01: Chapter 1\n\nCOMPLETE ORIGINAL CHAPTER ONE.\n\n## Chapter 02: ',
      finishReason: 'length',
    }

    await generateNarrativeChunked(makeJob(scriptDir), {
      episode_id: 'EPREPAIR-HEADING-PREFIX', title: 'Heading Prefix Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })

    const expansionCalls = fakeCalls.filter(call => call.kind === 'expansion')
    const slots = expansionCalls.map(call =>
      [...call.userMessage.matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1])),
    )
    assert.deepEqual(slots, [[1, 2, 3], [2], [3]])
    const first = await fs.readFile(path.join(scriptDir, 'EPREPAIR-HEADING-PREFIX_Chapter_01.md'), 'utf8')
    assert.match(first, /COMPLETE ORIGINAL CHAPTER ONE/)
    assert.doesNotMatch(first, /Chapter 02/, 'the unproven heading prefix is not retained in Chapter 1')
  })

  test('completion and resume reject an unproven final truncation block', async () => {
    const scriptDir = await freshDir()
    const episodeId = 'EPREPAIR-RESUME'
    fakeOutlineResponse = buildOutlineJson(3, 'narrative')
    let leaveSecondMissing = true
    fakeExpansionFor = (firstN, batchSize) => (
      firstN === 2 && leaveSecondMissing ? '' : buildExpansionFor(firstN, batchSize)
    )
    fakeIncompleteExpansion = {
      partialText: [
        '## Chapter 01: Chapter 1\n\nCOMPLETE ORIGINAL CHAPTER ONE.\n',
        '## Chapter 02: Chapter 2\n\nUNPROVEN PARTIAL CHAPTER TWO ends mid-sentence',
      ].join('\n'),
      finishReason: 'length',
    }

    await assert.rejects(
      generateNarrativeChunked(makeJob(scriptDir), {
        episode_id: episodeId, title: 'Length Resume Repair', totalChapters: 3, wordsPerChapter: 500,
        format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
      }),
      /did not pass its completion check; missing 2 after asking for every output token/i,
    )

    assert.equal(existsSync(path.join(scriptDir, `${episodeId}_Chapter_02.md`)), false,
      'an unproven final block is never retained as a resumable chapter')
    const incomplete = await inspectChunkedScriptCompletion(scriptDir, episodeId)
    assert.equal(incomplete.complete, false)
    assert.deepEqual(incomplete.missing, [2])

    fakeCalls = []
    leaveSecondMissing = false
    await expandChapters(makeJob(scriptDir), {
      episode_id: episodeId, title: 'Length Resume Repair', totalChapters: 3, wordsPerChapter: 500,
      format: makeFormat('narrative'), systemPrompt: 'sys', scriptDir, model: FAKE_MODEL, apiKeys: {},
    })
    const resumeSlots = fakeCalls.filter(call => call.kind === 'expansion').map(call =>
      [...call.userMessage.matchAll(/^\s*Chapter (\d+):/gm)].map(match => Number(match[1])),
    )
    assert.deepEqual(resumeSlots, [[2]], 'resume cannot accept the partial file and requests only its unfinished slot')
    assert.match(
      await fs.readFile(path.join(scriptDir, `${episodeId}_Chapter_01.md`), 'utf8'),
      /COMPLETE ORIGINAL CHAPTER ONE/,
      'resume does not overwrite an earlier proven chapter',
    )
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
      model: FAKE_MODEL, apiKeys: {},
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
      model: FAKE_MODEL, apiKeys: {},
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

  test('completion rejects an unapproved outline even when old files match every slot', async () => {
    const scriptDir = await freshDir()
    const episodeId = 'EP0045'
    await writeImportedOutline(
      scriptDir,
      episodeId,
      Array.from({ length: 15 }, (_, i) => ({ title: `Draft chapter ${i + 1}` })),
    )
    const progressPath = sidecarPath(scriptDir, episodeId)
    const draft = JSON.parse(await fs.readFile(progressPath, 'utf-8'))
    draft.outline_approved_at = null
    draft.chapters_done = []
    await fs.writeFile(progressPath, JSON.stringify(draft, null, 2))
    await fs.writeFile(path.join(scriptDir, `${episodeId}_Script_Narration.md`), '# older narration')
    for (let n = 1; n <= 15; n++) {
      await fs.writeFile(
        path.join(scriptDir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}.md`),
        `## Chapter ${n}: Older chapter ${n}\n\nBody`,
      )
    }

    const completion = await inspectChunkedScriptCompletion(scriptDir, episodeId)
    assert.equal(completion.approved, false)
    assert.equal(completion.present, 15)
    assert.deepEqual(completion.missing, [])
    assert.equal(completion.complete, false, 'draft outline supersedes matching older files')
    assert.equal(completion.resumable, false)
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
      model: FAKE_MODEL, apiKeys: {},
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
      model: FAKE_MODEL, apiKeys: {},
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
        model: FAKE_MODEL, apiKeys: {},
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
      model: FAKE_MODEL, apiKeys: {},
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
      model: FAKE_MODEL, apiKeys: {},
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
      model: FAKE_MODEL, apiKeys: {},
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
