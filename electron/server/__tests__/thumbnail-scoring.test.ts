/**
 * Thumbnail scoring (owner, 2026-11-01).
 *
 * These tests pin the behaviour the owner approved, and the honesty rules
 * around it:
 *
 *   - a COMPLETE run scores every candidate and the highest wins;
 *   - a PARTIAL run — one candidate's scoring fails — still scores the rest
 *     and still picks the best of what was measured;
 *   - an EMPTY run (no candidates) records nothing and picks nothing;
 *   - a STALE hash — a regenerated file — makes its old score unusable;
 *   - a MALFORMED model answer is "not scored", never a 0;
 *   - a PROVIDER FAILURE is "not scored", never a 0;
 *   - a RETRY after a failure scores what is left;
 *   - a HUMAN PIN always wins and is never overwritten;
 *   - a KHMER channel skips every text check;
 *   - the SWITCH OFF keeps today's behaviour — nothing is scored;
 *   - a NON-ZERO score is pinned to the record (a score of 0 would be
 *     indistinguishable from "not scored").
 *
 * No network and no paid call: the catalogue read and the model call are both
 * replaced through the service's own seams.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'
import {
  _setThumbnailScoreCatalogForTesting,
  _setThumbnailScoreEvaluatorForTesting,
  _setThumbnailScoreLanguageForTesting,
  chooseThumbnailPick,
  eligibleThumbnailScoreModels,
  parseThumbnailScoreAnswer,
  resolveThumbnailScoreModel,
  runThumbnailScoring,
  thumbnailAutoPickConfig,
  type ThumbnailScoreEvaluatorInput,
} from '../services/thumbnail-scoring.js'
import { applyThumbnailRules } from '../services/thumbnail-score-rules.js'
import { sortByNewestVersion } from '../lib/upload-metadata.js'
import {
  normalizeThumbnailScore,
  thumbnailScoreBand,
  type ThumbnailScoreRecord,
} from '../contracts/thumbnail-scores.js'

const MODEL_ID = 'openrouter-main::vision-free'

function visionRow(over: Partial<GenStudioChatModel> = {}): GenStudioChatModel {
  return {
    id: MODEL_ID,
    display_name: 'Vision Free',
    provider_id: 'openrouter-main',
    provider_name: 'OpenRouter',
    available: true,
    qualification_only: false,
    locked: false,
    supports_vision: true,
    structured_output_mode: 'json_object',
    chargeable: false,
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
    ...over,
  } as GenStudioChatModel
}

function config(over: Record<string, unknown> = {}) {
  return { thumbnail_auto_pick: { enabled: true, model: MODEL_ID, ...over } }
}

/** A real 16:9 PNG with visible content, so the local rules pass it. */
async function goodImage(file: string): Promise<void> {
  const width = 640
  const height = 360
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      raw[i] = (x * 255 / width) | 0
      raw[i + 1] = (y * 255 / height) | 0
      raw[i + 2] = ((x + y) % 255) | 0
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file)
}

/** A near-blank picture: one flat colour. */
async function blankImage(file: string): Promise<void> {
  await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 40, g: 40, b: 40 } },
  }).png().toFile(file)
}

/** A picture that is not 16:9. */
async function wrongShapeImage(file: string): Promise<void> {
  await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toFile(file)
}

interface Fixture {
  slug: string
  episodeDir: string
  thumbDir: string
  candidates: Array<{ filename: string; path: string }>
}

async function fixture(t: any, names: string[] = ['A', 'B', 'C']): Promise<Fixture> {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const pm = await import('../services/project-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Thumbnail scoring' })
  const paths = await utils.resolveEpisodePaths(project.slug, 'EP0001', '')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  const candidates: Array<{ filename: string; path: string }> = []
  // The versions DESCEND along the array, so the FIRST candidate is the one
  // the newest-version rule (highest `_vN`) picks — the same order the
  // picker lists them in. A test that says "the newest version" then means
  // `candidates[0]`.
  let version = names.length
  for (const name of names) {
    const filename = `EP0001_Thumb${name}_v${version}.png`
    version--
    const file = path.join(paths.thumb_dir, filename)
    await goodImage(file)
    candidates.push({ filename, path: file })
  }
  return { slug: project.slug, episodeDir: paths.episode_dir, thumbDir: paths.thumb_dir, candidates }
}

