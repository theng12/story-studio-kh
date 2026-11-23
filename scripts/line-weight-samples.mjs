#!/usr/bin/env node
/**
 * Render one frame of the Sketch Draw line reveal at each of the three weights, and MEASURE the
 * ink each one lays down, so the widths are a measured choice rather than a guessed constant.
 *
 * The measurement is the ink coverage: the share of pixels that differ from the source picture in
 * the drawing frame. Thin must be less ink than normal, and normal less than bold; a weight that
 * does not change the coverage is not a weight.
 *
 *   node scripts/line-weight-samples.mjs <out-dir>
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELPER = path.join(ROOT, 'bundled', 'scene-clip', 'scene-clip')
const OUT = path.resolve(process.argv[2] || path.join(os.homedir(), 'Developer/_orchestra/line-weight-374-samples'))

const W = 1920, H = 1080, FPS = 24, FRAMES = 24, HOLD = 6
const SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="620" fill="#8fb6d6"/>
  <rect y="620" width="${W}" height="460" fill="#8a6a45"/>
  <ellipse cx="980" cy="360" rx="230" ry="280" fill="#e8c39a"/>
  <rect x="760" y="600" width="440" height="480" fill="#3a5a8a"/>
  <circle cx="330" cy="220" r="140" fill="#f0d060"/>
  <rect x="1480" y="800" width="380" height="280" fill="#2f4a2f"/>
  <path d="M120 900 Q500 780 860 940 T1700 860" stroke="#6b4a2a" stroke-width="26" fill="none"/>
  <path d="M200 200 Q600 120 1000 240 T1800 160" stroke="#a8551f" stroke-width="18" fill="none"/>
</svg>`

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'line-weight-'))
  const source = path.join(work, 'source.png')
  await sharp(Buffer.from(SOURCE_SVG)).png().toFile(source)

  const measurements = []
  for (const weight of ['thin', 'normal', 'bold']) {
    const output = path.join(work, `${weight}.mp4`)
    const job = {
      kind: 'sketch', input: source, output, width: W, height: H, fps: FPS, frames: FRAMES,
      hold_frames: HOLD, paper: '#ffffff', pen: { mode: 'none' }, reveal: 'line', line_weight: weight, quality: 1,
    }
    const jobPath = path.join(work, `${weight}.job.json`)
    await fs.writeFile(jobPath, JSON.stringify(job))
    const run = spawnSync(HELPER, ['--job', jobPath], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`helper failed for ${weight}: ${run.stderr}`)

    // The ink is measured on PAPER, before the picture arrives: the `line` reveal lays the colour
    // in from u = 0.60, so an early frame is ink alone on white paper and every pixel that is not
    // paper is a pixel the pen covered.
    const frame = Math.round((FRAMES - HOLD) * 0.35)
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-vf', `select=eq(n\\,${frame})`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 })
    if (raw.status !== 0) throw new Error(`ffmpeg failed for ${weight}: ${raw.stderr}`)
    const drawn = raw.stdout

    // Ink coverage: the share of pixels that are not the white paper the drawing sits on.
    let inked = 0
    let sum = 0
    for (let i = 0; i < drawn.length; i++) {
      const d = 255 - drawn[i]
      sum += d
      if (d > 12) inked++
    }
    const pixels = W * H

    // The drawn WIDTH, measured: the horizontal runs of ink across the frame. Each run is one
    // stroke crossing that row, and its length in pixels is the width the pen left.
    const runs = []
    for (let y = 0; y < H; y++) {
      const row = y * W * 3
      let run = 0
      for (let x = 0; x < W; x++) {
        const ink = 255 - drawn[row + x * 3] > 12
        if (ink) run++
        else { if (run > 0) runs.push(run); run = 0 }
      }
      if (run > 0) runs.push(run)
    }
    runs.sort((a, b) => a - b)
    const median = runs.length ? runs[Math.floor(runs.length / 2)] : 0
    const p90 = runs.length ? runs[Math.floor(runs.length * 0.9)] : 0

    measurements.push({
      weight,
      ink_coverage_pct: +(100 * inked / (pixels * 3)).toFixed(2),
      mean_ink_darkness: +(sum / drawn.length).toFixed(2),
      stroke_runs: runs.length,
      stroke_width_median_px: median,
      stroke_width_p90_px: p90,
    })

    // One frame per weight, for the owner to look at.
    const still = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', output, '-vf', `select=eq(n\\,${frame})`,
      '-frames:v', '1', path.join(OUT, `${weight}.png`)], { encoding: 'utf8' })
    if (still.status !== 0) throw new Error(`ffmpeg still failed for ${weight}: ${still.stderr}`)
    await fs.copyFile(output, path.join(OUT, `${weight}.mp4`))
    console.log(`${weight}: ${measurements.at(-1).ink_coverage_pct}% of the picture covered by ink`)
  }

  // A side-by-side of the three frames, so the difference is visible at a glance.
  const panelWidth = Math.round(W / 3)
  const panels = await Promise.all(['thin', 'normal', 'bold'].map(async (weight, index) => ({
    input: await sharp(path.join(OUT, `${weight}.png`)).resize(panelWidth, H).png().toBuffer(),
    top: 0, left: index * panelWidth,
  })))
  await sharp({ create: { width: panelWidth * 3, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(panels.map(panel => ({ ...panel, blend: 'over' })))
    .png().toFile(path.join(OUT, 'all-three.png'))

  await fs.writeFile(path.join(OUT, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  console.log(JSON.stringify(measurements, null, 2))
  await fs.rm(work, { recursive: true, force: true })
}

main().catch(error => { console.error(error); process.exit(1) })
