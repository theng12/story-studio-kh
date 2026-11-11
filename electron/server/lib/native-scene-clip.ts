/**
 * Native scene-clip renderer — the fast path for a still-image scene clip.
 *
 * `native/scene-clip` is a small Swift helper bundled with the app: Metal does the camera move,
 * VideoToolbox (the media engine) does the encode. For a 7-second scene that is about 1 CPU-second
 * where the FFmpeg `zoompan` chain costs 30-45. This module is everything the Node side needs to
 * use it safely:
 *
 *   - find the helper (bundled resource, dev build, test override) and prove it runs;
 *   - turn a motion document into a job (`scene-motion-plan.ts` does the maths);
 *   - run it under the job's cancellation tracking, with a watchdog;
 *   - say, in one typed result, why a scene was NOT rendered natively so the caller can log it and
 *     render that scene with FFmpeg instead.
 *
 * It never throws for "this scene can't use the helper". Fallback is per clip and automatic: any
 * unsupported effect, missing binary, helper failure or output that fails the caller's validation
 * lands on the FFmpeg path the app has always used.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, accessSync, constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SceneMotionDocument } from '../contracts/scene-effects.js'
import { planStillMotion, type MotionPlan } from './scene-motion-plan.js'
import { appendCappedTail } from './ffmpeg-utils.js'
import { trackChild } from '../services/job-queue.js'
import { NATIVE_SCENE_CLIP_VERSION, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS } from './native-scene-clip-version.js'
import { SKETCH_REVEAL_TYPES, type SketchRevealType } from './sketch-reveal.js'
import { SKETCH_LINE_WEIGHTS, type SketchLineWeight } from './sketch-line-weight.js'
export { NATIVE_SCENE_CLIP_VERSION, SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS }
// One definition, in a dependency-free module the freshness rule can import; mirrors the helper's default.
export { sketchDefaultHoldFrames } from './sketch-hold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Bump with a helper change that alters its output; part of the render fingerprint. */

/**
 * VideoToolbox quality (0-1) for clips that the xfade stage will decode and re-encode. High enough
 * that the second generation's CRF-23 encode, not this one, sets the look; measured at 0.70 against
 * FFmpeg's own clips (see `docs/render-local.md`).
 */
export const NATIVE_CLIP_QUALITY = 0.7

const HELPER_TIMEOUT_MS = 10 * 60_000

// ── Locating the helper ─────────────────────────────────────────────────────

export function nativeSceneClipDisabledByEnv(): boolean {
  return /^(0|false|off|no)$/i.test(process.env.STORY_STUDIO_NATIVE_SCENE_CLIP || '')
}

export function resolveSceneClipHelperPath(): string | null {
  const candidates: string[] = []
  if (process.env.STORY_STUDIO_SCENE_CLIP_BIN) candidates.push(process.env.STORY_STUDIO_SCENE_CLIP_BIN)
  const resources = process.env.STORY_STUDIO_RESOURCES_DIR || process.resourcesPath
  // One bundle, one visible name: the render helper is the same "Story Studio KH Helper"
  // executable name inside the signed helper app (owner naming rule, 2026-11-11).
  if (resources && typeof resources === 'string') {
    candidates.push(path.join(resources, 'Story Studio KH Helper.app', 'Contents', 'Resources', 'Story Studio KH Helper'))
  }
  candidates.push(path.join(REPO_ROOT, 'bundled', 'Story Studio KH Helper.app', 'Contents', 'Resources', 'Story Studio KH Helper'))
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch { /* try the next */ }
  }
  return null
}

interface HelperProbe { available: boolean; path: string | null; reason?: string }
let probeCache: Promise<HelperProbe> | null = null

/** Test seam: forget the cached probe. */
export function resetNativeSceneClipProbe(): void { probeCache = null }

/**
 * Whether the helper can be used on this Mac, decided once per process: right platform, binary
 * present, and it actually runs (a quarantined or wrong-arch binary fails here, not mid-episode).
 */
export function probeNativeSceneClip(): Promise<HelperProbe> {
  if (!probeCache) probeCache = doProbe()
  return probeCache
}

