/**
 * Completion proofs for the WRITING job types.
 *
 * A writing job's output is text on disk, and the only honest proof that the
 * step finished is that artifact. This module re-reads each type's OWN
 * artifact and says whether every required item is there.
 *
 * WHY IT EXISTS. `outline_only`, `expand_chapters`, `introduction-only`,
 * `chapter-only`, `contextual_cues` and `music_scene_polish` had NO auditor
 * at all. The queue's provider-settlement path reads the auditor BEFORE it
 * offers to pick a settled writing job up again, so a job whose provider work
 * had all finished and whose text was already on disk failed loudly with
 * "no completion audit is registered for this job type" — the resume never
 * happened (AGENTS.md §8: unverifiable output is never success, and a settled
 * writing job is resumable).
 *
 * SIX TYPES, SIX ARTIFACTS. They do NOT share one generic "is there a file"
 * guess: each proves the thing that type is actually for, and each says which
 * item is missing when it cannot.
 *
 * Every reader here is READ-ONLY. An auditor never writes, never repairs and
 * never re-requests anything — a Retry must still collect the earlier answer
 * by its saved key, with no second submission.
 */
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'node:crypto'
import {
  chapterBelongsToOutline,
  chapterMatchesLanguage,
  inspectChunkedScriptCompletion,
  readSidecar,
} from '../lib/chunked-narration.js'
import { languageName, type ContentLanguage } from '../lib/content-language.js'
import {
  chapterFilePath,
  introductionFilePath,
} from '../lib/narration-assembly.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import { parseNarrationDocx, type NarrationSection } from '../lib/docx-parser.js'
import type { TextOutputContract } from '../lib/json-output-contract.js'
import { readContextualCueTimeline } from './contextual-cues.js'
import { buildGenStudioChatIdempotencyKey } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'
import { readMusicScenePolishRun, type MusicScenePolishRunArtifact } from './music-episode-store.js'

export interface TextCompletionAudit {
  /** The artifact's own source of truth could be read at all. */
  authoritative: boolean
  /** Every required item is present and usable. */
  complete: boolean
  /** What is missing, in words the Jobs card can show. */
  detail?: string
}

const NOT_COMPLETE = (authoritative: boolean, detail: string): TextCompletionAudit =>
  ({ authoritative, complete: false, detail })

/**
 * How one narration artifact was read.
 *
 * `missing` and `unreadable` are kept apart on purpose: a file that is not
 * there and a file that is there but cannot be parsed are different facts,
 * and a card that says "not on disk" about a broken file sends the owner
 * looking in the wrong place (AGENTS.md §6 — a zero that means two things).
 */
type ArtifactRead =
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }
  | { state: 'read'; sections: NarrationSection[] }

/**
 * Read one narration artifact the way every other reader reads it: the modern
 * `.md` file as text, a legacy `.docx` through the docx reader.
 *
 * `resolveReadPath` is what makes the legacy case work — a legacy episode
 * still has `_Chapter_01.docx` on disk and no `.md` sibling, and an audit that
 * looked only for the modern name reported a perfectly good chapter as
 * "not on disk" (the assembler reads the same two files, and the chapter
 * generator reads a sibling chapter through the same parser).
 *
 * THE PARSER IS THE AUDIO PATH'S PARSER (`parseNarrationDocx`), not the
 * bulk-source splitter. They are not the same reader, and the difference
 * decides whether a chapter looks stale:
 *
 *  - `splitNarrationIntoChapters` reads the model's SOURCE markdown and
 *    treats a level-1 heading as a SECTION BREAK, so a chapter whose body
 *    contains a heading of its own is cut short at that heading.
 *  - `parseNarrationDocx` reads the ASSEMBLED narration — the document the
 *    customer actually hears — and keeps a heading inside a chapter as part
 *    of that chapter's text.
 *
 * The assembled narration is what audio, subtitles and Video Assembly read, so
 * it is what this audit must read. Comparing a truncated source-splitting
 * view of the unified narration against the full chapter file reported a
 * perfectly fresh chapter as "older than" — a false stale verdict, which sent
 * the queue round the chapter generator again.
 */
