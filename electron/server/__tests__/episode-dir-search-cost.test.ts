/**
 * Finding one episode must not cost a walk through the episodes before it.
 *
 * The finders recursed depth-first, so locating EP0150 descended into every
 * episode folder (and each one's ~11 asset subfolders) of Season 001 before it
 * ever opened Season 002. A project-wide audit asks once per episode per stage,
 * which made it quadratic: 160 episodes measured ~0.6 M readdir calls and 20 s.
 * `findFileRecursive` (scene/thumbnail prompts) was worse still — it walked the
 * whole project on EVERY call, finding all matches.
 *
 * These tests count readdir calls rather than time, so a loaded machine cannot
 * make them flaky, and assert the answer is unchanged.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
const SLUG = 'dir-search-cost'
const SEASONS = 10
const PER_SEASON = 20
const SUBFOLDERS = ['01 Script', '02 Scene Prompts', '03 Thumbnail Prompts', '04 Audio', '05 Scene Images', '06 Thumbnails', '07 Merged', '08 Subtitles', '09 Video', '10 Metadata']

const code = (n: number) => `EP${String(n).padStart(4, '0')}`
let outputRoot = ''
let episodeDirOf: (n: number) => string

async function countReaddirs<T>(fn: () => Promise<T>): Promise<{ result: T; readdirs: number }> {
  const target = fs as any
  const original = target.readdir
  let readdirs = 0
  target.readdir = (...args: any[]) => { readdirs++; return original.apply(target, args) }
  try { return { result: await fn(), readdirs } } finally { target.readdir = original }
}

before(async () => {
  tmp = await useTempDataDir()
  const projDir = path.join(tmp.dir, 'projects', SLUG)
  outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({ slug: SLUG, name: 'x', episode_prefix: 'EP' }))
  episodeDirOf = n => path.join(outputRoot, `Season ${String(Math.ceil(n / PER_SEASON)).padStart(3, '0')}`, `${code(n)} - Title ${n}`)
  for (let n = 1; n <= SEASONS * PER_SEASON; n++) {
    for (const sub of SUBFOLDERS) await fs.mkdir(path.join(episodeDirOf(n), `${code(n)} - ${sub}`), { recursive: true })
  }
})
after(async () => { await tmp.cleanup() })

describe('episode folder lookups stay cheap on a big project', () => {
  test('lib/folder-resolver findEpisodeDir: a late episode costs a handful of readdirs and finds the right folder', async () => {
    const { findEpisodeDir } = await import('../lib/folder-resolver.js')
    const { result, readdirs } = await countReaddirs(() => findEpisodeDir(outputRoot, code(190)))
    assert.equal(result, episodeDirOf(190))
    // root + at most one read per season. The depth-first walk made ~1,800 here.
    assert.ok(readdirs <= SEASONS + 1, `expected at most ${SEASONS + 1} readdirs, saw ${readdirs}`)
  })

  test('a missing episode is still null (and bounded by the depth limit, not the file count)', async () => {
    const { findEpisodeDir } = await import('../lib/folder-resolver.js')
    const { result } = await countReaddirs(() => findEpisodeDir(outputRoot, 'EP9999'))
    assert.equal(result, null)
  })

  test('findScenePromptsFile reads only the episode folder, not the whole project', async () => {
    const { findScenePromptsFile, findThumbPromptsFile } = await import('../generators/images.js')
    const n = 190
    const dir = path.join(episodeDirOf(n), `${code(n)} - 02 Scene Prompts`)
    await fs.writeFile(path.join(dir, `${code(n)}_Scene_Prompts.docx`), 'stale')
    await fs.writeFile(path.join(dir, `${code(n)}_Scene_Prompts.md`), 'current')
    const { result, readdirs } = await countReaddirs(() => findScenePromptsFile(SLUG, code(n)))
    // .md outranks a stale .docx in the same folder (v1.0.436 rule) — unchanged.
    assert.equal(result, path.join(dir, `${code(n)}_Scene_Prompts.md`))
    // locate the folder (~11 reads) + its own subtree (~11 reads); the whole-project walk was ~2,400.
    assert.ok(readdirs <= 40, `expected a bounded read, saw ${readdirs} readdirs`)

    // An episode with no prompts yet: the answer is "missing", and it must not walk everything to say so.
    const missing = await countReaddirs(() => findThumbPromptsFile(SLUG, code(191)).then(() => 'found', () => 'missing'))
    assert.equal(missing.result, 'missing')
    assert.ok(missing.readdirs <= 40, `an unstarted episode saw ${missing.readdirs} readdirs`)
  })

  test('rename leftovers: prompts in the second folder sharing the code are still found', async () => {
    const { findScenePromptsFile } = await import('../generators/images.js')
    const n = 5
    const leftover = path.join(path.dirname(episodeDirOf(n)), `${code(n)} - Old Title`)
    await fs.mkdir(leftover, { recursive: true })
    const real = path.join(episodeDirOf(n), `${code(n)} - 02 Scene Prompts`)
    await fs.writeFile(path.join(real, `${code(n)}_Scene_Prompts.md`), 'x')
    assert.equal(await findScenePromptsFile(SLUG, code(n)), path.join(real, `${code(n)}_Scene_Prompts.md`))
  })

  test('prompts for a code with no episode folder anywhere keep the old whole-tree search', async () => {
    const { findScenePromptsFile } = await import('../generators/images.js')
    const stray = path.join(outputRoot, 'Loose')
    await fs.mkdir(stray, { recursive: true })
    await fs.writeFile(path.join(stray, 'EP7000_Scene_Prompts.md'), 'x')
    assert.equal(await findScenePromptsFile(SLUG, 'EP7000'), path.join(stray, 'EP7000_Scene_Prompts.md'))
  })
})
