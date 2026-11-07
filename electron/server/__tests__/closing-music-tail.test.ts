/**
 * The closing music tail (owner, 2026-10-19): every episode closes with 20–30 s
 * of music after the spoken content, over a black screen or the last scene held.
 *
 * Until this change that tail rendered SILENT — Audio Assembly trimmed the bed at
 * the narration's end and the renderer padded the picture with silence. The tail
 * is now baked ONCE into the merged mix, at the length the Video Assembly
 * preset's own `post_audio` asks for, and the renderer draws the matching
 * hold/black picture under it without adding a second pad.
 *
 * What is pinned here:
 *   • the mix's length arithmetic and the tail's own defaults (pure, no FFmpeg);
 *   • a REAL merge: 3 s narration + 8 s music lead-in + 25 s tail = 36 s, with
 *     music still present at the end of the tail and fading out over it;
 *   • the track LOOPS: the music file is shorter than the tail and the last
 *     seconds are not silence;
 *   • no BGM: the historical mix, no tail, and the job log says why;
 *   • the record's `closing_tail_sec`, and `lead_in_sec` that excludes the tail;
 *   • the video's two clocks: speech end vs the master's real length, so the
 *     renderer neither pads twice nor cuts the narration short;
 *   • Scene Plan coverage measured against the speech, not the music.
 *
 * ZERO paid calls: the voice catalogue the chapter list is read against is a
 * local mock, and the merge itself is local FFmpeg.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { after, before, describe } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { getAudioDuration, runFfmpeg } from '../lib/ffmpeg-utils.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const {
  generateAudioMerge, mergedMixDurationSec, resolveClosingTailParams,
  buildMusicLeadInVolumeExpr, DEFAULT_DUCK_RELEASE_SEC, DEFAULT_TAIL_FADE_OUT_SEC,
} = await import('../generators/audio-merge.js')
const { postRollSeconds, narrationSecFromMaster } = await import('../lib/closing-tail.js')
const { resolveVideoLengths, scanEpisodeAssets } = await import('../generators/video.js')
const pm = await import('../services/project-manager.js')
const { setApiKey } = await import('../services/app-secrets-store.js')
const { setGenStudioUrl } = await import('../services/app-settings.js')
const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
const { measureLoudness } = await import('../generators/music-episode-build.js')

const service = await startMockGenStudioService()
await setGenStudioUrl(service.baseUrl)
await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
service.ttsModels = [{
  id: 'roomy-model', display_name: 'roomy-model', provider_id: 'p', provider_name: 'Mock provider', description: '',
  credits_per_1000_characters: 1, minimum_credits: 1, maximum_input_characters: 4_000,
  supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, supports_voice_cloning: false,
  preview_policy: '', generation_enabled: true, provider_submit_concurrency: 1, controls: [],
}] as any
clearGenStudioCatalogCache()

after(async () => {
  clearGenStudioCatalogCache()
  await service.close()
  await temp.cleanup()
})

const NARRATION_SEC = 3
const LEAD_IN_SEC = 8
const TAIL_SEC = 25
/** 3 + 8 + 25 — what the merged master must measure. */
const MERGED_SEC = NARRATION_SEC + LEAD_IN_SEC + TAIL_SEC

const near = (actual: number | null | undefined, expected: number, tolerance = 0.6) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `expected ${actual} ≈ ${expected} (±${tolerance})`)

/** Mean loudness of one slice of a file; null when the slice is silent or unreadable. */
async function sliceLufs(file: string, startSec: number, durSec: number): Promise<number | null> {
  const out = path.join(temp.dir, `slice-${startSec}-${durSec}-${Math.random().toString(36).slice(2, 6)}.wav`)
  await runFfmpeg(['-y', '-ss', String(startSec), '-t', String(durSec), '-i', file, '-vn', '-c:a', 'pcm_s16le', out])
  const measured = await measureLoudness(out, { truePeak: false })
  await fs.rm(out, { force: true })
  return measured.lufs
}

// ── The tail's numbers, without FFmpeg ────────────────────────────────────