async function readNarrationArtifact(file: string): Promise<ArtifactRead> {
  const resolved = resolveReadPath(file)
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat?.isFile()) return { state: 'missing' }
  if (stat.size <= 0) return { state: 'unreadable', reason: 'the file is empty' }
  try {
    const sections = await parseNarrationDocx(resolved)
    if (!sections.length) return { state: 'unreadable', reason: 'the file holds no narration text' }
    return { state: 'read', sections }
  } catch (error) {
    return { state: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The slug every narration parser gives a chapter, whatever term its format uses. */
function chapterSlug(chapterNumber: number): string {
  return `Chapter_${chapterNumber.toString().padStart(2, '0')}`
}

/** The slug the narration parsers give the introduction. */
const INTRODUCTION_SLUG = 'Introduction'

/** The text of one section, or null when the document does not carry it. */
function sectionText(sections: NarrationSection[], slug: string): string | null {
  const found = sections.find(section => section.slug === slug)
  const text = String(found?.text || '').trim()
  return text ? text : null
}

/** Two texts are the same text when their words and spacing are the same. */
export function sameText(left: string, right: string): boolean {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim()
}

/**
 * `outline_only` — the outline sidecar is the output.
 *
 * The sidecar holds the outline itself: how many chapters it has, one entry
 * per chapter, and when it was completed. Approval is NOT part of this job's
 * output — approving the outline is the owner's next action, and the
 * expand-chapters job is the one that needs it — so an unapproved outline is
 * a COMPLETE outline.
 *
 * `expectedChapters` is the chapter count the run was ACTUALLY asked for, as
 * the generator resolved it (see `resolvedOutlineChapterCount`). Fewer
 * chapters than that is the only shortfall that is a shortfall; the generator
 * accepts an outline that came back LONGER than asked for.
 */
export async function inspectOutlineCompletion(
  scriptDir: string,
  code: string,
  expectedChapters?: number | null,
): Promise<TextCompletionAudit> {
  const sidecar = await readSidecar(scriptDir, code)
  if (!sidecar) {
    return NOT_COMPLETE(false, 'No outline was saved for this episode.')
  }
  if (!Number.isFinite(Date.parse(sidecar.outline_completed_at))) {
    return NOT_COMPLETE(true, 'The saved outline has no completion time, so it cannot be trusted as finished.')
  }
  const total = Number(sidecar.total_chapters)
  if (!Number.isInteger(total) || total < 1) {
    return NOT_COMPLETE(true, 'The saved outline holds no chapters.')
  }
  if (sidecar.outline.length !== total) {
    return NOT_COMPLETE(true, `The saved outline holds ${sidecar.outline.length} of ${total} chapters.`)
  }
  const numbers = new Set(sidecar.outline.map(entry => Number(entry.n)))
  if (numbers.size !== total || [...numbers].some(n => !Number.isInteger(n) || n < 1)) {
    return NOT_COMPLETE(true, 'The saved outline has duplicate or missing chapter numbers.')
  }
  const untitled = sidecar.outline.filter(entry => !String(entry.title || '').trim())
  if (untitled.length) {
    return NOT_COMPLETE(true, `${untitled.length} of ${total} saved chapters have no title.`)
  }
  if (Number.isInteger(expectedChapters) && (expectedChapters as number) > 0 && total < (expectedChapters as number)) {
    return NOT_COMPLETE(true, `The saved outline holds ${total} chapters; ${expectedChapters} were asked for.`)
  }
  return { authoritative: true, complete: true }
}

/**
 * The chapter count the outline run was actually asked for.
 *
 * THE GENERATOR'S OWN RESOLUTION (`resolveScriptSizing` in lib/script-sizing.ts,
 * 2026-10-30): the request, then this episode's own recorded outline, then the
 * Formula's default — and the job log names which one it used. So
 * `params.chapters` is the request-side count ONLY when the request named one;
 * when it named none the run used the episode's plan or the Formula default,
 * neither of which this audit can reconstruct honestly (the episode's sidecar
 * may have been rebuilt since, and reading the Formula live would measure
 * today's, not the run's).
 *
 * The count the run REALLY used is in the run's own completion declaration —
 * `requireJobCompletion(job, { expected: params.totalChapters, … })`
 * (generators/episode.ts:1011-1014) — so that is read first, and
 * `params.chapters` is the second claim. Where the two disagree the LARGER
 * count is used: a shortfall is measured against the strongest claim about
 * what was asked, because under-claiming it would report a short outline as
 * complete. When neither is available the shortfall check is simply not made:
 * a check against a number nobody can vouch for is the same mistake as
 * reporting an unmeasurable thing as zero (AGENTS.md §6).
 */
export function resolvedOutlineChapterCount(job: {
  params?: Record<string, any> | null
  result?: Record<string, any> | null
}): number | null {
  const declared = Number(job.result?.completion?.expected)
  const fromRecord = Number.isSafeInteger(declared) && declared > 0 ? declared : null
  const fromRequest = requestedChapterCount(job.params)
  if (fromRecord && fromRequest) return Math.max(fromRecord, fromRequest)
  return fromRecord ?? fromRequest
}

/**
 * `expand_chapters` — the chapter files and the unified narration.
 *
 * Two shapes, because the generator has two shapes:
 *
 *  - Expand ALL: the generator's own postcondition, read back through
 *    `inspectChunkedScriptCompletion` — the outline is approved, the outline
 *    is valid, the unified narration exists, and no chapter of the approved
 *    outline is missing.
 *  - Expand a SELECTION (`chapters_to_expand`): the owner asked for some
 *    chapters only, and the generator allows that run to stay partial. Only
 *    the chapters that were asked for are required — but each of them must be
 *    on disk, and must belong to the CURRENT outline (a chapter file left
 *    over from an earlier outline is not this run's output).
 */
export async function inspectExpandedScriptCompletion(
  scriptDir: string,
  code: string,
  chaptersToExpand?: readonly number[] | null,
  contentLanguage?: ContentLanguage | null,
): Promise<TextCompletionAudit> {
  const selection = Array.isArray(chaptersToExpand)
    ? chaptersToExpand.filter(n => Number.isInteger(n) && n > 0)
    : []
  if (selection.length) {
    const sidecar = await readSidecar(scriptDir, code)
    const missing: number[] = []
    const wrongScript: number[] = []
    for (const number of selection) {
      // `resolveReadPath`: a legacy episode still has `_Chapter_NN.docx` and
      // no `.md` sibling, and looking only for the modern name reported a
      // chapter that is on disk as missing.
      const file = resolveReadPath(chapterFilePath(scriptDir, code, number))
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile() || stat.size <= 0) { missing.push(number); continue }
      if (sidecar && !chapterBelongsToOutline(sidecar, file)) { missing.push(number); continue }
      // A chapter in another writing system counts as missing here too, and the
      // reason is named rather than left to read as "not on disk yet".
      if (!await chapterMatchesLanguage(file, contentLanguage ?? null)) wrongScript.push(number)
    }
    if (wrongScript.length) {
      return NOT_COMPLETE(true,
        `Chapter ${wrongScript.join(', ')} ${wrongScript.length === 1 ? 'is' : 'are'} not in this channel's writing system (${languageName(contentLanguage)}), so ${wrongScript.length === 1 ? 'it does' : 'they do'} not count as done.`)
    }
    if (missing.length) {
      return NOT_COMPLETE(true, `Chapter ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on disk yet.`)
    }
    return { authoritative: true, complete: true }
  }
  const completion = await inspectChunkedScriptCompletion(scriptDir, code, contentLanguage ?? null)
  if (completion.complete) return { authoritative: true, complete: true }
  if (!completion.approved) {
    return NOT_COMPLETE(true, 'The current outline is not approved, so the chapters cannot be counted as done.')
  }
  if (!completion.outline_valid) {
    return NOT_COMPLETE(true, `The outline holds an invalid chapter count (${completion.present}/${completion.expected} present).`)
  }
  if (completion.wrong_script.length) {
    return NOT_COMPLETE(true,
      `Chapter ${completion.wrong_script.join(', ')} ${completion.wrong_script.length === 1 ? 'is' : 'are'} not in this channel's writing system (${languageName(contentLanguage)}). `
      + 'Generate those chapters again, or switch the channel\'s language if that is what changed.')
  }
  if (!completion.has_unified) {
    return NOT_COMPLETE(true, 'The assembled narration is not on disk.')
  }
  return NOT_COMPLETE(
    true,
    `${completion.present}/${completion.expected} chapters are present; missing ${completion.missing.join(', ') || 'unknown'}.`,
  )
}

/**
 * The ASSEMBLED narration, and whether it is fresh against the source that
 * changed.
 *
 * Every downstream reader — audio, subtitles, Video Assembly, the story-context
 * prompts — reads `{code}_Script_Narration.*`, not the per-chapter files. A
 * chapter that was written but never assembled into the narration is therefore
 * NOT this job's finished output: the narration the customer hears is still
 * the old one.
 *
 * Freshness is proved by CONTENT, not by a timestamp: the narration's own text
 * for that chapter (or introduction) must be the text that is on disk now.
 * A narration assembled before the chapter changed does not contain it, so it
 * is reported as stale — which is the state that matters, and the one a
 * modification time would paper over (a later unrelated write moves the
 * mtime of a narration that is still missing the new chapter).
 */
async function inspectUnifiedNarration(
  scriptDir: string,
  code: string,
  want: { chapterNumber?: number; chapterText?: string; introductionText?: string },
): Promise<TextCompletionAudit> {
  const unified = await readNarrationArtifact(path.join(scriptDir, `${code}_Script_Narration.md`))
  if (unified.state === 'missing') {
    return NOT_COMPLETE(true, 'The assembled narration is not on disk.')
  }
  if (unified.state === 'unreadable') {
    return NOT_COMPLETE(true, `The assembled narration could not be read: ${unified.reason}.`)
  }
  if (typeof want.chapterNumber === 'number') {
    const assembled = sectionText(unified.sections, chapterSlug(want.chapterNumber))
    if (!assembled) {
      return NOT_COMPLETE(true, `The assembled narration has no chapter ${want.chapterNumber}.`)
    }
    if (!sameText(assembled, want.chapterText || '')) {
      return NOT_COMPLETE(true, `The assembled narration is older than chapter ${want.chapterNumber}.`)
    }
    return { authoritative: true, complete: true }
  }
  if (typeof want.introductionText === 'string') {
    const assembled = sectionText(unified.sections, INTRODUCTION_SLUG)
    if (!assembled) {
      return NOT_COMPLETE(true, 'The assembled narration has no introduction.')
    }
    if (!sameText(assembled, want.introductionText)) {
      return NOT_COMPLETE(true, 'The assembled narration is older than the introduction.')
    }
    return { authoritative: true, complete: true }
  }
  return NOT_COMPLETE(false, 'Nothing to compare the assembled narration against.')
}

/**
 * `chapter-only` — the one chapter this job was asked to write, AND the
 * assembled narration that carries it.
 *
 * The chapter number comes from the job, because that is the item this run
 * produced. A file with a heading and no text under it is a partial chapter,
 * not a finished one.
 */
export async function inspectChapterCompletion(
  scriptDir: string,
  code: string,
  chapterNumber: number | null | undefined,
): Promise<TextCompletionAudit> {
  if (!Number.isInteger(chapterNumber) || (chapterNumber as number) < 1) {
    return NOT_COMPLETE(false, 'This job names no chapter, so its output cannot be verified.')
  }
  const number = chapterNumber as number
  const artifact = await readNarrationArtifact(chapterFilePath(scriptDir, code, number))
  if (artifact.state === 'missing') {
    return NOT_COMPLETE(true, `Chapter ${number} is not on disk.`)
  }
  if (artifact.state === 'unreadable') {
    return NOT_COMPLETE(true, `Chapter ${number} could not be read: ${artifact.reason}.`)
  }
  const body = sectionText(artifact.sections, chapterSlug(number))
  if (!body) {
    return NOT_COMPLETE(true, `Chapter ${number} was saved with no text under its heading.`)
  }
  return inspectUnifiedNarration(scriptDir, code, { chapterNumber: number, chapterText: body })
}

/**
 * `introduction-only` — the introduction this job was asked to write, AND the
 * assembled narration that carries it.
 *
 * The introduction is its own file beside the chapters; the unified narration
 * is derived from it, and it is re-assembled by this same job, so a
 * introduction that never reached the narration is not a finished output.
 */
export async function inspectIntroductionCompletion(
  scriptDir: string,
  code: string,
): Promise<TextCompletionAudit> {
  const artifact = await readNarrationArtifact(introductionFilePath(scriptDir, code))
  if (artifact.state === 'missing') {
    return NOT_COMPLETE(true, 'The introduction is not on disk.')
  }
  if (artifact.state === 'unreadable') {
    return NOT_COMPLETE(true, `The introduction could not be read: ${artifact.reason}.`)
  }
  const body = sectionText(artifact.sections, INTRODUCTION_SLUG)
  if (!body) {
    return NOT_COMPLETE(true, 'The introduction was saved with no text under its heading.')
  }
  return inspectUnifiedNarration(scriptDir, code, { introductionText: body })
}

/**
 * `contextual_cues` — the cue timeline beside the scene plan.
 *
 * The timeline is the artifact, and it names the plan it was built from
 * (`source_scene_plan_generated_at`). A timeline left over from an EARLIER
 * plan is not this run's output, so the two stamps must agree. An empty cue
 * list is legitimate: a plan can yield no proposals, and the generator counts
 * the batches it ASKED, not the cues it kept.
 */
export async function inspectContextualCueCompletion(
  scenePlanPath: string,
): Promise<TextCompletionAudit> {
  const timeline = await readContextualCueTimeline(scenePlanPath)
  if (!timeline) {
    return NOT_COMPLETE(false, 'No contextual cue timeline was saved for this scene plan.')
  }
  const planGeneratedAt = await readScenePlanGeneratedAt(scenePlanPath)
  if (!planGeneratedAt) {
    return NOT_COMPLETE(false, 'The scene plan this cue timeline belongs to cannot be read.')
  }
  if (timeline.source_scene_plan_generated_at !== planGeneratedAt) {
    return NOT_COMPLETE(true, 'The saved cue timeline was built from an earlier scene plan.')
  }
  return { authoritative: true, complete: true }
}

/** When the scene plan at this path was generated, or null when it cannot be read. */
async function readScenePlanGeneratedAt(scenePlanPath: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(scenePlanPath, 'utf-8'))
    const generatedAt = typeof raw?.generated_at === 'string' ? raw.generated_at.trim() : ''
    return generatedAt || null
  } catch {
    return null
  }
}

