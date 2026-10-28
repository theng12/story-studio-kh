/**
 * Duplicate screening — the two checks, and the cache they read.
 *
 * Exposed as two questions, both answered with advice and never with a gate:
 *
 *   1. `screenEpisodeScenes` — do two scenes in this episode look like the
 *      same picture? (optionally, also against the channel's recent episodes)
 *   2. `screenTitle` — does this title look like one the channel already has?
 *
 * Every rule below comes from a specific failure this repo has had before:
 *
 * - **Episode-specific state must not survive an episode change (§4).** Results
 *   are keyed by episode AND by the image file's own hash, so a cached answer
 *   can only ever be shown for the exact picture it was computed from. A
 *   changed image re-embeds; another episode's result never appears as this
 *   one's.
 * - **A zero that means two things is a defect (§6).** "These differ" and "I
 *   could not look" are different values, and the second one carries a reason
 *   all the way to the badge.
 * - **Never a catalogue value (§1).** The encoder is chosen by this app's own
 *   opt-in switch and its downloaded revision, not by anything GenStudio
 *   publishes; the thresholds are Story policy constants in the contract.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  RECENT_EPISODE_WINDOW,
  SCENE_NEAR_DUPLICATE_SCORE,
  SCENE_SIMILAR_SCORE,
  TITLE_DUPLICATE_SCORE,
  describeSceneMatch,
  sceneDuplicateStrength,
  type SceneDuplicateMatch,
  type SceneDuplicateResult,
  type TitleDuplicateMatch,
  type TitleDuplicateResult,
} from '../contracts/local-duplicate-screening.js'
import { writeJsonAtomic, readJsonOr, withLock } from '../lib/atomic-store.js'
import { coreTitle, titleWrapperSegments } from './idea-similarity.js'
import { cosineSimilarity } from './local-embedding-encoder.js'
import { embedBatch } from './local-embedding-worker-host.js'

/** The cache file's name, inside the channel folder. */
export const VECTOR_CACHE_FILENAME = 'embedding-vectors.json'

/** How many entries one channel may keep before the oldest are dropped. */
const MAX_CACHE_ENTRIES = 4000

interface CachedVector {
  /** First 8 hex characters of the SHA-256 of the bytes that were embedded. */
  hash: string
  /**
   * What this row is. Recorded rather than inferred from `key`, so a scene
   * whose id happens to look like a title key can never be read as one.
   */
  kind: 'image' | 'title'
  /** Which episode the row came from, so it can never be read as another one's. */
  episode_code: string
  /** `image` rows carry a scene id; `title` rows carry the topic text. */
  key: string
  vector: number[]
  embedded_at: string
}

interface VectorCacheFile {
  schema_version: 1
  /** The model revision the vectors came from. A bump invalidates everything. */
  revision: string
  entries: CachedVector[]
}

const EMPTY_CACHE = (revision: string): VectorCacheFile => ({ schema_version: 1, revision, entries: [] })

export function vectorCachePath(projectDir: string): string {
  return path.join(projectDir, VECTOR_CACHE_FILENAME)
}

/**
 * Read the channel's cache, dropping everything when the model revision moved.
 *
 * The revision check is not defensive tidiness: vectors from a different
 * revision are a different vector space, and comparing across them produces
 * confident nonsense rather than an error.
 */
export async function readVectorCache(projectDir: string, revision: string): Promise<VectorCacheFile> {
  const raw = await readJsonOr<VectorCacheFile | null>(vectorCachePath(projectDir), null)
  if (!raw || raw.schema_version !== 1 || raw.revision !== revision || !Array.isArray(raw.entries)) {
    return EMPTY_CACHE(revision)
  }
  return raw
}

async function writeVectorCache(projectDir: string, cache: VectorCacheFile): Promise<void> {
  // Keep the newest rows when the cache outgrows its bound; a channel screens
  // recent episodes, so the oldest rows are the least useful.
  const entries = cache.entries.length > MAX_CACHE_ENTRIES
    ? cache.entries.slice(cache.entries.length - MAX_CACHE_ENTRIES)
    : cache.entries
  await writeJsonAtomic(vectorCachePath(projectDir), { ...cache, entries })
}

