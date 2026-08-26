/**
 * v1.4.48 — one read of the project's facts per LIST, not per episode.
 *
 * MEASURED 2026-08-23 on a 302-episode project:
 * `/episodes` taking 7.368 s cold and 43–158 ms warm. The cost was not the
 * work — it was reading the same two files over and over:
 *
 *   resolveEpisodePathsByCodeWithSidecar
 *     -> resolveEpisodePathsByCode -> getIdeas()          (ideas.json, 227 KB)
 *                                  -> resolveEpisodePaths  (project.json)
 *     -> resolveSubfolderNames                             (project.json again)
 *
 * and `computeEpisodeStatus` resolved again on its own, several times over. At
 * 302 episodes that is hundreds of reads and roughly 68 MB of JSON re-parsed
 * to answer one request, for two files that cannot change while the response
 * is being built.
 *
 * HOW THIS IS PROVEN. Not by counting `fs.readFile` calls — an earlier draft
 * did, and the counter silently measured a different module's reads while
 * looking convincing. It is proven by CONSEQUENCE: change the file on disk
 * mid-run, and a resolver that re-reads will see the change while one holding
 * a snapshot will not. That cannot be faked by a mis-aimed spy.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let utils: typeof import('../services/utils.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'read-count-project'
const EPISODES = 12

function projectJsonPath(): string {
  return path.join(tmp.dir, 'projects', SLUG, 'project.json')
}

async function makeProject(scriptFolder = '{code} - 01 Script') {
  const projDir = path.join(tmp.dir, 'projects', SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(projectJsonPath(), JSON.stringify({
    slug: SLUG,
    name: 'Read Count',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: { script: scriptFolder },
  }))
  const ideas = Array.from({ length: EPISODES }, (_unused, index) => ({
    id: `idea-${index + 1}`,
    episode_code: `EP${String(index + 1).padStart(3, '0')}`,
    title: `Episode ${index + 1}`,
    status: 'accepted',
  }))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas, next_episode_number: EPISODES + 1, recycled_numbers: [],
  }))
  for (const idea of ideas) {
    await fs.mkdir(path.join(outputRoot, 'Season 001', `${idea.episode_code} - ${idea.title}`), { recursive: true })
  }
  return { ideas }
}

describe('a whole list reads the project facts once, not once per episode', () => {
  before(async () => {
    tmp = await useTempDataDir()
    utils = await import('../services/utils.js')
  })
  after(async () => { await tmp?.cleanup() })

  test('WITHOUT a snapshot, every episode re-reads project.json', async () => {
    // The control, and the shape of the bug: a change lands mid-list because
    // each row went back to disk for a file that never changes during one
    // response.
    const { ideas } = await makeProject('{code} - 01 Script')
    const before1 = await utils.resolveSubfolderNames(SLUG, ideas[0]!.episode_code)
    assert.equal(before1.script, `${ideas[0]!.episode_code} - 01 Script`)

    await makeProject('{code} - CHANGED')
    const after1 = await utils.resolveSubfolderNames(SLUG, ideas[1]!.episode_code)
    assert.equal(after1.script, `${ideas[1]!.episode_code} - CHANGED`,
      'without a snapshot the resolver goes back to disk every time')
  })

  test('WITH one snapshot, the whole list sees ONE consistent read', async () => {
    const { ideas } = await makeProject('{code} - 01 Script')
    const cache = utils.createProjectFactsCache(SLUG)

    const first = await utils.resolveSubfolderNames(SLUG, ideas[0]!.episode_code, cache)
    assert.equal(first.script, `${ideas[0]!.episode_code} - 01 Script`)

    // Change the file underneath. A resolver that re-reads would see it.
    await makeProject('{code} - CHANGED')
    for (const idea of ideas.slice(1)) {
      const names = await utils.resolveSubfolderNames(SLUG, idea.episode_code, cache)
      assert.equal(names.script, `${idea.episode_code} - 01 Script`,
        'the snapshot must be read once and reused for the whole list')
    }

    // And a NEW snapshot — the next request — sees the new truth.
    const nextRequest = utils.createProjectFactsCache(SLUG)
    const fresh = await utils.resolveSubfolderNames(SLUG, ideas[0]!.episode_code, nextRequest)
    assert.equal(fresh.script, `${ideas[0]!.episode_code} - CHANGED`,
      'a snapshot must not outlive the request it was made for')
  })

  test('concurrent rows share ONE read rather than racing to start their own', async () => {
    // The snapshot holds the PROMISE, not the value. Holding the value would
    // mean every row that started before the first read finished missed the
    // cache and read for itself — which is most of them.
    const { ideas } = await makeProject('{code} - 01 Script')
    const cache = utils.createProjectFactsCache(SLUG)
    const all = await Promise.all(ideas.map(idea =>
      utils.resolveSubfolderNames(SLUG, idea.episode_code, cache)))
    assert.equal(new Set(all.map(names => names.script.replace(/^EP\d+ - /, ''))).size, 1)
  })

  test('paths resolve identically with and without the snapshot', async () => {
    // The whole point: this changes how often facts are READ, never what they
    // resolve to. A faster list that reports different folders is not a fix,
    // it is 302 episodes with wrong done/pending marks.
    const { ideas } = await makeProject('{code} - 01 Script')
    const cache = utils.createProjectFactsCache(SLUG)
    for (const idea of ideas) {
      const cached = await utils.resolveEpisodePathsByCodeWithSidecar(SLUG, idea.episode_code, 'audio_chapters.json', cache)
      const fresh = await utils.resolveEpisodePathsByCodeWithSidecar(SLUG, idea.episode_code, 'audio_chapters.json')
      assert.deepEqual(cached, fresh, `${idea.episode_code} resolved differently through the snapshot`)
    }
  })

  test('the episode title still comes from ideas.json, per episode', async () => {
    // The snapshot caches the FILE, not any per-episode conclusion drawn from
    // it. Every row must still find its own title, or every folder would be
    // the first episode's.
    const { ideas } = await makeProject('{code} - 01 Script')
    const cache = utils.createProjectFactsCache(SLUG)
    for (const idea of ideas) {
      const paths = await utils.resolveEpisodePathsByCode(SLUG, idea.episode_code, cache)
      // The folder template ends in a separator, so compare the last segment
      // rather than the raw suffix.
      assert.ok(paths.episode_dir.replace(/[\\/]+$/, '').endsWith(`${idea.episode_code} - ${idea.title}`),
        `${idea.episode_code} resolved to ${paths.episode_dir}`)
    }
  })
})

describe('a snapshot is request-scoped, and refuses to be anything else', () => {
  before(async () => {
    tmp = await useTempDataDir()
    utils = await import('../services/utils.js')
  })
  after(async () => { await tmp?.cleanup() })

  test('a snapshot made for another project is ignored, not believed', async () => {
    const { ideas } = await makeProject('{code} - 01 Script')
    const foreign = utils.createProjectFactsCache('some-other-project')
    const viaForeign = await utils.resolveEpisodePathsByCode(SLUG, ideas[0]!.episode_code, foreign)
    const direct = await utils.resolveEpisodePathsByCode(SLUG, ideas[0]!.episode_code)
    assert.deepEqual(viaForeign, direct)
  })

  test('a failed read is not remembered as the answer', async () => {
    // A snapshot that memoised a rejection would fail every remaining episode
    // in the response because of one transient error.
    const { ideas } = await makeProject('{code} - 01 Script')
    const cache = utils.createProjectFactsCache(SLUG)
    const saved = await fs.readFile(projectJsonPath(), 'utf-8')
    await fs.rm(projectJsonPath())
    await assert.rejects(() => utils.resolveEpisodePaths(SLUG, ideas[0]!.episode_code, 'Episode 1', cache))
    await fs.writeFile(projectJsonPath(), saved)
    const recovered = await utils.resolveEpisodePaths(SLUG, ideas[0]!.episode_code, 'Episode 1', cache)
    assert.ok(recovered.episode_dir.length > 0, 'the same snapshot must retry rather than stay broken')
  })
})
