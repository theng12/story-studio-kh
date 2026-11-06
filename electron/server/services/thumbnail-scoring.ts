/**
 * Thumbnail scoring — Stage 2, the model score, the record and the pick.
 *
 * The owner approved this design (2026-11-01). The two stages:
 *
 *   1. **Local rules** (`services/thumbnail-score-rules.ts`) throw out clear
 *      failures measured from the pixels alone.
 *   2. **A model score.** One free, vision-capable chat product on the Gateway
 *      looks at the survivors and scores each for clarity, curiosity and match
 *      with the title, with a short reason. It also reports misspelled or
 *      cut-off text, because only it can see that.
 *
 * The highest score wins. The page shows every candidate's score and reason,
 * and the owner can overrule.
 *
 * RULES THIS MODULE PINS:
 *
 *   - **The model is a live catalogue choice** (§1). `supports_vision` is read
 *     from the Gateway catalogue on every run. No model id is hardcoded and no
 *     capability is inferred from a name. A model the channel names through a
 *     preset or setting is the ONLY choice; when nothing names one, the answer
 *     is "not scored" — never a substitute product.
 *   - **Free by default.** A paid model is never picked on its own.
 *   - **A human pin always wins.** A pin is never overwritten, and a scored
 *     pick never displaces it. The order is pin → scored pick → newest version.
 *   - **A score is bound to a content hash.** A regenerated file's score is
 *     stale and is not used.
 *   - **One record per episode**, beside that episode's thumbnails (§4).
 *   - **A failure never stops a run.** A broken scoring run records
 *     `not_scored` with a reason and returns. It never fails the thumbnail
 *     step and never holds an upload.
 *   - **Khmer channels skip every text check** (their thumbnails are plain:
 *     no painted text, no overlay — owner, 2026-10-30).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import {
  callChatWithGenStudio,
  chatImageEligibility,
  listChatModels,
  type GenStudioChatModel,
} from '../lib/genstudio-client.js'
import { JSON_OBJECT_OUTPUT_CONTRACT, PROSE_OUTPUT_CONTRACT } from '../lib/json-output-contract.js'
import { getApiKey } from './app-secrets-store.js'
import { getContentLanguage } from '../lib/content-language.js'
import {
  normalizeThumbnailScore,
  THUMBNAIL_SCORE_FILENAME,
  THUMBNAIL_SCORE_SCHEMA,
  type ThumbnailScoreEntry,
  type ThumbnailScoreRecord,
} from '../contracts/thumbnail-scores.js'
import { applyThumbnailRules } from './thumbnail-score-rules.js'
import { resolveOverrideEpisodePaths } from './upload-overrides.js'
import { sortByNewestVersion } from '../lib/upload-metadata.js'

/** The picture sent to the model: a small JPEG, like the other vision calls. */
const SCORE_IMAGE_WIDTH = 640
const SCORE_IMAGE_QUALITY = 80

/** The channel's switch, read from `config.thumbnail_auto_pick`. */
export interface ThumbnailAutoPickConfig {
  /** The owner's switch. ON by default. */
  enabled: boolean
  /** The channel's chosen vision model, by catalogue id. Absent = nothing named. */
  model?: string
}

/**
 * The channel's settings, defaulted.
 *
 * ON by default, because the owner approved this feature as the default
 * behaviour. The model is read as the channel's SELECTION only — every limit,
 * price and capability comes from the live catalogue on each run (§1).
 */
export function thumbnailAutoPickConfig(config: unknown): ThumbnailAutoPickConfig {
  const raw = (config as any)?.thumbnail_auto_pick
  const body = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: body.enabled !== false,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
  }
}

/** True when this channel wants automatic scoring and picking. */
export function thumbnailAutoPickEnabled(config: unknown): boolean {
  return thumbnailAutoPickConfig(config).enabled
}

// ── Test seams ──────────────────────────────────────────────────────────────

/** Replaces the live catalogue read. */
let catalogReader: (() => Promise<GenStudioChatModel[]>) | null = null
export function _setThumbnailScoreCatalogForTesting(reader: (() => Promise<GenStudioChatModel[]>) | null): void {
  catalogReader = reader
}

