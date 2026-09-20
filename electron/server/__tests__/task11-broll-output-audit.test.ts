/** Task 11 — B-Roll completion is proved from the final render, not mutable inputs. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
let audit: typeof import('../boot/executors.js')
let sidecars: typeof import('../services/broll-selection-sidecar.js')
let pm: typeof import('../services/project-manager.js')
let ideas: typeof import('../services/idea-manager.js')
let provenance: typeof import('../services/video-visual-source.js')
let assembler: typeof import('../generators/broll-assemble.js')

const EPISODE = 'EP0001'
const TITLE = 'Actual Output Authority'
const TARGET_SEC = 3.1
let slug = ''
let outputDir = ''
let finalPath = ''
let stampPath = ''
let narrationPath = ''
let narrationV2Path = ''
let mergeCompletionPath = ''
let episodePaths: Awaited<ReturnType<(typeof import('../services/utils.js'))['resolveEpisodePaths']>>

before(async () => {
  tmp = await useTempDataDir()
  audit = await import('../boot/executors.js')
  sidecars = await import('../services/broll-selection-sidecar.js')
  provenance = await import('../services/video-visual-source.js')
  assembler = await import('../generators/broll-assemble.js')
  pm = await import('../services/project-manager.js')
  ideas = await import('../services/idea-manager.js')
  const project = await pm.createProject({ name: 'Task 11 Broll Output' })
  slug = project.slug
  const [idea] = await ideas.addIdeas(slug, [{
    title: TITLE, logline: 'Fixture.', themes: [], suggested_chapters: 1,
    suggested_length: 'short', mood: 'measured',
  }], 'mock-chat-v1')
  const accepted = await ideas.acceptIdea(slug, idea!.id, false)
  assert.equal(accepted.episode_code, EPISODE)
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  episodePaths = await resolveEpisodePathsByCode(slug, EPISODE)
  outputDir = episodePaths.video_dir
  finalPath = path.join(outputDir, `${EPISODE}_final_video.mp4`)
  stampPath = provenance.videoAssemblySourceStampPath(finalPath, EPISODE)
  narrationPath = path.join(episodePaths.merged_audio_dir, `${EPISODE}_merged_audio.mp3`)
  narrationV2Path = path.join(episodePaths.merged_audio_dir, `${EPISODE}_merged_audio_v2.mp3`)
  mergeCompletionPath = path.join(episodePaths.merged_audio_dir, `${EPISODE}_merged_audio.completion.json`)
  await Promise.all([
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(episodePaths.merged_audio_dir, { recursive: true }),
  ])
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TARGET_SEC}`,
    '-codec:a', 'libmp3lame', '-q:a', '9', narrationPath,
  ])
})

after(async () => { await tmp?.cleanup() })
beforeEach(async () => {
  await Promise.all([
    fs.rm(finalPath, { force: true }),
    fs.rm(stampPath, { force: true }),
    fs.rm(narrationV2Path, { force: true }),
    fs.rm(mergeCompletionPath, { force: true }),
  ])
})

function selection(coveredSec: number): any {
  return {
    pool_id: 'pool-1', selection_mode: 'auto', pacing_mode: 'timed', broll_volume: 0.3,
    target_duration: TARGET_SEC, generated_at: new Date().toISOString(),
    selection: [{ filename: 'clip.mp4', sha256: 'a'.repeat(64), target_duration: coveredSec }],
  }
}

async function writeVideo(durationSec: number, outputPath = finalPath): Promise<void> {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=10:d=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outputPath,
  ])
}

async function writeProducerProof(): Promise<void> {
  const source = await provenance.readVideoVisualSource(slug, EPISODE)
  const narration = await provenance.snapshotBrollNarration(narrationPath, episodePaths, EPISODE)
  await provenance.writeVideoAssemblySourceStamp(
    finalPath, EPISODE, source.source, source.image_pool, narration,
  )
}

const job = (includeOutputDir = true) => ({
  project_slug: slug,
  episode_id: EPISODE,
  title: TITLE,
  params: {},
  ...(includeOutputDir ? { output_dir: outputDir } : {}),
  output_lines: [] as string[],
})

describe('B-Roll completion audits the concrete output produced by this run', () => {
  test('a full-looking mutated selection cannot bless a short final video', async () => {
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    await writeVideo(0.2)
    await writeProducerProof()
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    assert.equal((await computeEpisodeStatus(slug, EPISODE)).video_assembly, false)
  })

  test('a complete final video is not invalidated by a later-shortened selection', async () => {
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    await writeVideo(TARGET_SEC)
    await writeProducerProof()
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(0.2))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'complete')
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    assert.equal((await computeEpisodeStatus(slug, EPISODE)).video_assembly, true)
  })

  test('a historical job with no output_dir and no canonical final is repair-required', async () => {
    await fs.rm(finalPath, { force: true })
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    const legacyJob = job(false)
    assert.equal(await audit.auditBrollAssemblyOutput(legacyJob), 'repair-required')
    assert.match(legacyJob.output_lines.join('\n'), /final video.*missing|run B-Roll Assembly.*again/i)
  })

  test('a legacy sidecar with no target cannot prove output coverage', async () => {
    const legacySelection = selection(TARGET_SEC)
    delete legacySelection.target_duration
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, legacySelection)
    await writeVideo(TARGET_SEC)
    await fs.rm(stampPath, { force: true })
    const legacyJob = job()
    assert.equal(await audit.auditBrollAssemblyOutput(legacyJob), 'repair-required')
    assert.match(legacyJob.output_lines.join('\n'), /target.*unknown|pick B-Roll.*again/i)
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    assert.equal(
      (await computeEpisodeStatus(slug, EPISODE)).video_assembly,
      false,
      'the Board must not stay green when the same historical B-Roll final has no producer proof',
    )
  })

  test('the producer rejects a short staged render before replacing a valid final', async () => {
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    await writeVideo(TARGET_SEC)
    await writeProducerProof()
    const priorFinal = await fs.readFile(finalPath)
    const tempPath = path.join(outputDir, '.tmp-task11-short-final.mp4')
    await writeVideo(0.2, tempPath)
    const source = await provenance.readVideoVisualSource(slug, EPISODE)
    const narration = await provenance.snapshotBrollNarration(narrationPath, episodePaths, EPISODE)

    await assert.rejects(
      () => assembler.promoteVerifiedBrollFinal({
        tempPath,
        finalPath,
        projectSlug: slug,
        episodeId: EPISODE,
        title: TITLE,
        narrationPath,
        paths: episodePaths,
        visualSource: source,
        narrationEvidence: narration,
      }),
      /partial.*prior final was preserved/i,
    )
    assert.deepEqual(await fs.readFile(finalPath), priorFinal)
    await fs.rm(tempPath, { force: true })
  })

  test('a foreign episode stamp cannot bless this episode final', async () => {
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    await writeVideo(TARGET_SEC)
    await writeProducerProof()
    const stamp = JSON.parse(await fs.readFile(stampPath, 'utf8'))
    await fs.writeFile(stampPath, JSON.stringify({ ...stamp, episode_code: 'EP9999' }))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
  })

  test('a newer canonical merge stales a final bound to the retained old merge', async () => {
    await sidecars.saveSelectionSidecar(slug, EPISODE, TITLE, selection(TARGET_SEC))
    await writeVideo(TARGET_SEC)
    await writeProducerProof()
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `sine=frequency=660:duration=${TARGET_SEC}`,
      '-codec:a', 'libmp3lame', '-q:a', '9', narrationV2Path,
    ])
    const stat = await fs.stat(narrationV2Path)
    await fs.writeFile(mergeCompletionPath, JSON.stringify({
      output_filename: path.basename(narrationV2Path),
      bytes: stat.size,
      duration_sec: TARGET_SEC,
      opening: { lead_in_sec: 0, music_lead_in_sec: 0 },
    }))
    assert.equal(await audit.auditBrollAssemblyOutput(job()), 'repair-required')
    const { computeEpisodeStatus } = await import('../services/asset-status.js')
    assert.equal((await computeEpisodeStatus(slug, EPISODE)).video_assembly, false)
  })
})
