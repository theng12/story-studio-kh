import { Router } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getUserDataDir } from '../services/project-manager.js'
import { NATIVE_SCENE_CLIP_VERSION, renderSketchDraw, type SketchDrawJob } from '../lib/native-scene-clip.js'
import { SKETCH_REVEAL_LABELS, SKETCH_REVEAL_TYPES, type SketchRevealType } from '../lib/sketch-reveal.js'
import { SKETCH_LINE_WEIGHTS, type SketchLineWeight } from '../lib/sketch-line-weight.js'

export const router = Router()

const sampleDirs = [
  path.join(process.resourcesPath || '/nonexistent', 'effects-gallery'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'electron', 'server', 'effects-gallery'),
]
const pending = new Map<string, Promise<string>>()
let queue = Promise.resolve()

/** Generate one short native clip per choice, with concurrent requests sharing the work. */
export async function sketchRevealSample(options: {
  reveal: SketchRevealType
  weight: SketchLineWeight
  cacheDir: string
  image: string
  render?: (job: SketchDrawJob) => Promise<unknown>
  helperVersion?: number
}): Promise<string> {
  const { reveal, weight, cacheDir, image } = options
  if (!(SKETCH_REVEAL_TYPES as readonly string[]).includes(reveal) || !(SKETCH_LINE_WEIGHTS as readonly string[]).includes(weight)) throw new Error('Unknown reveal or line weight')
  const imageHash = createHash('sha256').update(await fs.readFile(image)).digest('hex')
  const key = createHash('sha256').update(JSON.stringify([reveal, weight, options.helperVersion ?? NATIVE_SCENE_CLIP_VERSION, imageHash, 'sample-v1'])).digest('hex')
  const target = path.join(cacheDir, `${key}.mp4`)
  if ((await fs.stat(target).catch(() => null))?.size) return target
  const existing = pending.get(target)
  if (existing) return existing
  const task = queue.then(async () => {
    if ((await fs.stat(target).catch(() => null))?.size) return target
    await fs.mkdir(cacheDir, { recursive: true })
    const temporary = path.join(cacheDir, `${key}-${randomUUID()}.mp4`)
    try {
      const job: SketchDrawJob = { kind: 'sketch', input: image, output: temporary, width: 320, height: 180, fps: 15, frames: 60, hold_frames: 8, paper: '#ffffff', pen: { mode: 'none' }, reveal, line_weight: weight }
      await (options.render ?? renderSketchDraw)(job)
      if (!(await fs.stat(temporary).catch(() => null))?.size) throw new Error('The sample render produced no video')
      await fs.rename(temporary, target)
      return target
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  })
  queue = task.then(() => {}, () => {})
  pending.set(target, task)
  try { return await task } finally { pending.delete(target) }
}

router.get('/sketch-reveals', (_req, res) => {
  res.json({ reveals: SKETCH_REVEAL_TYPES.map(id => ({ id, label: SKETCH_REVEAL_LABELS[id] })) })
})

router.get('/sketch-reveals/:reveal/sample', async (req, res) => {
  const reveal = req.params.reveal
  const weight = req.query.weight
  if (!(SKETCH_REVEAL_TYPES as readonly string[]).includes(reveal) || typeof weight !== 'string' || !(SKETCH_LINE_WEIGHTS as readonly string[]).includes(weight)) {
    res.status(400).json({ detail: 'Unknown reveal or line weight.' })
    return
  }
  const image = sampleDirs.map(dir => path.join(dir, 'sample-river.jpg')).find(existsSync)
  if (!image) { res.status(503).json({ detail: 'The sample image is unavailable.' }); return }
  try {
    const file = await sketchRevealSample({ reveal: reveal as SketchRevealType, weight: weight as SketchLineWeight, image, cacheDir: path.join(getUserDataDir(), 'sketch-reveal-samples') })
    res.set('Cache-Control', 'no-cache')
    res.set('Content-Type', 'video/mp4')
    res.send(await fs.readFile(file))
  } catch (error) {
    res.status(503).json({ detail: error instanceof Error ? error.message : 'Could not render the sample.' })
  }
})