function useSeams(
  t: any,
  rows: GenStudioChatModel[],
  evaluator?: (input: ThumbnailScoreEvaluatorInput) => Promise<string>,
  language: string | null = 'en',
) {
  _setThumbnailScoreCatalogForTesting(async () => rows)
  _setThumbnailScoreEvaluatorForTesting(evaluator ? async input => evaluator(input) : null)
  _setThumbnailScoreLanguageForTesting(async () => language)
  t.after(() => {
    _setThumbnailScoreCatalogForTesting(null)
    _setThumbnailScoreEvaluatorForTesting(null)
    _setThumbnailScoreLanguageForTesting(null)
  })
}

/** The answer the rubric asks for. */
function answer(score: number, reason = 'Clear subject, matches the title.', textIssue = ''): string {
  return JSON.stringify({ score, reason, text_issue: textIssue })
}

// ── The local rules (Stage 1) ──────────────────────────────────────────────

test('the local rules throw out a wrong shape and a blank picture, and pass a good one', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const dir = temp.dir

  const good = path.join(dir, 'good.png')
  await goodImage(good)
  const goodResult = await applyThumbnailRules(good)
  assert.equal(goodResult.rejected, null, JSON.stringify(goodResult))

  const blank = path.join(dir, 'blank.png')
  await blankImage(blank)
  const blankResult = await applyThumbnailRules(blank)
  assert.equal(blankResult.rejected, 'blank')

  const wrong = path.join(dir, 'wrong.png')
  await wrongShapeImage(wrong)
  const wrongResult = await applyThumbnailRules(wrong)
  assert.equal(wrongResult.rejected, 'aspect')

  const missing = path.join(dir, 'missing.png')
  const missingResult = await applyThumbnailRules(missing)
  assert.equal(missingResult.rejected, 'unreadable')
})

// ── The model choice (§1) ──────────────────────────────────────────────────

test('the model is the one the channel names, and no model named means not scored', async (t) => {
  const rows = [visionRow()]
  useSeams(t, rows)
  const resolved = await resolveThumbnailScoreModel(config())
  assert.equal(resolved.ok, true)

  const unnamed = await resolveThumbnailScoreModel({ thumbnail_auto_pick: { enabled: true } })
  assert.equal(unnamed.ok, false)
  assert.match((unnamed as { reason: string }).reason, /No vision model is chosen/)

  const gone = await resolveThumbnailScoreModel(config({ model: 'retired-model' }))
  assert.equal(gone.ok, false)
  assert.match((gone as { reason: string }).reason, /not in the Gateway catalogue/)
})

test('a paid model is never used on its own, and an unknown price is not a free price', async (t) => {
  const rows = [visionRow({ chargeable: true })]
  useSeams(t, rows)
  const resolved = await resolveThumbnailScoreModel(config())
  assert.equal(resolved.ok, false)
  assert.match((resolved as { reason: string }).reason, /not a free model/)

  assert.deepEqual(eligibleThumbnailScoreModels([visionRow({ chargeable: undefined })]), [])
  assert.equal(eligibleThumbnailScoreModels([visionRow({ chargeable: false })]).length, 1)
})

test('a model that cannot carry a picture is refused by what the catalogue publishes', async (t) => {
  useSeams(t, [visionRow({ supports_vision: false })])
  const resolved = await resolveThumbnailScoreModel(config())
  assert.equal(resolved.ok, false)
  assert.match((resolved as { reason: string }).reason, /does not publish image input/)
})

test('the switch reads as on by default and off when it says so', () => {
  assert.equal(thumbnailAutoPickConfig({}).enabled, true)
  assert.equal(thumbnailAutoPickConfig({ thumbnail_auto_pick: {} }).enabled, true)
  assert.equal(thumbnailAutoPickConfig({ thumbnail_auto_pick: { enabled: false } }).enabled, false)
  assert.equal(thumbnailAutoPickConfig({ thumbnail_auto_pick: { model: ' x ' } }).model, 'x')
})

