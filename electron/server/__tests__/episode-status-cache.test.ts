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

async function writeVerifiedSubtitleTimeline(epDir: string) {
  const dir = path.join(epDir, `${CODE} - 09 Subtitles Output`)
  const stitched = path.join(dir, `${CODE}_stitched.srt`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:05,000\nNarration\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({
    complete: true,
    missing_sections: [],
    sections: [{ slug: 'Introduction', source_srt: `${CODE}_Introduction.srt`, cues_added: 1 }],
  }))
}

describe('episode-status-cache', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cacheMod = await import('../services/episode-status-cache.js')
    pm = await import('../services/project-manager.js')
    // Ensure PROJECTS_ROOT (resolved at module load) matches our temp dir.
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at the temp dir — env was set too late')
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

  test('an episode cached before any of its folders exist does not stay empty forever', async () => {
    // A newly-accepted episode has a resolved folder list but nothing on disk,
    // so its mtime snapshot is EMPTY. That entry could never go stale: the
    // staleness check stats only the folders already IN the snapshot, and
    // `mtimesUnchanged({}, {})` is true, so it was a permanent hit. The script
    // then really landed on disk and the episode still reported script:false —
    // for the life of the process, with no user action able to shift it.
    //
    // The disk path already treated these as poison and dropped them on
    // hydrate; only the in-memory path still created them.
    // Its own project: the shared one already has folders on disk from
    // earlier tests, and the whole point here is a project that has none.
    const slug = 'cache-not-yet-written'
    const code = 'EP777'
    const projDir = path.join(tmp.dir, 'projects', slug)
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      slug, name: 'Not Yet Written', episode_prefix: 'EP',
      season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }, null, 2))
    await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
      ideas: [{ id: 'idea-777', episode_code: code, title: 'Test', status: 'accepted' }],
      next_episode_number: 2, recycled_numbers: [],
    }, null, 2))
    const cache = cacheMod.episodeStatusCache

    // Nothing on disk yet.
    const cold = await cache.get(slug, code)
    assert.equal(cold.script, false, 'nothing has been written, so there is no script')

    // The script really lands.
    const scriptDir = path.join(projDir, 'episodes', 'Season 001', `${code} - Test`, `${code} - 01 Script`)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.docx`), 'fake docx content')

    const afterWrite = await cache.get(slug, code)
    assert.equal(afterWrite.script, true,
      'the script is on disk — a cache that cannot see it is telling the owner his work is missing')
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

    // Bump scriptDir's mtime. The old approach (sleep 50ms + write a file and
    // let the DIRECTORY mtime advance on its own) flaked under full-suite load:
    // when the bumped mtime landed inside the same filesystem timestamp
    // granularity as the stored one, the cache saw no change (observed
    // intermittently in full-suite runs, passes in isolation). Set an
    // explicitly DIFFERENT mtime (+2s in the future) with fs.utimes so the
    // change is unambiguous regardless of FS resolution or wall clock.
    await fs.writeFile(path.join(scriptDir, 'extra.txt'), 'cache-bust')
    // Base the bump on the SNAPSHOT's mtime (not wall clock) so it's
    // guaranteed to differ from what the cache stored, and assert the stat
    // visibly changed before the staleness check (fail here = FS issue, not
    // a cache bug).
    const storedMtime = stored.watchedMtimes[scriptDir]
    const bumped = new Date(storedMtime + 2_000)
    await fs.utimes(scriptDir, bumped, bumped)
    const st = await fs.stat(scriptDir)
    assert.notEqual(st.mtimeMs, storedMtime,
      'scriptDir mtime must differ from the snapshot before the staleness check')

    await cache.get(SLUG, CODE)  // should be STALE
    const after = cache.getStats()

    assert.equal(after.staleRecomputes - before.staleRecomputes, 1,
      'stale recompute counter incremented')
  })

  test('STALE: adding a missing chapter subtitle refreshes completion', async () => {
    const { epDir } = await makeProject()
    const subtitlesDir = path.join(epDir, `${CODE} - 09 Subtitles Output`)
    await fs.mkdir(subtitlesDir, { recursive: true })
    await fs.writeFile(path.join(epDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: 'Introduction' }, { slug: 'Chapter_01' }],
    }))
    await fs.writeFile(
      path.join(subtitlesDir, `${CODE}_Introduction.srt`),
      '1\n00:00:00,000 --> 00:00:02,000\nintro\n',
    )

    const cache = cacheMod.episodeStatusCache
    const pending = await cache.get(SLUG, CODE)
    assert.equal(pending.subtitles, false)
    const stored = cache._dumpProject(SLUG)[0]!
    assert.ok(Object.keys(stored.watchedMtimes).includes(subtitlesDir))

    await fs.writeFile(
      path.join(subtitlesDir, `${CODE}_Chapter_01.srt`),
      '1\n00:00:00,000 --> 00:00:02,000\nchapter\n',
    )
    const storedMtime = stored.watchedMtimes[subtitlesDir]!
    const bumped = new Date(storedMtime + 2_000)
    await fs.utimes(subtitlesDir, bumped, bumped)

    const complete = await cache.get(SLUG, CODE)
    assert.equal(complete.subtitles, true)
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
    const first = cache._dumpProject(SLUG)[0]
    assert.ok(first, 'first project entry stored')
    cache._hydrateProject(SLUG, [{ ...first, episode_code: 'EP002' }])
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

    const filePath = path.join(tmp.dir, 'cache', SLUG, 'episode-status.json')
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
    const filePath = path.join(tmp.dir, 'cache', SLUG, 'episode-status.json')
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
    const filePath = path.join(tmp.dir, 'cache', SLUG, 'episode-status.json')
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
        research: false,
        scene_plan: false, scene_review: false, motion_review: false,
        character_sheet: false,
        broll_picked: false,
        script: true, introduction: false,
        scene_prompts: false, thumb_prompts: false,
        metadata: false,
        images: false, thumbnails: false,
        audio: false, merged_audio: false,
        subtitles: false,
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

  // v1.0.519 — scene_review must recognise scene images by FILE EXISTENCE
  // (<scene_id>.png in the "05 Scene Images" folder), not only by the plan's
  // `image_path` field. Images produced OUTSIDE the app (e.g. a browser
  // extension) land on disk with the right name but leave image_path empty;
  // approved scenes must still read as done. Mirrors the Scene Review page +
  // unified assembler, which already detects by file existence.
  test('scene_review: external images (empty image_path) count when <scene_id>.png exists on disk', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    const imagesDir = path.join(epDir, `${CODE} - 05 Scene Images`)
    // Clean slate so ordering with the sibling test below can't contaminate.
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.rm(imagesDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    // A plan whose scenes have NO image_path — exactly the external-generation case.
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 's1', visual_prompt: 'a', approved: true },
        { id: 's2', visual_prompt: 'b', approved: true },
      ],
    }))
    await writeVerifiedSubtitleTimeline(epDir)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'png-bytes')
    await fs.writeFile(path.join(imagesDir, 's2.png'), 'png-bytes')

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, true, 'scene_plan.json present with content')
    assert.equal(status.scene_review, true, 'both scene images exist on disk → scene review done')
  })

  // v1.4.82 — the split-brain regression. An approve rewrites scene_plan.json
  // inside the Scene Prompts folder; if the cache is still holding the entry it
  // computed a moment earlier, the episode LIST keeps answering "scene review
  // pending" while the episode's own page reads fresh and says done. The
  // approve route now drops this episode's entry, and this is what that buys.
  test('scene_review: an approve is visible to the next list read, not the one after', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    const imagesDir = path.join(epDir, `${CODE} - 05 Scene Images`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.rm(imagesDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.mkdir(imagesDir, { recursive: true })
    const planPath = path.join(scenePromptsDir, 'scene_plan.json')
    const writePlan = async (approved: boolean) => fs.writeFile(planPath, JSON.stringify({
      scenes: [
        { id: 's1', visual_prompt: 'a', approved: true },
        { id: 's2', visual_prompt: 'b', approved },
      ],
    }))
    await writePlan(false)
    await writeVerifiedSubtitleTimeline(epDir)
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'png-bytes')
    await fs.writeFile(path.join(imagesDir, 's2.png'), 'png-bytes')

    const cache = cacheMod.episodeStatusCache
    const before = await cache.get(SLUG, CODE)
    assert.equal(before.scene_review, false, 'one scene is unapproved, so the episode is pending')

    // The approve lands. Without the route's invalidate this entry survives and
    // the list goes on reporting the stale answer.
    await writePlan(true)
    cache.invalidate(SLUG, CODE)

    const after = await cache.get(SLUG, CODE)
    assert.equal(after.scene_review, true, 'the very next read must reflect the approve')
  })

  test('scene_review: remains pending when every image exists but any scene is unapproved', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    const imagesDir = path.join(epDir, `${CODE} - 05 Scene Images`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.rm(imagesDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 's1', visual_prompt: 'first unique visual', approved: true },
        { id: 's2', visual_prompt: 'second unique visual', approved: false },
      ],
    }))
    await writeVerifiedSubtitleTimeline(epDir)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'png-bytes')
    await fs.writeFile(path.join(imagesDir, 's2.png'), 'png-bytes')

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, true)
    assert.equal(status.scene_review, false, 'one unapproved scene keeps Scene Review pending')
  })

  test('scene_review: pending when a scene has neither image_path nor a file on disk', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    const imagesDir = path.join(epDir, `${CODE} - 05 Scene Images`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.rm(imagesDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [{ id: 's1', visual_prompt: 'a' }, { id: 's2', visual_prompt: 'b' }],
    }))
    await writeVerifiedSubtitleTimeline(epDir)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'png-bytes')  // s2 missing

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, true)
    assert.equal(status.scene_review, false, 's2 has no image on disk and no image_path → pending')
  })

  test('scene_plan: duplicated prompts remain pending even when every row is filled', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      scenes: [
        { id: 's1', visual_prompt: 'the same repeated visual' },
        { id: 's2', visual_prompt: ' The same   repeated visual ' },
      ],
    }))
    await writeVerifiedSubtitleTimeline(epDir)

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, false)
    assert.equal(status.scene_review, false)
  })

  test('scene_plan: timeline-only and partially prompted plans remain pending', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    const imagesDir = path.join(epDir, `${CODE} - 05 Scene Images`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.rm(imagesDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      planning_stage: 'timeline',
      scenes: [
        { id: 's1', visual_prompt: 'complete prompt' },
        { id: 's2', visual_prompt: '   ' },
      ],
    }))
    // Even existing images cannot make Scene Review complete while its required
    // prompt-producing stage is incomplete.
    await fs.writeFile(path.join(imagesDir, 's1.png'), 'png-bytes')
    await fs.writeFile(path.join(imagesDir, 's2.png'), 'png-bytes')

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, false, 'one missing visual prompt keeps Scene Plan pending')
    assert.equal(status.scene_review, false, 'Scene Review cannot precede a complete Scene Plan')
  })

  test('scene_plan: render-blocking timeline gaps remain pending', async () => {
    const { epDir } = await makeProject()
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      total_duration_sec: 60,
      opening_mode: 'branded-opening',
      scenes: [
        { id: 's1', start_sec: 15, end_sec: 30, visual_prompt: 'first unique visual' },
        { id: 's2', start_sec: 35, end_sec: 60, visual_prompt: 'second unique visual' },
      ],
    }))
    await writeVerifiedSubtitleTimeline(epDir)

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.scene_plan, false, '5s internal gap must surface in Pending only')
    assert.equal(status.scene_review, false, 'Scene Review cannot be complete while coverage is unsafe')
  })

  // v1.2.7 — Contextual Cues is OPTIONAL, and an episode that never proposed a
  // cue has nothing outstanding. Before this, enabling the project setting made
  // every such episode read as incomplete, which is what turned one checkbox
  // into eighteen "scene_review needs contextual_cues" preflight failures and a
  // Video Assembly that refused to render. The readiness answer and the
  // "was anything produced" answer are now separate fields, because Pipeline's
  // idempotency skip needs the second one or it would cancel a selected
  // Contextual Cues step on exactly the episodes that need it most.
  test('contextual cues: enabled with nothing ever proposed is not outstanding, but is not produced either', async () => {
    const { epDir, projDir } = await makeProject()
    await fs.writeFile(path.join(projDir, 'config.json'), JSON.stringify({ contextual_cues: { enabled: true } }))
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      generated_at: '2026-08-17T00:00:00.000Z',
      total_duration_sec: 12,
      scenes: [
        { id: 's1', scene_index: 1, start_sec: 0, end_sec: 6, visual_prompt: 'first unique visual' },
        { id: 's2', scene_index: 2, start_sec: 6, end_sec: 12, visual_prompt: 'second unique visual' },
      ],
    }))
    await writeVerifiedSubtitleTimeline(epDir)

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.contextual_cues, true, 'no proposals means nothing for a reviewer to resolve')
    assert.equal(status.contextual_cues_generated, false, 'but no timeline was ever written')
  })

  test('contextual cues: an unresolved proposal still reads as outstanding', async () => {
    const { epDir, projDir } = await makeProject()
    await fs.writeFile(path.join(projDir, 'config.json'), JSON.stringify({ contextual_cues: { enabled: true } }))
    const scenePromptsDir = path.join(epDir, `${CODE} - 03 Scene Prompts`)
    await fs.rm(scenePromptsDir, { recursive: true, force: true })
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(path.join(scenePromptsDir, 'scene_plan.json'), JSON.stringify({
      generated_at: '2026-08-17T00:00:00.000Z',
      total_duration_sec: 12,
      scenes: [
        { id: 's1', scene_index: 1, start_sec: 0, end_sec: 6, visual_prompt: 'first unique visual' },
        { id: 's2', scene_index: 2, start_sec: 6, end_sec: 12, visual_prompt: 'second unique visual' },
      ],
    }))
    await fs.writeFile(path.join(scenePromptsDir, 'contextual_cues.json'), JSON.stringify({
      schema_version: 1,
      generated_at: '2026-08-17T00:00:00.000Z',
      source_scene_plan_generated_at: '2026-08-17T00:00:00.000Z',
      cues: [{
        id: 'cue-1', scene_id: 's1', start_sec: 0.5, end_sec: 3.5,
        title: 'Basra', subtitle: '869 CE', kind: 'location_date', placement: 'top-right',
        template: 'documentary-label', entrance: 'fade', exit: 'fade', status: 'proposed',
        created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z',
      }],
    }))
    await writeVerifiedSubtitleTimeline(epDir)

    const status = await cacheMod.episodeStatusCache.get(SLUG, CODE)
    assert.equal(status.contextual_cues, false, 'a proposal nobody reviewed is still outstanding')
    assert.equal(status.contextual_cues_generated, true)
  })
})
