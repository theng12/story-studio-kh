/**
 * Chunked-narration sidecar I/O + path helpers (v1.0.71+).
 *
 * The sidecar is the source of truth for "how far did we get?" and drives
 * cancel / resume / crash-recovery for chunked LLM runs. These tests lock
 * the file path convention and the resume contract (params_hash matching)
 * without spinning up a real LLM.
 *
 * The full orchestration (outline + expansion + per-chapter writes) is
 * exercised end-to-end in the existing pipeline integration tests; this
 * suite covers the small, sharp seams that are easy to break in isolation.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { sidecarPath, type ChunkedSidecar } from '../lib/chunked-narration.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-chunked-narration-test-'))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('chunked-narration sidecar path', () => {
  test('sidecarPath stays inside the supplied scriptDir, named by episode_id', () => {
    const p = sidecarPath('/some/dir', 'EP0042')
    assert.equal(p, '/some/dir/EP0042_chunked-progress.json')
  })

  test('different episode ids land at different paths in the same dir', () => {
    const a = sidecarPath('/some/dir', 'EP0001')
    const b = sidecarPath('/some/dir', 'EP0002')
    assert.notEqual(a, b)
  })
})

describe('chunked-narration sidecar JSON shape', () => {
  test('round-trips a populated v3 sidecar through atomic-write', async () => {
    const sidecar: ChunkedSidecar = {
      schema_version: 3,
      episode_id: 'EP0042',
      mode: 'narrative',
      total_chapters: 30,
      outline: [
        { n: 1, title: 'The First Hour', synopsis: 'Setting and tone', key_beats: ['arrive', 'observe', 'settle'] },
        { n: 2, title: 'The Second Hour', synopsis: 'Companion arrives', key_beats: ['greeting', 'shared task'], words_per_chapter: 800 },
      ],
      outline_completed_at: '2026-05-06T01:00:00.000Z',
      outline_approved_at: '2026-05-06T01:05:00.000Z',
      outline_edited_at: null,
      generation_params: {
        model: 'claude-sonnet-4-6',
        length: 30,
        total_words: 7500,
        words_per_chapter: 250,
        pattern_id: 'pat-true-crime',
        pattern_subject: 'Lighthouse keepers',
        character_ids: ['char-narrator'],
      },
      chapters_done: [1, 2, 3, 4, 5],
      params_hash: 'abc123def456abcd',
      last_updated: '2026-05-06T01:23:45.000Z',
    }
    const target = sidecarPath(tmpDir, 'EP0042')
    await writeJsonAtomic(target, sidecar)

    const raw = await fs.readFile(target, 'utf-8')
    const parsed = JSON.parse(raw) as ChunkedSidecar
    assert.equal(parsed.schema_version, 3)
    assert.equal(parsed.generation_params?.model, 'claude-sonnet-4-6',
      'persisted generation_params.model must round-trip — that field is the load-bearing fix for the EP0002 expand crash')
    assert.equal(parsed.generation_params?.words_per_chapter, 250)
    assert.deepEqual(parsed.generation_params?.character_ids, ['char-narrator'])
    assert.equal(parsed.mode, 'narrative')
    assert.equal(parsed.total_chapters, 30)
    assert.deepEqual(parsed.chapters_done, [1, 2, 3, 4, 5])
    assert.equal(parsed.outline.length, 2)
    assert.equal(parsed.outline[0].title, 'The First Hour')
    assert.equal(parsed.outline[1].words_per_chapter, 800,
      'per-entry word override must round-trip through JSON')
    assert.equal(parsed.outline_approved_at, '2026-05-06T01:05:00.000Z')
    assert.equal(parsed.outline_edited_at, null)
    assert.equal(parsed.params_hash, 'abc123def456abcd')
  })

  test('listicle sidecar uses hook_line + key_facts shape on outline entries', async () => {
    const sidecar: ChunkedSidecar = {
      schema_version: 3,
      episode_id: 'EP0099',
      mode: 'listicle',
      total_chapters: 100,
      outline: [
        { n: 1, title: 'Why Sleep Paralysis Feels So Real', hook_line: 'Your body is, briefly, both awake and asleep.', key_facts: ['REM atonia', 'hypnagogic visions', 'evolutionary roots'] },
      ],
      outline_completed_at: '2026-05-06T01:00:00.000Z',
      outline_approved_at: null,  // unapproved listicle outline (draft mode)
      outline_edited_at: null,
      generation_params: null,
      chapters_done: [],
      params_hash: 'feedface0badcafe',
      last_updated: '2026-05-06T01:00:00.000Z',
    }
    const target = sidecarPath(tmpDir, 'EP0099')
    await writeJsonAtomic(target, sidecar)

    const parsed = JSON.parse(await fs.readFile(target, 'utf-8')) as ChunkedSidecar
    assert.equal(parsed.mode, 'listicle')
    assert.equal(parsed.outline_approved_at, null,
      'unapproved outlines must round-trip with null approval timestamp')
    assert.equal(parsed.outline[0].hook_line, 'Your body is, briefly, both awake and asleep.')
    assert.deepEqual(parsed.outline[0].key_facts, ['REM atonia', 'hypnagogic visions', 'evolutionary roots'])
  })
})

describe('chunked-narration sidecar contract', () => {
  test('schema_version=3 is the current schema; v1 + v2 sidecars auto-upgrade on read', () => {
    // The current ChunkedSidecar type pins schema_version to 3. v1 sidecars
    // (pre-outline-review) and v2 sidecars (no generation_params yet) are
    // auto-upgraded by readSidecar in-memory. v3 adds the generation_params
    // snapshot so expand-chapters can re-derive its inputs from disk
    // instead of depending on the request body.
    const minimal: ChunkedSidecar = {
      schema_version: 3,
      episode_id: 'EP0001',
      mode: 'narrative',
      total_chapters: 30,
      outline: [],
      outline_completed_at: '',
      outline_approved_at: null,
      outline_edited_at: null,
      generation_params: null,
      chapters_done: [],
      params_hash: '',
      last_updated: '',
    }
    assert.equal(minimal.schema_version, 3)
  })
})

// ── Schema migrations ─────────────────────────────────────────────────────
//
// Pre-existing projects on disk may be at v1 (no outline_approved_at /
// outline_edited_at) or v2 (no generation_params). readSidecar auto-upgrades
// both in memory so the rest of the pipeline always sees v3 — the next
// writeSidecar call persists the upgrade. No data loss; in-flight outlines
// keep working through the schema bump (with generation_params: null
// triggering the request-body fallback in the expand executor).

describe('chunked-narration sidecar — v1 → v3 migration', () => {
  test('v1 sidecar on disk reads as v3 with outline_approved_at populated + generation_params null', async () => {
    // Write a raw v1 sidecar (the shape that exists on every machine that
    // ran a chunked listicle before the outline-review refactor).
    const v1Raw = {
      schema_version: 1,
      episode_id: 'EP0500',
      mode: 'listicle',
      total_chapters: 5,
      outline: [
        { n: 1, title: 'First topic', hook_line: 'Hook 1' },
        { n: 2, title: 'Second topic', hook_line: 'Hook 2' },
      ],
      outline_completed_at: '2026-05-01T12:00:00.000Z',
      chapters_done: [1],
      params_hash: 'v1hash00000000aa',
      last_updated: '2026-05-01T12:30:00.000Z',
    }
    const target = sidecarPath(tmpDir, 'EP0500')
    await fs.writeFile(target, JSON.stringify(v1Raw), 'utf-8')

    // The lookup must succeed (v1 sidecar didn't break the read) and the
    // returned entry must have the right title — proving v1 data flowed
    // through the migration intact.
    const { getOutlineEntryForChapter, readSidecar } = await import('../lib/chunked-narration.js')
    const lookup = await getOutlineEntryForChapter(tmpDir, 'EP0500', 2)
    assert.ok(lookup, 'v1 sidecar must read successfully after migration')
    assert.equal(lookup!.entry.title, 'Second topic')
    assert.equal(lookup!.entry.hook_line, 'Hook 2')
    assert.equal(lookup!.mode, 'listicle')
    assert.equal(lookup!.totalChapters, 5)
    // Direct readSidecar verification: schema bumped to 3, generation_params null.
    const upgraded = await readSidecar(tmpDir, 'EP0500')
    assert.ok(upgraded)
    assert.equal(upgraded!.schema_version, 3, 'v1 must upgrade through to v3')
    assert.equal(upgraded!.generation_params, null,
      'v1 has no generation_params — upgrade leaves it null and the executor falls back to req fields')
  })
})

describe('chunked-narration sidecar — v2 → v3 migration', () => {
  test('v2 sidecar on disk reads as v3 with generation_params: null', async () => {
    // v2 sidecars (post outline-review feature, pre generation_params) are
    // the most common shape on disk for users who upgraded mid-Phase 3.
    const v2Raw = {
      schema_version: 2,
      episode_id: 'EP0501',
      mode: 'listicle',
      total_chapters: 3,
      outline: [
        { n: 1, title: 'Topic one', hook_line: 'h1' },
        { n: 2, title: 'Topic two', hook_line: 'h2' },
        { n: 3, title: 'Topic three', hook_line: 'h3' },
      ],
      outline_completed_at: '2026-05-04T10:00:00.000Z',
      outline_approved_at: '2026-05-04T10:05:00.000Z',
      outline_edited_at: null,
      chapters_done: [],
      params_hash: 'v2hash00000000bb',
      last_updated: '2026-05-04T10:05:00.000Z',
    }
    const target = sidecarPath(tmpDir, 'EP0501')
    await fs.writeFile(target, JSON.stringify(v2Raw), 'utf-8')

    const { readSidecar } = await import('../lib/chunked-narration.js')
    const upgraded = await readSidecar(tmpDir, 'EP0501')
    assert.ok(upgraded, 'v2 sidecar must read successfully after migration')
    assert.equal(upgraded!.schema_version, 3, 'v2 must upgrade to v3')
    assert.equal(upgraded!.generation_params, null,
      'v2 has no generation_params — upgrade leaves it null and the executor falls back to req fields')
    // All v2 fields preserved through the upgrade.
    assert.equal(upgraded!.outline_approved_at, '2026-05-04T10:05:00.000Z')
    assert.equal(upgraded!.outline.length, 3)
    assert.equal(upgraded!.params_hash, 'v2hash00000000bb')
  })
})