// ── Reading the model's answer (§6) ────────────────────────────────────────

test('a malformed answer is not scored, never a zero', () => {
  assert.throws(() => parseThumbnailScoreAnswer('not json at all'))
  assert.throws(() => parseThumbnailScoreAnswer('[]'))
  assert.throws(() => parseThumbnailScoreAnswer(JSON.stringify({ reason: 'good' })), /did not give a number/)
  assert.throws(() => parseThumbnailScoreAnswer(JSON.stringify({ score: 500 })), /outside 0/)
  assert.throws(() => parseThumbnailScoreAnswer(JSON.stringify({ score: 80 })), /no reason/)
  const parsed = parseThumbnailScoreAnswer(answer(80))
  assert.equal(parsed.score, 80)
  assert.equal(parsed.reason, 'Clear subject, matches the title.')
})

test('a score of zero is a real score, and it is not the same as no score', () => {
  assert.deepEqual(normalizeThumbnailScore(0), { score: 0 })
  assert.ok('error' in normalizeThumbnailScore(undefined))
  assert.equal(thumbnailScoreBand(0), 'poor')
  assert.equal(thumbnailScoreBand(75), 'good')
  assert.equal(thumbnailScoreBand(95), 'excellent')
})

// ── The pick ───────────────────────────────────────────────────────────────

test('the pick is: a human pin, then the highest score, then the newest version', () => {
  const scored = [
    { filename: 'low.png', entry: { filename: 'low.png', state: 'scored' as const, score: 20 } },
    { filename: 'high.png', entry: { filename: 'high.png', state: 'scored' as const, score: 90 } },
  ]
  // The candidates carry real `_vN` versions, because the newest-version rule
  // is the UPLOAD's rule — highest `_vN` first, then lexicographic descending.
  // The fallback must apply THAT rule, not the order the caller happened to
  // pass: a record that names a different file from the one the upload takes
  // is a record that lies.
  const all = ['EP0001_Thumb01_v1.png', 'EP0001_Thumb03_v2.png', 'EP0001_Thumb02_v3.png']

  assert.equal(chooseThumbnailPick({ pinned: 'EP0001_Thumb01_v1.png', scored, all })?.filename, 'EP0001_Thumb01_v1.png')
  assert.equal(chooseThumbnailPick({ pinned: 'EP0001_Thumb01_v1.png', scored, all })?.basis, 'manual_pin')
  // The pin wins even when scoring produced NOTHING to compare it with —
  // an unmeasured run must never un-pick the owner's pin.
  assert.equal(chooseThumbnailPick({ pinned: 'EP0001_Thumb01_v1.png', scored: [], all })?.basis, 'manual_pin')
  assert.equal(chooseThumbnailPick({ scored, all })?.filename, 'high.png')
  assert.equal(chooseThumbnailPick({ scored, all })?.basis, 'score')
  // The newest version wins the fallback, and the caller's array order does
  // NOT decide it — 'EP0001_Thumb01_v1.png' is first in `all` and is the OLDEST.
  assert.equal(chooseThumbnailPick({ scored: [], all })?.filename, 'EP0001_Thumb02_v3.png')
  assert.equal(chooseThumbnailPick({ scored: [], all })?.basis, 'newest_version')
  assert.equal(chooseThumbnailPick({ scored: [], all: [] }), null)
})

test('the newest-version fallback names the file the upload will actually take', () => {
  // The same rule the upload resolver applies, on the same files: the record's
  // fallback and the upload's choice must be ONE answer.
  const all = ['EP0001_Thumb01_v1.png', 'EP0001_Thumb03_v2.png', 'EP0001_Thumb02_v3.png']
  assert.equal(
    chooseThumbnailPick({ scored: [], all })?.filename,
    sortByNewestVersion(all)[0],
    'the record names the file the upload takes',
  )
})

// ── The whole run ──────────────────────────────────────────────────────────

test('a complete run scores every candidate and the highest wins', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(70))
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(run.notScored, false)
  const scored = Object.values(run.record.candidates).filter(c => c.state === 'scored')
  assert.equal(scored.length, 3)
  assert.equal(run.pick, f.candidates[0]!.filename)
  assert.equal(run.record.pick?.basis, 'score')
  assert.equal(run.record.pick?.score, 70)
  assert.ok(run.record.pick?.reason)
})

