/**
 * Regression test for the recordTask read-modify-write race.
 *
 * Before the per-assetDir Promise chain was added, parallel workers calling
 * recordTask() for different filenames in the same asset folder could both
 * read an empty manifest, each add their own filename, and the second write
 * would silently clobber the first. The lost task_id then broke retry-then-
 * repair: on retry the reconciler couldn't find the in-flight task and the
 * user double-paid.
 *
 * The serialization fix lives in task-manifest.ts. This test fires N
 * concurrent recordTask calls against the same dir and asserts every entry
 * survives in the final manifest.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { recordTask, recordTaskStrict, readManifest, readManifestStrict } from '../services/task-manifest.js'

test('subtitle originals survive current-task updates and cannot be overwritten or rebound from a stale current entry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-original-manifest-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const entry = { provider: 'genstudio', task_id: 'original-task', submitted_at: 'ts',
    idempotency_key: 'original-key', input_hash: 'sha256:input' }
  const original = { task_id: 'original-task', idempotency_key: 'original-key', input_hash: 'sha256:input' }
  await recordTaskStrict(dir, 'Chapter_01.srt', entry)
  await recordTaskStrict(dir, 'Chapter_01.srt', { ...entry, subtitle_originals: { 'original-key': original } })
  await assert.rejects(recordTaskStrict(dir, 'Chapter_01.srt', { ...entry,
    subtitle_originals: { 'original-key': { ...original, task_id: 'other-real-task' } },
  }), /identity/)
  await recordTaskStrict(dir, 'Chapter_01.srt', { ...entry, task_id: 'replacement-task', idempotency_key: 'replacement-key' })
  const saved = (await readManifestStrict(dir)).tasks['Chapter_01.srt']!
  assert.deepEqual(saved.subtitle_originals, { 'original-key': original })
  await assert.rejects(recordTaskStrict(dir, 'Chapter_01.srt', { ...entry,
    subtitle_originals: { 'original-key': original },
  }), /identity/, 'a stale rebind must not overwrite the newer current task')
  assert.deepEqual((await readManifestStrict(dir)).tasks['Chapter_01.srt'], saved)
})

test('recordTask: 50 concurrent writes against the same dir all persist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manifest-race-'))
  try {
    const N = 50
    // Submit all writes in parallel — the race window only exists when
    // the second write's read happens before the first's write lands.
    await Promise.all(
      Array.from({ length: N }, (_, i) => recordTask(dir, `chunk_${i.toString().padStart(3, '0')}.mp3`, {
        provider: 'genaipro',
        task_id: `task_${i}`,
        submitted_at: new Date().toISOString(),
      })),
    )
    const m = await readManifest(dir)
    const filenames = Object.keys(m.tasks).sort()
    assert.equal(filenames.length, N, 'expected every concurrent write to survive')
    // Spot-check a few entries to confirm the right task_id landed at the
    // right filename (not just N entries with shuffled IDs).
    assert.equal(m.tasks['chunk_007.mp3']?.task_id, 'task_7')
    assert.equal(m.tasks['chunk_042.mp3']?.task_id, 'task_42')
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('recordTask: never throws when the asset dir is unwritable (best-effort contract)', async () => {
  // Contract from task-manifest.ts:17-19: "Best-effort: every write is wrapped —
  // failures never propagate into the caller's generation flow." The asset
  // download (image .png, audio .mp3) is the primary output; the manifest is
  // recovery affordance only. If a manifest write fails the user still gets
  // their asset; they just can't retry-repair if a later step needs the
  // task_id. Locking this contract guards against a refactor that surfaces
  // these failures into the generator's error stream — which would convert
  // a successful download into a "failed" job and confuse the user.
  //
  // We force a write failure by passing a path that exists as a FILE — the
  // initial mkdir({recursive:true}) inside recordTask treats the file as a
  // collision and throws ENOTDIR. The function's outer try/catch should
  // swallow it.
  const collidingFile = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manifest-fail-'))
  // Replace the dir with a regular file at the same path.
  await fs.rm(collidingFile, { recursive: true, force: true })
  await fs.writeFile(collidingFile, 'I am a file, not a directory')
  try {
    // Capture stderr so the warn line doesn't pollute test output.
    const origWarn = console.warn
    let warned = false
    console.warn = () => { warned = true }
    try {
      await recordTask(collidingFile, 'whatever.mp3', {
        provider: 'genaipro', task_id: 't', submitted_at: 'ts',
      })
    } finally {
      console.warn = origWarn
    }
    assert.ok(warned, 'recordTask should log a warning when the write fails')
  } finally {
    await fs.rm(collidingFile, { recursive: true, force: true }).catch(() => {})
  }
})

test('recordTaskStrict: aborts a durable provider boundary when identity cannot persist', async () => {
  const collidingFile = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manifest-strict-'))
  await fs.rm(collidingFile, { recursive: true, force: true })
  await fs.writeFile(collidingFile, 'I am a file, not a directory')
  try {
    await assert.rejects(
      recordTaskStrict(collidingFile, 'chapter.mp3', {
        provider: 'genstudio',
        task_id: '',
        submitted_at: 'ts',
        idempotency_key: 'story-tts-stable',
        operation: 'tts',
        last_state: 'prepared',
      }),
    )
  } finally {
    await fs.rm(collidingFile, { recursive: true, force: true }).catch(() => {})
  }
})

test('recordTask: writes to different dirs do not block each other', async () => {
  // Per-dir chains mean dirA and dirB writes interleave freely — only
  // same-dir writes serialize. This test just exercises the path; the
  // assertion is that both manifests end up correct.
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manifest-A-'))
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manifest-B-'))
  try {
    await Promise.all([
      recordTask(dirA, 'a1.mp3', { provider: 'genaipro', task_id: 'A1', submitted_at: 'ts' }),
      recordTask(dirB, 'b1.mp3', { provider: 'genaipro', task_id: 'B1', submitted_at: 'ts' }),
      recordTask(dirA, 'a2.mp3', { provider: 'genaipro', task_id: 'A2', submitted_at: 'ts' }),
      recordTask(dirB, 'b2.mp3', { provider: 'genaipro', task_id: 'B2', submitted_at: 'ts' }),
    ])
    const mA = await readManifest(dirA)
    const mB = await readManifest(dirB)
    assert.equal(Object.keys(mA.tasks).length, 2)
    assert.equal(Object.keys(mB.tasks).length, 2)
    assert.equal(mA.tasks['a1.mp3']?.task_id, 'A1')
    assert.equal(mB.tasks['b2.mp3']?.task_id, 'B2')
  } finally {
    await fs.rm(dirA, { recursive: true, force: true }).catch(() => {})
    await fs.rm(dirB, { recursive: true, force: true }).catch(() => {})
  }
})

test('shouldChunkByBudget: trips chunking when prompt + output crowd the cap', async () => {
  const { shouldChunkByBudget } = await import('../lib/chunked-narration.js')

  // v1.0.786 — the cap is now passed EXPLICITLY. These cases were always
  // reasoning about a 16,000-token product (see the arithmetic below); they
  // just used to get that number from an implicit fallback constant inside
  // the function. The constant was an invented ceiling and is gone, so the
  // product the case is about is named here instead.
  const SMALL_PRODUCT_TOKENS = 16_000

  // Median sleep-story shape — 8400 words, modest prompt. Should NOT chunk.
  assert.equal(
    shouldChunkByBudget({
      systemPromptChars: 4000, userPromptChars: 4000, targetWords: 8400,
      outputTokenCap: SMALL_PRODUCT_TOKENS,
    }),
    false,
    'median sleep-story should stay on the single-call path',
  )

  // Heavy character cast + standards: same word count, much bigger prompt.
  // 20K input chars → ~5K input tokens. 8400 words → ~10.9K output tokens.
  // 5K + 10.9K + 1.5K margin = 17.4K > 16K cap → must chunk.
  assert.equal(
    shouldChunkByBudget({
      systemPromptChars: 12000, userPromptChars: 8000, targetWords: 8400,
      outputTokenCap: SMALL_PRODUCT_TOKENS,
    }),
    true,
    'heavy-prompt project at 8400 words should trip dynamic chunking',
  )

  // Tiny project — definitely safe.
  assert.equal(
    shouldChunkByBudget({
      systemPromptChars: 500, userPromptChars: 1000, targetWords: 2000,
      outputTokenCap: SMALL_PRODUCT_TOKENS,
    }),
    false,
  )

  // With NO published cap the same tiny project chunks anyway: there is no
  // budget to measure against, and chunked mode is the side of that unknown
  // that keeps per-chapter resume. What it must not do is measure against a
  // number Story Studio made up.
  assert.equal(
    shouldChunkByBudget({ systemPromptChars: 500, userPromptChars: 1000, targetWords: 2000 }),
    true,
    'an unpublished cap must not resolve to a fallback number',
  )
})
