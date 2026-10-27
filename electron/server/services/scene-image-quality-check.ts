/**
 * Free scene-image quality check (owner 2026-10-26).
 *
 * Uses the fleet's own vision model through the Gateway (free, never spends) to
 * score each generated scene image and record what is wrong with it. The model
 * is resolved from the live catalogue or a project preset — never hardcoded
 * (AGENTS.md §1).
 *
 * Phase 1 is a 2-week SHADOW mode (started 2026-10-27): findings are recorded
 * and shown to the owner, and nothing is changed. The auto-remake switch is
 * built now and OFF by default; once the owner turns it on, a failed check
 * remakes the image at most once.
 *
 * A failed or unavailable check never blocks generation and never reads as a
 * pass (§6): an unavailable model records `state: 'not_checked'`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { analyzeImage, listVisionModels } from '../lib/scene-vision-client.js'
import { SCENE_IMAGE_CHECK_SHADOW_UNTIL, sceneImageCheckShadowOver } from '../contracts/scene-image-check.js'
import type { ScenePlan } from '../models/types.js'

export type SceneImageCheckState = 'passed' | 'failed' | 'not_checked'

export interface SceneImageQualityCheckResult {
  state: SceneImageCheckState
  score?: number
  passed?: boolean
  findings: string[]
  /** What the free engine cannot measure. Named so "not found" never reads as "fine" (§6). */
  unmeasurable: string[]
  caption?: string
  model_id?: string
  model_name?: string
  checked_at: string
  shadow_mode: boolean
  remade: boolean
  reason?: string
}

export interface SceneImageCheckConfig {
  /** Master on/off switch for the check. Default ON. When off, nothing is queued or recorded. */
  enabled: boolean
  /** The auto-remake switch. OFF by default, and locked until shadow_until. */
  auto_remake: boolean
  shadow_until: string
  model?: string
}

export const DEFAULT_SCENE_IMAGE_CHECK_CONFIG: SceneImageCheckConfig = {
  enabled: true,
  auto_remake: false,
  shadow_until: SCENE_IMAGE_CHECK_SHADOW_UNTIL,
}

/** The project's settings, defaulted. Never cached past the read. */
export function sceneImageCheckConfig(config: unknown): SceneImageCheckConfig {
  const raw = (config as any)?.scene_image_check
  const until = typeof raw?.shadow_until === 'string' && Number.isFinite(Date.parse(raw.shadow_until))
    ? raw.shadow_until
    : SCENE_IMAGE_CHECK_SHADOW_UNTIL
  return {
    enabled: raw?.enabled !== false,
    auto_remake: raw?.auto_remake === true,
    shadow_until: until,
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
  }
}

/** Shadow mode is findings-only: either auto_remake is off, or we are still before shadow_until. */
export function sceneImageCheckShadowMode(cfg: SceneImageCheckConfig, now = Date.now()): boolean {
  return !cfg.auto_remake || !sceneImageCheckShadowOver(cfg.shadow_until, now)
}

export interface VisionCheckModelCandidate { id: string; display_name: string; available: boolean }

/** Test seam: replaces the live catalogue read. */
let catalogReader: (() => Promise<VisionCheckModelCandidate[]>) | null = null
export function _setVisionCheckCatalogForTesting(reader: (() => Promise<VisionCheckModelCandidate[]>) | null): void {
  catalogReader = reader
}
/** Test seam: replaces the vision evaluation. */
let evaluator: ((input: { imagePath: string; visualPrompt: string; modelId: string }) => Promise<{
  score: number; findings: string[]; caption?: string
}>) | null = null
export function _setVisionCheckEvaluatorForTesting(next: typeof evaluator): void { evaluator = next }

/** The fleet's vision models, from the live catalogue. */
export async function liveFleetVisionModels(): Promise<VisionCheckModelCandidate[]> {
  if (catalogReader) return catalogReader()
  const rows = await listVisionModels()
  return rows
    .filter(row => row.available !== false)
    .map(row => ({ id: row.id, display_name: row.display_name || row.id, available: true }))
}

/**
 * Which model runs the check. A model named by the project preset wins when the
 * live catalogue still offers it; otherwise the first available fleet model.
 * An empty answer means "no model to check with" — never a substitute.
 */
export async function resolveSceneImageCheckModel(
  modelOverride?: string,
  catalog?: VisionCheckModelCandidate[],
): Promise<{ id: string; display_name: string } | null> {
  let rows: VisionCheckModelCandidate[]
  try { rows = catalog ?? await liveFleetVisionModels() } catch { return null }
  if (!rows.length) return null
  if (modelOverride) {
    const named = rows.find(row => row.id === modelOverride)
    return named ? { id: named.id, display_name: named.display_name } : null
  }
  const first = rows[0]!
  return { id: first.id, display_name: first.display_name }
}

