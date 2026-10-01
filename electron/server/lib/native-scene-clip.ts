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

import { spawn } from 'node:child_process'
import { existsSync, accessSync, constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SceneMotionDocument } from '../contracts/scene-effects.js'
import { planStillMotion, type MotionPlan } from './scene-motion-plan.js'
import { appendCappedTail } from './ffmpeg-utils.js'
import { trackChild } from '../services/job-queue.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Bump with a helper change that alters its output; part of the render fingerprint. */
export const NATIVE_SCENE_CLIP_VERSION = 1

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
  if (resources && typeof resources === 'string') candidates.push(path.join(resources, 'scene-clip', 'scene-clip'))
  candidates.push(path.join(REPO_ROOT, 'bundled', 'scene-clip', 'scene-clip'))
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

async function runHelper(helper: string, jobPath: string, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const proc = spawn(helper, ['--job', jobPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    trackChild(proc)
    let stderr = ''
    let timedOut = false
    proc.stderr.on('data', (chunk: Buffer) => { stderr = appendCappedTail(stderr, chunk.toString(), 16 * 1024) })
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5000).unref()
    }, timeoutMs)
    proc.on('error', error => { clearTimeout(timer); resolve({ code: null, stderr: `spawn failed: ${error.message}` }) })
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? null : code, stderr: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (signal ? `killed (${signal})` : stderr) })
    })
  })
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
