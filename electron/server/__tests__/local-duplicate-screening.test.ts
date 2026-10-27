/**
 * Duplicate screening — the checks themselves, against stub vectors.
 *
 * Deliberately no model: every test here replaces the encoder with a function
 * that returns vectors with a KNOWN cosine to each other, so a threshold is
 * proved by arithmetic rather than by a 970 MB download. The real encoder is
 * qualified separately, by the parity harness, not by these tests.
 *
 * The cases that matter, and why:
 * - **off records nothing**, and reads `not_checked` — the owner's rule that
 *   the feature is optional and absent means "not checked", never "passed".
 * - **a changed image re-embeds** — a stale cached vector would report a score
 *   for a picture that no longer exists.
 * - **another episode's result never appears as this one's** (§4), including
 *   the easy-to-miss case where both episodes name a scene `scene-001`.
 * - **the formula is stripped** before titles are compared, or every title in
 *   a formula channel matches every other one.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'

let screening: typeof import('../services/local-duplicate-screening.js')
let store: typeof import('../services/local-model-store.js')
let host: typeof import('../services/local-embedding-worker-host.js')
let contract: typeof import('../contracts/local-duplicate-screening.js')
let settings: typeof import('../services/local-screening-settings.js')

let root: string
let projectDir: string
const REVISION = 'test-revision'

/** A unit vector, so cosine distance is easy to reason about. */
function unit(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  return values.map(value => value / norm)
}

/** How many times the stub encoder was asked to embed anything. */
let embedCalls = 0

/** Canned vectors by input, so a test controls the exact similarity. */
let vectorsByInput = new Map<string, number[]>()

before(async () => {
  await useTempDataDir()
  screening = await import('../services/local-duplicate-screening.js')
  store = await import('../services/local-model-store.js')
  host = await import('../services/local-embedding-worker-host.js')
  contract = await import('../contracts/local-duplicate-screening.js')
  settings = await import('../services/local-screening-settings.js')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-local-screening-'))
  projectDir = path.join(root, 'channel')
  await fs.mkdir(projectDir, { recursive: true })
})

after(async () => {
  store._setLocalModelInstalledForTesting(null)
  host._setEmbeddingEncoderForTesting(null)
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await host.stopEmbeddingWorker()
  embedCalls = 0
  vectorsByInput = new Map()
  host._setEmbeddingEncoderForTesting(async tasks => {
    embedCalls += tasks.length
    return tasks.map(task => {
      const vector = vectorsByInput.get(task.input) ?? vectorsByInput.get(path.basename(task.input))
      return vector ? { embedding: vector } : { embedding: null, error: `no stub vector for ${path.basename(task.input)}` }
    })
  })
  // Every test starts from "installed" so the checks can run. This is a TEST
  // SEAM, not stand-in files: the fixture harness snapshots the sandbox, so
  // writing exact-size files here materialised ~1 GB of zeros per run for a
  // test that never reads a byte of them.
  store._setLocalModelInstalledForTesting(true)
  await fs.rm(screening.vectorCachePath(projectDir), { force: true })
})

/** Write an image whose content is `content`, and return its path. */
async function writeImage(name: string, content: string): Promise<string> {
  const file = path.join(root, name)
  await fs.writeFile(file, content)
  return file
}

/** Two vectors whose cosine is exactly `score`. */
function pairAtCosine(score: number): [number[], number[]] {
  const perpendicular = Math.sqrt(1 - score * score)
  return [unit([1, 0, 0]), unit([score, perpendicular, 0])]
}

// ── Off, not downloaded, and honest "not checked" ──────────────────────────

test('the switch starts OFF and records nothing', async () => {
  const current = await settings.localScreeningSettings()
  assert.equal(current.enabled, false, 'the feature must start off')

  // Nothing is embedded while it is off — the caller checks the switch, and
  // this asserts the default the caller reads.
  assert.equal(embedCalls, 0)
})

test('a missing model reports not_checked with a reason, never an empty pass', async () => {
  // Make the store look absent.
  store._setLocalModelInstalledForTesting(false)
  assert.equal(await store.localModelLooksInstalled(), false)

  const imageA = await writeImage('a.png', 'a')
  const [vectorA] = pairAtCosine(1)
  vectorsByInput.set(imageA, vectorA!)

  const results = await screening.screenEpisodeScenes({
    projectDir,
    revision: REVISION,
    episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageA },
    ],
  })

  assert.equal(results.length, 2)
  for (const result of results) {
    assert.equal(result.state, 'not_checked')
    assert.match(result.reason || '', /not been downloaded/i)
    assert.deepEqual(result.matches, [])
  }
  assert.equal(embedCalls, 0, 'an absent model must not be asked to embed anything')
})