describe('closing tail: the mix length and the tail defaults', () => {
  test('the mix runs narration + music lead-in + closing tail', () => {
    assert.equal(mergedMixDurationSec(120, 8, 25), 153)
    assert.equal(mergedMixDurationSec(120, 8, 0), 128, 'no tail = the historical length')
    assert.equal(mergedMixDurationSec(120, 0, 25), 145)
    // Negative / junk terms cannot shorten the mix below the narration.
    assert.equal(mergedMixDurationSec(120, -4, -4), 120)
  })

  test('with nothing set, the tail keeps the bed\'s normal level and the tuned rise and fade', () => {
    const tail = resolveClosingTailParams({
      tailSec: 25, postNarrationVolume: 0.08, musicFadeOut: 0, closing: undefined,
    })
    assert.equal(tail.tailSec, 25)
    assert.equal(tail.level, 0.08, '100% IS the level Audio Assembly already set — not full scale')
    assert.equal(tail.duckReleaseSec, DEFAULT_DUCK_RELEASE_SEC)
    assert.equal(tail.fadeOutSec, DEFAULT_TAIL_FADE_OUT_SEC)
  })

  test('the controls are honoured, clamped, and never longer than the tail', () => {
    const loud = resolveClosingTailParams({
      tailSec: 25, postNarrationVolume: 0.08, musicFadeOut: 0,
      closing: { volume: 150, duck_release_sec: 2.5, fade_out_sec: 8 },
    })
    assert.equal(loud.level, 0.12)
    assert.equal(loud.duckReleaseSec, 2.5)
    assert.equal(loud.fadeOutSec, 8)

    const clamped = resolveClosingTailParams({
      tailSec: 25, postNarrationVolume: 1, musicFadeOut: 0,
      closing: { volume: 900, duck_release_sec: -1, fade_out_sec: 0 },
    })
    assert.equal(clamped.level, 1, 'the level can never exceed the narration-relative scale')
    assert.equal(clamped.duckReleaseSec, 0, 'a negative rise is no rise, not a backwards one')
    assert.equal(clamped.fadeOutSec, DEFAULT_TAIL_FADE_OUT_SEC, 'zero falls back to the tuned default')

    const short = resolveClosingTailParams({
      tailSec: 3, postNarrationVolume: 0.08, musicFadeOut: 0,
      closing: { duck_release_sec: 10, fade_out_sec: 10 },
    })
    assert.equal(short.duckReleaseSec, 3, 'the rise cannot outlast the tail')
    assert.equal(short.fadeOutSec, 3)
  })

  test('the Audio Assembly music fade-out is the fallback when the tail sets none', () => {
    const tail = resolveClosingTailParams({
      tailSec: 25, postNarrationVolume: 0.08, musicFadeOut: 4, closing: {},
    })
    assert.equal(tail.fadeOutSec, 4)
  })

  test('the duck release ramps the bed back up instead of jumping', () => {
    // With a release the expression carries a ramp from the ducked level to the
    // tail's level, starting exactly where the narration ends.
    const withRelease = buildMusicLeadInVolumeExpr(0, 0, 100, 0.08, 0.2, 1.5)
    assert.equal(withRelease, 'if(lt(t,100.000),0.080,if(lt(t,101.500),0.080+(0.200-0.080)*(t-100.000)/1.500,0.200))')
    // With no release it is the historical step, byte for byte.
    assert.equal(buildMusicLeadInVolumeExpr(0, 0, 100, 0.08, 0.2), 'if(lt(t,100.000),0.080,0.200)')
    // The music intro's own phases are untouched by the tail.
    assert.equal(
      buildMusicLeadInVolumeExpr(8, 0.6, 120, 0.15, 0.4),
      'if(lt(t,8.000),1.0,if(lt(t,8.600),1.0+(0.150-1.0)*(t-8.000)/0.600,if(lt(t,128.000),0.150,0.400)))',
    )
  })
})

// ── The video's two clocks ────────────────────────────────────────────────