export interface ThumbnailScoreEvaluatorInput {
  imagePath: string
  modelId: string
  system: string
  user: string
  /** True when this channel's thumbnails carry no text, so no text check runs. */
  skipText: boolean
  structuredOutput: boolean
}
/** Replaces the network call. Returns the model's raw answer text. */
let evaluator: ((input: ThumbnailScoreEvaluatorInput) => Promise<string>) | null = null
export function _setThumbnailScoreEvaluatorForTesting(fn: typeof evaluator): void { evaluator = fn }

/** Replaces the episode's language read (the Khmer text-skip rule). */
let languageReader: ((slug: string) => Promise<string | null>) | null = null
export function _setThumbnailScoreLanguageForTesting(fn: typeof languageReader): void { languageReader = fn }

// ── The rubric ──────────────────────────────────────────────────────────────

/**
 * The rubric the model is asked to apply.
 *
 * Three axes the owner named — clarity, curiosity and match with the title —
 * and one thing only a model can see: whether the text on the picture is
 * misspelled or cut off.
 */
const THUMBNAIL_SCORE_RUBRIC = [
  'You are judging a YouTube thumbnail that was drawn for a video with a given title.',
  'Score it from 0 to 100, using these bands:',
  '- 0-39 poor: unclear, dull, or nothing like the title',
  '- 40-69 fair: readable but not especially inviting',
  '- 70-89 good: clear and worth a click',
  '- 90-100 excellent: clear, curiosity-making and exactly on the title',
  '',
  'Judge THREE things, and weigh them together into the one score:',
  '1. CLARITY - is the subject readable at a glance, with a clear focal point?',
  '2. CURIOSITY - does it make someone want to click, without being misleading?',
  '3. MATCH - does the picture actually show what the title promises?',
  '',
  'Then look at the TEXT drawn on the picture (if any):',
  '- Report any word that is misspelled.',
  '- Report any word that is cut off, cropped or overlapping.',
  '- If there is no text on the picture, say so; do not invent a text problem.',
  '',
  'Rules:',
  '- Judge only what you can actually see. Never guess.',
  '- Give a reason of ONE short sentence in plain words.',
  '- Answer with ONE JSON object and nothing else.',
].join('\n')

/** The JSON shape asked for. */
const THUMBNAIL_SCORE_ANSWER_SHAPE = '{"score":0,"reason":"","text_issue":""}'

export function thumbnailScoreSystemPrompt(): string {
  return `${THUMBNAIL_SCORE_RUBRIC}\n\nReturn exactly this shape:\n${THUMBNAIL_SCORE_ANSWER_SHAPE}`
}

/** What the model is told about this episode. */
export function thumbnailScoreUserPrompt(input: { title: string; skipText: boolean }): string {
  const lines = [`The video's title is: ${input.title.trim() || '(no title)'}`]
  if (input.skipText) {
    lines.push('This channel\'s thumbnails carry no text at all, so do not look for any and do not report a text problem.')
  } else {
    lines.push('Report any misspelled or cut-off word you can see in the text drawn on the picture.')
  }
  return lines.join('\n')
}

/**
 * Read one model's answer.
 *
 * A malformed answer is a MALFORMED answer — never a 0 (§6). The caller
 * records `not_scored` with the reason.
 */
export function parseThumbnailScoreAnswer(raw: string): { score: number; reason: string; text_issue?: string } {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new Error('The model did not return a JSON object.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The model returned a JSON value that is not an object.')
  }
  const row = value as Record<string, unknown>
  const normalized = normalizeThumbnailScore(row.score)
  if ('error' in normalized) throw new Error(normalized.error)
  const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 300) : ''
  if (!reason) throw new Error('The model gave a score with no reason.')
  const textIssue = typeof row.text_issue === 'string' ? row.text_issue.trim().slice(0, 300) : ''
  return {
    score: normalized.score,
    reason,
    ...(textIssue ? { text_issue: textIssue } : {}),
  }
}

// ── The model choice ────────────────────────────────────────────────────────