/**
 * The inert reference that lives in `job.params.music_scene_polish` (v2).
 *
 * Free text does NOT live here: `safeJob` rewrites every string in params
 * through `redactSecrets`, which turns "Key lighting" into "Key [REDACTED]".
 * Only hex ids, digests and timestamps survive that pass unchanged, so this
 * record carries only those — the exact request, baseline and outputs are
 * on the episode-side artifact (`MusicScenePolishRunArtifact`).
 */
export interface MusicScenePolishParamsRef {
  version: 2
  run_id: string
  project_slug: string
  episode_code: string
  scene_ids: string[]
  input_fingerprint: string
  owner_job_id: string
  retry_of?: { job_id: string; run_id: string }
  prepared_key?: string
  accepted_key?: string
  accepted_job_id?: string
  output_digests?: Record<string, string>
  missing?: string[]
  outputs_recorded_at?: string
}

/** Where the v2 reference lives inside the job's own params. */
export const MUSIC_SCENE_POLISH_SNAPSHOT_KEY = 'music_scene_polish'

/**
 * Backward-compatible type alias for the authored test fixture.
 * The production boundary now uses `MusicScenePolishParamsRef` (v2) and
 * `MusicScenePolishRunArtifact`; this alias keeps the legacy test file
 * compiling without re-exporting the removed v1 shape as a production type.
 */
