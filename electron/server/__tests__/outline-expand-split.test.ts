/**
 * Phase 2 of the outline-first refactor — verify buildOutlineOnly +
 * expandChapters behave correctly when called separately. Reuses the
 * fake-text-provider pattern from chunked-narration-smoke.test.ts so
 * the LLM is never actually invoked.
 *
 * Scenarios covered:
 *   - buildOutlineOnly (no auto_approve) writes sidecar with
 *     outline_approved_at: null (draft state).
 *   - buildOutlineOnly (auto_approve) sets outline_approved_at to now.
 *   - expandChapters refuses (throws) when the outline is unapproved.
 *   - expandChapters with auto_approve bypasses the gate.
 *   - expandChapters with chaptersToExpand: [3, 5] expands only those.
 *   - Per-entry words_per_chapter (v2 schema) renders into the batch
 *     prompt as an explicit Length: line, proving overrides flow end-to-end.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'node:crypto'
import path from 'path'
import os from 'os'
import {
  buildOutlineOnly, expandChapters, sidecarPath,
  type ChunkedNarrationParams, type ChunkedSidecar,
} from '../lib/chunked-narration.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { registry } from '../providers/registry.js'
import type { Job, Format } from '../models/types.js'
import type { TextProvider, TextGenerationRequest } from '../providers/types.js'
import { chapterFilePath, writeChapterFiles } from '../lib/narration-assembly.js'

// ── Fake provider — same shape as chunked-narration-smoke ─────────────────

interface FakeCall { kind: 'outline' | 'expansion'; userMessage: string }
let fakeCalls: FakeCall[] = []
let fakeOutlineResponse: string = '[]'
// The fake expansion is fed the EXACT chapter numbers parsed out of the
// SLOTS block — letting tests exercise non-contiguous selections like
// [3, 5, 7]. The default implementation echoes a tiny body for each slot.
let fakeExpansionFor: (chapterNumbers: number[]) => string = (ns) =>
  ns.map(n => `## Chapter ${String(n).padStart(2, '0')}: Topic ${n}\n\nLorem ipsum.\n`).join('\n')

const FAKE_MODEL = 'genstudio-chat-test-outline-split-v1'
const DISPATCH_MODEL = `genstudio-chat:${FAKE_MODEL}`

const fakeProvider: TextProvider = {
  meta: { id: 'genstudio', name: 'Fake the Gateway', apiKeyField: 'genstudio_api_key' as any },
  supportsModel(m: string): boolean { return m === DISPATCH_MODEL },
  async callText(req: TextGenerationRequest): Promise<string> {
    if (req.signal?.aborted) throw new Error('Cancelled by user')
    const isOutline = /Plan the chapter structure|Plan a listicle/.test(req.userMessage)
    if (isOutline) {
      fakeCalls.push({ kind: 'outline', userMessage: req.userMessage })
      return fakeOutlineResponse
    }
    fakeCalls.push({ kind: 'expansion', userMessage: req.userMessage })
    const slots = [...req.userMessage.matchAll(/^\s*Chapter (\d+):/gm)]
    const seen = new Set<number>()
    const ordered: number[] = []
    for (const m of slots) {
      const n = parseInt(m[1]!, 10)
      if (!seen.has(n)) { seen.add(n); ordered.push(n) }
    }
    if (!ordered.length) return ''
    return fakeExpansionFor(ordered)
  },
}

before(() => { registry.registerText(fakeProvider) })
beforeEach(() => { fakeCalls = [] })

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeJob(scriptDir: string): Job {
  return {
    job_id: 'test-job',
    project_slug: 'test-slug',
    type: 'outline_only' as any,
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

function buildOutlineJson(n: number, mode: 'narrative' | 'listicle'): string {
  const entries = Array.from({ length: n }, (_, i) => {
    if (mode === 'listicle') return { n: i + 1, title: `Topic ${i + 1}`, hook_line: `Hook ${i + 1}` }
    return { n: i + 1, title: `Chapter ${i + 1}`, synopsis: `Synopsis ${i + 1}`, key_beats: ['a', 'b'] }
  })
  return JSON.stringify(entries)
}

function buildExpansionFor(chapterNumbers: number[]): string {
  return chapterNumbers
    .map(n => `## Chapter ${String(n).padStart(2, '0')}: Topic ${n}\n\nThe quick brown fox jumps over the lazy dog. Lorem ipsum.\n`)
    .join('\n')
}

let tmpRoot: string
before(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-outline-split-')) })
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

async function freshDir(): Promise<string> { return fs.mkdtemp(path.join(tmpRoot, 'ep-')) }

test('expansion chapter writes preserve a valid file that already won the path lock', async () => {
  const scriptDir = await freshDir()
  const existing = '## Chapter 10: Existing\n\nHuman-approved bytes stay here.\n'
  const target = chapterFilePath(scriptDir, 'EP0700', 10)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(target, existing)
  const before = await fs.readFile(target)

  await writeChapterFiles(scriptDir, 'EP0700', 'Race fixture', {
    chapters: [{ number: 10, title: 'Late provider result', text: 'This must not replace the existing chapter.' }],
  }, { preserveExisting: true, preserveExistingSince: new Date(0).toISOString() })

  assert.deepEqual(await fs.readFile(target), before)
})

test('expansion chapter writes repair empty files while explicit chapter writes still replace by default', async () => {
  const scriptDir = await freshDir()
  const target = chapterFilePath(scriptDir, 'EP0700', 10)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(target, '')
  const parts = { chapters: [{ number: 10, title: 'Repair', text: 'Repaired chapter body.' }] }
  await writeChapterFiles(scriptDir, 'EP0700', 'Repair fixture', parts, {
    preserveExisting: true, preserveExistingSince: new Date(0).toISOString(),
  })
  assert.match(await fs.readFile(target, 'utf8'), /Repaired chapter body/)

  await writeChapterFiles(scriptDir, 'EP0700', 'Explicit fixture', {
    chapters: [{ number: 10, title: 'Explicit', text: 'Explicit replacement body.' }],
  })
  assert.match(await fs.readFile(target, 'utf8'), /Explicit replacement body/)
})

function makeParams(scriptDir: string, opts: Partial<ChunkedNarrationParams> = {}): ChunkedNarrationParams {
  return {
    episode_id: 'EP0700',
    title: 'Outline Split Test',
    totalChapters: 8,
    wordsPerChapter: 400,
    format: makeFormat('listicle', true),
    systemPrompt: 'sys',
    scriptDir,
    model: FAKE_MODEL,
    apiKeys: {},
    ...opts,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildOutlineOnly — approval state', () => {
  test('without auto_approve, writes sidecar with outline_approved_at: null (draft)', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(5, 'listicle')
    const job = makeJob(scriptDir)

    const result = await buildOutlineOnly(job, makeParams(scriptDir, { totalChapters: 5 }), 'listicle')
    assert.equal(result.outline.length, 5)
    assert.equal(result.fromCache, false)
    assert.equal(result.approved, false, 'fresh outline must NOT be auto-approved')

    // Sidecar on disk reflects the draft state.
    const raw = await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')
    const sidecar = JSON.parse(raw) as ChunkedSidecar
    assert.equal(sidecar.schema_version, 3)
    assert.equal(sidecar.outline_approved_at, null,
      'sidecar must persist outline_approved_at: null when no auto_approve')
    assert.equal(sidecar.outline_edited_at, null)
  })

  test('with auto_approve, sets outline_approved_at to now', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(5, 'listicle')
    const job = makeJob(scriptDir)

    const result = await buildOutlineOnly(
      job,
      makeParams(scriptDir, { totalChapters: 5 }),
      'listicle',
      { auto_approve: true },
    )
    assert.equal(result.approved, true)

    const raw = await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')
    const sidecar = JSON.parse(raw) as ChunkedSidecar
    assert.ok(sidecar.outline_approved_at, 'auto_approve must populate outline_approved_at')
    assert.match(sidecar.outline_approved_at!, /^\d{4}-\d{2}-\d{2}T/, 'must be ISO timestamp')
  })

  test('on resume, auto_approve flips an unapproved cached sidecar to approved', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(5, 'listicle')
    const job = makeJob(scriptDir)

    // First call: no auto_approve → draft.
    await buildOutlineOnly(job, makeParams(scriptDir, { totalChapters: 5 }), 'listicle')
    fakeCalls = []
    // Second call: auto_approve → cached outline reused, approval flipped.
    const result = await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 5 }), 'listicle', { auto_approve: true },
    )
    assert.equal(fakeCalls.length, 0, 'cached outline must NOT trigger a fresh LLM call')
    assert.equal(result.fromCache, true)
    assert.equal(result.approved, true)
    const raw = await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')
    assert.ok(JSON.parse(raw).outline_approved_at, 'sidecar approval must persist')
  })
})

describe('expandChapters — approval gate + selective expansion', () => {
  test('refuses (throws) when outline is unapproved and no auto_approve', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(5, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)

    // Build outline as draft (no auto_approve).
    await buildOutlineOnly(job, makeParams(scriptDir, { totalChapters: 5 }), 'listicle')

    // 1.4.300 — the refusal is the channel's "Outline approved before chapters" safety check on Block.
    const { useTempDataDir } = await import('./_helpers.js')
    const temp = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const project = await pm.createProject({ name: 'Outline Gate Block' })
      await pm.updateConfig(project.slug, { safety_checks: { outline_approved: 'block' } } as any)
      job.project_slug = project.slug

      // Try to expand without approving → must throw with a clear message.
      await assert.rejects(
        expandChapters(job, makeParams(scriptDir, { totalChapters: 5 }), {}),
        /not approved/i,
        'expansion must refuse to run on an unapproved outline',
      )
    } finally {
      await temp.cleanup()
    }
  })

  test('expands only the chapters listed in chaptersToExpand', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(8, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)

    // Build + auto-approve so expansion can run.
    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 8 }), 'listicle', { auto_approve: true },
    )

    const result = await expandChapters(
      job, makeParams(scriptDir, { totalChapters: 8 }),
      { chaptersToExpand: [3, 5, 7] },
    )

    assert.equal(result.chaptersWritten, 3, 'only 3 chapters should be written')
    // Disk reflects: chapters 3, 5, 7 exist; 1, 2, 4, 6, 8 do not.
    for (const n of [3, 5, 7]) {
      assert.equal(
        existsSync(path.join(scriptDir, `EP0700_Chapter_${String(n).padStart(2, '0')}.md`)),
        true,
        `chapter ${n} should exist`,
      )
    }
    for (const n of [1, 2, 4, 6, 8]) {
      assert.equal(
        existsSync(path.join(scriptDir, `EP0700_Chapter_${String(n).padStart(2, '0')}.md`)),
        false,
        `chapter ${n} should NOT exist (not in chaptersToExpand)`,
      )
    }
  })

  test('returns no-op result when all selected chapters are already on disk', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(5, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)

    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 5 }), 'listicle', { auto_approve: true },
    )
    // Expand all once.
    await expandChapters(job, makeParams(scriptDir, { totalChapters: 5 }), {})
    fakeCalls = []
    // Re-expand the same selection — should no-op (no LLM calls).
    const result = await expandChapters(
      job, makeParams(scriptDir, { totalChapters: 5 }),
      { chaptersToExpand: [1, 2] },
    )
    assert.equal(result.chaptersWritten, 5,
      'chaptersWritten counts what is on disk, not just this run')
    assert.equal(fakeCalls.length, 0,
      'all chapters already on disk → no fresh LLM call')
  })

  test('preserves chapters 1–9 byte-for-byte and writes only missing chapters 10–15', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(15, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)
    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 15 }), 'listicle', { auto_approve: true },
    )
    await writeChapterFiles(scriptDir, 'EP0700', 'Existing chapter fixture', {
      chapters: Array.from({ length: 9 }, (_, i) => ({
        number: i + 1,
        title: `Existing ${i + 1}`,
        text: `Existing approved body ${i + 1}.`,
      })),
    })
    const hash = async (n: number) => createHash('sha256')
      .update(await fs.readFile(chapterFilePath(scriptDir, 'EP0700', n)))
      .digest('hex')
    const before = await Promise.all(Array.from({ length: 9 }, (_, i) => hash(i + 1)))

    const result = await expandChapters(job, makeParams(scriptDir, { totalChapters: 15 }), {})

    const after = await Promise.all(Array.from({ length: 9 }, (_, i) => hash(i + 1)))
    assert.deepEqual(after, before)
    assert.equal(result.chaptersWritten, 15)
    const progress = JSON.parse(await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf8'))
    assert.deepEqual(progress.chapters_done, Array.from({ length: 15 }, (_, i) => i + 1))
    for (let n = 10; n <= 15; n++) {
      assert.equal(existsSync(chapterFilePath(scriptDir, 'EP0700', n)), true, `chapter ${n} should be written`)
    }
  })
})

describe('v3 generation_params snapshot (persist + read-back)', () => {
  test('buildOutlineOnly persists params.generationParams to the sidecar', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'listicle')
    const job = makeJob(scriptDir)

    const generationParams = {
      model: FAKE_MODEL,
      length: 30,
      total_words: 7500,
      words_per_chapter: 400,
      style: 'B',
      perspective: 'second-immersive',
      custom_perspective: 'Keep every beat in present tense.',
      character_ids: ['char-narrator'],
      custom_style_text: 'wry, observational',
    }

    await buildOutlineOnly(
      job,
      makeParams(scriptDir, { totalChapters: 3, generationParams }),
      'listicle',
      { auto_approve: true },
    )

    const raw = await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')
    const sidecar = JSON.parse(raw) as ChunkedSidecar
    assert.deepEqual(sidecar.generation_params, generationParams,
      'every field passed via params.generationParams must round-trip through the sidecar — that is the whole point of v3')
  })

  test('omitted generationParams writes generation_params: null (back-compat shape)', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'listicle')
    const job = makeJob(scriptDir)

    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 3 }), 'listicle', { auto_approve: true },
    )

    const raw = await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')
    const sidecar = JSON.parse(raw) as ChunkedSidecar
    assert.equal(sidecar.generation_params, null,
      'absent generationParams must serialise as null so v2-fallback paths in the executor remain identifiable')
  })
})

describe('per-entry words_per_chapter override flows into the prompt', () => {
  test('listicle batch with mixed overrides renders per-slot Length: lines', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)

    // Build outline (auto-approve so we can immediately expand).
    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 3 }), 'listicle', { auto_approve: true },
    )

    // Hand-edit the sidecar to add per-entry overrides — simulates the
    // PUT /outline path the frontend would call. Chapter 1 gets a longer
    // target, chapter 3 a shorter one, chapter 2 stays at the default.
    const sc = JSON.parse(await fs.readFile(sidecarPath(scriptDir, 'EP0700'), 'utf-8')) as ChunkedSidecar
    sc.outline[0]!.words_per_chapter = 800
    sc.outline[2]!.words_per_chapter = 200
    await writeJsonAtomic(sidecarPath(scriptDir, 'EP0700'), sc)

    fakeCalls = []
    await expandChapters(job, makeParams(scriptDir, { totalChapters: 3 }), {})
    const expansionCall = fakeCalls.find(c => c.kind === 'expansion')
    assert.ok(expansionCall, 'expected an expansion call')
    const msg = expansionCall.userMessage
    // Mixed-target case: each slot must get its own "Length: ~N words" line.
    assert.match(msg, /Length:\s*800 words.*min 720, max 920/i,
      'chapter 1 must show its 800-word override with derived min/max')
    assert.match(msg, /Length:\s*200 words.*min 180, max 230/i,
      'chapter 3 must show its 200-word override with derived min/max')
    assert.match(msg, /Length:\s*400 words/i,
      'chapter 2 must show its default 400-word fallback')
    // Header should explain that per-slot Length: lines are binding.
    assert.match(msg, /each chapter has its OWN word target/i,
      'mixed-target prompt must call out the per-slot binding')
  })

  test('uniform batch (no overrides) keeps the simple back-compat prompt shape', async () => {
    const scriptDir = await freshDir()
    fakeOutlineResponse = buildOutlineJson(3, 'listicle')
    fakeExpansionFor = buildExpansionFor
    const job = makeJob(scriptDir)

    await buildOutlineOnly(
      job, makeParams(scriptDir, { totalChapters: 3 }), 'listicle', { auto_approve: true },
    )
    fakeCalls = []
    await expandChapters(job, makeParams(scriptDir, { totalChapters: 3 }), {})
    const expansionCall = fakeCalls.find(c => c.kind === 'expansion')
    assert.ok(expansionCall)
    const msg = expansionCall.userMessage
    // Uniform case: single global PER-CHAPTER LENGTH block, no per-slot
    // Length: lines, no "OWN word target" language.
    assert.doesNotMatch(msg, /Length:\s*\d+ words/,
      'uniform batches must NOT emit per-slot Length: lines')
    assert.doesNotMatch(msg, /each chapter has its OWN word target/i)
    assert.match(msg, /Target:\s*400 words/, 'uniform target must appear in the global block')
  })
})