/**
 * A row this score may use: available, sellable, and able to carry a picture.
 *
 * `chargeable === false` is the Gateway stating the work is free. A row that
 * says nothing is UNKNOWN, and an unknown row is not picked on its own —
 * "free models only by default" means a row must state that it is free.
 */
export function eligibleThumbnailScoreModels(rows: GenStudioChatModel[]): GenStudioChatModel[] {
  return rows.filter(row =>
    row.available === true
    && row.locked !== true
    && row.qualification_only === false
    && row.chargeable === false
    && chatImageEligibility(row).eligible)
}

type ResolvedScoreModel = { ok: true; model: GenStudioChatModel } | { ok: false; reason: string }

/**
 * Which model scores the candidates.
 *
 * A row the channel named wins when the live catalogue still offers it. No
 * model named means "not scored" — never "the first one" on the owner's
 * behalf (§1).
 */
export async function resolveThumbnailScoreModel(
  config: unknown,
  rows?: GenStudioChatModel[],
): Promise<ResolvedScoreModel> {
  const cfg = thumbnailAutoPickConfig(config)
  if (!cfg.model) {
    return { ok: false, reason: 'No vision model is chosen for this channel, so the thumbnails were not scored.' }
  }
  let catalog: GenStudioChatModel[]
  try {
    catalog = rows ?? await liveChatModels()
  } catch (error: any) {
    return { ok: false, reason: `The Gateway catalogue could not be read (${error?.message || 'unknown error'}), so the thumbnails were not scored.` }
  }
  const row = catalog.find(item => item.id === cfg.model)
  if (!row) {
    return { ok: false, reason: `${cfg.model} is not in the Gateway catalogue any more, so the thumbnails were not scored. Choose a vision model again.` }
  }
  const eligibility = chatImageEligibility(row)
  if (!eligibility.eligible) {
    return { ok: false, reason: `${eligibility.reason} So the thumbnails were not scored. Choose another vision model.` }
  }
  if (row.available !== true || row.locked === true || row.qualification_only !== false) {
    return { ok: false, reason: `${row.display_name || row.id} is not available right now, so the thumbnails were not scored.` }
  }
  if (row.chargeable !== false) {
    return { ok: false, reason: `${row.display_name || row.id} is not a free model, so the thumbnails were not scored. Pick a free vision model.` }
  }
  return { ok: true, model: row }
}

async function liveChatModels(): Promise<GenStudioChatModel[]> {
  if (catalogReader) return catalogReader()
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) throw new Error('No Gateway API Key is configured, so no model could be resolved.')
  return listChatModels(apiKey)
}

// ── The record ──────────────────────────────────────────────────────────────

/** Where the record lives: beside the episode's own thumbnails. */
export function thumbnailScoreRecordPath(episodeDir: string): string {
  return path.join(episodeDir, THUMBNAIL_SCORE_FILENAME)
}

/** The episode's own folder — the SAME resolver the picker and the uploader use. */
export async function thumbnailScoreEpisodeDir(
  slug: string,
  episodeCode: string,
  fallbackTitle: string,
): Promise<string> {
  const paths = await resolveOverrideEpisodePaths(slug, episodeCode, fallbackTitle, 'youtube')
  return paths.episode_dir
}

/**
 * Read the episode's record.
 *
 * An unreadable or malformed file reads as an EMPTY record — a broken
 * sidecar must not take the whole episode down, and it must never be read as
 * "everything passed" (§6).
 */
export async function readThumbnailScoreRecord(
  episodeDir: string,
  episodeCode: string,
): Promise<ThumbnailScoreRecord> {
  const empty: ThumbnailScoreRecord = {
    schema: THUMBNAIL_SCORE_SCHEMA,
    episode_code: episodeCode,
    scored_at: '',
    candidates: {},
  }
  let raw: string
  try { raw = await fs.readFile(thumbnailScoreRecordPath(episodeDir), 'utf8') } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as ThumbnailScoreRecord
    if (!parsed || typeof parsed !== 'object' || !parsed.candidates || typeof parsed.candidates !== 'object') {
      return empty
    }
    return { ...empty, ...parsed, candidates: parsed.candidates }
  } catch {
    return empty
  }
}

