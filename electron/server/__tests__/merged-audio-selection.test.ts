import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

// Must be set before ../app.js is imported so the throwaway server does not listen.
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

/**
 * v1.4.314 — one explicit, episode-owned merged-audio choice.
 *
 * PR0002/PR0003: the owner chose the latest (`_v2`) merge, but the Final Video
 * path (stitch, plan gate, render, Scene Review) selected the base 14-voice test
 * track while `audio-merge-status` and B-Roll selected the `_v2`. Four selectors
 * answered "which narration?" four ways. These pin the single shared choice:
 * the pin wins everywhere, membership is validated, and a pin that no longer
 * names a real track is refused rather than silently swapped for another.
 */

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let resolveEpisodePathsByCode: typeof import('../services/utils.js').resolveEpisodePathsByCode

function plan(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-10-17T09:00:00.000Z',
    total_duration_sec: 952.58229,
    source_timeline: { sha256: 'a'.repeat(64), total_cues: 1, first_cue_start_sec: 0, last_cue_end_sec: 952.582 },
    source_merged_audio: { duration_sec: 952.582 },
    opening_mode: 'from-start',
    opening_reserved_sec: 0,
    scenes: [{ id: 'scene-0001', scene_index: 1, start_sec: 0, end_sec: 952.58229, visual_prompt: 'A quiet archive.' }],
    ...overrides,
  }
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  ;({ app } = await import('../app.js'))
  ;({ resolveEpisodePathsByCode } = await import('../services/utils.js'))
})

after(async () => { await cleanup() })

async function seedEpisode(name: string) {
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'Merged choice', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
  }], 'test-model')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify(plan()))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  return { slug: project.slug, code: accepted.episode_code, paths }
}

async function writeMerges(paths: any, code: string, recordNames: 'base' | 'v2') {
  await fs.mkdir(paths.merged_audio_dir, { recursive: true })
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.mp3`), 'ID3')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio_v2.mp3`), 'ID3')
  await fs.writeFile(path.join(paths.merged_audio_dir, `${code}_merged_audio.completion.json`), JSON.stringify({
    schema_version: 2,
    output_filename: recordNames === 'v2' ? `${code}_merged_audio_v2.mp3` : `${code}_merged_audio.mp3`,
    duration_sec: recordNames === 'v2' ? 664.64 : 952.582,
    opening: { lead_in_sec: 0 },
  }))
}

// ── The pure selection rule ─────────────────────────────────────────────────

test('applyMergedAudioSelection: a member pin is used, no pin is "unset", a non-member is "invalid"', async () => {
  const { applyMergedAudioSelection } = await import('../lib/merged-audio-selection.js')
  const entries = ['PR0002_merged_audio.mp3', 'PR0002_merged_audio_v2.mp3']

  assert.deepEqual(
    applyMergedAudioSelection(entries, 'PR0002', 'PR0002_merged_audio_v2.mp3'),
    { source: 'selected', filename: 'PR0002_merged_audio_v2.mp3', pinned: 'PR0002_merged_audio_v2.mp3' },
  )
  assert.deepEqual(
    applyMergedAudioSelection(entries, 'PR0002', null),
    { source: 'unset', filename: null, pinned: null },
  )
  // Pinned but gone: refused, never silently swapped for the other track.
  assert.deepEqual(
    applyMergedAudioSelection(entries, 'PR0002', 'PR0002_merged_audio_v3.mp3'),
    { source: 'invalid', filename: null, pinned: 'PR0002_merged_audio_v3.mp3' },
  )
  // Foreign: another episode's track is not a member of this folder either.
  assert.equal(
    applyMergedAudioSelection(entries, 'PR0002', 'PR0003_merged_audio.mp3').source,
    'invalid',
  )
})

test('isEpisodeMergedAudioFilename: ownership is read, not guessed', async () => {
  const { isEpisodeMergedAudioFilename } = await import('../lib/merged-audio-selection.js')
  assert.equal(isEpisodeMergedAudioFilename('PR0002_merged_audio.mp3', 'PR0002'), true)
  assert.equal(isEpisodeMergedAudioFilename('PR0002_merged_audio_v3.m4a', 'pr0002'), true)
  assert.equal(isEpisodeMergedAudioFilename('PR0002_merged_audio.completion.json', 'PR0002'), false)
  assert.equal(isEpisodeMergedAudioFilename('PR0003_merged_audio.mp3', 'PR0002'), false)
  assert.equal(isEpisodeMergedAudioFilename('.selected_merged_audio', 'PR0002'), false)
  assert.equal(isEpisodeMergedAudioFilename('notes.txt', 'PR0002'), false)
})