export type MusicScenePolishSnapshot = Record<string, any>

/** Fingerprint the exact request and the episode prompts it may replace. */
export function scenePolishInputFingerprint(input: {
  model: string
  system: string
  userMessage: string
  temperature: number
  outputBudget: string
  outputContract: TextOutputContract
  requestIdentity: string
  sceneIds: string[]
  baselinePrompts: Record<string, string>
}): string {
  return createHash('sha256').update(JSON.stringify({
    model: input.model,
    system: input.system,
    user_message: input.userMessage,
    temperature: input.temperature,
    output_budget: input.outputBudget,
    output_contract: input.outputContract,
    request_identity: input.requestIdentity,
    scene_ids: input.sceneIds,
    baseline_prompts: input.baselinePrompts,
  })).digest('hex')
}

/**
 * What the boundary found when reading the v2 params reference.
 *
 * `absent` means no reference was written yet (first submission is safe).
 * `invalid` means a reference exists but cannot be trusted — and an invalid
 * reference must never be treated as absent, because "absent" authorises a
 * first submission. An unreadable reference refuses, non-retryable.
 */
export type MusicScenePolishSnapshotRead =
  | { state: 'absent' }
  | { state: 'valid'; ref: MusicScenePolishParamsRef }
  | { state: 'invalid'; reason: string }