test('a scene with no image is not_checked for that reason, not "different"', async () => {
  const imageA = await writeImage('only-a.png', 'a')
  vectorsByInput.set(imageA, unit([1, 0, 0]))

  const results = await screening.screenEpisodeScenes({
    projectDir,
    revision: REVISION,
    episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: null },
    ],
  })
  assert.equal(results[0]!.state, 'checked')
  assert.equal(results[1]!.state, 'not_checked')
  assert.match(results[1]!.reason || '', /no image yet/i)
})

// ── Thresholds ─────────────────────────────────────────────────────────────

test('a pair above the duplicate threshold is reported with its score', async () => {
  const imageA = await writeImage('dup-a.png', 'a')
  const imageB = await writeImage('dup-b.png', 'b')
  const [left, right] = pairAtCosine(0.95)
  vectorsByInput.set(imageA, left!)
  vectorsByInput.set(imageB, right!)

  const results = await screening.screenEpisodeScenes({
    projectDir,
    revision: REVISION,
    episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageB },
    ],
  })
  assert.equal(results[0]!.state, 'checked')
  assert.equal(results[0]!.matches.length, 1)
  assert.equal(results[0]!.matches[0]!.strength, 'duplicate')
  assert.equal(results[0]!.matches[0]!.scene_index, 1)
  assert.ok(results[0]!.matches[0]!.score > 0.94 && results[0]!.matches[0]!.score < 0.96)
  assert.match(screening.describeSceneMatch(results[0]!.matches[0]!), /duplicate of scene 1/)
})

test('a pair between the two thresholds is called similar, never a duplicate', async () => {
  const imageA = await writeImage('sim-a.png', 'a')
  const imageB = await writeImage('sim-b.png', 'b')
  const [left, right] = pairAtCosine(0.895)
  vectorsByInput.set(imageA, left!)
  vectorsByInput.set(imageB, right!)

  const results = await screening.screenEpisodeScenes({
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageB },
    ],
  })
  assert.equal(results[0]!.matches[0]!.strength, 'similar')
  assert.match(screening.describeSceneMatch(results[0]!.matches[0]!), /looks similar to scene 1/)
  assert.doesNotMatch(screening.describeSceneMatch(results[0]!.matches[0]!), /duplicate/)
})

test('a pair below both thresholds produces no match at all', async () => {
  const imageA = await writeImage('far-a.png', 'a')
  const imageB = await writeImage('far-b.png', 'b')
  const [left, right] = pairAtCosine(0.5)
  vectorsByInput.set(imageA, left!)
  vectorsByInput.set(imageB, right!)

  const results = await screening.screenEpisodeScenes({
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageB },
    ],
  })
  assert.equal(results[0]!.state, 'checked', 'it was measured…')
  assert.deepEqual(results[0]!.matches, [], '…and the answer is: nothing alike')
})

test('the thresholds are ordered, and the bands do not overlap', () => {
  assert.ok(contract.SCENE_SIMILAR_SCORE < contract.SCENE_NEAR_DUPLICATE_SCORE)
  assert.equal(contract.sceneDuplicateStrength(0.95), 'duplicate')
  assert.equal(contract.sceneDuplicateStrength(0.89), 'similar')
  assert.equal(contract.sceneDuplicateStrength(0.5), null)
  // A score that is not a number is not a duplicate.
  assert.equal(contract.sceneDuplicateStrength(Number.NaN), null)
})

// ── Cache: keyed by content, invalidated by content ────────────────────────

test('a second run re-uses cached vectors instead of embedding again', async () => {
  const imageA = await writeImage('cache-a.png', 'a')
  const imageB = await writeImage('cache-b.png', 'b')
  const [left, right] = pairAtCosine(0.95)
  vectorsByInput.set(imageA, left!)
  vectorsByInput.set(imageB, right!)

  const options = {
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageB },
    ],
  }
  await screening.screenEpisodeScenes(options)
  const firstCalls = embedCalls
  assert.equal(firstCalls, 2)

  await screening.screenEpisodeScenes(options)
  assert.equal(embedCalls, firstCalls, 'an unchanged episode must not be re-embedded')

  const cache = await screening.readVectorCache(projectDir, REVISION)
  assert.equal(cache.entries.length, 2)
  assert.ok(cache.entries.every(entry => entry.vector.length === 3))
})