test('a partial run — one candidate\'s scoring fails — still scores the rest and picks the best of them', async (t) => {
  const f = await fixture(t)
  let call = 0
  useSeams(t, [visionRow()], async () => {
    call++
    if (call === 2) throw new Error('the provider is down')
    return answer(call === 1 ? 95 : 40)
  })
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  const entries = Object.values(run.record.candidates)
  const scored = entries.filter(c => c.state === 'scored')
  const notScored = entries.filter(c => c.state === 'not_scored')
  assert.equal(scored.length, 2)
  assert.equal(notScored.length, 1)
  assert.equal(notScored[0]!.score, undefined, 'a failed candidate carries no number')
  assert.match(notScored[0]!.reason || '', /could not be reached/)
  assert.equal(run.pick, f.candidates[0]!.filename)
  assert.equal(run.record.pick?.score, 95)
})

test('an empty run records nothing and picks nothing', async (t) => {
  const f = await fixture(t, [])
  useSeams(t, [visionRow()], async () => answer(70))
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: [],
    title: 'The title',
    config: config(),
  })
  assert.deepEqual(run.record.candidates, {})
  assert.equal(run.pick, '', 'scoring chose nothing')
  assert.equal(run.resolved, '', 'and there is nothing to resolve to')
  assert.equal(run.allBad, false, 'no candidates at all is not "all bad" — nothing was rejected')
})

test('a malformed model answer is not scored, never a zero', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => 'this is not json')
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  const entries = Object.values(run.record.candidates)
  assert.equal(entries.length, 3)
  for (const entry of entries) {
    assert.equal(entry.state, 'not_scored')
    assert.equal(entry.score, undefined, 'a malformed answer never becomes a 0')
  }
  assert.equal(run.notScored, true)
  assert.equal(run.pick, '', 'scoring chose nothing when every answer was unreadable')
  assert.equal(run.resolved, f.candidates[0]!.filename, "today's newest-version rule still stands")
})

test('a provider failure is not scored, and a RETRY scores what is left', async (t) => {
  const f = await fixture(t)
  let fail = true
  useSeams(t, [visionRow()], async () => {
    if (fail) throw new Error('the provider is down')
    return answer(88)
  })
  const first = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(first.notScored, true)
  assert.equal(first.pick, '', 'scoring chose nothing when nothing could be measured')
  // Today's newest-version rule still stands — it is the upload's rule, not
  // scoring's — so the record names the file the upload will take.
  assert.equal(first.resolved, f.candidates[0]!.filename,
    "today's newest-version rule still resolves the upload")
  assert.equal(first.record.pick?.basis, 'newest_version')
  assert.equal(first.record.pick?.score, undefined, 'the fallback names no score, and none is not a 0')
  for (const entry of Object.values(first.record.candidates)) {
    assert.equal(entry.state, 'not_scored')
    assert.equal(entry.score, undefined)
  }

  fail = false
  const retry = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(retry.notScored, false)
  for (const entry of Object.values(retry.record.candidates)) {
    assert.equal(entry.state, 'scored')
    assert.equal(entry.score, 88)
  }
})

test('a regenerated file makes its score stale, so the stale score is not used', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(60))
  const first = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(first.notScored, false)

  // The file changes on disk — a re-render. Its old score is now stale.
  await fs.writeFile(f.candidates[0]!.path, 'a completely different file')
  const second = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  const stale = second.record.candidates[f.candidates[0]!.filename]!
  assert.equal(stale.state, 'rejected_by_rule', 'the unreadable file is set aside, not scored on an old number')
  assert.equal(stale.score, undefined)
})