function musicScenePolishRefProblem(record: Record<string, unknown>, jobId: string, retryOf?: unknown): string {
  if (typeof record.version !== 'number' || record.version !== 2) return 'its version is not one this build understands'
  if (typeof record.run_id !== 'string' || !/^[0-9a-f]{32}$/.test(record.run_id)) return 'its run id is not a 32-hex string'
  if (typeof record.episode_code !== 'string' || !record.episode_code.trim()) return 'it names no episode'
  if (!Array.isArray(record.scene_ids) || !record.scene_ids.length) return 'it names no scene'
  const sceneIds = record.scene_ids as unknown[]
  if (sceneIds.some(id => typeof id !== 'string' || !id.trim())) return 'one of its scene ids is not text'
  const unique = new Set(sceneIds as string[])
  if (unique.size !== sceneIds.length) return 'it names the same scene twice'
  if (typeof record.input_fingerprint !== 'string' || !record.input_fingerprint.trim()) return 'it holds no input fingerprint'
  const owner = typeof record.owner_job_id === 'string' ? record.owner_job_id.trim() : ''
  if (!owner) return 'it names no owner job'
  for (const key of ['prepared_key', 'accepted_key', 'accepted_job_id', 'outputs_recorded_at']) {
    const value = record[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return `its ${key} is not text`
  }
  const digests = record.output_digests
  if (digests !== undefined) {
    if (!digests || typeof digests !== 'object' || Array.isArray(digests)) return 'its output digests are not a record'
    for (const [id, value] of Object.entries(digests as Record<string, unknown>)) {
      if (!unique.has(id)) return `it holds an output digest for scene ${id}, which it never asked for`
      if (typeof value !== 'string' || !value.trim()) return `its output digest for scene ${id} is empty`
    }
  }
  if (record.missing !== undefined) {
    if (!Array.isArray(record.missing)) return 'its missing list is not a list'
    const missing = record.missing as unknown[]
    if (missing.some(id => typeof id !== 'string' || !unique.has(id))) return 'its missing list names a scene it never asked for'
  }
  const retry = retryOf && typeof retryOf === 'object' && !Array.isArray(retryOf)
    ? retryOf as { job_id?: unknown; run_id?: unknown }
    : null
  const continuesPredecessor = typeof retry?.job_id === 'string'
    && retry.job_id === owner
    && typeof retry.run_id === 'string'
    && retry.run_id === record.run_id
  if (jobId && owner !== jobId && !continuesPredecessor) return 'it belongs to another run'
  if (retryOf !== undefined && retryOf !== null && !continuesPredecessor) return 'its retry predecessor marker is invalid'
  return ''
}

/**
 * Read this run's v2 params reference.
 *
 * A v1 record is INVALID, not absent: treating it as absent would authorise
 * a first submission under a new digest, polishing the same scenes twice.
 */
export function readMusicScenePolishSnapshot(job: {
  job_id?: string
  params?: Record<string, any> | null
}): MusicScenePolishSnapshotRead {
  const raw = job.params?.[MUSIC_SCENE_POLISH_SNAPSHOT_KEY]
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'invalid', reason: 'it is not a record' }
  }
  const record = raw as Record<string, unknown>
  if (typeof record.version === 'number' && record.version === 1) {
    return { state: 'invalid', reason: 'v1 records are no longer accepted; start a new Polish run' }
  }
  const reason = musicScenePolishRefProblem(record, typeof job.job_id === 'string' ? job.job_id : '', job.params?.music_scene_polish_retry_of)
  if (reason) return { state: 'invalid', reason }
  return { state: 'valid', ref: record as unknown as MusicScenePolishParamsRef }
}

