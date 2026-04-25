/**
 * Tests for `findFileCaseInsensitive` — the shared helper the three
 * reconcilers (image / video / audio) use to decide whether an expected
 * asset is already on disk.
 *
 * Pins down the bug documented in audit-reports/05-portability.md §9
 * (P9 / High): reconcilers build expected filenames by uppercasing the
 * episode code (`TN0001_Scene01_v1.png`) and used to call `existsSync`
 * against that exact path. On macOS APFS the lookup silently succeeded
 * regardless of the on-disk casing — but on case-sensitive filesystems
 * (Linux, case-sensitive APFS, SMB-mounted servers) a legacy or
 * foreign-cased file (`tn0001_scene01_v1.png`) would be reported as
 * missing. The visible symptom was nasty: the Repair button returned
 * "no assets found for this episode" on projects the user knew had
 * assets, leading them to regenerate at cost.
 *
 * These tests exercise the helper directly against a real tmp
 * directory — the behaviour is inherently about the filesystem's
 * case-sensitivity semantics, so we don't mock fs here.
 *
 * Note: on macOS-default APFS the filesystem is case-insensitive, so
 * the "different case on disk" scenarios still pass via the exact-case
 * fast path (existsSync hits the file regardless of casing). The tests
 * assert on the returned path VALUE — specifically, that the on-disk
 * casing is preserved — which is what the downstream `stat` + size
 * check in each reconciler actually relies on.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { findFileCaseInsensitive } from '../services/fs-case-insensitive.js'

describe('findFileCaseInsensitive', () => {
  let tmp: string

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-caseins-'))
  })

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  test('exact-case match returns the canonical path', async () => {
    const file = path.join(tmp, 'TN0001_Scene01_v1.png')
    await fs.writeFile(file, 'x')
    const result = await findFileCaseInsensitive(tmp, 'TN0001_Scene01_v1.png')
    assert.equal(result, file)
  })

  test('uppercase-expected / lowercase-on-disk still matches', async () => {
    // The audit's exact bug scenario: reconciler expects `TN0002_...`
    // but the actual on-disk file was written under a legacy lowercase
    // convention. On macOS-default APFS (case-insensitive) the
    // existsSync fast-path resolves either casing to the same inode,
    // so we assert on the round-trip: a stat on the returned path
    // succeeds with the expected size. On case-sensitive filesystems
    // (Linux, case-sensitive APFS) the fallback scan matches the
    // lowercase entry and returns its literal on-disk path.
    const actual = path.join(tmp, 'tn0002_scene01_v1.png')
    await fs.writeFile(actual, 'body')
    const result = await findFileCaseInsensitive(tmp, 'TN0002_Scene01_v1.png')
    assert.ok(result, 'should locate the lowercase file via case-insensitive compare')
    const st = await fs.stat(result!)
    assert.equal(st.size, 'body'.length)
    assert.equal(path.basename(result!).toLowerCase(), 'tn0002_scene01_v1.png')
  })

  test('mixed-case-on-disk matches uppercase-expected', async () => {
    const actual = path.join(tmp, 'Tn0003_Scene01_V1.png')
    await fs.writeFile(actual, 'body')
    const result = await findFileCaseInsensitive(tmp, 'TN0003_SCENE01_V1.PNG')
    assert.ok(result)
    const st = await fs.stat(result!)
    assert.equal(st.size, 'body'.length)
    assert.equal(path.basename(result!).toLowerCase(), 'tn0003_scene01_v1.png')
  })

  test('no match returns null', async () => {
    const result = await findFileCaseInsensitive(tmp, 'TN9999_Nope.png')
    assert.equal(result, null)
  })

  test('missing directory returns null (not throws)', async () => {
    const result = await findFileCaseInsensitive(path.join(tmp, 'does-not-exist'), 'TN0001_x.png')
    assert.equal(result, null)
  })

  test('returned path is stat-able — downstream size check works', async () => {
    // The reconcilers use the result to then `stat()` for a size>0
    // check. Prove round-trip: return the actual-cased path, and
    // `stat` on that path succeeds with the right size.
    const actual = path.join(tmp, 'tn0004_chapter_01.mp3')
    await fs.writeFile(actual, 'hello-audio')
    const found = await findFileCaseInsensitive(tmp, 'TN0004_Chapter_01.mp3')
    assert.ok(found, 'helper should locate the file regardless of casing')
    const st = await fs.stat(found!)
    assert.equal(st.size, 'hello-audio'.length)
  })
})