/** Words a describer would use for a figure; only then is "no subject" a finding. */
const FIGURE_WORDS = /\b(person|people|man|woman|boy|girl|child|children|character|figure|hero|heroine|king|queen|prince|princess|monk|villager|farmer|soldier|teacher|student|couple|face|portrait)\b/i
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'with', 'from', 'by', 'for', 'is', 'are', 'his', 'her', 'their', 'its', 'this', 'that'])

function contentWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9']+/).filter(word => word.length > 3 && !STOP_WORDS.has(word))
}

/**
 * The evaluation itself: one 640 px JPEG to the fleet's vision engine (the same
 * low-network shape the scene analysis uses), one request.
 */
async function evaluateWithFleet(input: { imagePath: string; visualPrompt: string; modelId: string }): Promise<{
  score: number; findings: string[]; caption?: string; unmeasurable: string[]
}> {
  if (evaluator) {
    const answer = await evaluator(input)
    return { ...answer, unmeasurable: [] }
  }
  const jpeg = await sharp(input.imagePath)
    .resize({ width: 640, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  const { answer } = await analyzeImage({
    tasks: ['subject'],
    image: { b64: jpeg.toString('base64'), mime: 'image/jpeg' },
    text: input.visualPrompt.slice(0, 500).trim() || 'the main subject',
    model: [input.modelId],
    priority: 'background',
  })
  const findings: string[] = []
  const unmeasurable: string[] = []
  let score = 90
  const caption = typeof answer.caption === 'string' ? answer.caption.trim() : ''
  const subject = answer.subject || null
  if (FIGURE_WORDS.test(input.visualPrompt)) {
    if (!subject) { findings.push('No person or figure was found, though the prompt asks for one.'); score -= 45 }
    else if (typeof subject.score === 'number' && subject.score < 0.5) {
      findings.push(`The main figure is hard to identify (confidence ${subject.score.toFixed(2)}).`)
      score -= 20
    }
  }
  if (!caption) {
    // No description means off-prompt cannot be judged. That is "not measured",
    // never a finding and never a pass (§6).
    unmeasurable.push('off-prompt (the model returned no description)')
  } else {
    const promptWords = contentWords(input.visualPrompt)
    const captionWords = new Set(contentWords(caption))
    if (promptWords.length && !promptWords.some(word => captionWords.has(word))) {
      findings.push(`The picture's description shares no key words with the prompt ("${caption.slice(0, 160)}").`)
      score -= 25
    }
  }
  return { score: Math.max(0, Math.min(100, score)), findings, caption: caption || undefined, unmeasurable }
}

/**
 * Run the free check for one scene image and record it beside the image and in
 * the scene plan. Never throws: a broken check is recorded as `not_checked`.
 */
export async function runSceneImageQualityCheck(input: {
  sceneId: string
  imagePath: string
  visualPrompt: string
  planPath?: string | null
  config?: unknown
  /** True when this image IS the automatic remake of an earlier failed check. */
  remade?: boolean
}): Promise<SceneImageQualityCheckResult> {
  const cfg = sceneImageCheckConfig(input.config)
  if (!cfg.enabled) {
    // When off, no check is queued and nothing is recorded.
    return {
      state: 'not_checked',
      passed: false,
      findings: [],
      unmeasurable: [],
      checked_at: new Date().toISOString(),
      shadow_mode: true,
      remade: false,
      reason: 'The free vision check is turned off in project settings.',
    }
  }

  const base = {
    checked_at: new Date().toISOString(),
    shadow_mode: sceneImageCheckShadowMode(cfg),
    remade: input.remade === true,
    unmeasurable: ['text legibility', 'anatomy (extra or missing limbs)'],
  }

  let model: Awaited<ReturnType<typeof resolveSceneImageCheckModel>> = null
  try {
    model = await resolveSceneImageCheckModel(cfg.model)
  } catch {
    model = null
  }
  const record = async (result: SceneImageQualityCheckResult): Promise<SceneImageQualityCheckResult> => {
    await recordSceneImageCheck(input.planPath, input.sceneId, input.imagePath, result).catch(() => undefined)
    return result
  }
  if (!model) {
    return record({
      ...base, state: 'not_checked', passed: false, findings: [],
      reason: 'No fleet vision model is available, so the picture was not checked.',
    })
  }

  let evaluated: { score: number; findings: string[]; caption?: string; unmeasurable: string[] }
  try {
    evaluated = await evaluateWithFleet({ imagePath: input.imagePath, visualPrompt: input.visualPrompt, modelId: model.id })
  } catch (error: any) {
    return record({
      ...base, state: 'not_checked', passed: false, findings: [],
      model_id: model.id, model_name: model.display_name,
      reason: `The vision check could not run (${error?.message || 'unknown error'}), so the picture was not checked.`,
    })
  }

  const passed = evaluated.findings.length === 0 && evaluated.score >= 70
  return record({
    ...base,
    state: passed ? 'passed' : 'failed',
    score: evaluated.score,
    passed,
    findings: evaluated.findings,
    unmeasurable: [...base.unmeasurable, ...evaluated.unmeasurable],
    caption: evaluated.caption,
    model_id: model.id,
    model_name: model.display_name,
  })
}

/** Write the verdict beside the image and onto the scene's plan entry, under the plan's lock. */
export async function recordSceneImageCheck(
  planPath: string | null | undefined,
  sceneId: string,
  imagePath: string,
  result: SceneImageQualityCheckResult,
): Promise<void> {
  const sidecar = path.join(path.dirname(imagePath), `${path.basename(imagePath, path.extname(imagePath))}.check.json`)
  await fs.writeFile(sidecar, JSON.stringify(result, null, 2), 'utf8').catch(() => undefined)
  if (!planPath) return
  await withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes?.find(item => item.id === sceneId)
    if (!scene) return
    ;(scene as any).image_check = result
    await writeJsonAtomic(planPath, plan, { compact: true })
  })
}