/**
 * Validate a loaded artifact against the job's params reference and recompute
 * the exact-body digest proof. Returns '' when the artifact can be trusted,
 * or a human-readable reason when it cannot.
 *
 * The digest recompute uses the client's OWN exported builder over the
 * artifact's stored request inputs — never a hand-hashed value, never a
 * preview-derived model id. A mismatch means the artifact's body is not the
 * body that was submitted under the recorded key, so recovery must refuse.
 */
export function validateMusicScenePolishArtifact(input: {
  artifact: MusicScenePolishRunArtifact
  ref: MusicScenePolishParamsRef
  jobId: string
  retryOf?: { job_id?: unknown; run_id?: unknown } | null
}): string {
  const { artifact, ref, jobId } = input
  // Malformed nested shapes must produce an invalid reason, never a raw
  // TypeError: an unreadable artifact is refused, never treated as absent.
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return 'the artifact is not a record'
  const request = artifact.request as Record<string, unknown> | undefined
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'the artifact holds no request record'
  if (typeof request.model !== 'string' || !request.model.trim()) return 'the artifact request names no model'
  if (typeof request.system !== 'string') return 'the artifact request holds no system message'
  if (typeof request.user_message !== 'string' || !request.user_message.trim()) return 'the artifact request holds no request body'
  if (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)) return 'the artifact request holds no temperature'
  if (typeof request.output_budget !== 'string' || !request.output_budget.trim()) return 'the artifact request holds no output budget'
  if (!request.output_contract || typeof request.output_contract !== 'object' || Array.isArray(request.output_contract)) {
    return 'the artifact request holds no output contract'
  }
  if (typeof request.request_identity !== 'string' || !request.request_identity.trim()) return 'the artifact request holds no request identity'
  if (!Array.isArray(artifact.scene_ids) || !artifact.scene_ids.length) return 'the artifact names no scene'
  if ((artifact.scene_ids as unknown[]).some(id => typeof id !== 'string' || !id.trim())) return 'one of the artifact scene ids is not text'
  const baseline = artifact.baseline_prompts as Record<string, unknown> | undefined
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return 'the artifact holds no baseline prompts'
  for (const id of artifact.scene_ids) {
    if (typeof baseline[id] !== 'string') return `the artifact holds no baseline prompt for scene ${id}`
  }
  if (typeof artifact.input_fingerprint !== 'string' || !artifact.input_fingerprint.trim()) return 'the artifact holds no input fingerprint'
  if (typeof artifact.owner_job_id !== 'string' || !artifact.owner_job_id.trim()) return 'the artifact names no owner job'
  if (artifact.run_id !== ref.run_id) return 'artifact run id does not match the params reference'
  if (artifact.project_slug !== ref.project_slug) return 'artifact project does not match the params reference'
  if (artifact.episode_code.toUpperCase() !== ref.episode_code.toUpperCase()) return 'artifact episode does not match the params reference'
  if (artifact.scene_ids.length !== ref.scene_ids.length
    || artifact.scene_ids.some((id, i) => id !== ref.scene_ids[i])) {
    return 'artifact scene set does not match the params reference'
  }
  // Recompute the input fingerprint from the artifact's exact facts, INCLUDING
  // the baseline prompts: the baseline is the tamper proof for what each scene
  // held before the run, so a changed baseline changes the fingerprint.
  const recomputedFingerprint = scenePolishInputFingerprint({
    model: request.model as string,
    system: request.system as string,
    userMessage: request.user_message as string,
    temperature: request.temperature as number,
    outputBudget: request.output_budget as string,
    outputContract: request.output_contract as TextOutputContract,
    requestIdentity: request.request_identity as string,
    sceneIds: artifact.scene_ids,
    baselinePrompts: Object.fromEntries(artifact.scene_ids.map(id => [id, String(baseline[id] ?? '')])),
  })
  if (recomputedFingerprint !== artifact.input_fingerprint) return 'artifact input fingerprint does not match its own request'
  if (recomputedFingerprint !== ref.input_fingerprint) return 'params reference fingerprint does not match the artifact'
  const owner = artifact.owner_job_id
  const continuesPredecessor = input.retryOf
    && typeof input.retryOf.job_id === 'string'
    && input.retryOf.job_id === owner
    && typeof input.retryOf.run_id === 'string'
    && input.retryOf.run_id === artifact.run_id
  if (jobId && owner !== jobId && !continuesPredecessor) return 'artifact belongs to another run'
  if (input.retryOf && !continuesPredecessor) return 'artifact retry predecessor does not match this job'
  // The current job marker authorizes only the predecessor reference above.
  if (artifact.prepared_key) {
    if (typeof artifact.prepared_key !== 'string' || !artifact.prepared_key.trim()) return 'the artifact prepared key is not text'
    const resolvedModel = resolveGenStudioModelId('chat', request.model as string) || (request.model as string)
    const recomputedKey = buildGenStudioChatIdempotencyKey({
      modelId: resolvedModel,
      system: request.system as string,
      userMessage: request.user_message as string,
      temperature: request.temperature as number,
      outputBudget: request.output_budget as any,
      outputContract: request.output_contract as TextOutputContract,
      requestIdentity: request.request_identity as string,
    })
    if (recomputedKey !== artifact.prepared_key) return 'artifact prepared key does not match the digest of its stored request'
  }
  // Output digests, when present, must cover the EXACT output set in both
  // directions: every digest matches the artifact's text, and the artifact
  // holds no output the reference does not digest.
  if (artifact.outputs !== undefined || ref.output_digests !== undefined) {
    const outputs = artifact.outputs && typeof artifact.outputs === 'object' && !Array.isArray(artifact.outputs)
      ? artifact.outputs
      : {}
    const digests = ref.output_digests && typeof ref.output_digests === 'object' && !Array.isArray(ref.output_digests)
      ? ref.output_digests
      : {}
    const outputIds = Object.keys(outputs)
    const digestIds = Object.keys(digests)
    if (outputIds.length !== digestIds.length || outputIds.some(id => !(id in digests))) {
      return 'the params output digests do not cover the exact artifact output set'
    }
    for (const [id, digest] of Object.entries(digests)) {
      const text = outputs[id]
      if (text === undefined) return `params reference names an output digest for scene ${id} that the artifact does not hold`
      if (typeof text !== 'string' || !text.trim()) return `the artifact output for scene ${id} is empty`
      if (typeof digest !== 'string' || !digest.trim()) return `the params output digest for scene ${id} is empty`
      const actual = createHash('sha256').update(text).digest('hex')
      if (actual !== digest) return `output digest for scene ${id} does not match the artifact's text`
    }
  }
  return ''
}