test('a human pin always wins and is never overwritten', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(10))
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
    pinned: f.candidates[2]!.filename,
  })
  // The pin wins. `pick` is what SCORING chose, so it is empty here — the pin
  // is the owner's own choice, not scoring's answer.
  assert.equal(run.pick, '', 'scoring chose nothing; the owner chose')
  // `resolved` is what the upload will take, and that IS the pinned file.
  assert.equal(run.resolved, f.candidates[2]!.filename, 'the pinned file is what the upload takes')
  assert.equal(run.record.pick?.basis, 'manual_pin')
  assert.equal(run.record.pick?.filename, f.candidates[2]!.filename)
  // The pinned file was also SCORED, and that score is kept: it is a fact
  // about the picture, and the owner asked for the scores to be kept so they
  // can be compared with real click-through. It is not a claim that the
  // score chose the file — `basis` says what did.
  assert.equal(run.record.pick?.score, 10, 'the pinned file keeps its own honest score')
  assert.equal(run.record.pick?.reason, 'The owner pinned this thumbnail.',
    'the reason says what actually chose it, not the score')
})

test('a run that cannot measure keeps the previous valid pick, with the reason', async (t) => {
  const f = await fixture(t)
  // Scores that make the WINNER a file the newest-version rule would NOT
  // take, so "kept" and "fell back" are distinguishable.
  const byPath: Record<string, number> = {
    [f.candidates[0]!.path]: 40,
    [f.candidates[1]!.path]: 90,
    [f.candidates[2]!.path]: 60,
  }
  useSeams(t, [visionRow()], async input => answer(byPath[input.imagePath] ?? 50))
  const first = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  const winner = first.record.pick!.filename
  assert.equal(first.record.pick?.basis, 'score')
  assert.notEqual(winner, f.candidates[0]!.filename, 'the winner is not the newest version')

  // Every provider call fails: this run measures NOTHING.
  useSeams(t, [visionRow()], async () => { throw new Error('the provider is down') })
  const second = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(second.notScored, true, 'this run measured nothing, and says so')
  assert.equal(second.record.pick?.filename, winner, 'the previous valid pick is kept, not swapped for the newest version')
  assert.equal(second.record.pick?.basis, 'score')
  assert.match(second.record.pick!.reason, /previous scored pick is kept/, 'the reason says the pick was KEPT and why')
  assert.equal(second.resolved, winner, 'the upload still takes the kept pick')
  assert.equal(second.pick, winner, 'the record and the run agree a score chose it')
  assert.equal(second.record.candidates[winner]!.state, 'scored',
    'the measurement of the same bytes stands; not_scored never replaces it')
  assert.equal(second.allBad, false)

  useSeams(t, [visionRow()], async input => {
    if (input.imagePath === f.candidates[0]!.path) throw new Error('one provider result unavailable')
    return answer(input.imagePath === f.candidates[2]!.path ? 99 : 45)
  })
  const partial = await runThumbnailScoring({ slug: f.slug, episodeCode: 'EP0001', fallbackTitle: '',
    candidates: f.candidates, title: 'The title', config: config() })
  assert.equal(partial.record.pick?.filename, winner, 'partial scoring must not replace the existing valid selection')
  assert.match(partial.record.pick!.reason, /Scoring is incomplete/)
})

test('missing candidates are not measured and never count as all bad', async t => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(70))
  const run = await runThumbnailScoring({ slug: f.slug, episodeCode: 'EP0001', fallbackTitle: '',
    candidates: [{ ...f.candidates[0]!, path: path.join(f.episodeDir, 'missing.png') }],
    title: 'The title', config: config() })
  assert.equal(run.allBad, false)
  assert.equal(Object.values(run.record.candidates)[0]?.state, 'not_scored')
})