test('a changed image re-embeds, and the old vector is gone', async () => {
  const imageA = await writeImage('change-a.png', 'original')
  const imageB = await writeImage('change-b.png', 'b')
  const [left, right] = pairAtCosine(0.95)
  vectorsByInput.set(imageA, left!)
  vectorsByInput.set(imageB, right!)

  const options = {
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: imageA },
      { scene_id: 'scene-002', scene_index: 1, image_path: imageB },
    ],
  }
  await screening.screenEpisodeScenes(options)
  const afterFirst = embedCalls

  // Same path, different bytes: a re-render. The old vector described a picture
  // that is no longer on disk.
  //
  // The replacement is deliberately ORTHOGONAL to the original — `pairAtCosine`
  // returns [reference, angledVector], and its first element is always the same
  // [1,0,0]; reaching for that would have re-used the original vector and made
  // this test assert nothing.
  const farLeft = unit([0, 0, 1])
  await fs.writeFile(imageA, 're-rendered')
  vectorsByInput.set(imageA, farLeft)

  const results = await screening.screenEpisodeScenes(options)
  assert.equal(embedCalls, afterFirst + 1, 'the changed picture must be re-embedded')
  assert.equal(results[0]!.matches.length, 0, 'the new picture is not a duplicate of the old one')

  const cache = await screening.readVectorCache(projectDir, REVISION)
  const sceneOne = cache.entries.filter(entry => entry.key === 'scene-001')
  assert.equal(sceneOne.length, 1, 'one row per scene, not one per version')
  assert.deepEqual(sceneOne[0]!.vector, farLeft, 'the cached row is the NEW picture')
})

test('a model revision change discards every cached vector', async () => {
  const imageA = await writeImage('rev-a.png', 'a')
  vectorsByInput.set(imageA, unit([1, 0, 0]))
  await screening.screenEpisodeScenes({
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [{ scene_id: 'scene-001', scene_index: 0, image_path: imageA }],
  })
  const callsAfterFirst = embedCalls

  // Vectors from a different revision live in a different vector space.
  const other = await screening.readVectorCache(projectDir, 'a-different-revision')
  assert.equal(other.entries.length, 0)

  await screening.screenEpisodeScenes({
    projectDir, revision: 'a-different-revision', episodeCode: 'EP0001',
    scenes: [{ scene_id: 'scene-001', scene_index: 0, image_path: imageA }],
  })
  assert.equal(embedCalls, callsAfterFirst + 1, 'a new revision re-embeds')
})

// ── Episode awareness (§4) ─────────────────────────────────────────────────

test('another episode\'s scene never appears as this episode\'s match', async () => {
  // Both episodes call a scene `scene-001`. Scene ids repeat across episodes,
  // so a lookup by id alone would compare two different pictures.
  const mineFile = await writeImage('ep2-scene-001.png', 'mine')
  const theirsFile = await writeImage('ep1-scene-001.png', 'theirs')
  const myOther = await writeImage('ep2-scene-002.png', 'other')

  const mine = unit([1, 0, 0])
  const theirs = unit([1, 0, 0])  // identical picture, but a different episode
  const other = unit([0, 1, 0])
  vectorsByInput.set(mineFile, mine)
  vectorsByInput.set(theirsFile, theirs)
  vectorsByInput.set(myOther, other)

  const results = await screening.screenEpisodeScenes({
    projectDir,
    revision: REVISION,
    episodeCode: 'EP0002',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: mineFile },
      { scene_id: 'scene-002', scene_index: 1, image_path: myOther },
    ],
    recentEpisodes: [
      // EP0001's own scenes, named by EP0001's ids.
      {
        episode_code: 'EP0001',
        title: 'The earlier one',
        scenes: [
          { scene_id: 'scene-001', scene_index: 0, image_path: theirsFile },
          { scene_id: 'scene-002', scene_index: 1, image_path: theirsFile },
        ],
      },
    ],
  })

  const first = results[0]!
  assert.equal(first.state, 'checked')
  const fromOtherEpisode = first.matches.filter(match => match.other_episode)
  assert.ok(fromOtherEpisode.length >= 1, 'the identical picture in EP0001 should be reported')
  for (const match of fromOtherEpisode) {
    assert.equal(match.other_episode!.episode_code, 'EP0001', 'it must name the episode it came from')
  }
  // The within-episode match must NOT be reported as coming from EP0001.
  const withinEpisode = first.matches.filter(match => !match.other_episode)
  assert.equal(withinEpisode.length, 0, 'scene-002 is a different picture in the same episode')
})

test('an episode with no images contributes nothing to the pool', async () => {
  const mineFile = await writeImage('pool-mine.png', 'mine')
  vectorsByInput.set(mineFile, unit([1, 0, 0]))
  const emptyCacheBefore = embedCalls

  await screening.screenEpisodeScenes({
    projectDir, revision: REVISION, episodeCode: 'EP0002',
    scenes: [{ scene_id: 'scene-001', scene_index: 0, image_path: mineFile }],
    recentEpisodes: [{
      episode_code: 'EP0001',
      scenes: [
        { scene_id: 'scene-001', scene_index: 0, image_path: null },
        { scene_id: 'scene-002', scene_index: 1, image_path: null },
      ],
    }],
  })
  assert.equal(embedCalls, emptyCacheBefore + 1, 'only this episode\'s own picture is embedded')
})