/**
 * What a music scene-polish run has to prove.
 */
export interface ScenePolishProof {
  /** The scene prompts saved on the episode document. */
  promptOverrides: Record<string, string> | null | undefined
  /** This run's own artifact record, when it could be loaded and validated. */
  artifact: MusicScenePolishRunArtifact | null
  /**
   * The run's own result record, when it got that far: which scenes it polished
   * and which it did not (`job.result`), plus the itemised declaration the
   * generator writes through `requireJobCompletion` (`job.result.completion`).
   */
  result?: {
    polished?: number
    missing?: Array<string | number>
    complete?: boolean
    completion?: {
      complete?: boolean
      expected?: number
      completed?: number
      missing?: Array<string | number>
    } | null
  } | null
}

/**
 * `music_scene_polish` — this run's own output, on the document.
 *
 * THE RUN'S ARTIFACT DECIDES, AND THE DOCUMENT CORROBORATES IT:
 *
 *  1. the run kept its own exact record on disk (the episode-side artifact);
 *  2. that record names the scenes the run was asked to polish;
 *  3. the document carries EXACTLY the texts this run produced, for every one
 *     of those scenes;
 *  4. the run's own itemised declaration agrees.
 *
 * A MISSING declaration is not a failure: a run interrupted before it could
 * write one is reconstructed from the durable outputs by the generator, so the
 * audit never has to guess and never has to call an incomplete run complete.
 */