async function doProbe(): Promise<HelperProbe> {
  if (nativeSceneClipDisabledByEnv()) return { available: false, path: null, reason: 'disabled by STORY_STUDIO_NATIVE_SCENE_CLIP' }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return { available: false, path: null, reason: `not supported on ${process.platform}/${process.arch}` }
  }
  const helper = resolveSceneClipHelperPath()
  if (!helper) return { available: false, path: null, reason: 'helper binary not found' }
  const out = await new Promise<{ code: number | null; stdout: string }>(resolve => {
    try {
      const proc = spawn(helper, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.on('error', () => resolve({ code: null, stdout }))
      proc.on('close', code => resolve({ code, stdout }))
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 10_000).unref()
    } catch { resolve({ code: null, stdout: '' }) }
  })
  const match = out.stdout.match(/^scene-clip (\d+)/)
  if (out.code !== 0 || !match) return { available: false, path: helper, reason: 'helper did not start' }
  if (Number(match[1]) !== NATIVE_SCENE_CLIP_VERSION) {
    return { available: false, path: helper, reason: `helper version ${match[1]} does not match app (${NATIVE_SCENE_CLIP_VERSION})` }
  }
  return { available: true, path: helper }
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface NativeSceneClipRequest {
  imagePath: string
  outPath: string
  /** The resolved motion document (after legacy parameters were folded in). */
  document: SceneMotionDocument
  w: number
  h: number
  fps: number
  /** Clip length in seconds: the same number the FFmpeg chain is given. */
  duration: number
  quality?: number
  /** Where the job description is written; defaults beside the output. */
  jobPath?: string
  timeoutMs?: number
  /** Test seam: replaces the process spawn. Resolves the helper's exit code and stderr. */
  run?: (helperPath: string, jobPath: string) => Promise<{ code: number | null; stderr: string }>
}

export type NativeSceneClipResult =
  | { rendered: true; kind: 'camera' | 'spin' | 'static'; frames: number }
  | { rendered: false; reason: 'unsupported' | 'failed'; detail: string }

/**
 * The job the helper reads. Exported so tests can pin the contract with the Swift side.
 */
export function buildSceneClipJob(req: NativeSceneClipRequest, plan: Extract<MotionPlan, { supported: true }>) {
  return {
    input: req.imagePath,
    output: req.outPath,
    width: req.w,
    height: req.h,
    fps: req.fps,
    prepWidth: plan.prepared.w,
    prepHeight: plan.prepared.h,
    resample: plan.kind === 'camera' ? 'lanczos' : 'bilinear',
    matrix: 'bt709',
    quality: req.quality ?? NATIVE_CLIP_QUALITY,
    frames: plan.frames,
  }
}

interface HelperRunOptions { signal?: AbortSignal; trackChild?: (child: ChildProcess) => void }

async function runHelper(helper: string, jobPath: string, timeoutMs: number, options: HelperRunOptions = {}): Promise<{ code: number | null; stderr: string }> {
  if (options.signal?.aborted) return { code: null, stderr: 'cancelled' }
  return new Promise(resolve => {
    const proc = spawn(helper, ['--job', jobPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    trackChild(proc)
    options.trackChild?.(proc)
    let stderr = ''
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      try { proc.kill('SIGTERM') } catch { /* gone */ }
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5000)
      killTimer.unref()
    }
    const cancelled = () => stop()
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted) stop()
    proc.stderr.on('data', (chunk: Buffer) => { stderr = appendCappedTail(stderr, chunk.toString(), 16 * 1024) })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', cancelled)
    }
    proc.on('error', error => { cleanup(); resolve({ code: null, stderr: `spawn failed: ${error.message}` }) })
    proc.on('close', (code, signal) => {
      cleanup()
      resolve({ code: timedOut ? null : code, stderr: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (signal ? `killed (${signal})` : stderr) })
    })
  })
}

/** Sketch has no FFmpeg fallback: an unavailable local helper is a visible job failure. */
export type SketchDrawPen =
  | { mode: 'none' | 'plain' }
  | { mode: 'name'; text: string }
  | { mode: 'logo'; logo: string }