test('"all bad" means every candidate was explicitly rejected — never not_scored or a 0', async (t) => {
  // (a) Every candidate set aside by a local rule: that IS all-bad.
  const all = await fixture(t, ['A', 'B'])
  for (const candidate of all.candidates) await blankImage(candidate.path)
  useSeams(t, [visionRow()], async () => answer(70))
  const rejected = await runThumbnailScoring({
    slug: all.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: all.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(rejected.allBad, true, 'every candidate was explicitly rejected')
  assert.equal(rejected.pick, '', 'no score chose anything')

  // (b) One rejection plus candidates that were merely NOT MEASURED:
  // unmeasured is not a rejection, so this is not all-bad.
  const mixed = await fixture(t, ['A', 'B', 'C'])
  await blankImage(mixed.candidates[0]!.path)
  useSeams(t, [visionRow()], async () => { throw new Error('the provider is down') })
  const partial = await runThumbnailScoring({
    slug: mixed.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: mixed.candidates,
    title: 'The title',
    config: config(),
  })
  const entries = Object.values(partial.record.candidates)
  assert.ok(entries.some(c => c.state === 'rejected_by_rule'))
  assert.ok(entries.some(c => c.state === 'not_scored'))
  assert.equal(partial.allBad, false, 'not_scored is never a rejection')

  // (c) A real score of 0 is a measurement, not all-bad.
  const zero = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(0))
  const zeroed = await runThumbnailScoring({
    slug: zero.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: zero.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(zeroed.allBad, false)
  assert.equal(zeroed.notScored, false, 'a 0 is a score')
})

test('a pinned file that was never measured carries no score, and a missing score is not a 0', async (t) => {
  const f = await fixture(t)
  // The model call fails, so nothing is measured — including the pinned file.
  useSeams(t, [visionRow()], async () => { throw new Error('the provider is down') })
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
    pinned: f.candidates[2]!.filename,
  })
  assert.equal(run.record.pick?.basis, 'manual_pin')
  assert.equal(run.record.pick?.score, undefined, 'an unmeasured file carries no score, and none is not a 0')
})

test('a Khmer channel skips every text check', async (t) => {
  const f = await fixture(t)
  let sawSkipText = false
  useSeams(t, [visionRow()], async (input) => {
    if (input.skipText) sawSkipText = true
    return answer(75)
  }, 'km')
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(sawSkipText, true, 'the model is told to skip the text check')
  for (const entry of Object.values(run.record.candidates)) {
    assert.equal(entry.state, 'scored')
    assert.equal(entry.text_issue, undefined)
  }
})

test('the switch off keeps today\'s behaviour — nothing is scored', async (t) => {
  const f = await fixture(t)
  let called = false
  useSeams(t, [visionRow()], async () => { called = true; return answer(70) })
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config({ enabled: false }),
    pinned: f.candidates[2]!.filename,
  })
  assert.equal(run.resolved, f.candidates[2]!.filename, 'switching scoring off still honors the human pin')
  assert.equal(called, false, 'no model call happens when the switch is off')
  assert.equal(run.notScored, true)
  assert.equal(run.pick, '', 'scoring chose nothing')
  assert.deepEqual(run.record.candidates, {})
})

test('a non-zero score is pinned to the record', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(37))
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(run.record.pick?.score, 37)
  assert.equal(run.record.pick?.filename, f.candidates[0]!.filename)
})

test('the record is per episode — one episode\'s scores never reach another', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(55))
  await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  const recordPath = path.join(f.episodeDir, 'thumbnail_scores.json')
  const written = JSON.parse(await fs.readFile(recordPath, 'utf8')) as ThumbnailScoreRecord
  assert.equal(written.episode_code, 'EP0001')
  assert.equal(Object.keys(written.candidates).length, 3)
  // The record lives in the episode's OWN folder — no shared, channel-wide file.
  assert.ok(recordPath.startsWith(f.episodeDir))
})

test('the pick is logged with its score and reason, so it can be compared with click-through', async (t) => {
  const f = await fixture(t)
  useSeams(t, [visionRow()], async () => answer(64, 'Bold and clear.'))
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.ok(run.record.pick)
  assert.equal(run.record.pick!.score, 64)
  assert.equal(run.record.pick!.reason, 'Bold and clear.')
  assert.equal(run.record.pick!.basis, 'score')
  assert.ok(run.record.pick!.at)
})

test('a candidate the local rules set aside is never sent to the model', async (t) => {
  const f = await fixture(t)
  const blank = path.join(f.thumbDir, 'EP0001_ThumbBlank_v1.png')
  await blankImage(blank)
  const seen: string[] = []
  useSeams(t, [visionRow()], async (input) => {
    seen.push(path.basename(input.imagePath))
    return answer(70)
  })
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: [...f.candidates, { filename: path.basename(blank), path: blank }],
    title: 'The title',
    config: config(),
  })
  assert.equal(seen.length, 3, 'the blank picture never reached the model')
  const setAside = run.record.candidates[path.basename(blank)]!
  assert.equal(setAside.state, 'rejected_by_rule')
  assert.equal(setAside.reason_code, 'blank')
  assert.equal(setAside.score, undefined)
})