// ── Titles: the formula is stripped first ──────────────────────────────────

test('titles that differ only by the channel formula are the same topic', async () => {
  // Every title in this channel ends "| Documentary for Sleep". A naive
  // compare would score the two at ~1.0 and call them duplicates. The topic
  // is what differs, so the formula must be stripped before comparing.
  const formula = ' | Documentary for Sleep'
  const topicVectors = new Map<string, number[]>([
    ['the cambrian explosion', unit([1, 0, 0])],
    ['the mongol conquests', unit([0, 1, 0])],
  ])
  host._setEmbeddingEncoderForTesting(async tasks => {
    embedCalls += tasks.length
    return tasks.map(task => {
      const key = task.input.toLowerCase()
      const vector = topicVectors.get(key)
      return vector ? { embedding: vector } : { embedding: null, error: `no stub for ${key}` }
    })
  })

  // THREE titles carrying the formula: `titleWrapperSegments` only treats a
  // segment as wrapper once at least three titles share it, and with two it
  // would have compared the formula itself.
  const result = await screening.screenTitle({
    projectDir,
    revision: REVISION,
    candidate: `The Mongol Conquests${formula}`,
    existing: [
      { title: `The Cambrian Explosion${formula}`, idea_id: 'idea-1' },
      { title: `The Cambrian Explosion (part 2)${formula}`, idea_id: 'idea-2' },
      { title: `Angkor Wat at Dawn${formula}`, idea_id: 'idea-3' },
    ],
  })
  assert.equal(result.state, 'checked')
  assert.equal(result.matches.length, 0, 'different topics, same formula — not a duplicate')
})

test('a genuinely repeated topic is reported with the title it repeats', async () => {
  host._setEmbeddingEncoderForTesting(async tasks => {
    embedCalls += tasks.length
    return tasks.map(() => ({ embedding: unit([1, 0, 0]) }))
  })
  const result = await screening.screenTitle({
    projectDir,
    revision: REVISION,
    candidate: 'The Fall of the Pygmalion',
    existing: [{ title: 'The Fall of Pygmalion', idea_id: 'idea-9', episode_code: 'EP0007' }],
  })
  assert.equal(result.state, 'checked')
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.idea_id, 'idea-9')
  assert.match(screening.describeTitleMatch(result.matches[0]!), /looks like an existing title/)
  assert.equal(screening.titleLooksDuplicate(result.matches[0]!.score), true)
})

test('an empty title is not_checked rather than silently fine', async () => {
  const result = await screening.screenTitle({
    projectDir, revision: REVISION, candidate: '   ', existing: [{ title: 'Anything' }],
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /no title/i)
})

test('a title that is nothing but the channel formula is not_checked', async () => {
  // "| Documentary for Sleep" on its own has no topic to compare, so there is
  // nothing honest to say about it.
  const result = await screening.screenTitle({
    projectDir,
    revision: REVISION,
    candidate: '| Documentary for Sleep',
    existing: [
      { title: 'The Cambrian Explosion | Documentary for Sleep' },
      { title: 'The Mongol Conquests | Documentary for Sleep' },
      { title: 'Angkor Wat at Dawn | Documentary for Sleep' },
    ],
    // The channel's configured suffix, as the route passes it. Without it the
    // wrapper rule still needs three titles and the topic is still the formula;
    // with it, "nothing but the formula" is detectable on a small channel.
    suffix: ' | Documentary for Sleep',
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /formula|no topic/i)
})

test('one encoder failure does not cost the whole episode', async () => {
  const good = await writeImage('partial-good.png', 'good')
  const bad = await writeImage('partial-bad.png', 'bad')
  vectorsByInput.set(good, unit([1, 0, 0]))
  // `bad` deliberately has no stub vector: the encoder reports a reason for it.

  const results = await screening.screenEpisodeScenes({
    projectDir, revision: REVISION, episodeCode: 'EP0001',
    scenes: [
      { scene_id: 'scene-001', scene_index: 0, image_path: good },
      { scene_id: 'scene-002', scene_index: 1, image_path: bad },
    ],
  })
  assert.equal(results[0]!.state, 'checked', 'the picture that worked is still checked')
  assert.equal(results[1]!.state, 'not_checked')
  assert.match(results[1]!.reason || '', /no stub vector/i)
})
