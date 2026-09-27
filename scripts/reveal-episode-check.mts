/**
 * The episode-scale check the design asks for: a whole sequence of scenes at one pace.
 *
 * `docs/reveal-effects.md` ends with a verification section, and its last item is *"a full episode
 * at Slow pace, to see whether the pacing reads as considered or as padding"*. This is the
 * closest honest form of that on a machine with no episode in it: it takes real stills, resolves
 * the **real** plan through the same resolver Video Assembly calls, renders each scene through the
 * **real** render path, concatenates them, and writes a receipt — the plan, the durations, the
 * image count, and the frames sampled out of one hold to show the picture drifts rather than
 * freezing.
 *
 * It runs on the app's own FFmpeg, on this Mac, with no model and no memory tier — the same claim
 * the design makes for the feature.
 *
 *   npx tsx scripts/reveal-episode-check.mts --images a.png,b.png,c.png --pace slow --out /tmp/reveal-episode
 *
 * What it is NOT: an episode. There is no narration, so each scene's window is the `--window` given
 * here rather than a sentence boundary, and the concat is a plain stream copy rather than the
 * assembly's xfade chain. The numbers it prints are about pacing and image count; the assembly's
 * own timeline is pinned by its tests.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolveSceneReveals } from '../electron/server/lib/reveal-assembly.js'
import { renderRevealClip } from '../electron/server/lib/reveal-render.js'
import { isRevealPace, type RevealPace } from '../electron/server/lib/reveal-pacing.js'
import { listRevealPresets } from '../electron/server/services/style-effect-loader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = process.env.STORY_FFMPEG || path.join(ROOT, 'bundled', 'ffmpeg', 'ffmpeg')

interface Args {
  images: string[]
  out: string
  pace: RevealPace
  window: number
  seed: number
  width: number
  height: number
  fps: number
  crf: number
  coherence: 'scene' | 'act' | 'episode'
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : fallback
  }
  const raw = (get('images') || '').split(',').map(value => value.trim()).filter(Boolean)
  if (!raw.length) {
    console.error('usage: npx tsx scripts/reveal-episode-check.mts --images a.png[,b.png,…] '
      + '[--out /tmp/reveal-episode] [--pace slow] [--window 12] [--seed 7] [--width 1280] [--height 720] '
      + '[--fps 24] [--crf 20] [--coherence scene|act|episode]')
    process.exit(2)
  }
  const pace = get('pace', 'slow')!
  if (!isRevealPace(pace)) {
    console.error(`unknown pace "${pace}"; expected fast | standard | slow | documentary`)
    process.exit(2)
  }
  const coherence = get('coherence', 'scene')!
  if (!['scene', 'act', 'episode'].includes(coherence)) {
    console.error(`unknown coherence "${coherence}"; expected scene | act | episode`)
    process.exit(2)
  }
  return {
    images: raw,
    out: get('out', '/tmp/reveal-episode')!,
    pace,
    window: Number(get('window', '12')),
    seed: Number(get('seed', '7')),
    width: Number(get('width', '1280')),
    height: Number(get('height', '720')),
    fps: Number(get('fps', '24')),
    crf: Number(get('crf', '20')),
    coherence: coherence as Args['coherence'],
  }
}

async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}: ${stderr.slice(-400)}`))))
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await fs.mkdir(args.out, { recursive: true })

  const library = await listRevealPresets()
  const scenes = args.images.map((_image, index) => ({
    scene_id: `scene-${index + 1}`,
    scene_index: index,
    act_index: Math.floor(index / 4),
    // No narration here: the window is the stand-in, and it is the number the plan is resolved with.
    window_seconds: args.window,
  }))
  const plan = resolveSceneReveals({
    scenes,
    settings: { enabled: true, seed: args.seed, pace: args.pace, coherence: args.coherence },
    library,
  })

  const clips: Array<{ scene: number, preset: string, seconds: number, hold: number, reveal: number, file: string }> = []
  for (const scene of plan.scenes) {
    const image = args.images[scene.scene_index]!
    const file = path.join(args.out, `scene-${String(scene.scene_index + 1).padStart(2, '0')}.mp4`)
    const rendered = await renderRevealClip({
      imagePath: image,
      outPath: file,
      document: scene.document,
      pace: plan.pace,
      windowSeconds: scene.hold.total_seconds,
      width: args.width,
      height: args.height,
      fps: args.fps,
      crf: args.crf,
    })
    clips.push({
      scene: scene.scene_index + 1,
      preset: scene.preset_id,
      seconds: rendered.plan.total_seconds,
      reveal: rendered.plan.reveal_seconds,
      hold: rendered.plan.hold_seconds,
      file: path.basename(file),
    })
    process.stdout.write(`scene ${scene.scene_index + 1}/${plan.scenes.length}: ${scene.preset_id} `
      + `${rendered.plan.reveal_seconds.toFixed(1)}s + ${rendered.plan.hold_seconds.toFixed(1)}s\n`)
  }

  // Concat with a stream copy: every clip came out of the same encoder settings, which is the whole
  // reason `revealEncoderArgs` exists.
  const listFile = path.join(args.out, 'concat.txt')
  await fs.writeFile(listFile, clips.map(clip => `file '${clip.file}'`).join('\n') + '\n')
  const episode = path.join(args.out, `reveal-episode--${plan.pace}.mp4`)
  await run([FFMPEG, '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', episode])

  // One hold, sampled: a frozen frame is the failure this feature exists to avoid, so the receipt
  // carries the drift a person would see rather than a claim that it is there.
  const first = clips[0]!
  const sampleAt = (offset: number) => path.join(args.out, `hold-${offset.toFixed(1)}s.png`)
  const sampleTimes = [first.reveal + 0.4, first.reveal + (first.hold / 2), first.seconds - 0.4]
  for (const time of sampleTimes) {
    await run([FFMPEG, '-y', '-ss', String(time), '-i', path.join(args.out, first.file), '-frames:v', '1', sampleAt(time)])
  }

  const totalSeconds = clips.reduce((sum, clip) => sum + clip.seconds, 0)
  const receipt = {
    script: 'scripts/reveal-episode-check.mts',
    pace: plan.pace,
    coherence: plan.coherence,
    seed: plan.seed,
    window_seconds: args.window,
    canvas: { width: args.width, height: args.height, fps: args.fps, crf: args.crf },
    library_source: library.length ? `${library.length} preset(s)` : 'built-ins',
    scenes: clips,
    totals: {
      scenes: clips.length,
      seconds: Number(totalSeconds.toFixed(3)),
      seconds_per_image: Number((totalSeconds / clips.length).toFixed(3)),
      // What the same window would cost at the uniform 5 s/image the design compares against.
      uniform_five_second_images: Math.ceil(totalSeconds / 5),
      images_saved: Math.ceil(totalSeconds / 5) - clips.length,
    },
    hold_samples: sampleTimes.map(time => path.basename(sampleAt(time))),
    outputs: { episode: path.basename(episode), clips: clips.map(clip => clip.file) },
  }
  await fs.writeFile(path.join(args.out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`\n${clips.length} scenes, ${totalSeconds.toFixed(1)}s, `
    + `${(totalSeconds / clips.length).toFixed(1)}s per image\n`
    + `at 5s/image that window needs ${receipt.totals.uniform_five_second_images} images — `
    + `${receipt.totals.images_saved} fewer here\n${episode}`)
}

await main()