// ── What the upload actually picks ─────────────────────────────────────────

test('the upload resolves: a human pin, then the scored pick, then the newest version', async (t) => {
  const f = await fixture(t, ['A', 'B', 'C'])
  const pm = await import('../services/project-manager.js')
  const upload = await import('../lib/upload-metadata.js')
  const overrides = await import('../services/upload-overrides.js')
  // The MIDDLE candidate scores highest, so the scored pick is NOT the
  // newest version — the two rules can be told apart.
  useSeams(t, [visionRow()], async (input) => {
    const name = path.basename(input.imagePath)
    return answer(name.includes('ThumbB') ? 95 : 40)
  })
  await pm.updateConfig(f.slug, { thumbnail_auto_pick: { enabled: true, model: MODEL_ID } } as any)

  const input = { slug: f.slug, episode_code: 'EP0001', fallback_title: '', platform: 'youtube' as const }

  // No scores yet: today's newest-version rule.
  const before = await upload.resolveUploadMetadata(input)
  assert.equal(path.basename(before.thumbnailPath), f.candidates[0]!.filename)

  // Scored: the highest score wins over the newest version.
  const run = await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  assert.equal(run.pick, f.candidates[1]!.filename)
  const scored = await upload.resolveUploadMetadata(input)
  assert.equal(path.basename(scored.thumbnailPath), f.candidates[1]!.filename,
    'the scored pick resolves, and the record names it')

  // A human pin beats the score, always.
  await overrides.writeSelectedThumbnail(f.slug, 'EP0001', '', 'youtube', f.candidates[2]!.filename)
  const pinned = await upload.resolveUploadMetadata(input)
  assert.equal(path.basename(pinned.thumbnailPath), f.candidates[2]!.filename,
    'the pin wins over the score')
})

test('a regenerated file\'s stale score is not used for the upload', async (t) => {
  const f = await fixture(t, ['A', 'B', 'C'])
  const pm = await import('../services/project-manager.js')
  const upload = await import('../lib/upload-metadata.js')
  useSeams(t, [visionRow()], async (input) => {
    const name = path.basename(input.imagePath)
    return answer(name.includes('ThumbB') ? 95 : 40)
  })
  await pm.updateConfig(f.slug, { thumbnail_auto_pick: { enabled: true, model: MODEL_ID } } as any)
  const input = { slug: f.slug, episode_code: 'EP0001', fallback_title: '', platform: 'youtube' as const }

  await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config(),
  })
  // The scored file is replaced on disk — its score is now stale.
  await fs.writeFile(f.candidates[1]!.path, 'a different file entirely')
  const resolved = await upload.resolveUploadMetadata(input)
  assert.notEqual(path.basename(resolved.thumbnailPath), f.candidates[1]!.filename,
    'a stale score never chooses the upload')
  assert.equal(path.basename(resolved.thumbnailPath), f.candidates[0]!.filename,
    'and the newest-version rule takes over')
})

test('the switch off keeps the upload on today\'s newest-version rule', async (t) => {
  const f = await fixture(t, ['A', 'B', 'C'])
  const pm = await import('../services/project-manager.js')
  const upload = await import('../lib/upload-metadata.js')
  useSeams(t, [visionRow()], async () => answer(80))
  await pm.updateConfig(f.slug, { thumbnail_auto_pick: { enabled: false, model: MODEL_ID } } as any)

  await runThumbnailScoring({
    slug: f.slug,
    episodeCode: 'EP0001',
    fallbackTitle: '',
    candidates: f.candidates,
    title: 'The title',
    config: config({ enabled: false }),
  })
  const resolved = await upload.resolveUploadMetadata({
    slug: f.slug, episode_code: 'EP0001', fallback_title: '', platform: 'youtube',
  })
  assert.equal(path.basename(resolved.thumbnailPath), f.candidates[0]!.filename,
    'the newest version is still what the upload takes')
})
