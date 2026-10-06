/**
 * Warm-list reads must not re-stat every episode.
 *
 * The defect: opening any page that lists a project's episodes re-statted
 * the ~10 watched folders of every episode to confirm nothing had changed.
 * On the owner's 302-episode project that is ~3,200 filesystem round-trips
 * per navigation, every navigation, to learn that nothing changed.
 *
 * The fix: the project already runs a recursive folder watcher, and the
 * watcher deletes an episode's cache entry the moment anything under it
 * changes. So an entry last confirmed against disk AFTER that watcher went
 * live can be served as-is. These tests pin the three properties that make
 * that safe:
 *
 *   1. A warm list of unchanged episodes does no per-episode statting.
 *   2. A change to one episode recomputes that episode and no other.
 *   3. Losing the watcher costs speed, never correctness — the strict
 *      mtime check comes straight back, and a rolling audit re-verifies
 *      aged entries even while the watcher looks healthy.
 *
 * Plus the residency rule: this machine holds ~1,557 persisted rows across
 * 12 projects against a 1,000-entry cap, so eviction must never throw out
 * the project being read.
 *
 * IMPORTANT — module-load ordering: project-manager.ts evaluates
 * PROJECTS_ROOT at module-load time, so STORY_STUDIO_DATA_DIR must be set
 * (via useTempDataDir) BEFORE the cache is imported. All imports happen
 * inside before().
 */

