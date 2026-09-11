/** Local integration smoke: synthetic media only; requires ffmpeg/ffprobe on PATH.
 * Run: npx tsx scripts/testing/smoke-image-pool-render.mts
 * Exercises the real generator, including ignored forged shuffle/exclusions,
 * fractional narration tail, cyclic ordering, measured opening and crossfade.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-image-pool-e2e-'))
process.env.STORY_STUDIO_DATA_DIR = root
process.env.ELECTRON_RUN_AS_NODE = '1'
const slug = 'image-pool-e2e'
const episode = 'EP0001'
const title = 'Tiny Image Pool E2E'
const episodeDir = path.join(root, 'projects', slug, 'episodes', 'Season 001', `${episode} - ${title}`)
const poolDir = path.join(root, 'image-pool')
const audioDir = path.join(episodeDir, `${episode} - 08 Audio Merge Output`)
const videoDir = path.join(episodeDir, `${episode} - 10 Video Assembly Output`)
const renamedTitle = 'Renamed Tiny Image Pool E2E'
const renamedSibling = path.join(path.dirname(episodeDir), `${episode} - ${renamedTitle}`)

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)))
  })
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
async function probe(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    child.stdout.on('data', b => { out += b })
    child.stderr.on('data', b => { err += b })
    child.once('error', reject)
    child.once('exit', code => {
      const n = Number(out.trim())
      code === 0 && Number.isFinite(n) ? resolve(n) : reject(new Error(`ffprobe failed: ${err}`))
    })
  })
}
async function sampleRgb(file: string, seconds: number): Promise<[number, number, number]> {
  const { default: sharp } = await import('sharp')
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ss', String(seconds), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []; let err = ''
    child.stdout.on('data', b => chunks.push(b))
    child.stderr.on('data', b => { err += b })
    child.once('error', reject)
    child.once('exit', async code => {
      if (code !== 0) return reject(new Error(`frame extraction failed: ${err}`))
      if (!chunks.length) return reject(new Error(`frame extraction produced no image at ${seconds}s from ${file}: ${err}`))
      try {
        const { data } = await sharp(Buffer.concat(chunks)).raw().toBuffer({ resolveWithObject: true })
        resolve([data[0]!, data[1]!, data[2]!])
      } catch (e) { reject(e) }
    })
  })
}
async function makeCase(caseName: string, withOpening: boolean, withCrossfade = false) {
  await fs.mkdir(audioDir, { recursive: true }); await fs.mkdir(poolDir, { recursive: true })
  await fs.writeFile(path.join(root, 'projects', slug, 'project.json'), JSON.stringify({
    slug, name: 'Image Pool E2E', episode_prefix: 'EP', season_size: 20,
    season_prefix: 'Season', folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(root, 'projects', slug, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'e2e', title: renamedTitle, status: 'accepted', episode_code: episode }],
    next_episode_number: 2, recycled_numbers: [],
  }))
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.mkdir(renamedSibling, { recursive: true })
  const red = path.join(poolDir, 'red.png'); const blue = path.join(poolDir, 'blue.png')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', red])
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', blue])
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '9.2', '-q:a', '9', path.join(audioDir, `${episode}_merged_audio.mp3`)] )
  const redHash = sha256(await fs.readFile(red)); const blueHash = sha256(await fs.readFile(blue))
  await fs.writeFile(path.join(root, 'broll-pools.json'), JSON.stringify({ schema_version: 1, pools: [{
    id: 'images', name: 'E2E Images', folder_path: poolDir, media: 'image', auto_normalize: false,
    fps_target: 24, resolution_target: '1920x1080', created_at: new Date().toISOString(),
  }] }))
  await fs.writeFile(path.join(poolDir, '.story-studio-broll.json'), JSON.stringify({ schema_version: 1, pool_name: 'E2E Images', clips: {
    'red.png': { filename: 'red.png', duration: 0, width: 320, height: 180, fps: 1, size_bytes: (await fs.stat(red)).size, sha256: redHash, normalized: false, tags: [], indexed_at: new Date().toISOString() },
    'blue.png': { filename: 'blue.png', duration: 0, width: 320, height: 180, fps: 1, size_bytes: (await fs.stat(blue)).size, sha256: blueHash, normalized: false, tags: [], indexed_at: new Date().toISOString() },
  } }))
  await fs.writeFile(path.join(episodeDir, 'broll-selection.json'), JSON.stringify({
    schema_version: 1, episode_code: episode, pool_id: 'images', source: 'image_pool', media: 'image',
    selection_mode: 'manual', pacing_mode: 'timed', segment_seconds: 3, broll_volume: 0,
    selection: [{ filename: 'red.png', sha256: redHash, target_duration: 2 }, { filename: 'blue.png', sha256: blueHash, target_duration: 2 }],
    target_duration: 9.2, generated_at: new Date().toISOString(), warnings: [],
  }))
  let intro: any = undefined
  if (withOpening) {
    const introPath = path.join(root, 'green-intro.mp4')
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10', '-t', '2', introPath])
    intro = { enabled: true, video_path: introPath, duration: 2 }
  }
  const { generateVideo } = await import('../../electron/server/generators/video.ts')
  const job: any = {
    job_id: `e2e-${caseName}`, project_slug: slug, episode_id: episode, type: 'video_assembly',
    title: `E2E ${caseName}`, status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null,
    error: null, output_lines: [], progress: 0,
    params: {
      resolution: '720p', quality: 'compact', fps: 10, format: 'mp4',
      merged_audio_path: path.join(audioDir, `${episode}_merged_audio.mp3`),
      narration_path: path.join(audioDir, `${episode}_merged_audio.mp3`),
      subtitles: { enabled: false, srt_path: '/not-this-episode.srt' },
      scenes: [{ image_path: red, duration: 2 }],
      scene_recycling: { seconds_per_scene: 2, shuffle: true, excluded_scenes: [1] },
      post_audio: { behavior: 'hard-cut' },
      ...(withCrossfade ? { transition: 'crossfade', transition_duration: 0.5 } : {}),
      scene_animation: { type: 'none', zoom_start: 100, zoom_end: 100, parallax_direction: 'right', parallax_speed: 0, breathe_amplitude: 0, breathe_base_zoom: 100 },
      intro,
    },
  }
  await generateVideo(job)
  if (job.output_lines.some((line: string) => /Burning in subtitles/i.test(line))) {
    throw new Error(`${caseName}: disabled subtitles were burned into the Image Pool render`)
  }
  const siblingFiles = await fs.readdir(renamedSibling)
  if (siblingFiles.length) throw new Error(`Render wrote into the renamed sibling: ${siblingFiles.join(', ')}`)
  const output = path.join(videoDir, `${episode}_final_video.mp4`)
  const duration = await probe(output)
  const opening = withOpening ? await sampleRgb(output, 0.4) : null
  const sampleA = await sampleRgb(output, withOpening ? 2.4 : 0.4)
  const sampleB = await sampleRgb(output, withOpening ? 5.4 : 3.4)
  const sampleRepeat = await sampleRgb(output, withOpening ? 8.6 : 6.6)
  console.log(JSON.stringify({ caseName, output, duration, opening, sampleA, sampleB, sampleRepeat, lines: job.output_lines.slice(-12) }, null, 2))
  const expected = 9.2
  const durationOk = Math.abs(duration - expected) <= 0.15
  if (!durationOk) console.error(`${caseName}: EXPECTED ${expected}s, GOT ${duration}s`)
  if (!durationOk) failures++
  if (sampleRepeat[0] <= sampleRepeat[2]) { console.error(`${caseName}: expected cyclic red repeat, got ${sampleRepeat}`); failures++ }
  if (sampleA[0] <= sampleA[2] || sampleB[2] <= sampleB[0]) { console.error(`${caseName}: expected red then blue scene order, got ${sampleA} then ${sampleB}`); failures++ }
  if (withOpening && (!opening || opening[1] <= opening[0] || opening[1] <= opening[2])) { console.error(`${caseName}: expected green opening, got ${opening}`); failures++ }
}

async function makeMixedScenePlanCase(variable = false, motion = true) {
  const caseName = `${variable ? 'variable' : 'uniform'}-${motion ? 'opening-motion' : 'stills'}`
  const cuts = variable ? [0, 1, 3, 9] : [0, 3, 6, 9]
  const red = path.join(poolDir, 'red.png')
  const blue = path.join(poolDir, 'blue.png')
  const selectionPath = path.join(episodeDir, 'broll-selection.json')
  const selection = JSON.parse(await fs.readFile(selectionPath, 'utf8'))
  await fs.writeFile(selectionPath, JSON.stringify({ ...selection, source: 'scene_plan' }))
  const expectedSelection = await fs.readFile(selectionPath, 'utf8')

  const { resolveVideoAssetsDir } = await import('../../electron/server/generators/scene-clip.ts')
  const clipsDir = await resolveVideoAssetsDir(slug, episode, episodeDir)
  await fs.mkdir(clipsDir, { recursive: true })
  const clip = path.join(clipsDir, 'scene-clip.mp4')
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10', '-t', '3', '-pix_fmt', 'yuv420p', clip])
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1, generated_at: new Date().toISOString(), total_duration_sec: 9,
    pacing: variable ? { mode: 'variable', min_sec: 1, max_sec: 2, periods: [
      { start_sec: 0, end_sec: 3, min_sec: 1, max_sec: 2 },
      { start_sec: 3, end_sec: null, min_sec: 6, max_sec: 6 },
    ] } : { min_sec: 3, max_sec: 3 },
    scenes: [
      { id: 'scene-clip', scene_index: 1, start_sec: cuts[0], end_sec: cuts[1], transcript_segment: 'Clip', visual_prompt: 'Green clip', motion_prompt: 'Green motion', rendered_motion_prompt: 'Green motion', approved: true, image_path: red, motion_choice: motion ? 'clip' : 'still' },
      { id: 'scene-still-red', scene_index: 2, start_sec: cuts[1], end_sec: cuts[2], transcript_segment: 'Red', visual_prompt: 'Red still', approved: true, image_path: motion ? red : blue, motion_choice: 'still' },
      { id: 'scene-still-blue', scene_index: 3, start_sec: cuts[2], end_sec: cuts[3], transcript_segment: 'Blue', visual_prompt: 'Blue still', approved: true, image_path: motion ? blue : red, motion_choice: 'still' },
    ],
  }))

  const { generateVideo } = await import('../../electron/server/generators/video.ts')
  const job: any = {
    job_id: `e2e-${caseName}`, project_slug: slug, episode_id: episode, type: 'video_assembly',
    title: `E2E ${caseName}`, status: 'running', created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null,
    error: null, output_lines: [], progress: 0,
    params: {
      resolution: '720p', quality: 'compact', fps: 10, format: 'mp4',
      scenes: [{ image_path: blue, duration: 9 }],
      scene_recycling: { seconds_per_scene: 9, shuffle: true, excluded_scenes: [1] },
      post_audio: { behavior: 'hard-cut' },
      subtitles: { enabled: false, srt_path: '/not-this-episode.srt' },
      scene_animation: { type: 'none', zoom_start: 100, zoom_end: 100, parallax_direction: 'right', parallax_speed: 0, breathe_amplitude: 0, breathe_base_zoom: 100 },
    },
  }
  await generateVideo(job)
  const output = path.join(videoDir, `${episode}_final_video.mp4`)
  const { videoAssemblySourceStampPath } = await import('../../electron/server/services/video-visual-source.ts')
  const sourceStamp = JSON.parse(await fs.readFile(videoAssemblySourceStampPath(output, episode), 'utf8'))
  const duration = await probe(output)
  console.log(JSON.stringify({ caseName: `${caseName}-before-frame-check`, duration, lines: job.output_lines }, null, 2))
  await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration,nb_frames,r_frame_rate,time_base', '-of', 'json', output])
  const clipSample = await sampleRgb(output, (cuts[0]! + cuts[1]!) / 2)
  const redStillSample = await sampleRgb(output, (cuts[1]! + cuts[2]!) / 2)
  const blueStillSample = await sampleRgb(output, (cuts[2]! + cuts[3]!) / 2)
  console.log(JSON.stringify({ caseName, output, duration, clipSample, redStillSample, blueStillSample, lines: job.output_lines.slice(-12) }, null, 2))
  if (Math.abs(duration - 9.2) > 0.15) { console.error(`mixed Scene Plan: expected 9.2s, got ${duration}s`); failures++ }
  if (motion ? (clipSample[1] <= clipSample[0] || clipSample[1] <= clipSample[2]) : clipSample[0] <= clipSample[2]) { console.error(`mixed Scene Plan: expected ${motion ? 'green clip' : 'red still'}, got ${clipSample}`); failures++ }
  if (motion ? redStillSample[0] <= redStillSample[2] : redStillSample[2] <= redStillSample[0]) { console.error(`mixed Scene Plan: expected red still, got ${redStillSample}`); failures++ }
  if (motion ? blueStillSample[2] <= blueStillSample[0] : blueStillSample[0] <= blueStillSample[2]) { console.error(`mixed Scene Plan: expected blue still, got ${blueStillSample}`); failures++ }
  if (sourceStamp.source !== 'scene_plan') { console.error(`mixed Scene Plan: expected scene_plan source, got ${sourceStamp.source}`); failures++ }
  if (job.output_lines.some((line: string) => /Burning in subtitles/i.test(line))) { console.error('mixed Scene Plan: subtitles were burned despite being off'); failures++ }
  if (await fs.readFile(selectionPath, 'utf8') !== expectedSelection) { console.error('mixed Scene Plan: source selection sidecar changed during render'); failures++ }
}
let failures = 0
try {
  await makeCase('without-opening-hardcut', false)
  await makeCase('with-opening-hardcut', true)
  await makeCase('without-opening-crossfade', false, true)
  await makeCase('with-opening-crossfade', true, true)
  await makeMixedScenePlanCase()
  await makeMixedScenePlanCase(false, false)
  await makeMixedScenePlanCase(true, false)
  await makeMixedScenePlanCase(true, true)
  console.log(`fixture failures: ${failures}`)
  console.log(`fixture root: ${root}`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
if (failures) process.exitCode = 1
