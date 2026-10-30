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

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import {
  claimMissingImageTaskStrict,
  compareAndRecordImageTaskStrict,
  promoteCurrentImageTaskArtifactStrict,
  recordTask,
  recordTaskStrict,
  readManifest,
  readManifestStrict,
} from '../services/task-manifest.js'
import { useTempDataDir } from './_helpers.js'

const testData = await useTempDataDir()
after(() => testData.cleanup())

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

test('a replaced scene image is copied to Trash; a first render copies nothing', async t => {
  const dir = await fs.mkdtemp(path.join(testData.dir, 'scene-image-trash-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const trashDir = path.join(dir, '_trash', 'scene-images')
  const filename = 'scene-001.png'
  const outputPath = path.join(dir, filename)
  const owner = {
    provider: 'genstudio', task_id: 'task-a', submitted_at: 'ts-a', operation: 'image' as const,
    idempotency_key: 'key-a', input_hash: 'hash-a', request_scope: 'scope-a', last_state: 'prepared',
  }
  await recordTaskStrict(dir, filename, owner)
  const firstStage = path.join(dir, '.first.png')
  await fs.writeFile(firstStage, 'first')
  assert.equal(await promoteCurrentImageTaskArtifactStrict(dir, filename, owner, firstStage, outputPath, async () => {}, trashDir), true)
  assert.equal(await fs.readdir(trashDir).catch(() => []).then(rows => rows.length), 0, 'a first render keeps no copy')

  const nextStage = path.join(dir, '.next.png')
  await fs.writeFile(nextStage, 'next')
  assert.equal(await promoteCurrentImageTaskArtifactStrict(dir, filename, owner, nextStage, outputPath, async () => {}, trashDir), true)
  const kept = await fs.readdir(trashDir)
  assert.equal(kept.length, 1)
  assert.equal(await fs.readFile(path.join(trashDir, kept[0]!), 'utf8'), 'first')
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'next')
})

test('a superseded scene attempt cannot reclaim ownership or replace the winner', async t => {
  const dir = await fs.mkdtemp(path.join(testData.dir, 'scene-image-owner-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filename = 'scene-001.png'
  const outputPath = path.join(dir, filename)
  const ownerA = {
    provider: 'genstudio', task_id: 'task-a', submitted_at: 'ts-a', operation: 'image' as const,
    idempotency_key: 'key-a', input_hash: 'hash-a', request_scope: 'scope-a', last_state: 'accepted',
  }
  const ownerB = {
    provider: 'genstudio', task_id: '', submitted_at: 'ts-b', operation: 'image' as const,
    idempotency_key: 'key-b', input_hash: 'hash-b', request_scope: 'scope-b', last_state: 'prepared',
    superseded_image_requests: [ownerA],
  }
  await recordTaskStrict(dir, filename, ownerA)
  await compareAndRecordImageTaskStrict(dir, filename, ownerA, ownerB)
  await assert.rejects(compareAndRecordImageTaskStrict(dir, filename, ownerA, ownerA), /ownership changed/i)

  const staleStage = path.join(dir, '.stale.png')
  const winnerStage = path.join(dir, '.winner.png')
  await fs.writeFile(staleStage, 'stale')
  await fs.writeFile(winnerStage, 'winner')
  let checkpoints = 0
  assert.equal(await promoteCurrentImageTaskArtifactStrict(
    dir, filename, ownerA, staleStage, outputPath, async () => { checkpoints++ },
  ), false)
  assert.equal(await promoteCurrentImageTaskArtifactStrict(dir, filename, ownerB, winnerStage, outputPath, async () => {
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'winner')
    checkpoints++
  }), true)
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'winner')
  assert.equal(checkpoints, 1)
  assert.equal((await readManifestStrict(dir)).tasks[filename]?.idempotency_key, 'key-b')
  assert.equal(await fs.stat(staleStage).catch(() => null), null)
})

test('a completed output that appears before the manual claim keeps its original manifest owner', async t => {
  const dir = await fs.mkdtemp(path.join(testData.dir, 'scene-image-before-claim-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filename = 'scene-001.png'
  const outputPath = path.join(dir, filename)
  const original = {
    provider: 'genstudio', task_id: 'task-old', submitted_at: 'ts-old', operation: 'image' as const,
    idempotency_key: 'key-old', input_hash: 'hash-old', request_scope: 'scope-old', last_state: 'accepted',
  }
  const replacement = {
    provider: 'genstudio', task_id: '', submitted_at: 'ts-new', operation: 'image' as const,
    idempotency_key: 'key-new', input_hash: 'hash-new', request_scope: 'scope-new', last_state: 'prepared',
    superseded_image_requests: [original],
  }
  await recordTaskStrict(dir, filename, original)
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toFile(outputPath)

  assert.equal(await claimMissingImageTaskStrict(dir, filename, outputPath, original, replacement), false)
  assert.deepEqual((await readManifestStrict(dir)).tasks[filename], original)
  await sharp(outputPath).stats()
})

test('shouldChunkByBudget: trips chunking when prompt + output crowd the cap', async () => {
  const { shouldChunkByBudget } = await import('../lib/chunked-narration.js')

  // v1.0.786 — the cap is now passed EXPLICITLY. These cases were always
  // reasoning about a 16,000-token product (see the arithmetic below); they
  // just used to get that number from an implicit fallback constant inside
  // the function. The constant was an invented ceiling and is gone, so the
  // product the case is about is named here instead.
  const SMALL_PRODUCT_TOKENS = 16_000

  // Median sleep-story shape — 8400 words, modest prompt. It USED to stay on
  // the single-call path, and now chunks: 8K input chars ≈ 2K tokens, 8400
  // words ≈ 13.4K output tokens at the measured 1.6 tokens/word, plus the
  // 1.5K margin = 16.9K > 16K cap. The estimate moving to the measured rate is
  // what moved this case over the line (2026-09-26), and that is the intended
  // direction: a call that would consume ~96% of the ceiling is exactly the one
  // that comes back cut off, so it is split instead.
  assert.equal(
    shouldChunkByBudget({
      systemPromptChars: 4000, userPromptChars: 4000, targetWords: 8400,
      outputTokenCap: SMALL_PRODUCT_TOKENS,
    }),
    true,
    'median sleep-story at 8400 words now chunks — the measured rate leaves no margin',
  )

  // Heavy character cast + standards: same word count, much bigger prompt.
  // 20K input chars → ~5K input tokens. 8400 words → ~13.4K output tokens.
  // 5K + 13.4K + 1.5K margin = 19.9K > 16K cap → must chunk.
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

// S11: entries that queue behind a write share the next one; each still succeeds or fails on its own.
test('concurrent recordTask calls are batched into a few writes, keep every entry, and a bad entry fails alone', async t => {
  const { _batchedManifestWritesForTesting } = await import('../services/task-manifest.js')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batched-manifest-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const before = _batchedManifestWritesForTesting()
  const writes = Array.from({ length: 60 }, (_, i) => recordTaskStrict(dir, `scene-${i}.png`, { provider: 'genstudio', task_id: `t${i}`, submitted_at: 'ts' }))
  // A subtitle-original binding with no current entry is refused; only this one call fails.
  const bad = assert.rejects(recordTaskStrict(dir, 'scene-0.png', { provider: 'genstudio', task_id: 'x', submitted_at: 'ts', idempotency_key: 'k', input_hash: 'h',
    subtitle_originals: { k: { task_id: 'x', idempotency_key: 'k', input_hash: 'other' } } } as any), /identity changed/)
  await Promise.all([...writes, bad])
  const manifest = await readManifestStrict(dir)
  assert.equal(Object.keys(manifest.tasks).length, 60)
  assert.equal(manifest.tasks['scene-59.png']?.task_id, 't59')
  const made = _batchedManifestWritesForTesting() - before
  assert.ok(made <= 3, `60 entries took ${made} writes`)
  assert.ok(!(await fs.readFile(path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.json'))!), 'utf8')).includes('\n  '), 'written compact')
})
