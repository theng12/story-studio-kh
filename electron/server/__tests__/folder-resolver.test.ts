import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  resolveSubfolder, findSubfolder, resolveEpisodeDir,
  findEpisodeDir, buildEpisodeDirIndex,
} from '../lib/folder-resolver.js'

// v1.0.338 — folder-resolver is now THE canonical episode-dir + subfolder
// lookup (consolidated from private copies in generators/video.ts,
// routes/video.ts, generators/audio.ts, routes/ideas.ts). These tests pin
// the semantics each copy depended on, across both on-disk layouts.

let root = ''
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssk-folder-resolver-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function mk(...segments: string[]): Promise<string> {
  const p = path.join(root, ...segments)
  await fs.mkdir(p, { recursive: true })
  return p
}

describe('findEpisodeDir — layout matrix', () => {
  test('Season-nested layout (root/Season 001/EP0001 - Title)', async () => {
    const dir = await mk('Season 001', 'EP0001 - The Quiet Hero')
    assert.equal(await findEpisodeDir(root, 'EP0001'), dir)
  })

  test('episodes/-nested layout (root/episodes/Season 001/EP0001 - Title)', async () => {
    const dir = await mk('episodes', 'Season 001', 'EP0001 - The Quiet Hero')
    assert.equal(await findEpisodeDir(root, 'EP0001'), dir)
  })

  test('lowercase code still matches (case-insensitive prefix)', async () => {
    const dir = await mk('Season 001', 'EP0001 - The Quiet Hero')
    assert.equal(await findEpisodeDir(root, 'ep0001'), dir)
  })

  test('titleHint disambiguates rename leftovers sharing the code prefix', async () => {
    // readdir order is platform-dependent; the exact-match pass must win
    // regardless of which leftover lists first.
    await mk('Season 001', 'EP0001 - Old Stale Title')
    const real = await mk('Season 001', 'EP0001 - The Real Title')
    assert.equal(
      await findEpisodeDir(root, 'EP0001', { titleHint: 'The Real Title' }),
      real,
    )
  })

  test('"✅ "-prefixed episode dir still matches', async () => {
    const dir = await mk('Season 001', '✅ EP0001 - The Quiet Hero')
    assert.equal(await findEpisodeDir(root, 'EP0001'), dir)
  })

  test('missing episode → null; depth limit respected', async () => {
    await mk('a', 'b', 'c', 'd', 'e', 'EP0001 - Too Deep') // depth 5 > maxDepth 4
    assert.equal(await findEpisodeDir(root, 'EP0001'), null)
    assert.equal(await findEpisodeDir(root, 'EP9999'), null)
  })
})

describe('findSubfolder — non-creating lookup', () => {
  test('exact name', async () => {
    const ep = await mk('Season 001', 'EP0001 - T')
    const audio = await mk('Season 001', 'EP0001 - T', 'EP0001 - 07 Audio Assets')
    assert.equal(await findSubfolder(ep, 'EP0001 - 07 Audio Assets'), audio)
  })

  test('"✅ "-prefixed variant matches (user marked the step done)', async () => {
    const ep = await mk('Season 001', 'EP0001 - T')
    const audio = await mk('Season 001', 'EP0001 - T', '✅ EP0001 - 07 Audio Assets')
    assert.equal(await findSubfolder(ep, 'EP0001 - 07 Audio Assets'), audio)
  })

  test('missing → null (does NOT create)', async () => {
    const ep = await mk('Season 001', 'EP0001 - T')
    assert.equal(await findSubfolder(ep, 'EP0001 - 05 Scene Images'), null)
    const entries = await fs.readdir(ep)
    assert.equal(entries.length, 0, 'nothing was created')
  })
})

describe('resolveSubfolder — creating lookup', () => {
  test('returns the "✅ "-prefixed folder instead of creating a duplicate', async () => {
    // The pre-v1.0.338 lib missed the ✅ tolerance, so writers (image
    // prompts / metadata) created an unprefixed duplicate next to the
    // marked folder. Pin the fix.
    const ep = await mk('Season 001', 'EP0001 - T')
    const marked = await mk('Season 001', 'EP0001 - T', '✅ EP0001 - 02 Metadata')
    const resolved = await resolveSubfolder(ep, 'EP0001 - 02 Metadata')
    assert.equal(resolved, marked)
    const entries = await fs.readdir(ep)
    assert.equal(entries.length, 1, 'no duplicate folder created')
  })

  test('creates when truly missing', async () => {
    const ep = await mk('Season 001', 'EP0001 - T')
    const resolved = await resolveSubfolder(ep, 'EP0001 - 02 Metadata')
    assert.equal(resolved, path.join(ep, 'EP0001 - 02 Metadata'))
    const st = await fs.stat(resolved)
    assert.ok(st.isDirectory())
  })
})

describe('resolveEpisodeDir — single-level lookup', () => {
  test('matches "{code} - " prefix in the given dir only', async () => {
    const season = await mk('Season 001')
    const ep = await mk('Season 001', 'EP0002 - Title')
    assert.equal(await resolveEpisodeDir(season, 'EP0002'), ep)
    assert.equal(await resolveEpisodeDir(root, 'EP0002'), null, 'does not recurse')
  })
})

describe('buildEpisodeDirIndex — one walk, many codes', () => {
  test('finds all episodes across seasons without descending into matched dirs', async () => {
    const e1 = await mk('Season 001', 'EP0001 - A')
    const e2 = await mk('Season 001', 'EP0002 - B')
    const e3 = await mk('Season 002', 'EP0021 - C')
    // Subfolders inside an episode dir share its code prefix — the walk
    // must map the EPISODE dir, not a subfolder.
    await mk('Season 001', 'EP0001 - A', 'EP0001 - 01 Script')

    const idx = await buildEpisodeDirIndex(root, new Set(['EP0001', 'EP0002', 'EP0021']))
    assert.equal(idx.get('EP0001'), e1)
    assert.equal(idx.get('EP0002'), e2)
    assert.equal(idx.get('EP0021'), e3)
  })

  test('episodes/-nested layout + "✅ " prefixed episode dirs', async () => {
    const e1 = await mk('episodes', 'Season 001', '✅ EP0001 - A')
    const idx = await buildEpisodeDirIndex(root, new Set(['EP0001']))
    assert.equal(idx.get('EP0001'), e1)
  })

  test('empty codes → empty map, no walk', async () => {
    const idx = await buildEpisodeDirIndex(root, new Set())
    assert.equal(idx.size, 0)
  })

  test('missing codes are simply absent from the map', async () => {
    await mk('Season 001', 'EP0001 - A')
    const idx = await buildEpisodeDirIndex(root, new Set(['EP0001', 'EP0099']))
    assert.equal(idx.get('EP0001')?.endsWith('EP0001 - A'), true)
    assert.equal(idx.has('EP0099'), false)
  })
})