export interface SketchDrawJob {
  kind: 'sketch'
  input: string
  output: string
  width: number
  height: number
  fps: number
  frames: number
  /** Exact closing hold. Omit for the default; see sketchDefaultHoldFrames. */
  hold_frames?: number
  paper: string
  pen: SketchDrawPen
  /**
   * The reveal style this scene resolved to. The app resolves a Mix per scene and passes the
   * ANSWER; the helper never sees the mix set, so a re-render cannot drift from freshness.
   */
  reveal: SketchRevealType
  /**
   * The ink weight this scene is drawn with. Omit for NORMAL, the engine's own weight — a job with
   * no weight draws exactly as it always has.
   */
  line_weight?: SketchLineWeight
  quality?: number
  /**
   * This scene's own depth map (an 8-bit greyscale image), used only by the `colour` reveal to
   * paint the subject before the background. It is an input, not a gate: the generator omits it
   * when the scene has no usable analysis, and the helper then colours in one phase rather than
   * inventing a subject.
   */
  mask?: string
}

export class SketchDrawError extends Error {
  constructor(public readonly code: 'bad_job' | 'unsupported' | 'failed' | 'cancelled', detail: string) {
    super(`Sketch Draw: ${detail}`)
    this.name = 'SketchDrawError'
  }
}

/** Keep the trust boundary in sync with SketchJob's native validation. */
export function validateSketchDrawJob(job: SketchDrawJob): void {
  const invalid = (detail: string): never => { throw new SketchDrawError('bad_job', detail) }
  if (!job || job.kind !== 'sketch') invalid('kind must be sketch')
  for (const [key, value] of [['width', job.width], ['height', job.height]] as const) {
    if (!Number.isInteger(value) || value < 2 || value > 4096 || value % 2) invalid(`${key} must be even, 2–4096 pixels`)
  }
  if (!Number.isInteger(job.fps) || job.fps < 1 || job.fps > 120) invalid('fps must be an integer, 1–120')
  if (!Number.isInteger(job.frames) || job.frames < 1 || job.frames > 1_000_000) invalid('frames must be an integer, 1–1000000')
  if (job.hold_frames !== undefined && (!Number.isInteger(job.hold_frames) || (job.frames < 3 ? job.hold_frames !== job.frames : job.hold_frames < 1 || job.hold_frames > job.frames - 2))) {
    invalid('hold_frames must be 1 to frames-2 (or frames when frames < 3)')
  }
  if (typeof job.input !== 'string' || typeof job.output !== 'string' || !path.isAbsolute(job.input) || !path.isAbsolute(job.output) || path.resolve(job.input) === path.resolve(job.output)) invalid('input and output must be different absolute paths')
  if (typeof job.paper !== 'string' || !/^#[a-f\d]{6}$/i.test(job.paper)) invalid('paper must be a six-digit hex colour')
  if (typeof job.reveal !== 'string' || !(SKETCH_REVEAL_TYPES as readonly string[]).includes(job.reveal)) invalid(`reveal must be one of ${SKETCH_REVEAL_TYPES.join(', ')}`)
  if (job.line_weight !== undefined && !(SKETCH_LINE_WEIGHTS as readonly string[]).includes(job.line_weight)) invalid('line_weight must be one of thin, normal, bold')
  if (job.mask !== undefined && (typeof job.mask !== 'string' || !path.isAbsolute(job.mask))) invalid('mask must be an absolute path')
  if (job.quality !== undefined && (!Number.isFinite(job.quality) || job.quality < 0 || job.quality > 1)) invalid('quality must be 0–1')
  const pen = job.pen
  if (!pen || !['none', 'plain', 'name', 'logo'].includes(pen.mode)) invalid('unknown pen mode')
  if (pen.mode === 'name' && (typeof pen.text !== 'string' || !pen.text.trim() || [...pen.text].length > 256)) invalid('pen name must contain 1–256 characters')
  if (pen.mode === 'logo' && (typeof pen.logo !== 'string' || !path.isAbsolute(pen.logo))) invalid('pen logo must be an absolute path')
}

export interface SketchDrawOptions extends HelperRunOptions {
  timeoutMs?: number
  jobPath?: string
  /** Same process/probe seams used by the camera helper's tests. */
  run?: (helperPath: string, jobPath: string) => Promise<{ code: number | null; stderr: string }>
  probe?: () => Promise<HelperProbe>
}

/** The caller owns a new temporary output and verifies the media before accepting it. */
export async function renderSketchDraw(job: SketchDrawJob, options: SketchDrawOptions = {}): Promise<{ rendered: true; kind: 'sketch'; frames: number }> {
  validateSketchDrawJob(job)
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new SketchDrawError('cancelled', 'render cancelled; Retry renders this scene again')
  }
  checkCancelled()
  const probe = options.run ? { available: true, path: 'injected' } : await (options.probe ?? probeNativeSceneClip)()
  checkCancelled()
  if (!probe.available || !probe.path) throw new SketchDrawError('unsupported', `${probe.reason || 'native helper unavailable'}. Install the current app and Retry`)
  const jobPath = options.jobPath ?? `${job.output}.${randomUUID()}.job.json`
  let created = false
  try {
    checkCancelled()
    if (await fs.stat(job.output).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error })) {
      throw new SketchDrawError('bad_job', 'output already exists; use a new temporary path')
    }
    await fs.writeFile(jobPath, JSON.stringify({ ...job, quality: job.quality ?? NATIVE_CLIP_QUALITY }), { flag: 'wx' })
    created = true
    checkCancelled()
    const result = options.run ? await options.run(probe.path, jobPath) : await runHelper(probe.path, jobPath, options.timeoutMs ?? HELPER_TIMEOUT_MS, options)
    checkCancelled()
    if (result.code !== 0) {
      const code = result.code === 2 ? 'bad_job' : result.code === 3 ? 'unsupported' : 'failed'
      throw new SketchDrawError(code, `helper exit ${result.code}: ${result.stderr.trim().split('\n').slice(-2).join(' | ') || 'no output'}. Retry renders this scene again`)
    }
    const output = await fs.stat(job.output).catch(() => null)
    if (!output?.isFile() || output.size === 0) throw new SketchDrawError('failed', 'helper returned without a nonempty clip. Retry renders this scene again')
    return { rendered: true, kind: 'sketch', frames: job.frames }
  } catch (error) {
    if (error instanceof SketchDrawError) throw error
    throw new SketchDrawError('failed', `${error instanceof Error ? error.message : String(error)}. Retry renders this scene again`)
  } finally {
    if (created) await fs.unlink(jobPath).catch(() => {})
  }
}

