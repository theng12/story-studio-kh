/**
 * Render reveal previews — one clip per (preset, pace) on a real image.
 *
 * The design's verification is "render one scene per family per pace setting on
 * a real episode's images — and look at them". This is the tool that does it,
 * and it is deliberately a *script*, not a test: what it produces is judged by
 * eye, and a test that asserted "the wipe looks right" would only be asserting
 * that the filter string did not change.
 *
 * ```sh
 * npx tsx scripts/reveal-preview.mts --image /path/scene.png --out /tmp/reveals --pace all
 * ```
 *
 * It writes one MP4 per combination plus `receipt.json`, which records the plan
 * each clip was rendered from — reveal, hold, micro-event offsets — and the
 * exact FFmpeg argument list. That receipt is what makes a look reproducible
 * later: the same seed and the same plan give the same clip.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_SCENE_REVEALS } from '../electron/server/contracts/scene-reveal-presets.js'
import { REVEAL_PACES, planSceneHold } from '../electron/server/lib/reveal-pacing.js'
import { renderRevealClip } from '../electron/server/lib/reveal-render.js'
import { compileSceneReveal } from '../electron/server/lib/reveal-compiler.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FFMPEG = path.join(ROOT, 'bundled', 'ffmpeg', 'ffmpeg')
const FFPROBE = path.join(ROOT, 'bundled', 'ffmpeg', 'ffprobe')

interface Args {
  image: string
  out: string
  family: string
  pace: string
  preset: string
  width: number
  height: number
  fps: number
  narration: number
  window: number
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : fallback
  }
  const image = get('image')
  if (!image) {
    console.error('usage: npx tsx scripts/reveal-preview.mts --image <png> --out <dir> '
      + '[--family geometric|palette|draw-on|all] [--pace fast|standard|slow|documentary|all] '
      + '[--preset <id>] [--width 1280] [--height 720] [--fps 24] [--narration 6] [--window 12]')
    process.exit(2)
  }
  return {
    image,
    out: get('out', '/tmp/reveal-previews')!,
    family: get('family', 'all')!,
    pace: get('pace', 'all')!,
    preset: get('preset', '')!,
    width: Number(get('width', '1280')),
    height: Number(get('height', '720')),
    fps: Number(get('fps', '24')),
    narration: Number(get('narration', '6')),
    window: Number(get('window', '12')),
  }
}

/** The bundled FFmpeg, spawned directly: the app's manager wants an app context. */
function runFfmpegDirect(args: string[], options: { timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    const timer = options.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, options.timeoutMs)
      : null
    child.on('error', error => { if (timer) clearTimeout(timer); reject(error) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}\n${stderr}`))
    })
  })
}

function probe(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', reject)
    child.on('close', () => {
      try { resolve(JSON.parse(out)) } catch (error) { reject(error) }
    })
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await fs.mkdir(args.out, { recursive: true })

  const presets = BUILT_IN_SCENE_REVEALS.filter(preset => (
    (args.preset ? preset.id === args.preset : true)
    && (args.family === 'all' ? true : preset.family === args.family)
  ))
  const paces = REVEAL_PACES.filter(pace => args.pace === 'all' || pace === args.pace)
  if (!presets.length || !paces.length) {
    console.error(`nothing to render: ${presets.length} preset(s), ${paces.length} pace(s)`)
    process.exit(2)
  }

  const receipt: any[] = []
  console.log(`image   ${args.image}`)
  console.log(`canvas  ${args.width}x${args.height} @ ${args.fps}fps, window ${args.window}s, `
    + `narration ${args.narration}s`)
  console.log('')

  for (const preset of presets) {
    for (const pace of paces) {
      const name = `${preset.id}--${pace}.mp4`
      const outPath = path.join(args.out, name)
      const started = Date.now()
      const rendered = await renderRevealClip({
        imagePath: args.image,
        outPath,
        document: preset.document,
        pace,
        windowSeconds: args.window,
        narrationSeconds: args.narration,
        width: args.width,
        height: args.height,
        fps: args.fps,
        run: runFfmpegDirect,
      })
      const facts = await probe(outPath)
      const video = facts.streams.find((stream: any) => stream.codec_type === 'video')
      const seconds = Number(facts.format?.duration ?? 0)
      const size = Number(facts.format?.size ?? 0)
      console.log(
        `${preset.id.padEnd(22)} ${pace.padEnd(12)} `
        + `reveal ${rendered.plan.reveal_seconds.toFixed(2)}s hold ${rendered.plan.hold_seconds.toFixed(2)}s `
        + `events [${rendered.plan.micro_event_offsets.map(value => value.toFixed(1)).join(', ')}] `
        + `-> ${seconds.toFixed(2)}s ${video?.width}x${video?.height} ${(size / 1024).toFixed(0)}KB `
        + `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
      )
      receipt.push({
        preset: preset.id,
        family: preset.family,
        pace,
        output: name,
        plan: rendered.plan,
        document: preset.document,
        duration_seconds: seconds,
        width: video?.width,
        height: video?.height,
        bytes: size,
        filters: rendered.compiled.filters,
        ffmpeg_args: rendered.args,
      })
    }
  }

  await fs.writeFile(path.join(args.out, 'receipt.json'), JSON.stringify({
    image: args.image,
    canvas: { width: args.width, height: args.height, fps: args.fps },
    window_seconds: args.window,
    narration_seconds: args.narration,
    clips: receipt,
  }, null, 2) + '\n')
  console.log(`\nreceipt: ${path.join(args.out, 'receipt.json')}`)
}

/**
 * A contact sheet of one clip: five moments from the arrival to the end of the
 * hold, left to right, so a whole look is reviewable in one image.
 */
async function contactSheet(clip: string, out: string, seconds: number): Promise<void> {
  const fps = 24
  const frames = [0.06, 0.3, 0.55, 0.8, 0.96].map(fraction => Math.round(seconds * fraction * fps))
  // ONE `select` with an `or`-ed expression: chaining five selects with `+`
  // parses as a single broken expression, which is how this first failed.
  const expression = frames.map(frame => `eq(n,${frame})`).join('+')
  await runFfmpegDirect([
    '-y', '-i', clip,
    '-vf', `select='${expression}',scale=460:-1,tile=5x1`,
    '-frames:v', '1', out,
  ])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(async () => {
    // Contact sheets are what make the clips reviewable in one screen: five
    // frames from each, left to right, reveal to hold.
    const args = parseArgs(process.argv.slice(2))
    try {
      const entries = await fs.readdir(args.out)
      for (const entry of entries.filter(name => name.endsWith('.mp4'))) {
        const clip = path.join(args.out, entry)
        const facts = await probe(clip)
        const sheet = path.join(args.out, `${entry.replace(/\.mp4$/, '')}--sheet.png`)
        await contactSheet(clip, sheet, Number(facts.format?.duration ?? 8))
      }
      console.log(`contact sheets written beside each clip`)
    } catch (error) {
      console.error(`contact sheets skipped: ${(error as Error).message}`)
    }
  }).catch(error => {
    console.error(error)
    process.exit(1)
  })
}

export { compileSceneReveal, planSceneHold }