/** The content hash a cache row is keyed by. Read lazily, so an unchanged file costs one stat. */
export async function fileContentHash(file: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(file)
    return createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  } catch {
    return null
  }
}

/** A stable 8-hex hash of a string, so a title row is keyed the same way an image is. */
export function textContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

function rowKey(kind: 'image' | 'title', episodeCode: string, key: string): string {
  return `${kind}\u0000${episodeCode}\u0000${key}`
}

function indexCache(cache: VectorCacheFile): Map<string, CachedVector> {
  const map = new Map<string, CachedVector>()
  for (const entry of cache.entries) {
    // A row written before `kind` existed is treated as an image row, which is
    // all this cache held at the time; it will be replaced on the next run.
    map.set(rowKey(entry.kind === 'title' ? 'title' : 'image', entry.episode_code, entry.key), entry)
  }
  return map
}

export interface ScreenSceneInput {
  scene_id: string
  scene_index: number
  /** Absolute path to the scene's own image, or null when it has none yet. */
  image_path: string | null
}

export interface ScreenEpisodeOptions {
  projectDir: string
  revision: string
  episodeCode: string
  /** This episode's scenes, in scene order. */
  scenes: ScreenSceneInput[]
  /**
   * Scenes from the channel's recent episodes to compare against, when the
   * channel asked for that. Each entry is one episode's own scenes; they are
   * never mixed in as if they were part of this episode.
   */
  recentEpisodes?: Array<{ episode_code: string; title?: string; scenes: ScreenSceneInput[] }>
}

/**
 * The near-duplicate check for one episode.
 *
 * Returns one result per scene, in the order handed in. A scene with no image
 * yet is `not_checked` with that reason — it is not "different from everything".
 */
export async function screenEpisodeScenes(options: ScreenEpisodeOptions): Promise<SceneDuplicateResult[]> {
  const { scenes, episodeCode, revision, projectDir } = options
  if (!scenes.length) return []

  const cache = await readVectorCache(projectDir, revision)
  const indexed = indexCache(cache)
  const dirty: CachedVector[] = []

  // Which file hashes each scene currently has. A changed image gets a new
  // hash, which is exactly what makes its old vector unreachable.
  const hashed = await Promise.all(scenes.map(async scene => ({
    scene,
    hash: scene.image_path ? await fileContentHash(scene.image_path) : null,
  })))

  const needEmbedding: Array<{ index: number; file: string; hash: string }> = []
  const vectors = new Map<number, number[]>()
  for (const [index, item] of hashed.entries()) {
    if (!item.scene.image_path) continue
    if (!item.hash) continue
    const existing = indexed.get(rowKey('image', episodeCode, item.scene.scene_id))
    if (existing && existing.hash === item.hash && existing.vector.length) {
      vectors.set(index, existing.vector)
    } else {
      needEmbedding.push({ index, file: item.scene.image_path, hash: item.hash })
    }
  }

  const recentEmbeddings = await embedRecentEpisodes(options, revision, projectDir, indexed, dirty)

  // The first reason the encoder gave for anything in this episode it could not
  // encode. Kept here, per call — never on module state, which would leak one
  // episode's failure into the next one's message (§4).
  let firstFailure: string | null = null

  if (needEmbedding.length) {
    const outcomes = await embedBatch(needEmbedding.map(item => ({ kind: 'image' as const, input: item.file })))
    for (const [position, outcome] of outcomes.entries()) {
      const target = needEmbedding[position]!
      if (!outcome.embedding) {
        if (!firstFailure) firstFailure = outcome.error || 'This picture could not be compared.'
        continue
      }
      vectors.set(target.index, outcome.embedding)
      dirty.push({
        hash: target.hash,
        kind: 'image',
        episode_code: episodeCode,
        key: scenes[target.index]!.scene_id,
        vector: outcome.embedding,
        embedded_at: new Date().toISOString(),
      })
    }
  }

  // ONE write for the whole call, AFTER both batches. It used to sit inside the
  // "this episode had uncached scenes" branch, which meant a fully cached
  // episode silently threw away the recent-episode vectors it had just
  // computed, and re-embedded them on every visit.
  if (dirty.length) {
    const merged = [
      ...cache.entries.filter(entry => !dirty.some(row => row.key === entry.key && row.episode_code === entry.episode_code)),
      ...dirty,
    ]
    await withLock(vectorCachePath(projectDir), () =>
      writeVectorCache(projectDir, { ...cache, entries: merged }),
    ).catch(() => {
      // A cache write that fails costs a re-embed next time, nothing more.
    })
  }

  const results: SceneDuplicateResult[] = []
  for (const [index, scene] of scenes.entries()) {
    if (!scene.image_path) {
      results.push({ scene_id: scene.scene_id, state: 'not_checked', matches: [], reason: 'This scene has no image yet.' })
      continue
    }
    const vector = vectors.get(index)
    if (!vector) {
      results.push({
        scene_id: scene.scene_id,
        state: 'not_checked',
        matches: [],
        reason: firstFailure || 'This picture could not be compared.',
      })
      continue
    }

    const matches: SceneDuplicateMatch[] = []
    for (const [otherIndex, other] of scenes.entries()) {
      if (otherIndex === index || !other.image_path) continue
      const otherVector = vectors.get(otherIndex)
      if (!otherVector) continue
      const score = cosineSimilarity(vector, otherVector)
      const strength = sceneDuplicateStrength(score)
      if (!strength) continue
      matches.push({ scene_id: other.scene_id, scene_index: other.scene_index, score, strength })
    }
    // Recent episodes: compare against each of THEIR OWN scenes, by their own
    // ids. Scene ids repeat across episodes ("scene-001" in every one), so
    // looking one up by this episode's id would compare a scene with a
    // different picture — the §4 defect exactly.
    for (const recent of recentEmbeddings) {
      for (const other of recent.scenes) {
        const otherVector = recent.vectors.get(other.scene_id)
        if (!otherVector) continue
        const score = cosineSimilarity(vector, otherVector)
        const strength = sceneDuplicateStrength(score)
        if (!strength) continue
        matches.push({
          scene_id: other.scene_id,
          scene_index: other.scene_index,
          score,
          strength,
          other_episode: { episode_code: recent.episode_code, title: recent.title },
        })
      }
    }

    matches.sort((left, right) => right.score - left.score)
    results.push({ scene_id: scene.scene_id, state: 'checked', matches: matches.slice(0, 3) })
  }
  return results
}