/** One line for the job log: what happened, and whether anything was changed. */
export function describeSceneImageCheck(result: SceneImageQualityCheckResult): string {
  const score = result.score != null ? ` (score ${result.score})` : ''
  const shadow = result.shadow_mode ? ' [shadow — nothing changed]' : ''
  if (result.state === 'not_checked') return `Image check: not checked — ${result.reason || 'no answer'}`
  if (result.state === 'passed') return `Image check: passed${score}${shadow}`
  const findings = result.findings.length ? ` — ${result.findings.join('; ')}` : ''
  return `Image check: failed${score}${findings}${result.remade ? ' [auto-remade once]' : ''}${shadow}`
}

/**
 * Shadow checks run AFTER the job, through a bounded in-process queue — the
 * same shape as scene analysis. A 300-scene run must not decode 300 JPEGs at
 * once on a small Mac, and must not delay the render it is checking.
 */
const BACKGROUND_CHECKS_MAX = 2
const backgroundChecks: Array<() => Promise<unknown>> = []
let backgroundChecksRunning = 0
export function queueSceneImageQualityCheck(input: Parameters<typeof runSceneImageQualityCheck>[0]): void {
  const cfg = sceneImageCheckConfig(input.config)
  if (!cfg.enabled) return
  backgroundChecks.push(() => runSceneImageQualityCheck(input))
  pumpBackgroundChecks()
}
function pumpBackgroundChecks(): void {
  while (backgroundChecksRunning < BACKGROUND_CHECKS_MAX && backgroundChecks.length) {
    const task = backgroundChecks.shift()!
    backgroundChecksRunning++
    void task().catch(() => undefined).finally(() => {
      backgroundChecksRunning--
      pumpBackgroundChecks()
    })
  }
}
/** Test seam: wait until every queued shadow check finished (or failed soft). */
export async function _drainSceneImageCheckQueueForTesting(): Promise<void> {
  while (backgroundChecksRunning || backgroundChecks.length) await new Promise(resolve => setTimeout(resolve, 5))
}

/**
 * Queue the ONE automatic remake for a failed check. The remake is the normal
 * per-scene generator with `image_check_remake: true`, so its own check records
 * the second verdict and will not queue a third. The dedupe is this scene's
 * remake only, so it cannot be confused with the scene's first render.
 */
export async function enqueueImageCheckRemake(input: {
  projectSlug: string
  episodeId: string
  sceneId: string
  title?: string
  params?: Record<string, any>
}): Promise<void> {
  const jq = await import('./job-queue.js')
  // At most once per scene, ever: a retry of the first render must not buy a
  // second remake after the first one already ran.
  const earlier = await jq.findJobs(input.projectSlug, (job: any) =>
    job.type === 'scene_image_generate'
    && job.episode_id === input.episodeId
    && job.params?.scene_id === input.sceneId
    && job.params?.image_check_remake === true)
  if (earlier.length) return
  const source = { ...(input.params || {}) }
  await jq.enqueue({
    project_slug: input.projectSlug,
    type: 'scene_image_generate',
    episode_id: input.episodeId,
    title: `${input.title || `Scene ${input.sceneId}`} — remake after image check`,
    dedupeParams: (params: any) => params?.scene_id === input.sceneId && params?.image_check_remake === true,
    params: {
      ...source,
      scene_id: input.sceneId,
      image_check_remake: true,
      generation_action: { id: `${input.sceneId}-image-check-remake`, kind: 'fresh' },
    },
  })
}