import { test, describe, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

let cacheMod: typeof import('../services/episode-status-cache.js')
let watcherMod: typeof import('../services/episode-folder-watcher.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'warm-list-project'
const CODES = ['EP001', 'EP002', 'EP003', 'EP004', 'EP005', 'EP006']

/** Create the project plus one folder-complete episode per code. */
async function makeProject(codes: string[] = CODES) {
  const projDir = path.join(tmp.dir, 'projects', SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Warm List',
    episode_prefix: 'EP',
    season_size: 100,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }, null, 2))
  const dirs: Record<string, { epDir: string; scriptDir: string }> = {}
  for (const code of codes) {
    const epDir = path.join(outputRoot, 'Season 001', `${code} - Test`)
    const scriptDir = path.join(epDir, `${code} - 01 Script`)
    await fs.mkdir(scriptDir, { recursive: true })
    await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.docx`), 'fake docx')
    dirs[code] = { epDir, scriptDir }
  }
  // The ideas store is what gives each code its canonical title, and the
  // path resolver needs it: without it the watched-folder list resolves to
  // paths that do not exist and every entry caches an empty snapshot.
  // Shape must match readStoreFromDisk's wrapper — a bare array reads as
  // "no ideas".
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: codes.map((code, i) => ({
      id: `idea-${i}`, episode_code: code, title: 'Test', status: 'accepted',
    })),
    next_episode_number: codes.length + 1,
    recycled_numbers: [],
  }, null, 2))
  return { projDir, outputRoot, dirs }
}

/** Read every episode the way the /episodes list route does. */
async function listAll(codes: string[] = CODES) {
  for (const code of codes) {
    await cacheMod.episodeStatusCache.getForList(SLUG, code)
  }
}

/** Count fs.stat calls made while `fn` runs. */
async function countStats<T>(fn: () => Promise<T>): Promise<{ result: T, stats: number }> {
  const target = fs as any
  const original = target.stat
  let count = 0
  target.stat = (...args: any[]) => { count++; return original.apply(target, args) }
  try {
    const result = await fn()
    return { result, stats: count }
  } finally {
    target.stat = original
  }
}

/**
 * State the precondition "these entries were just verified" instead of racing
 * the clock for it.
 *
 * `trusted()` serves an entry without statting only while it is younger than
 * AUDIT_MAX_AGE_MS (15s); past that the rolling audit re-verifies it. That is
 * the cache working correctly — and it is also a clock the tests below were
 * racing. On a loaded machine the SET-UP pass can itself take longer than that
 * window, so entries aged out before the assertion, the audit re-verified them
 * exactly as designed, and "a warm list costs nothing" failed intermittently
 * with nothing actually wrong.
 *
 * Reproduced deliberately rather than guessed: backdating `verifiedAt` by 16s
 * before the warm pass turns "must not stat episode folders" into "saw 12" —
 * the exact intermittent failure, on demand.
 *
 * Nothing is weakened. The ageing path has its own test below, which backdates
 * on purpose and asserts the audit DOES fire.
 */
function markFreshlyVerified() {
  const now = Date.now()
  for (const entry of cacheMod.episodeStatusCache._dumpProject(SLUG)) entry.verifiedAt = now
}

/**
 * Let the project's own set-up finish arriving before measuring anything.
 *
 * makeProject() writes six episode folders, and the watcher only attaches
 * when the first list read asks for it — AFTER those writes. On macOS,
 * FSEvents from a burst that began before attach can still be delivered
 * after it. The watcher then does exactly its job: invalidate() is a map
 * delete, so one freshly hydrated row vanishes, and a test that dumps the
 * map right then sees five episodes instead of six. That is a race in the
 * test's own set-up, not a defect in the cache — the sibling of the
 * audit-clock race markFreshlyVerified() settles above.
 *
 * Reproduced on demand: it is the intermittent "5 !== 6" on
 * "every episode is cached before the change".
 *
 * Not a fixed sleep — `no-new-wallclock-sleeps` forbids one, and rightly: a
 * sleep asserts this machine schedules promptly, which is the same class of
 * race being fixed. Instead, poll for the condition that matters: after a
 * re-hydrating read, every episode is present again. waitFor()'s budget is
 * scheduled time, so a loaded machine stretches the wait instead of failing.
 * A straggler that deletes a row makes the probe false; the next read puts
 * the row back; the probe turns true. From here on the only events are the
 * ones a test raises deliberately.
 */
async function settleWatcher() {
  await waitFor(async () => {
    await listAll()
    return cacheMod.episodeStatusCache._dumpProject(SLUG).length === CODES.length
  }, { label: 'set-up watch events to land and every episode to be re-hydrated' })
}

describe('episode-status warm list', () => {
  before(async () => {
    tmp = await useTempDataDir()
    cacheMod = await import('../services/episode-status-cache.js')
    watcherMod = await import('../services/episode-folder-watcher.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'),
      'projectsRoot() must point at the temp dir — env was set too late')
  })

  after(async () => {
    watcherMod.stopAllWatchers()
    await tmp.cleanup()
  })

  beforeEach(() => {
    cacheMod.episodeStatusCache.clear()
    watcherMod.stopAllWatchers()
    // Restore the real wiring (episode-status-cache.ts binds this at import),
    // so a test that deliberately goes deaf cannot leak into the next one.
    watcherMod.bindInvalidator((slug, code) => cacheMod.episodeStatusCache.invalidate(slug, code))
  })

  test('an unchanged warm list does no per-episode statting', async () => {
    await makeProject()

    // Cold pass: every episode is computed, and the stat counter proves the
    // instrumentation is actually attached (a silent no-op patch would make
    // the warm assertion below pass for the wrong reason).
    const cold = await countStats(() => listAll())
    assert.ok(cold.stats > CODES.length,
      `cold list must stat the disk (saw ${cold.stats} stats)`)

    if (watcherMod.watcherTrustedSince(SLUG) === null) {
      // Recursive fs.watch is unavailable here. The cache is still correct —
      // it simply keeps re-statting. Nothing to assert about speed.
      return
    }

    // The cold pass above may itself have outlived the trust window on a busy
    // machine, and set-up events may still be landing. Say what this test
    // means — the entries are current and settled — rather than depending on
    // how long the previous line took.
    await settleWatcher()
    markFreshlyVerified()

    // getStats() counters are cumulative across the settle pass above, so
    // measure this pass as a delta — the same way the convergence tests
    // below read staleRecomputes.
    const before = cacheMod.episodeStatusCache.getStats()
    const warm = await countStats(() => listAll())
    assert.equal(warm.stats, 0,
      `a warm list of unchanged episodes must not stat episode folders (saw ${warm.stats})`)
    const after = cacheMod.episodeStatusCache.getStats()
    assert.equal(after.watchedHits - before.watchedHits, CODES.length,
      'every row served on the watcher\'s word')
    assert.equal(after.staleRecomputes - before.staleRecomputes, 0, 'nothing recomputed')
  })

  test('a change to one episode recomputes only that episode', async () => {
    await makeProject()
    await listAll()
    if (watcherMod.watcherTrustedSince(SLUG) === null) return
    await settleWatcher()

    // This test drives the cache invalidator directly below. Isolate that
    // measurement from any leading/trailing native events left by setup;
    // beforeEach restores the real watcher wiring for the watcher tests.
    watcherMod.bindInvalidator(() => {})

    const stamps = () => new Map(
      cacheMod.episodeStatusCache._dumpProject(SLUG).map(e => [e.episode_code, e.computedAt]),
    )
    const before = stamps()
    assert.equal(before.size, CODES.length, 'every episode is cached before the change')

    // This is exactly what the watcher does when a file lands under an
    // episode: `bindInvalidator` wires its events straight to invalidate().
    // Driving that hook directly keeps the test about the cache's behaviour
    // instead of about whether this filesystem delivers fs.watch events —
    // which, measured here, it sometimes does not.
    cacheMod.episodeStatusCache.invalidate(SLUG, 'EP003')

    const measured = await countStats(() => listAll())
    const after = stamps()
    const recomputed = [...after]
      .filter(([code, at]) => before.get(code) !== at)
      .map(([code]) => code)
      .sort()
    assert.deepEqual(recomputed, ['EP003'],
      `only the changed episode may recompute (recomputed: ${recomputed.join(', ') || 'none'})`)
    assert.ok(measured.stats > 0, 'the recomputed episode did re-read its folders')
  })

  test('a watcher that stops delivering events still converges', async () => {
    const { dirs } = await makeProject()
    await listAll()
    if (watcherMod.watcherTrustedSince(SLUG) === null) return
    await settleWatcher()

    // The watcher is alive as far as anyone can tell — it started without
    // error and was never closed — but no event arrives for this change.
    // fs.watch really does behave this way on some filesystems, and it
    // reports nothing when it does, so the cache must not depend on it.
    //
    // "No event arrives" is made a FACT, not a hope. The change below is an
    // `fs.utimes` on a watched folder while the watcher is live, so on any
    // machine where fs.watch actually delivers, it would arrive as a real
    // invalidation — turning the read into a miss instead of the stale
    // recompute this test measures, and failing it. It passes here only
    // because fs.watch delivers nothing at all in this environment, which is
    // precisely the sort of accident that becomes a mystery failure on
    // someone else's machine.
    watcherMod.bindInvalidator(() => { /* deaf on purpose, for this test */ })
    const entry = cacheMod.episodeStatusCache._dumpProject(SLUG)
      .find(e => e.episode_code === 'EP004')!
    const scriptDir = dirs['EP004'].scriptDir
    const storedMtime = entry.watchedMtimes[scriptDir]!
    assert.ok(storedMtime, 'the script folder is one of the watched paths')
    const bumped = new Date(storedMtime + 2_000)
    await fs.utimes(scriptDir, bumped, bumped)

    // Immediately after, the list may still serve the trusted entry — that
    // is the deal. What must not happen is that it stays that way.
    const before = cacheMod.episodeStatusCache.getStats()
    for (const e of cacheMod.episodeStatusCache._dumpProject(SLUG)) {
      // Age every entry past the trust window, exactly as the clock would.
      e.verifiedAt = Date.now() - 10 * 60 * 1000
    }
    await listAll()
    const after = cacheMod.episodeStatusCache.getStats()
    assert.equal(after.staleRecomputes - before.staleRecomputes, 1,
      'the unannounced change is picked up by the audit, with no event and no user action')
  })

  test('losing the watcher restores strict mtime checking, not stale status', async () => {
    const { dirs } = await makeProject()
    await listAll()

    // The watcher dies — evicted by the LRU cap, an error event, an
    // unsupported platform. Whatever the reason, correctness must not
    // depend on it.
    // Ignore any delayed native events from the setup writes, then establish
    // the exact cached precondition this test needs before stopping it.
    watcherMod.bindInvalidator(() => {})
    await listAll()
    watcherMod.stopProjectWatcher(SLUG)
    assert.equal(watcherMod.watcherTrustedSince(SLUG), null, 'trust withdrawn')

    const entry = cacheMod.episodeStatusCache._dumpProject(SLUG)
      .find(e => e.episode_code === 'EP002')!
    const scriptDir = dirs['EP002'].scriptDir
    const storedMtime = entry.watchedMtimes[scriptDir]!
    const bumped = new Date(storedMtime + 2_000)
    await fs.utimes(scriptDir, bumped, bumped)

    const before = cacheMod.episodeStatusCache.getStats()
    await listAll()
    const after = cacheMod.episodeStatusCache.getStats()
    assert.equal(after.staleRecomputes - before.staleRecomputes, 1,
      'the out-of-band change is caught by the mtime check with no watcher at all')
    assert.equal(after.watchedHits, before.watchedHits,
      'nothing may be served on a dead watcher\'s word')
  })

  test('aged entries are re-verified even while the watcher looks healthy', async () => {
    await makeProject()
    await listAll()
    if (watcherMod.watcherTrustedSince(SLUG) === null) return
    await settleWatcher()

    // Age every entry past the audit window. _dumpProject hands back the live
    // entries, so this is the same state a long-open app reaches on its own.
    for (const e of cacheMod.episodeStatusCache._dumpProject(SLUG)) {
      e.verifiedAt = Date.now() - 10 * 60 * 1000
    }

    const audited = await countStats(() => listAll())
    assert.ok(audited.stats > 0,
      'aged entries must be re-checked against disk — the watcher is not the only witness')

    // ...and once re-verified they are trusted again, so the audit is a
    // rolling cost, not a permanent one. (Freshened for the same reason as
    // above: the audit pass itself can outlive the window under load, which
    // would re-age the very entries it just verified.)
    markFreshlyVerified()
    const settled = await countStats(() => listAll())
    assert.equal(settled.stats, 0, 're-verified entries go back to costing nothing')
  })

  test('a large project re-audits a paced slice per window, rows loaded from disk included', async () => {
    // 1.4.257 — the owner's 405-episode channel re-audited almost every row on
    // every read, because the budget refilled each second and a read took
    // longer than that. Now one window spends a bounded slice, and the next
    // window finishes the job.
    const codes = Array.from({ length: 30 }, (_, i) => `EP${String(i + 1).padStart(3, '0')}`)
    await makeProject(codes)
    await listAll(codes)
    if (watcherMod.watcherTrustedSince(SLUG) === null) return
    watcherMod.bindInvalidator(() => {})
    await listAll(codes)
    assert.equal(cacheMod.episodeStatusCache._dumpProject(SLUG).length, 30, 'every episode is cached')
    // Last confirmed before this watcher went live — exactly a row read from
    // the disk cache at startup.
    for (const e of cacheMod.episodeStatusCache._dumpProject(SLUG)) e.verifiedAt = 0
    const verified = () => cacheMod.episodeStatusCache._dumpProject(SLUG).filter(e => (e.verifiedAt ?? 0) > 0).length

    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    try {
      await listAll(codes)
      assert.equal(verified(), 24, 'one window re-checks only its budget; the rest are served as they are')
      await listAll(codes)
      assert.equal(verified(), 24, 'a second read in the same window spends nothing more')
      mock.timers.tick(15_001)
      await listAll(codes)
      assert.equal(verified(), 30, 'the next window re-checks the rest')
      assert.equal(cacheMod.episodeStatusCache.getStats().staleRecomputes, 0, 'unchanged rows are confirmed, not recomputed')
    } finally {
      mock.timers.reset()
    }
  })

  test('a full cache evicts other projects before the one being read', async () => {
    await makeProject()
    // This case is about residency, not whether this filesystem delivers a
    // delayed watch event from the project setup above. On a loaded full-suite
    // run one such event can arrive while the filler rows are being inserted
    // and remove an otherwise protected active-project row. Keep the watcher
    // alive (so the warm-read assertion below remains meaningful), but make
    // its invalidator deliberately deaf for this eviction-only case.
    watcherMod.bindInvalidator(() => {})
    await listAll()   // SLUG becomes the active project

    // Two other projects' persisted rows are hydrated — together far more
    // than the 1,000-entry cap, exactly the shape of this machine (~1,557
    // rows across 12 projects). Under plain LRU the active project's rows
    // were inserted first and would be the first thrown away, so every
    // click in the project the user is actually looking at paid a full
    // recompute.
    const filler = (slug: string, n: number) => Array.from({ length: n }, (_, i) => ({
      slug,
      episode_code: `FL${String(i).padStart(4, '0')}`,
      status: { script: true } as any,
      computedAt: Date.now(),
      verifiedAt: Date.now(),
      watchedMtimes: { [`/tmp/${slug}/${i}`]: 1 },
      schemaVersion: cacheMod.SCHEMA_VERSION,
    }))
    cacheMod.episodeStatusCache._hydrateProject('other-a', filler('other-a', 600))
    cacheMod.episodeStatusCache._hydrateProject('other-b', filler('other-b', 600))

    const resident = cacheMod.episodeStatusCache._dumpProject(SLUG)
    assert.equal(resident.length, CODES.length,
      'the project being read keeps every row')
    assert.ok(cacheMod.episodeStatusCache.getStats().size <= 1000,
      'the cache is still bounded')

    // And the reads that follow are free, because nothing was evicted.
    if (watcherMod.watcherTrustedSince(SLUG) === null) return
    // Hydrating 1,200 filler rows is real work; on a busy machine it alone can
    // outlive the trust window. This test is about EVICTION, not ageing.
    markFreshlyVerified()
    const after = await countStats(() => listAll())
    assert.equal(after.stats, 0, 'no recompute after another project was hydrated')
  })
})