export function inspectScenePolishCompletion(proof: ScenePolishProof): TextCompletionAudit {
  const artifact = proof.artifact
  if (!artifact) {
    return NOT_COMPLETE(false, 'This run left no readable record of the prompts it produced, so its output cannot be verified.')
  }
  const outputs: Record<string, string> | null = artifact.outputs && typeof artifact.outputs === 'object'
    ? artifact.outputs
    : null
  if (!outputs) {
    return NOT_COMPLETE(false, 'This run did not record the prompts it produced, so its output cannot be verified.')
  }
  const missing = Array.isArray(artifact.missing) ? artifact.missing.map(id => String(id).trim()).filter(Boolean) : []
  if (missing.length) {
    return NOT_COMPLETE(true, `This run did not polish scene ${missing.join(', ')}.`)
  }
  const overrides: Record<string, string> = proof.promptOverrides && typeof proof.promptOverrides === 'object'
    ? proof.promptOverrides
    : {}
  for (const id of artifact.scene_ids) {
    const produced = String(outputs[id] ?? '').trim()
    if (!produced) return NOT_COMPLETE(true, `This run did not polish scene ${id}.`)
    const saved = String(overrides[id] ?? '')
    if (sameText(saved, produced)) continue
    const startedFrom = String(artifact.baseline_prompts?.[id] ?? '')
    if (sameText(saved, startedFrom)) {
      return NOT_COMPLETE(true, `Scene ${id} still holds the prompt this run started from, so this run's polished prompt is not on the document.`)
    }
    return NOT_COMPLETE(true, `The prompt saved for scene ${id} was changed after this run, so this run's polished prompt is not on the document.`)
  }
  const completion = proof.result?.completion ?? null
  if (completion) {
    if (completion.complete === false) {
      return NOT_COMPLETE(true, 'This run recorded an incomplete set of polished prompts.')
    }
    const expected = Number(completion.expected)
    const completed = Number(completion.completed)
    if (!Number.isFinite(expected) || !Number.isFinite(completed) || expected !== completed) {
      return NOT_COMPLETE(true, `This run recorded ${completed} of ${expected} polished prompt(s).`)
    }
    if (completion.missing?.length) {
      return NOT_COMPLETE(true, `This run did not polish ${completion.missing.length} scene(s).`)
    }
  }
  const notPolished = (proof.result?.missing || []).map(id => String(id).trim()).filter(Boolean)
  if (notPolished.length) {
    return NOT_COMPLETE(true, `This run did not polish scene ${notPolished.join(', ')}.`)
  }
  return { authoritative: true, complete: true }
}

/** The chapter count a writing job asked for, when it named one. */
export function requestedChapterCount(params: unknown): number | null {
  const value = Number((params as { chapters?: unknown } | null | undefined)?.chapters)
  return Number.isInteger(value) && value > 0 ? value : null
}

/** The chapters a filtered expansion asked for, when it named any. */
export function requestedChapterSelection(params: unknown): number[] {
  const raw = (params as { chapters_to_expand?: unknown } | null | undefined)?.chapters_to_expand
  if (!Array.isArray(raw)) return []
  return raw.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)
}

/** The chapter number a chapter-only job was asked to write. */
export function requestedChapterNumber(params: unknown): number | null {
  const value = Number((params as { chapter_number?: unknown } | null | undefined)?.chapter_number)
  return Number.isInteger(value) && value > 0 ? value : null
}