/** Per-recent-episode vectors, keyed by that episode's own scene ids. */
interface RecentEpisodeVectors {
  episode_code: string
  title?: string
  scenes: ScreenSceneInput[]
  vectors: Map<string, number[]>
}

async function embedRecentEpisodes(
  options: ScreenEpisodeOptions,
  revision: string,
  projectDir: string,
  indexed: Map<string, CachedVector>,
  dirty: CachedVector[],
): Promise<RecentEpisodeVectors[]> {
  const recent = (options.recentEpisodes || []).slice(0, RECENT_EPISODE_WINDOW)
  if (!recent.length) return []

  const pending: Array<{ episode: string; title?: string; scene: ScreenSceneInput; hash: string }> = []
  const resolved: RecentEpisodeVectors[] = recent.map(entry => ({
    episode_code: entry.episode_code,
    title: entry.title,
    scenes: entry.scenes,
    vectors: new Map<string, number[]>(),
  }))

  for (const [recentIndex, entry] of recent.entries()) {
    for (const scene of entry.scenes) {
      if (!scene.image_path) continue
      const hash = await fileContentHash(scene.image_path)
      if (!hash) continue
      // A recent episode's row is keyed by ITS episode code, so it can never be
      // mistaken for this episode's scene with the same id.
      const existing = indexed.get(rowKey('image', entry.episode_code, scene.scene_id))
      if (existing && existing.hash === hash && existing.vector.length) {
        resolved[recentIndex]!.vectors.set(scene.scene_id, existing.vector)
      } else {
        pending.push({ episode: entry.episode_code, title: entry.title, scene, hash })
      }
    }
  }

  if (pending.length) {
    const outcomes = await embedBatch(pending.map(item => ({ kind: 'image' as const, input: item.scene.image_path! })))
    for (const [position, outcome] of outcomes.entries()) {
      const target = pending[position]!
      if (!outcome.embedding) continue
      const bucket = resolved.find(entry => entry.episode_code === target.episode)
      bucket?.vectors.set(target.scene.scene_id, outcome.embedding)
      dirty.push({
        hash: target.hash,
        kind: 'image',
        episode_code: target.episode,
        key: target.scene.scene_id,
        vector: outcome.embedding,
        embedded_at: new Date().toISOString(),
      })
    }
  }
  return resolved
}