export async function renderNativeSceneClip(req: NativeSceneClipRequest): Promise<NativeSceneClipResult> {
  const plan = planStillMotion(req.document, { w: req.w, h: req.h, fps: req.fps, duration: req.duration })
  if (!plan.supported) return { rendered: false, reason: 'unsupported', detail: plan.reason }
  if (req.w % 2 || req.h % 2) return { rendered: false, reason: 'unsupported', detail: `odd frame size ${req.w}x${req.h}` }

  let helper: string
  if (req.run) {
    helper = 'injected'
  } else {
    const probe = await probeNativeSceneClip()
    if (!probe.available || !probe.path) return { rendered: false, reason: 'unsupported', detail: probe.reason || 'helper unavailable' }
    helper = probe.path
  }

  const jobPath = req.jobPath ?? `${req.outPath}.job.json`
  try {
    await fs.writeFile(jobPath, JSON.stringify(buildSceneClipJob(req, plan)))
    const result = req.run
      ? await req.run(helper, jobPath)
      : await runHelper(helper, jobPath, req.timeoutMs ?? HELPER_TIMEOUT_MS)
    if (result.code === 0) return { rendered: true, kind: plan.kind, frames: plan.frames.length }
    // Exit 3 is the helper declining the picture (alpha, odd colour model...): a normal fallback, not a fault.
    const reason = result.code === 3 ? 'unsupported' : 'failed'
    return { rendered: false, reason, detail: `exit ${result.code}: ${result.stderr.trim().split('\n').slice(-2).join(' | ') || 'no output'}` }
  } catch (error: any) {
    return { rendered: false, reason: 'failed', detail: error?.message || String(error) }
  } finally {
    await fs.unlink(jobPath).catch(() => {})
  }
}
