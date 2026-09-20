/**
 * Task 14 — B-Roll completion requires a real full-length A/V render and one
 * authoritative narration source. These are local FFmpeg fixtures only: no
 * provider request, paid operation, or customer data is involved.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'

const EPISODE = 'EP0001'
const TITLE = 'B-Roll Media Boundary'
const TARGET_SEC = 3.1

let tmp: { dir: string; cleanup: () => Promise<void> }
let slug = ''
let paths: Awaited<ReturnType<(typeof import('../services/utils.js'))['resolveEpisodePathsByCode']>>
let finalPath = ''
let provenance: typeof import('../services/video-visual-source.js')
let assembler: typeof import('../generators/broll-assemble.js')

before(async () => {
  tmp = await useTempDataDir()
  const projects = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const sidecars = await import('../services/broll-selection-sidecar.js')
  provenance = await import('../services/video-visual-source.js')
  assembler = await import('../generators/broll-assemble.js')

  const project = await projects.createProject({ name: 'Task 14 B-Roll Media Boundary' })
  slug = project.slug
  const [idea] = await ideas.addIdeas(slug, [{
    title: TITLE,
    logline: 'Disposable local-media fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(slug, idea!.id, false)
  assert.equal(accepted.episode_code, EPISODE)

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  paths = await resolveEpisodePathsByCode(slug, EPISODE)
  finalPath = path.join(paths.video_dir, `${EPISODE}_final_video.mp4`)
  await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, {
    schema_version: 1,
    episode_code: EPISODE,
    pool_id: 'fixture-pool',
    source: 'scene_plan',
    media: 'video',
    selection_mode: 'auto',
    pacing_mode: 'timed',
    broll_volume: 0,
    target_duration: TARGET_SEC,
    generated_at: new Date().toISOString(),
    selection: [{
      filename: 'fixture.mp4',
      sha256: 'a'.repeat(64),
      target_duration: TARGET_SEC,
    }],
  })
})

after(async () => { await tmp?.cleanup() })

beforeEach(async () => {
  await Promise.all([
    fs.rm(paths.audio_dir, { recursive: true, force: true }),
    fs.rm(paths.merged_audio_dir, { recursive: true, force: true }),
    fs.rm(paths.video_dir, { recursive: true, force: true }),
  ])
  await Promise.all([
    fs.mkdir(paths.audio_dir, { recursive: true }),
    fs.mkdir(paths.merged_audio_dir, { recursive: true }),
    fs.mkdir(paths.video_dir, { recursive: true }),
  ])
})

async function writeMp3(outputPath: string, durationSec = TARGET_SEC, bitrate = '96k'): Promise<void> {
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-codec:a', 'libmp3lame', '-b:a', bitrate, outputPath,
  ])
}

async function writeAudioOnlyMp4(outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TARGET_SEC}`,
    '-c:a', 'aac', '-vn', outputPath,
  ])
}

async function writeShortVideoLongAudio(outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=0.2',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TARGET_SEC}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    outputPath,
  ])
}

async function writeFullAv(outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=10:d=${TARGET_SEC}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TARGET_SEC}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outputPath,
  ])
}

async function writeCanonicalMerge(): Promise<string> {
  const narrationPath = path.join(paths.merged_audio_dir, `${EPISODE}_merged_audio.mp3`)
  await writeMp3(narrationPath)
  const stat = await fs.stat(narrationPath)
  await fs.writeFile(
    path.join(paths.merged_audio_dir, `${EPISODE}_merged_audio.completion.json`),
    JSON.stringify({
      output_filename: path.basename(narrationPath),
      bytes: stat.size,
      duration_sec: TARGET_SEC,
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }),
  )
  return narrationPath
}

async function stampFinalFor(narrationPath: string) {
  const source = await provenance.readVideoVisualSource(slug, EPISODE)
  const narration = await provenance.snapshotBrollNarration(narrationPath, paths, EPISODE)
  await provenance.writeVideoAssemblySourceStamp(
    finalPath, EPISODE, source.source, source.image_pool, narration,
  )
  return { source, narration }
}

async function expectPromotionRejected(
  stagedPath: string,
  narrationPath: string,
): Promise<void> {
  const { source, narration } = await stampFinalFor(narrationPath)
  const priorFinal = await fs.readFile(finalPath)

  await assert.rejects(() => assembler.promoteVerifiedBrollFinal({
    tempPath: stagedPath,
    finalPath,
    projectSlug: slug,
    episodeId: EPISODE,
    title: TITLE,
    narrationPath,
    paths,
    visualSource: source,
    narrationEvidence: narration,
  }))
  assert.deepEqual(await fs.readFile(finalPath), priorFinal, 'a rejected staged render must preserve the prior final')
}

describe('B-Roll rendered-media boundary', () => {
  test('the shared inspector rejects an audio-only MP4', async () => {
    const audioOnly = path.join(paths.video_dir, 'audio-only.mp4')
    await writeAudioOnlyMp4(audioOnly)

    const inspection = await provenance.inspectBrollRenderCoverage(audioOnly, TARGET_SEC)
    assert.equal(inspection.complete, false)
    assert.match(inspection.reason, /video/i)
  })

  test('the shared inspector compares the video stream, not a longer container audio track', async () => {
    const splitDuration = path.join(paths.video_dir, 'short-video-long-audio.mp4')
    await writeShortVideoLongAudio(splitDuration)

    const inspection = await provenance.inspectBrollRenderCoverage(splitDuration, TARGET_SEC)
    assert.equal(inspection.complete, false)
    assert.match(inspection.reason, /partial|video/i)
  })

  test('the shared inspector compares the audio stream, not a longer container video track', async () => {
    const splitDuration = path.join(paths.video_dir, 'long-video-short-audio.mp4')
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=10:d=${TARGET_SEC}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      splitDuration,
    ])

    const inspection = await provenance.inspectBrollRenderCoverage(splitDuration, TARGET_SEC)
    assert.equal(inspection.complete, false)
    assert.match(inspection.reason, /partial|audio/i)
  })

  test('the producer does not promote an audio-only staged final', async () => {
    const narrationPath = await writeCanonicalMerge()
    await writeFullAv(finalPath)
    const stagedPath = path.join(paths.video_dir, '.tmp-audio-only.mp4')
    await writeAudioOnlyMp4(stagedPath)

    await expectPromotionRejected(stagedPath, narrationPath)
  })

  test('the producer does not promote full-length audio over a truncated video stream', async () => {
    const narrationPath = await writeCanonicalMerge()
    await writeFullAv(finalPath)
    const stagedPath = path.join(paths.video_dir, '.tmp-short-video-long-audio.mp4')
    await writeShortVideoLongAudio(stagedPath)

    await expectPromotionRejected(stagedPath, narrationPath)
  })
})

describe('B-Roll narration authority', () => {
  test('multiple eligible raw narration files are ambiguous instead of choosing by duration or bytes', async () => {
    const longLowBitrate = path.join(paths.audio_dir, `${EPISODE}_long-low-bitrate.mp3`)
    const shortHighBitrate = path.join(paths.audio_dir, `${EPISODE}_short-high-bitrate.mp3`)
    await Promise.all([
      writeMp3(longLowBitrate, TARGET_SEC, '32k'),
      writeMp3(shortHighBitrate, 1, '320k'),
    ])

    await assert.rejects(
      () => provenance.snapshotBrollNarration(longLowBitrate, paths, EPISODE),
      /ambiguous|multiple|exactly one/i,
    )
  })

  test('a second raw narration invalidates a final proved from the formerly sole raw track', async () => {
    const soleRaw = path.join(paths.audio_dir, `${EPISODE}_full.mp3`)
    await writeMp3(soleRaw)
    await writeFullAv(finalPath)
    await stampFinalFor(soleRaw)

    assert.equal((await provenance.inspectBrollAssemblyOutput({
      project_slug: slug,
      episode_id: EPISODE,
      title: TITLE,
      final_video_path: finalPath,
    })).complete, true, 'exactly one full raw narration remains a compatible control')

    await writeMp3(path.join(paths.audio_dir, `${EPISODE}_Chapter_02.mp3`), 1)
    const ambiguous = await provenance.inspectBrollAssemblyOutput({
      project_slug: slug,
      episode_id: EPISODE,
      title: TITLE,
      final_video_path: finalPath,
    })
    assert.equal(ambiguous.complete, false)
    assert.match(ambiguous.reason, /ambiguous|multiple|exactly one/i)
  })

  test('the producer rechecks raw authority and preserves the prior final when another raw file appears', async () => {
    const soleRaw = path.join(paths.audio_dir, `${EPISODE}_full.mp3`)
    await writeMp3(soleRaw)
    await writeFullAv(finalPath)
    const { source, narration } = await stampFinalFor(soleRaw)
    const priorFinal = await fs.readFile(finalPath)

    await writeMp3(path.join(paths.audio_dir, `${EPISODE}_Chapter_02.mp3`), 1)
    const stagedPath = path.join(paths.video_dir, '.tmp-valid-but-ambiguous-narration.mp4')
    await writeFullAv(stagedPath)
    await assert.rejects(
      () => assembler.promoteVerifiedBrollFinal({
        tempPath: stagedPath,
        finalPath,
        projectSlug: slug,
        episodeId: EPISODE,
        title: TITLE,
        narrationPath: soleRaw,
        paths,
        visualSource: source,
        narrationEvidence: narration,
      }),
      /ambiguous|multiple|exactly one/i,
    )
    assert.deepEqual(await fs.readFile(finalPath), priorFinal)
  })

  test('the completion-verified current merge remains authoritative and promotable', async () => {
    const narrationPath = await writeCanonicalMerge()
    const source = await provenance.readVideoVisualSource(slug, EPISODE)
    const narration = await provenance.snapshotBrollNarration(narrationPath, paths, EPISODE)
    const stagedPath = path.join(paths.video_dir, '.tmp-current-merge.mp4')
    await writeFullAv(stagedPath)

    const promoted = await assembler.promoteVerifiedBrollFinal({
      tempPath: stagedPath,
      finalPath,
      projectSlug: slug,
      episodeId: EPISODE,
      title: TITLE,
      narrationPath,
      paths,
      visualSource: source,
      narrationEvidence: narration,
    })
    assert.equal(promoted.completion.complete, true)
    assert.equal(promoted.completion.target_duration_sec, narration.duration_sec)
  })
})