// ── Titles ─────────────────────────────────────────────────────────────────

export interface ExistingTitle {
  idea_id?: string
  episode_code?: string
  title: string
}

export interface ScreenTitleOptions {
  projectDir: string
  revision: string
  /** The title being considered, as the owner typed or the model wrote it. */
  candidate: string
  /** Everything the channel already has: ideas, episode titles, and its Formula's titles. */
  existing: ExistingTitle[]
  /**
   * The channel's OWN configured title prefix and suffix, read live from its
   * config (§1). Passing them is what makes the formula strip work on a small
   * channel: `titleWrapperSegments` needs the wrapper to appear in three
   * titles before it treats it as a wrapper, and a channel with two ideas would
   * otherwise compare its formula against itself.
   */
  prefix?: string
  suffix?: string
}

/**
 * A leading `|` is a wrapper the segment splitter cannot see.
 *
 * `coreTitle` splits on `" | "`, so `"| Documentary for Sleep"` — a formula
 * with nothing in front of it — stays one segment and survives stripping. This
 * turns a leading pipe into the separator the splitter expects, which is what
 * makes "this title is nothing but the channel's formula" detectable at all.
 */
function normalizeLeadingPipe(title: string): string {
  return title.replace(/^[\s|｜]+/, '')
}

/**
 * Is what is left after stripping just the formula again?
 *
 * Covers the case the segment splitter cannot reach — a topic that is entirely
 * the channel's configured prefix/suffix — so "no topic to compare" is reported
 * rather than one formula being compared against every formula.
 */
function isOnlyFormula(topic: string, prefix: string, suffix: string): boolean {
  const strip = (text: string) =>
    text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
  const key = strip(topic)
  if (!key) return true
  return (!!prefix && key === strip(prefix)) || (!!suffix && key === strip(suffix))
}

/**
 * Does this title repeat one the channel already has?
 *
 * **The channel's formula is stripped first.** A channel whose titles all end
 * "| Documentary for Sleep" would otherwise match every other title in the
 * channel — the prototype measured exactly that ("formula channels like Coffee
 * Jazz otherwise all match"). The stripping reuses `titleWrapperSegments` and
 * `coreTitle`, the two functions the idea pipeline already uses for the same
 * reason, rather than growing a second copy that could drift.
 */