test('the pin round-trips through the sidecar and clears', async () => {
  const { readSelectedMergedAudio, writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merged-pin-'))
  assert.equal(await readSelectedMergedAudio(dir), null)
  await writeSelectedMergedAudio(dir, 'PR0002_merged_audio_v2.mp3')
  assert.equal(await readSelectedMergedAudio(dir), 'PR0002_merged_audio_v2.mp3')
  await writeSelectedMergedAudio(dir, null)
  assert.equal(await readSelectedMergedAudio(dir), null)
})

test('with no pin the merged-track choice is unchanged (the base track wins by code-unit order)', async () => {
  const { resolveEpisodeMergedAudioFilename } = await import('../lib/merged-audio-selection.js')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merged-default-'))
  await fs.writeFile(path.join(dir, 'PR0002_merged_audio_v2.mp3'), 'ID3')
  await fs.writeFile(path.join(dir, 'PR0002_merged_audio.mp3'), 'ID3')
  assert.equal(await resolveEpisodeMergedAudioFilename(dir, 'PR0002'), 'PR0002_merged_audio.mp3')
})

// ── The pin is honoured by the readers ──────────────────────────────────────

test('resolveEpisodeIntroLeadIn describes the owner-pinned track, not the base', async () => {
  const { code, paths } = await seedEpisode('Merged pin leadin')
  await writeMerges(paths, code, 'v2')
  const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  const { resolveEpisodeIntroLeadIn } = await import('../lib/intro-lead-in.js')

  const base = await resolveEpisodeIntroLeadIn(paths.episode_dir, paths.merged_audio_dir, code)
  assert.equal(base.merged_filename, `${code}_merged_audio.mp3`, 'no pin → the base track, unchanged')

  await writeSelectedMergedAudio(paths.merged_audio_dir, `${code}_merged_audio_v2.mp3`)
  const pinned = await resolveEpisodeIntroLeadIn(paths.episode_dir, paths.merged_audio_dir, code)
  assert.equal(pinned.merged_filename, `${code}_merged_audio_v2.mp3`, 'the pin is the narration')
})

test('resolveEpisodeIntroLeadIn refuses a pin that no longer names a real track', async () => {
  const { code, paths } = await seedEpisode('Merged pin gone')
  await writeMerges(paths, code, 'base')
  const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  const { resolveEpisodeIntroLeadIn } = await import('../lib/intro-lead-in.js')
  await writeSelectedMergedAudio(paths.merged_audio_dir, `${code}_merged_audio_v3.mp3`)

  const lead = await resolveEpisodeIntroLeadIn(paths.episode_dir, paths.merged_audio_dir, code)
  assert.equal(lead.status, 'unmeasurable')
  // Pin the facts that make the refusal actionable — WHICH pin, WHICH episode, and
  // WHERE it was not found — rather than a phrase this module never writes. A regex
  // on wording that does not exist passes on nothing and hides a real message change.
  const reason = lead.reason || ''
  assert.ok(reason.includes(`("${code}_merged_audio_v3.mp3")`), `the pin is named: ${reason}`)
  assert.ok(reason.toLowerCase().includes(code.toLowerCase()), `the episode is named: ${reason}`)
  assert.ok(reason.includes(`is not in ${paths.merged_audio_dir}`), `the folder it is missing from is named: ${reason}`)
})

// ── The renderer's own scan agrees ──────────────────────────────────────────

test('scanEpisodeAssets puts the pinned track first and reports the choice', async () => {
  const { slug, code, paths } = await seedEpisode('Merged pin scan')
  await writeMerges(paths, code, 'v2')
  const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  const { scanEpisodeAssets } = await import('../generators/video.js')
  await writeSelectedMergedAudio(paths.merged_audio_dir, `${code}_merged_audio_v2.mp3`)

  const assets = await scanEpisodeAssets(slug, code)
  assert.equal(assets.merged_audio[0]?.filename, `${code}_merged_audio_v2.mp3`)
  assert.equal(assets.merged_audio_selection?.source, 'selected')
  assert.equal(assets.merged_audio_selection?.filename, `${code}_merged_audio_v2.mp3`)
})

test('scanEpisodeAssets reports an invalid pin and does not substitute a track', async () => {
  const { slug, code, paths } = await seedEpisode('Merged pin scan invalid')
  await writeMerges(paths, code, 'base')
  const { writeSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  const { scanEpisodeAssets } = await import('../generators/video.js')
  await writeSelectedMergedAudio(paths.merged_audio_dir, `${code}_merged_audio_v3.mp3`)

  const assets = await scanEpisodeAssets(slug, code)
  assert.equal(assets.merged_audio_selection?.source, 'invalid')
  assert.equal(assets.merged_audio_selection?.pinned, `${code}_merged_audio_v3.mp3`)
  assert.equal(assets.merged_audio_selection?.filename, null)
})

test('scanEpisodeAssets keeps an accepted job on the track it was accepted with', async () => {
  const { slug, code, paths } = await seedEpisode('Merged snapshot wins')
  await writeMerges(paths, code, 'base')
  // The episode's current choice is the base; the accepted job was queued with v2.
  const { scanEpisodeAssets } = await import('../generators/video.js')
  const assets = await scanEpisodeAssets(slug, code, { preferredMergedFilename: `${code}_merged_audio_v2.mp3` })
  assert.equal(assets.merged_audio[0]?.filename, `${code}_merged_audio_v2.mp3`)
})

test('an accepted render whose captured track is gone is refused, never switched to another', async () => {
  const { slug, code, paths } = await seedEpisode('Merged snapshot gone')
  await writeMerges(paths, code, 'v2')
  // The render was accepted with the v2 track, and that file has since been deleted.
  const captured = path.join(paths.merged_audio_dir, `${code}_merged_audio_v2.mp3`)
  await fs.rm(captured)
  const { prepareUnifiedVideoAssemblyInputs } = await import('../generators/video.js')
  const job = { output_lines: [] as string[] } as any
  const req = { merged_audio_path: captured } as any

  await assert.rejects(
    () => prepareUnifiedVideoAssemblyInputs(slug, code, req, job),
    /accepted with.*no longer in this episode's merged-audio folder/is,
  )
  // Standing identity contract: an accepted job never silently switches audio, not
  // even with a note in the log.
  assert.ok(
    !job.output_lines.some((line: string) => /using .* instead/.test(line)),
    `the captured track was substituted instead of refused:\n${job.output_lines.join('\n')}`,
  )
})

test('expectedMergedAudioFilename refuses an invalid pin instead of naming a track to check', async () => {
  const { expectedMergedAudioFilename, applyMergedAudioSelection } = await import('../lib/merged-audio-selection.js')
  const entries = ['PR0002_merged_audio.mp3', 'PR0002_merged_audio_v2.mp3']
  const withEntries = (pinned: string | null) => ({ ...applyMergedAudioSelection(entries, 'PR0002', pinned), entries })

  assert.deepEqual(
    expectedMergedAudioFilename(withEntries(null), 'PR0002'),
    { ok: true, filename: 'PR0002_merged_audio.mp3' },
  )
  assert.deepEqual(
    expectedMergedAudioFilename(withEntries('PR0002_merged_audio_v2.mp3'), 'PR0002'),
    { ok: true, filename: 'PR0002_merged_audio_v2.mp3' },
  )
  // The pin is gone. NOT `{ ok: true, filename: null }` — a null expectation tells a
  // completion-record reader to skip its filename check and trust a record that may
  // describe a different track. The caller must refuse instead.
  assert.deepEqual(
    expectedMergedAudioFilename(withEntries('PR0002_merged_audio_v3.mp3'), 'PR0002'),
    { ok: false, pinned: 'PR0002_merged_audio_v3.mp3' },
  )
})

// ── The route that stores the choice ────────────────────────────────────────

test('PUT merged-audio/select refuses a foreign or dangling filename and stores a valid pin', async () => {
  const { slug, code, paths } = await seedEpisode('Merged pin route')
  await writeMerges(paths, code, 'base')
  const url = `/api/projects/${slug}/video-editor/merged-audio/select/${code}`

  const foreign = await request(app).put(url).send({ filename: 'PR9999_merged_audio.mp3' })
  assert.equal(foreign.status, 400)

  const notAudio = await request(app).put(url).send({ filename: `${code}_merged_audio.completion.json` })
  assert.equal(notAudio.status, 400)

  const dangling = await request(app).put(url).send({ filename: `${code}_merged_audio_v3.mp3` })
  assert.equal(dangling.status, 404)

  const ok = await request(app).put(url).send({ filename: `${code}_merged_audio_v2.mp3` })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.selected_merged_audio, `${code}_merged_audio_v2.mp3`)

  const { readSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')
  assert.equal(await readSelectedMergedAudio(paths.merged_audio_dir), `${code}_merged_audio_v2.mp3`)

  const cleared = await request(app).put(url).send({ filename: null })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.selected_merged_audio, null)
  assert.equal(await readSelectedMergedAudio(paths.merged_audio_dir), null)
})

test('PUT merged-audio/select refuses a path-shaped or dot-leading filename, storing nothing', async () => {
  const { slug, code, paths } = await seedEpisode('Merged pin malformed')
  await writeMerges(paths, code, 'base')
  const url = `/api/projects/${slug}/video-editor/merged-audio/select/${code}`
  const { readSelectedMergedAudio } = await import('../lib/merged-audio-selection.js')

  // Each of these would read back as `invalid` (membership is an exact entry match),
  // so the route must 400 it up front rather than store a pin that can never resolve.
  const malformed = [
    `${code}_merged_audio/../_merged_audio.mp3`,   // path separator
    `${code}_merged_audio\\nested_merged_audio.mp3`, // backslash separator
    `.${code}_merged_audio.mp3`,                   // leading dot
    `sub/${code}_merged_audio.mp3`,                // foreign path
  ]
  for (const bad of malformed) {
    const res = await request(app).put(url).send({ filename: bad })
    assert.equal(res.status, 400, `${bad} must be refused: ${JSON.stringify(res.body)}`)
  }
  assert.equal(await readSelectedMergedAudio(paths.merged_audio_dir), null, 'no malformed pin was stored')
})