/** Write the record, under the record's own lock. */
export async function writeThumbnailScoreRecord(
  episodeDir: string,
  record: ThumbnailScoreRecord,
): Promise<void> {
  const file = thumbnailScoreRecordPath(episodeDir)
  await withLock(file, async () => {
    await writeJsonAtomic(file, record)
  })
}

/** The file's content hash — the key a score is bound to. */
export async function thumbnailFileHash(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

// ── Running one score ───────────────────────────────────────────────────────

/** One candidate's outcome, before it is written to the record. */
export interface ScoredCandidate {
  filename: string
  entry: ThumbnailScoreEntry
}

function notScored(filename: string, reason: string, extra: Partial<ThumbnailScoreEntry> = {}): ScoredCandidate {
  return {
    filename,
    entry: {
      filename,
      state: 'not_scored',
      reason: reason.slice(0, 400),
      reason_code: 'not_scored',
      ...extra,
    },
  }
}

/**
 * Score one candidate.
 *
 * Never throws: a broken call is `not_scored` with a reason, never a 0 and
 * never a pass (§6).
 */
export async function scoreThumbnailCandidate(input: {
  filename: string
  imagePath: string
  model: GenStudioChatModel
  title: string
  /** True when this channel's thumbnails carry no text (Khmer). */
  skipText: boolean
}): Promise<ScoredCandidate> {
  const sha256 = await thumbnailFileHash(input.imagePath).catch(() => '')
  const base = {
    filename: input.filename,
    sha256: sha256 || undefined,
    model_id: input.model.id,
    model_name: input.model.display_name,
    provider_name: input.model.provider_name,
    scored_at: new Date().toISOString(),
  }

  let answer: string
  try {
    answer = await askTheModel({
      imagePath: input.imagePath,
      model: input.model,
      modelId: input.model.id,
      system: thumbnailScoreSystemPrompt(),
      user: thumbnailScoreUserPrompt({ title: input.title, skipText: input.skipText }),
      skipText: input.skipText,
      structuredOutput: input.model.structured_output_mode !== 'none',
    })
  } catch (error: any) {
    return notScored(input.filename,
      `The scoring model could not be reached (${String(error?.message || 'unknown error').slice(0, 200)}), so this picture was not scored.`,
      base)
  }

  let parsed: { score: number; reason: string; text_issue?: string }
  try {
    parsed = parseThumbnailScoreAnswer(answer)
  } catch (error: any) {
    return notScored(input.filename,
      `The scoring model's answer could not be read (${String(error?.message || 'unknown error').slice(0, 200)}), so this picture was not scored.`,
      base)
  }

  return {
    filename: input.filename,
    entry: {
      ...base,
      state: 'scored',
      score: parsed.score,
      reason: parsed.reason,
      ...(parsed.text_issue ? { text_issue: parsed.text_issue } : {}),
    },
  }
}

/** 640 px q80 JPEG — the same encoding the other vision calls send. */
async function encodeScoreImage(imagePath: string): Promise<{ dataUri: string; sha256: string }> {
  const jpeg = await sharp(imagePath)
    .resize({ width: SCORE_IMAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: SCORE_IMAGE_QUALITY })
    .toBuffer()
  return {
    dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    sha256: crypto.createHash('sha256').update(jpeg).digest('hex'),
  }
}

async function askTheModel(input: ThumbnailScoreEvaluatorInput & { model: GenStudioChatModel }): Promise<string> {
  if (evaluator) return evaluator(input)
  const apiKey = await getApiKey('genstudio')
  const image = await encodeScoreImage(input.imagePath)
  const result = await callChatWithGenStudio(apiKey, {
    modelId: input.model.id,
    system: input.system,
    userMessage: input.user,
    temperature: 0,
    outputBudget: 'short',
    outputContract: input.structuredOutput ? JSON_OBJECT_OUTPUT_CONTRACT : PROSE_OUTPUT_CONTRACT,
    inputImage: { dataUri: image.dataUri, sha256: image.sha256 },
    // Content-derived, so a retry of the SAME picture and model replays the
    // settled job instead of buying a second answer.
    requestIdentity: `thumbnail-score:${image.sha256}:${input.model.id}`,
  })
  return result.text
}

// ── The pick ────────────────────────────────────────────────────────────────

/**
 * The candidate that wins, given the scores.
 *
 * The order is the owner's: **a human pin always wins**, then the scored
 * pick, then today's newest-version rule. A pin is never overwritten.
 */
export interface ThumbnailPickInput {
  /** The human's pin, when there is one. It always wins. */
  pinned?: string | null
  /** The scored candidates. */
  scored: ScoredCandidate[]
  /** Every candidate's filename. */
  all: string[]
}

/**
 * The winner, and why.
 *
 * `basis` says which rule chose it, so the record can be compared with real
 * click-through later.
 */
export function chooseThumbnailPick(input: ThumbnailPickInput): { filename: string; basis: 'score' | 'manual_pin' | 'newest_version' } | null {
  if (input.pinned && input.all.includes(input.pinned)) {
    return { filename: input.pinned, basis: 'manual_pin' }
  }
  const measured = input.scored
    .filter(candidate => candidate.entry.state === 'scored' && typeof candidate.entry.score === 'number')
    .sort((a, b) => (b.entry.score! - a.entry.score!))
  if (measured.length) {
    return { filename: measured[0]!.filename, basis: 'score' }
  }
  if (input.all.length) {
    // Today's newest-version rule — the SAME rule the upload applies, not
    // "whatever order the caller happened to pass". The two must agree: this
    // record's fallback names the file the upload will actually take.
    const newest = sortByNewestVersion(input.all)[0]
    if (newest) return { filename: newest, basis: 'newest_version' }
  }
  return null
}

// ── The whole run ───────────────────────────────────────────────────────────

/** What one scoring run produced. */
export interface ThumbnailScoringRun {
  /** The record as it now stands on disk. */
  record: ThumbnailScoreRecord
  /**
   * The candidate SCORING chose, or '' when scoring chose nothing.
   *
   * This is the SCORING feature's answer, not the upload's. When nothing
   * could be scored it is '' — the upload still falls back to today's
   * newest-version rule on its own, but that rule did not come from
   * scoring, and saying otherwise would claim a pick that never happened
   * (§6 — "the answer is none" and "we could not work out the answer" are
   * different facts).
   */
  pick: string
  /**
   * The file the upload will actually take, whatever chose it.
   *
   * A human pin, then the scored pick, then today's newest-version rule.
   * This is what the record's `pick` names, and it is what the upload
   * resolver does too — so the record and the upload cannot disagree.
   */
  resolved: string
  /** One line for the job log. */
  summary: string
  /** True when nothing could be scored — the reason is on the record. */
  notScored: boolean
  /**
   * True only when EVERY candidate this run was explicitly set aside by a
   * local rule. A candidate that was merely not measured (no model, a
   * provider failure), a missing one, an unknown one or a real score of 0
   * never makes this true — "all bad" is a fact about rejections only, and an
   * empty candidate list is never all-bad (§6). For a later regeneration
   * decision; this run does not act on it.
   */
  allBad: boolean
}

/**
 * Score an episode's thumbnail candidates and write the record.
 *
 * NEVER throws. Every failure becomes `not_scored` on the record with a
 * reason, because a broken scoring run must never fail the thumbnail step or
 * hold an upload (AGENTS §8).
 */
export async function runThumbnailScoring(input: {
  slug: string
  episodeCode: string
  fallbackTitle: string
  /** The candidates, in the picker's order, with their on-disk paths. */
  candidates: Array<{ filename: string; path: string }>
  /** The episode's title — the model judges match with it. */
  title: string
  /** The channel's config, read live. */
  config: unknown
  /** The human's pin, when there is one. */
  pinned?: string | null
  /** Overrides the language read. Used by the tests. */
  language?: string | null
}): Promise<ThumbnailScoringRun> {
  const episodeDir = await thumbnailScoreEpisodeDir(input.slug, input.episodeCode, input.fallbackTitle)
  const now = new Date().toISOString()

  // The switch, checked FIRST: off means today's behaviour stays — the
  // newest-version rule, untouched. Nothing is scored, nothing is recorded,
  // and no model is resolved.
  const cfg = thumbnailAutoPickConfig(input.config)
  if (!cfg.enabled) {
    return {
      record: await readThumbnailScoreRecord(episodeDir, input.episodeCode),
      pick: '',
      // Today's newest-version rule still resolves the upload — the switch
      // turns SCORING off, not the uploader's own rule.
      resolved: chooseThumbnailPick({ pinned: input.pinned, scored: [], all: input.candidates.map(candidate => candidate.filename) })?.filename || '',
      summary: 'Automatic thumbnail picking is off for this channel, so nothing was scored.',
      notScored: true,
      allBad: false,
    }
  }
  const record = await readThumbnailScoreRecord(episodeDir, input.episodeCode)

  // Khmer channels keep their plain thumbnails: no painted text, no overlay.
  // Every text check is skipped for them (owner, 2026-11-01).
  let channelLanguage = input.language ?? null
  if (input.language === undefined) {
    channelLanguage = languageReader
      ? await languageReader(input.slug).catch(() => null)
      : await getContentLanguage(input.slug).catch(() => null)
  }
  const skipText = channelLanguage === 'km'

  const candidates: ScoredCandidate[] = []

  // Stage 1: the local rules.
  const survivors: Array<{ filename: string; path: string }> = []
  for (const candidate of input.candidates) {
    if (!await fs.stat(candidate.path).then(stat => stat.isFile()).catch(() => false)) {
      candidates.push(notScored(candidate.filename, 'The image file is missing or unavailable; it was not measured.'))
      continue
    }
    const rules = await applyThumbnailRules(candidate.path).catch(() => ({
      rejected: 'unreadable' as const,
      reason: 'the file could not be read as an image',
      measurements: { width: 0, height: 0, stdev: 0, mean: 0 },
    }))
    if (rules.rejected) {
      candidates.push({
        filename: candidate.filename,
        entry: {
          filename: candidate.filename,
          state: 'rejected_by_rule',
          reason: rules.reason,
          reason_code: rules.rejected,
          sha256: await thumbnailFileHash(candidate.path).catch(() => undefined),
          scored_at: now,
        },
      })
      continue
    }
    survivors.push(candidate)
  }

  // Stage 2: the model score, on the survivors only.
  if (survivors.length) {
    const resolved = await resolveThumbnailScoreModel(input.config)
    if (!resolved.ok) {
      for (const candidate of survivors) {
        candidates.push(notScored(candidate.filename, resolved.reason))
      }
    } else {
      for (const candidate of survivors) {
        const scored = await scoreThumbnailCandidate({
          filename: candidate.filename,
          imagePath: candidate.path,
          model: resolved.model,
          title: input.title,
          skipText,
        })
        candidates.push(scored)
      }
    }
  }

  // The record. A candidate that was NOT measured in this run keeps its old
  // entry only when the file's hash still matches — otherwise the old score
  // is stale and is dropped.
  const nextCandidates: Record<string, ThumbnailScoreEntry> = {}
  for (const [filename, entry] of Object.entries(record.candidates || {})) {
    const candidate = input.candidates.find(item => item.filename === filename)
    if (!candidate) continue
    const hash = await thumbnailFileHash(candidate.path).catch(() => '')
    if (!hash || hash !== entry.sha256) continue
    nextCandidates[filename] = entry
  }
  for (const candidate of candidates) {
    const hash = await thumbnailFileHash(
      input.candidates.find(item => item.filename === candidate.filename)?.path || '',
    ).catch(() => '')
    if (hash) candidate.entry.sha256 = hash
    // An unmeasured candidate never replaces a measurement of the SAME bytes:
    // a run that could not score learns nothing about a file it already
    // scored, and dropping the old score would silently un-pick it (§6).
    const kept = nextCandidates[candidate.filename]
    if (candidate.entry.state === 'not_scored'
      && kept?.state === 'scored'
      && kept.sha256 && kept.sha256 === candidate.entry.sha256) continue
    nextCandidates[candidate.filename] = candidate.entry
  }

  const scored = candidates.filter(candidate => candidate.entry.state === 'scored')
  let pick = chooseThumbnailPick({
    pinned: input.pinned,
    scored,
    all: input.candidates.map(candidate => candidate.filename),
  })

  // Incomplete scoring cannot displace a hash-bound pick; a pin still wins.
  let keptReason: string | null = null
  const priorPick = record.pick
  const keptEntry = priorPick?.basis === 'score' ? nextCandidates[priorPick.filename] : undefined
  if (pick?.basis !== 'manual_pin'
    && candidates.some(candidate => candidate.entry.state === 'not_scored')
    && priorPick?.basis === 'score'
    && keptEntry?.state === 'scored'
    && keptEntry.sha256
    && record.candidates?.[priorPick.filename]?.sha256 === keptEntry.sha256) {
    pick = { filename: priorPick.filename, basis: 'score' }
    keptReason = `Scoring is incomplete (${candidates.find(c => c.entry.state === 'not_scored')?.entry.reason || 'a picture could not be measured'}), so the previous scored pick is kept.`
  }

  const nextRecord: ThumbnailScoreRecord = {
    schema: THUMBNAIL_SCORE_SCHEMA,
    episode_code: input.episodeCode,
    scored_at: now,
    candidates: nextCandidates,
  }
  if (pick) {
    const chosen = nextCandidates[pick.filename]
    nextRecord.pick = {
      filename: pick.filename,
      // The score is the CHOSEN FILE's own honest score, whenever it has one.
      //
      // A pinned file that was also scored carries that score: it is a fact
      // about the picture, and the owner asked for the scores to be kept so
      // they can be compared with real click-through. It is NOT a claim that
      // the score chose it — `basis` says what did.
      //
      // A file that was never measured carries NO score, and a missing score
      // is not a 0 (§6 — a zero that means two things is a defect).
      ...(typeof chosen?.score === 'number' ? { score: chosen.score } : {}),
      // The reason says what ACTUALLY chose it. A pinned pick never borrows
      // the score's reason, because that would read as "the score chose
      // this" when the owner overruled it.
      reason: keptReason
        || (pick.basis === 'score'
          ? (chosen?.reason || 'The highest-scoring thumbnail.')
          : pick.basis === 'manual_pin'
            ? 'The owner pinned this thumbnail.'
            : 'No picture could be scored, so the newest version was used.'),
      at: now,
      basis: pick.basis,
    }
  }
  await writeThumbnailScoreRecord(episodeDir, nextRecord)

  const nothingScored = !scored.length
  const summary = nothingScored
    ? `Thumbnails were not scored: ${candidates.find(c => c.entry.reason)?.entry.reason || 'no candidate could be measured.'}`
      + (keptReason && nextRecord.pick ? ` Kept the previous pick, ${nextRecord.pick.filename}.` : '')
    : `Scored ${scored.length} thumbnail candidate(s); ${nextRecord.pick?.filename || 'none'} was picked`
      + ` (${keptReason ? 'previous pick kept because scoring is incomplete' : nextRecord.pick?.basis === 'score' ? 'highest score' : nextRecord.pick?.basis === 'manual_pin' ? 'owner’s pin' : 'newest version'}).`

  // SCORING chose a file only when a score did. A pin is the owner's own
  // choice (not scoring's), and the newest-version fallback is today's rule
  // (not scoring's either) — so neither is reported as scoring's pick. The
  // `resolved` field carries what the upload will actually take, so both
  // facts are available and neither is confused with the other.
  const scoredPick = pick?.basis === 'score' ? pick.filename : ''

  return {
    record: nextRecord,
    pick: scoredPick,
    resolved: nextRecord.pick?.filename || '',
    summary,
    notScored: nothingScored,
    allBad: candidates.length > 0 && candidates.every(candidate => candidate.entry.state === 'rejected_by_rule'),
  }
}

/**
 * The score bounds, re-exported for the callers that validate a model's answer.
 */
export { THUMBNAIL_SCORE_MAX, THUMBNAIL_SCORE_MIN } from '../contracts/thumbnail-scores.js'