describe('video length: the master that already carries the tail is not padded twice', () => {
  test('a baked tail makes the master the video length and the speech the narration', () => {
    const lengths = resolveVideoLengths({
      sourceDurationSec: MERGED_SEC, bakedClosingTailSec: TAIL_SEC,
      postAudio: { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: TAIL_SEC },
    })
    assert.equal(lengths.narrationDurationSec, NARRATION_SEC + LEAD_IN_SEC, 'the speech, plus the music lead-in')
    assert.equal(lengths.postRollSec, TAIL_SEC)
    assert.equal(lengths.targetDurationSec, MERGED_SEC, 'exactly the master — no second pad, no truncation')
  })

  test('the merged audio wins over a preset changed after the merge', () => {
    // The preset now says 5 s (or nothing at all): the audio that exists is 25 s.
    for (const postAudio of [
      { behavior: 'hold-last-scene' as const, fade_duration: 5, tail_seconds: 5 },
      { behavior: 'hard-cut' as const, fade_duration: 5 },
      undefined,
    ]) {
      const lengths = resolveVideoLengths({
        sourceDurationSec: MERGED_SEC, bakedClosingTailSec: TAIL_SEC, postAudio,
      })
      assert.equal(lengths.postRollSec, TAIL_SEC)
      assert.equal(lengths.targetDurationSec, MERGED_SEC)
    }
  })

  test('without a baked tail nothing changes', () => {
    const lengths = resolveVideoLengths({
      sourceDurationSec: 120, bakedClosingTailSec: 0,
      postAudio: { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: 25 },
    })
    assert.equal(lengths.narrationDurationSec, 120, 'the whole track is the narration, as before')
    assert.equal(lengths.postRollSec, 25)
    assert.equal(lengths.targetDurationSec, 145)
    assert.equal(resolveVideoLengths({ sourceDurationSec: 120, bakedClosingTailSec: 0, postAudio: undefined }).targetDurationSec, 120)
  })

  test('the post-roll rule itself is one definition', () => {
    assert.equal(postRollSeconds({ behavior: 'black-screen', fade_duration: 5, tail_seconds: 25 }), 25)
    assert.equal(postRollSeconds({ behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: 25 }), 25)
    assert.equal(postRollSeconds({ behavior: 'fade-to-black', fade_duration: 5 }), 5)
    assert.equal(postRollSeconds({ behavior: 'hard-cut', fade_duration: 5 }), 0)
    assert.equal(postRollSeconds({ behavior: 'continue-cycling', fade_duration: 5 }), 0)
    assert.equal(postRollSeconds(undefined), 0, 'a request that never named a behavior has never had a tail drawn')
    assert.equal(narrationSecFromMaster(36, 25), 11)
    assert.equal(narrationSecFromMaster(36, 0), 36)
    assert.equal(narrationSecFromMaster(10, 25), 0, 'a tail longer than the file cannot make the narration negative')
  })
})

// ── A real merge ──────────────────────────────────────────────────────────

/** A one-chapter episode plus a short music track, and the channel's closing preset. */
async function episodeWithClosingTail() {
  const project = await pm.createProject({
    name: `Closing tail ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3,
  })
  await pm.updateConfig(project.slug, {
    safety_checks: { chapter_audio_present: 'off' },
    // The channel's Video Assembly timeline preset: the owner's closing. Audio
    // Assembly reads the tail and its music controls from HERE — one source.
    video_bundle_presets: [{
      id: 'bundle-1', name: 'Closing 25',
      data: { fallback: { timeline: { post_audio: { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: TAIL_SEC } } } },
    }],
    video_bundle_last_preset: 'bundle-1',
  } as any)

  const outputRoot = (await pm.getProjectOutputRoot(project.slug))!
  const narrationDir = path.join(outputRoot, 'EP001 - Test')
  await fs.mkdir(narrationDir, { recursive: true })
  await fs.writeFile(path.join(narrationDir, 'EP001_Script_Narration.md'), [
    '# Narration', '## Chapter 1: One', 'The first chapter is short.',
  ].join('\n\n'))

  const { resolveAudioDir, findNarrationFile } = await import('../generators/audio.js')
  const audioDir = await resolveAudioDir(project.slug, await findNarrationFile(project.slug, 'EP001'), 'EP001')
  await fs.mkdir(audioDir, { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${NARRATION_SEC}`,
    '-c:a', 'libmp3lame', path.join(audioDir, 'EP001_Chapter_01.mp3')])
  // Deliberately SHORTER than the tail: if the bed did not loop, the end of the
  // tail would be silence.
  const musicPath = path.join(temp.dir, 'closing-music.mp3')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-c:a', 'libmp3lame', musicPath])

  const run = async (music: Record<string, unknown> | undefined) => {
    const job: any = {
      job_id: `merge-${Math.random().toString(36).slice(2)}`, project_slug: project.slug, type: 'audio_merge',
      episode_id: 'EP001', title: 'Audio Assembly', status: 'running', created_at: new Date().toISOString(),
      started_at: null, finished_at: null, error: null, output_lines: [],
      params: { episode_id: 'EP001', chapters: [], gap_duration: 0, normalize_volume: false, ...(music ? { music } : {}) },
    }
    await generateAudioMerge(job)
    return job
  }
  return { slug: project.slug, musicPath, run }
}