export async function screenTitle(options: ScreenTitleOptions): Promise<TitleDuplicateResult> {
  const candidate = normalizeLeadingPipe(String(options.candidate || '').trim())
  if (!candidate) {
    return { state: 'not_checked', matches: [], reason: 'There is no title to compare yet.' }
  }
  const pool = options.existing.filter(entry => entry.title && entry.title.trim())
  if (!pool.length) {
    return { state: 'checked', matches: [] }
  }

  const prefix = String(options.prefix || '').trim()
  const suffix = String(options.suffix || '').trim()
  // Strip the channel's own prefix/suffix as well as its recurring segments:
  // `coreTitle` already accepts both, and a channel that configures its formula
  // as a prefix rather than a ` | ` segment must still be stripped.
  const wrappers = titleWrapperSegments([candidate, ...pool.map(entry => entry.title)])
  const candidateTopic = coreTitle(candidate, wrappers, prefix, suffix).trim()
  if (!candidateTopic || isOnlyFormula(candidateTopic, prefix, suffix)) {
    return {
      state: 'not_checked',
      matches: [],
      reason: 'This title is nothing but the channel’s own formula, so there is no topic to compare.',
    }
  }

  const topics = pool.map(entry => ({
    entry,
    topic: coreTitle(normalizeLeadingPipe(entry.title.trim()), wrappers, prefix, suffix).trim(),
  })).filter(item => item.topic && !isOnlyFormula(item.topic, prefix, suffix))
  const cache = await readVectorCache(options.projectDir, options.revision)
  const indexed = indexCache(cache)
  const dirty: CachedVector[] = []

  const candidateKey = `title:${textContentHash(candidateTopic)}`
  let candidateVector: number[] | null = null
  const existingCandidate = indexed.get(rowKey('title', '', candidateKey))
  if (existingCandidate?.vector.length) {
    candidateVector = existingCandidate.vector
  }

  const pendingVectors: Array<{ topic: string; key: string }> = []
  const vectorByTopic = new Map<string, number[]>()
  for (const { topic } of topics) {
    const key = `title:${textContentHash(topic)}`
    const row = indexed.get(rowKey('title', '', key))
    if (row?.vector.length) vectorByTopic.set(topic, row.vector)
    else if (!pendingVectors.some(item => item.key === key)) pendingVectors.push({ topic, key })
  }

  const texts = [...(candidateVector ? [] : [candidateTopic]), ...pendingVectors.map(item => item.topic)]
  let failure: string | null = null
  if (texts.length) {
    const outcomes = await embedBatch(texts.map(text => ({ kind: 'text' as const, input: text })))
    let cursor = 0
    if (!candidateVector) {
      const outcome = outcomes[cursor++]
      if (outcome?.embedding) candidateVector = outcome.embedding
      else failure = outcome?.error || 'This title could not be compared.'
    }
    for (const item of pendingVectors) {
      const outcome = outcomes[cursor++]
      if (!outcome?.embedding) { failure = failure || outcome?.error || null; continue }
      vectorByTopic.set(item.topic, outcome.embedding)
      dirty.push({ hash: textContentHash(item.topic), kind: 'title', episode_code: '', key: item.key, vector: outcome.embedding, embedded_at: new Date().toISOString() })
    }
  }

  if (!candidateVector) {
    return { state: 'not_checked', matches: [], reason: failure || 'This title could not be compared.' }
  }

  // The candidate's own vector is worth keeping too: the same title typed twice
  // then costs no embedding. Added to the SAME batch of rows so this is one
  // write, not two racing ones.
  if (!existingCandidate && !dirty.some(row => row.key === candidateKey)) {
    dirty.push({
      hash: textContentHash(candidateTopic),
      kind: 'title',
      episode_code: '',
      key: candidateKey,
      vector: candidateVector,
      embedded_at: new Date().toISOString(),
    })
  }
  if (dirty.length) {
    const merged = [...cache.entries.filter(entry => !dirty.some(row => row.key === entry.key)), ...dirty]
    await withLock(vectorCachePath(options.projectDir), () =>
      writeVectorCache(options.projectDir, { ...cache, entries: merged }),
    ).catch(() => { /* a lost cache write only costs a re-embed */ })
  }

  const matches: TitleDuplicateMatch[] = []
  for (const { entry, topic } of topics) {
    const vector = vectorByTopic.get(topic)
    if (!vector) continue
    // A title with the same topic as the candidate IS the candidate (a re-typed
    // idea), so an exact match is reported rather than skipped: that is the
    // single most useful thing this check can say.
    const score = cosineSimilarity(candidateVector, vector)
    if (score < TITLE_DUPLICATE_SCORE) continue
    matches.push({
      idea_id: entry.idea_id,
      episode_code: entry.episode_code,
      title: entry.title,
      topic,
      score,
    })
  }
  matches.sort((left, right) => right.score - left.score)
  return { state: 'checked', matches: matches.slice(0, 3) }
}

/**
 * Which strength a title score is, for the message. Titles have one band: they
 * either repeat an idea or they do not. Exposed so the UI and tests agree.
 */
export function titleLooksDuplicate(score: number): boolean {
  return Number.isFinite(score) && score >= TITLE_DUPLICATE_SCORE
}

/** The one-line message the idea page shows. Never a refusal. */
export function describeTitleMatch(match: TitleDuplicateMatch): string {
  const where = match.episode_code ? ` (${match.episode_code})` : ''
  return `This looks like an existing title: “${match.title}”${where} · ${match.score.toFixed(3)}`
}

/** The scene bands, re-exported so a caller does not import the contract directly. */
export { SCENE_NEAR_DUPLICATE_SCORE, SCENE_SIMILAR_SCORE, describeSceneMatch }
