/**
 * Phase 1 of the outline-first refactor — chapter-only regeneration must
 * read the chunked-progress sidecar and thread the original outline entry
 * (title, hook, key_facts for listicle / synopsis, key_beats for narrative)
 * back into the regen prompt. Pre-fix, regenerating listicle Chapter 5
 * silently drifted to a brand-new topic because the LLM only knew "this
 * is chapter 5" — the original topic title was on disk but never read.
 *
 * These tests cover the lookup helper directly; the prompt-assembly side
 * is covered by reading the modified episode.ts logic and the manual
 * regen test in the verification plan. The helper is the load-bearing
 * piece — if it returns the right entry, the prompt assembly is a simple
 * template substitution.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { getOutlineEntryForChapter, sidecarPath, type ChunkedSidecar } from '../lib/chunked-narration.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-chapter-only-outline-'))
})
after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('getOutlineEntryForChapter — listicle sidecar', () => {
  test('returns the matching entry with hook + key_facts for the requested chapter', async () => {
    const sidecar: ChunkedSidecar = {
      schema_version: 1,
      episode_id: 'EP0001',
      mode: 'listicle',
      total_chapters: 3,
      outline: [
        { n: 1, title: 'Why sleep paralysis feels real', hook_line: 'Your body is briefly both awake and asleep.', key_facts: ['REM atonia', 'hypnagogic visions'] },
        { n: 2, title: 'The placebo effect that fooled doctors', hook_line: 'A sugar pill outperformed real surgery.', key_facts: ['1959 trial', 'sham incisions'] },
        { n: 3, title: 'How a turtle finds the same beach 30 years later', hook_line: 'Magnetic field memory imprinted at birth.', key_facts: ['geomagnetic imprinting', 'natal homing'] },
      ],
      outline_completed_at: '2026-05-07T01:00:00.000Z',
      chapters_done: [],
      params_hash: 'abc123def4567890',
      last_updated: '2026-05-07T01:00:00.000Z',
    }
    await writeJsonAtomic(sidecarPath(tmpDir, 'EP0001'), sidecar)

    const lookup = await getOutlineEntryForChapter(tmpDir, 'EP0001', 2)
    assert.ok(lookup, 'lookup returned null when sidecar was on disk')
    assert.equal(lookup!.mode, 'listicle')
    assert.equal(lookup!.totalChapters, 3)
    assert.equal(lookup!.entry.n, 2)
    assert.equal(lookup!.entry.title, 'The placebo effect that fooled doctors')
    assert.equal(lookup!.entry.hook_line, 'A sugar pill outperformed real surgery.')
    assert.deepEqual(lookup!.entry.key_facts, ['1959 trial', 'sham incisions'])
  })

  test('returns null when chapter number is not in the outline (off-by-one / mismatched count)', async () => {
    const lookup = await getOutlineEntryForChapter(tmpDir, 'EP0001', 99)
    assert.equal(lookup, null)
  })
})

describe('getOutlineEntryForChapter — narrative sidecar', () => {
  test('returns synopsis + key_beats for narrative-mode regen', async () => {
    const sidecar: ChunkedSidecar = {
      schema_version: 1,
      episode_id: 'EP0042',
      mode: 'narrative',
      total_chapters: 3,
      outline: [
        { n: 1, title: 'The First Hour', synopsis: 'Setting and tone — arrival at the cabin.', key_beats: ['arrive', 'observe', 'settle'] },
        { n: 2, title: 'The Second Hour', synopsis: 'Companion arrives, shared meal.', key_beats: ['greeting', 'shared task', 'memory'] },
        { n: 3, title: 'The Third Hour', synopsis: 'Quiet, drifting toward sleep.', key_beats: ['wind down', 'release', 'fade'] },
      ],
      outline_completed_at: '2026-05-07T01:00:00.000Z',
      chapters_done: [1],
      params_hash: 'feedface0badcafe',
      last_updated: '2026-05-07T01:00:00.000Z',
    }
    await writeJsonAtomic(sidecarPath(tmpDir, 'EP0042'), sidecar)

    const lookup = await getOutlineEntryForChapter(tmpDir, 'EP0042', 2)
    assert.ok(lookup)
    assert.equal(lookup!.mode, 'narrative')
    assert.equal(lookup!.entry.title, 'The Second Hour')
    assert.equal(lookup!.entry.synopsis, 'Companion arrives, shared meal.')
    assert.deepEqual(lookup!.entry.key_beats, ['greeting', 'shared task', 'memory'])
    // Listicle-only fields stay undefined for narrative mode
    assert.equal(lookup!.entry.hook_line, undefined)
    assert.equal(lookup!.entry.key_facts, undefined)
  })
})

describe('getOutlineEntryForChapter — no sidecar', () => {
  test('returns null cleanly for projects that never went through chunked mode', async () => {
    // Single-call (sub-threshold) projects don't have a sidecar — chapter-only
    // must fall through to its legacy prompt assembly without error.
    const freshDir = await fs.mkdtemp(path.join(tmpDir, 'no-sidecar-'))
    const lookup = await getOutlineEntryForChapter(freshDir, 'EP9999', 1)
    assert.equal(lookup, null)
  })

  test('returns null when sidecar JSON is corrupt (must not throw)', async () => {
    // Defensive: a partial / corrupt sidecar from a crash mid-write must not
    // poison chapter-only — we degrade silently to the legacy prompt path.
    const corruptDir = await fs.mkdtemp(path.join(tmpDir, 'corrupt-sidecar-'))
    await fs.writeFile(sidecarPath(corruptDir, 'EP1234'), '{not valid json', 'utf-8')
    const lookup = await getOutlineEntryForChapter(corruptDir, 'EP1234', 1)
    assert.equal(lookup, null)
  })
})