describe('Audio Assembly: the closing tail is music, and it never goes silent', () => {
  test('BGM + 25 s tail → narration + lead-in + 25 s, music across the tail, fading out at the end', async () => {
    const ep = await episodeWithClosingTail()
    const job = await ep.run({
      enabled: true, source: 'manual', files: [ep.musicPath],
      volume: 0.5, post_narration_volume: 0.6, fade_in: 0, fade_out: 0,
      lead_in_enabled: true, lead_in_seconds: LEAD_IN_SEC,
    })

    const lines = job.output_lines.join('\n')
    assert.match(lines, new RegExp(`Closing tail: the background music continues for ${TAIL_SEC}s`), lines)

    const mergedDir = job.output_dir as string
    const mergedPath = path.join(mergedDir, 'EP001_merged_audio.mp3')
    const record = JSON.parse(await fs.readFile(path.join(mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'))

    assert.equal(record.closing_tail_sec, TAIL_SEC, 'the tail the mix baked is written down')
    near(record.duration_sec, MERGED_SEC)
    // The tail is not an opening: the lead-in the captions shift by stays 8 s.
    near(record.opening.lead_in_sec, LEAD_IN_SEC, 0.4)
    assert.equal(record.opening.music_lead_in_sec, LEAD_IN_SEC)

    const info = await getAudioDuration(mergedPath)
    near(info, MERGED_SEC)

    // Music under the narration, and — the point of the change — music 20 s into
    // the tail, long after the 2 s track would have run out.
    const underVoice = await sliceLufs(mergedPath, 4, 3)
    const midTail = await sliceLufs(mergedPath, 20, 3)
    assert.ok(underVoice !== null && underVoice > -70, `music should play under the narration (got ${underVoice})`)
    assert.ok(midTail !== null && midTail > -70, `the tail must carry music, not silence (got ${midTail})`)

    // The track LOOPS: it is 2 s long and the tail is 25 s, so the last seconds
    // can only be music if the loop kept playing.
    const lateTail = await sliceLufs(mergedPath, MERGED_SEC - 6, 3)
    assert.ok(lateTail !== null && lateTail > -70, `the bed must loop rather than run out (got ${lateTail})`)

    // Fade-out over the end: the final second is clearly below the tail's body.
    const lastSecond = await sliceLufs(mergedPath, MERGED_SEC - 1, 0.9)
    assert.ok(
      lastSecond === null || lastSecond < midTail! - 6,
      `the tail must fade out, not stop with a cut (body ${midTail}, final second ${lastSecond})`,
    )
  })

  test('no BGM → the historical mix, no tail, and the job log says so', async () => {
    const ep = await episodeWithClosingTail()
    const job = await ep.run({ enabled: false, files: [], volume: 0.5, post_narration_volume: 0.6, fade_in: 0, fade_out: 0 })

    const lines = job.output_lines.join('\n')
    assert.match(lines, new RegExp(`asks for ${TAIL_SEC}s after the narration, but no background music is selected`), lines)
    assert.doesNotMatch(lines, /the background music continues for/)

    const mergedDir = job.output_dir as string
    const record = JSON.parse(await fs.readFile(path.join(mergedDir, 'EP001_merged_audio.completion.json'), 'utf-8'))
    assert.equal(record.closing_tail_sec, 0, 'no bed, no tail')
    near(record.duration_sec, NARRATION_SEC, 0.3)
    near(record.opening.lead_in_sec, 0, 0.3)
  })
})

// ── Scene Plan coverage measures the speech ───────────────────────────────

describe('Scene Plan: the master\'s closing tail is not narration', () => {
  const SLUG = 'closing-tail-scan'
  let n = 0

  before(async () => {
    const projectDir = path.join(temp.dir, 'projects', SLUG)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: SLUG, name: 'Closing Tail Scan', episode_prefix: 'EP', season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    }))
    await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
      ideas: [], next_episode_number: 1, recycled_numbers: [],
    }))
  })

  async function scannedEpisode(masterSec: number, closingTailSec: number) {
    const code = `EP000${++n}`
    const ideasPath = path.join(temp.dir, 'projects', SLUG, 'ideas.json')
    const ideas = JSON.parse(await fs.readFile(ideasPath, 'utf-8'))
    ideas.ideas.push({ id: code, episode_code: code, title: `Ep ${n}`, status: 'accepted' })
    await fs.writeFile(ideasPath, JSON.stringify(ideas))
    const episodeDir = path.join(temp.dir, 'projects', SLUG, 'episodes', 'Season 001', `${code} - Ep ${n}`)
    const imagesDir = path.join(episodeDir, 'scene_images')
    const mergedDir = path.join(episodeDir, `${code} - 08 Audio Merge Output`)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.mkdir(mergedDir, { recursive: true })
    // One scene covering exactly the speech: 0 → (master − tail).
    const speechEnd = masterSec - closingTailSec
    const scenes = [{
      id: 's1', scene_index: 1, start_sec: 0, end_sec: speechEnd,
      transcript_segment: 'x', visual_prompt: 'x', approved: true,
    }]
    for (const scene of scenes) await fs.writeFile(path.join(imagesDir, `${scene.id}.png`), 'png')
    await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
      schema_version: 1, generated_at: new Date().toISOString(), research_used: false, opening_mode: 'from-start',
      total_duration_sec: speechEnd, scenes,
    }))
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      sections: [{ slug: 'Chapter_01', duration_s: speechEnd }], gap_duration_s: 0,
    }))

    const filename = `${code}_merged_audio.mp3`
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=8000,atrim=duration=${masterSec}`,
      '-codec:a', 'libmp3lame', '-q:a', '9', path.join(mergedDir, filename),
    ])
    await fs.writeFile(path.join(mergedDir, `${code}_merged_audio.completion.json`), JSON.stringify({
      output_filename: filename, duration_sec: masterSec, closing_tail_sec: closingTailSec,
      opening: { lead_in_sec: 0, intro: null, music_lead_in_sec: 0 },
    }))

    return { code, assets: await scanEpisodeAssets(SLUG, code) }
  }
  test('the scan reports the tail, and the coverage is measured on the speech', async () => {
    const { assets } = await scannedEpisode(36, 25)
    assert.equal(assets.merged_audio[0]?.closing_tail_sec, 25)
    near(assets.scene_plan_timing?.audio_duration_sec, 11, 0.15)
    assert.equal(assets.scene_plan_timing?.complete, true, 'a plan covering the speech is complete')
    near(assets.scene_plan_timing?.tail_gap_sec, 0, 0.15)
  })

  test('a master with no tail is read exactly as before', async () => {
    const { assets } = await scannedEpisode(36, 0)
    assert.equal(assets.merged_audio[0]?.closing_tail_sec, 0)
    near(assets.scene_plan_timing?.audio_duration_sec, 36, 0.15)
    assert.equal(assets.scene_plan_timing?.complete, true)
  })
})
