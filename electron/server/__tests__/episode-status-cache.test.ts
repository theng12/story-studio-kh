/**
 * Tests for the episode-status cache (services/episode-status-cache.ts).
 *
 * Coverage:
 *   - MISS: empty cache → computes and stores; stats counter increments.
 *   - HIT: pre-warmed entry, watched-folder mtimes unchanged → returns cached.
 *   - STALE: bump a watched folder's mtime → cache recomputes.
 *   - invalidate: explicit per-episode drop forces a fresh compute.
 *   - invalidateProject: drops every entry under the project's slug.
 *   - in-flight dedup: two concurrent .get() calls share one compute promise.
 *   - hydrate/dump: schema-version mismatch is dropped on hydrate.
 *
 * IMPORTANT — module-load ordering: project-manager.ts evaluates PROJECTS_ROOT
 * at module-load time, so we must set STORY_STUDIO_DATA_DIR via useTempDataDir
 * BEFORE the cache or its dependencies are imported. All cache imports happen
 * inside before() to guarantee env-first init.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let cacheMod: typeof import('../services/episode-status-cache.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'cache-test-project'
const CODE = 'EP001'

async function makeProject() {
  const projectsDir = path.join(tmp.dir, 'projects')
  const projDir = path.join(projectsDir, SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  // Minimal project.json so resolveEpisodePaths works.
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Cache Test',
    output_root: outputRoot,
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }, null, 2))
  // Episode folder with a script subfolder so the status compute has
  // something to find.
  const epDir = path.join(outputRoot, 'Season 001', `${CODE} - Test`)
  const scriptDir = path.join(epDir, `${CODE} - 01 Script`)
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(scriptDir, `${CODE}_Script_Narration.docx`), 'fake docx content')
  // Ideas list with an accepted episode. Note: shape must match
  // readStoreFromDisk's expected { ideas, next_episode_number, recycled_numbers }
  // wrapper — a bare array is silently rejected as "no ideas".
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'idea-001',
      episode_code: CODE,
      title: 'Test',
      status: 'accepted',
    }],
    next_episode_number: 2,
    recycled_numbers: [],
  }, null, 2))
  return { projDir, epDir, scriptDir }
}

describe('episode-status-cache', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cacheMod = await import('../services/episode-status-cache.js')
    pm = await import('../services/project-manager.js')
    // Ensure PROJECTS_ROOT (resolved at module load) matches our temp dir.
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at the temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(() => {
    cacheMod.episodeStatusCache.clear()
  })

  test('MISS: empty cache computes and stores', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    const status = await cache.get(SLUG, CODE)
    assert.equal(status.script, true, 'script flag should be true (we wrote a docx)')
    const stats = cache.getStats()
    assert.equal(stats.misses, 1, 'one miss recorded')
    assert.equal(stats.size, 1, 'entry stored')
  })

  test('HIT: warm cache, mtimes unchanged → no recompute', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)        // warm
    cache.getStats()                    // discard counters
    const before = cache.getStats()
    const status = await cache.get(SLUG, CODE)  // hit
    const after = cache.getStats()

    assert.equal(status.script, true)
    assert.equal(after.hits - before.hits, 1, 'hit counter incremented')
    assert.equal(after.staleRecomputes, before.staleRecomputes, 'no stale recomputes')
  })

  test('STALE: bumping a watched folder mtime triggers recompute', async () => {
    const { scriptDir, epDir } = await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)  // warm
    const before = cache.getStats()

    // Inspect what the cache snapshotted.
    const dump = cache._dumpProject(SLUG)
    assert.equal(dump.length, 1, 'one entry stored')
    const stored = dump[0]
    const watchedKeys = Object.keys(stored.watchedMtimes)
    if (process.env.DEBUG_CACHE === '1') {
      console.log('scriptDir:', scriptDir)
      console.log('epDir:', epDir)
      console.log('watched keys:', watchedKeys)
      console.log('script_dir mtime stored:', stored.watchedMtimes[scriptDir])
    }
    assert.ok(watchedKeys.includes(scriptDir),
      `scriptDir (${scriptDir}) must be in watched folders, got: ${JSON.stringify(watchedKeys)}`)

    // Bump scriptDir's mtime by writing a new file inside it.
    // Sleep 50ms first so the new mtime is > old mtime even on FSes with
    // millisecond resolution and very fast tests.
    await new Promise(r => setTimeout(r, 50))
    await fs.writeFile(path.join(scriptDir, 'extra.txt'), 'cache-bust')

    await cache.get(SLUG, CODE)  // should be STALE
    const after = cache.getStats()

    assert.equal(after.staleRecomputes - before.staleRecomputes, 1,
      'stale recompute counter incremented')
  })

  test('invalidate(): explicit drop forces miss next time', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)  // warm
    const before = cache.getStats()

    cache.invalidate(SLUG, CODE)
    assert.equal(cache.getStats().size, 0, 'entry dropped')

    await cache.get(SLUG, CODE)
    const after = cache.getStats()
    assert.equal(after.misses - before.misses, 1, 'next get is a miss')
  })

  test('invalidateProject(): drops every entry under the slug', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)
    await cache.get(SLUG, 'EP002')  // will compute empty status (no folder)
    assert.equal(cache.getStats().size, 2)

    cache.invalidateProject(SLUG)
    assert.equal(cache.getStats().size, 0, 'all project entries dropped')
  })

  test('in-flight dedup: two concurrent gets share one compute', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    const before = cache.getStats()
    const [a, b] = await Promise.all([cache.get(SLUG, CODE), cache.get(SLUG, CODE)])
    const after = cache.getStats()

    assert.deepEqual(a, b, 'both calls return same object')
    assert.equal(after.misses - before.misses, 1, 'only one miss/compute fired')
    assert.equal(after.inflightDedups - before.inflightDedups, 1, 'dedup counter incremented')
  })

  test('_hydrateProject: wrong schema version is dropped', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    // Forge an entry with a bogus schema version (cast to bypass the
    // schemaVersion literal-type check).
    const bad = {
      slug: SLUG,
      episode_code: 'EP999',
      status: { script: true } as any,
      computedAt: Date.now(),
      watchedMtimes: {},
      schemaVersion: 99,
    } as unknown as import('../services/episode-status-cache.js').EpisodeStatusCacheEntry
    const loaded = cache._hydrateProject(SLUG, [bad])
    assert.equal(loaded, 0, 'wrong-schema entry rejected')
    assert.equal(cache.getStats().size, 0, 'nothing stored')
  })

  test('persistence: flushProjectNow writes a file readable by a fresh cache', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)
    await cache.flushProjectNow(SLUG)

    const filePath = path.join(pm.PROJECTS_ROOT, SLUG, '.cache', 'episode-status.json')
    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    assert.equal(raw.schemaVersion, cacheMod.SCHEMA_VERSION)
    assert.equal(raw.slug, SLUG)
    assert.equal(raw.entries.length, 1)
    assert.equal(raw.entries[0].episode_code, CODE)
    assert.equal(raw.entries[0].status.script, true)

    // Simulate restart: clear in-memory; next get must re-hydrate from disk
    // and serve cached without recomputing.
    cache.clear()
    const before = cache.getStats()
    const status = await cache.get(SLUG, CODE)
    const after = cache.getStats()

    assert.equal(status.script, true, 'status correctly hydrated')
    assert.equal(after.diskHydrates - before.diskHydrates, 1, 'hydrate counter incremented')
    // After hydrate, the entry exists. The current get is a HIT (mtimes
    // unchanged since persist).
    assert.ok(after.hits > before.hits, 'served from hydrated entry')
  })

  test('persistence: schema version mismatch on disk is ignored', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    // Write a malformed cache file directly.
    const filePath = path.join(pm.PROJECTS_ROOT, SLUG, '.cache', 'episode-status.json')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify({
      schemaVersion: 99,
      slug: SLUG,
      writtenAt: Date.now(),
      entries: [{ slug: SLUG, episode_code: 'EPGHOST', status: {}, computedAt: 0, watchedMtimes: {}, schemaVersion: 99 }],
    }))

    cache.clear()
    await cache.get(SLUG, CODE)

    // The forged EPGHOST entry must not appear in the cache.
    const dump = cache._dumpProject(SLUG)
    assert.equal(dump.find(e => e.episode_code === 'EPGHOST'), undefined,
      'wrong-schema entries from disk are rejected')
  })

  test('persistence: empty project deletes the cache file', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    await cache.get(SLUG, CODE)
    await cache.flushProjectNow(SLUG)
    const filePath = path.join(pm.PROJECTS_ROOT, SLUG, '.cache', 'episode-status.json')
    assert.ok(await fs.stat(filePath).then(() => true).catch(() => false), 'file written')

    cache.invalidateProject(SLUG)
    await cache.flushProjectNow(SLUG)
    assert.equal(
      await fs.stat(filePath).then(() => true).catch(() => false), false,
      'empty cache → file removed',
    )
  })

  test('_hydrateProject: matching schema is loaded', async () => {
    await makeProject()
    const cache = cacheMod.episodeStatusCache

    const good: import('../services/episode-status-cache.js').EpisodeStatusCacheEntry = {
      slug: SLUG,
      episode_code: 'EP777',
      status: {
        script: true, introduction: false,
        scene_prompts: false, thumb_prompts: false,
        metadata: false,
        images: false, thumbnails: false,
        audio: false, merged_audio: false,
        video: false,
        video_assembly: false,
      },
      computedAt: Date.now(),
      watchedMtimes: {},  // empty mtimes = no folders to check; will always be considered HIT
      schemaVersion: cacheMod.SCHEMA_VERSION,
    }
    const loaded = cache._hydrateProject(SLUG, [good])
    assert.equal(loaded, 1, 'good entry loaded')
    assert.equal(cache.getStats().size, 1, 'entry stored')
  })
})
