/**
 * The OPT-IN stronger scene-image check (owner 2026-10-27).
 *
 * One vision-capable chat product from the live Gateway catalogue is asked,
 * with a fixed rubric, about three axes: anatomy, face, and text. Its findings
 * are recorded BESIDE the free Florence check — never instead of it — and in
 * shadow mode nothing is changed.
 *
 * Rules it must keep:
 * - **The model is a live catalogue choice** (§1): only rows the catalogue
 *   publishes image input for, resolved on every run. No fallback model, no
 *   remembered limits; a model that has left the catalogue records
 *   `not_checked` by name.
 * - **Provider is display, never dispatch** (§2): the provider is read from the
 *   catalogue and recorded with the finding so a person can see who looked at
 *   the picture. It is never used to choose or route.
 * - **Four verdicts stay four verdicts** (§6): `pass`, `fail`, `not_visible`
 *   and `could_not_check` per axis, and `not_checked` for the whole check when
 *   no call happened. Nothing here ever turns "I could not tell" into a pass.
 * - **Auto-remake is per axis, OFF by default, and locked** until the existing
 *   shadow window ends. The owner turns these on one at a time.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import {
  callChatWithGenStudio,
  chatImageEligibility,
  listChatModels,
  type GenStudioChatModel,
} from '../lib/genstudio-client.js'
import {
  SCENE_IMAGE_CHECK_SHADOW_UNTIL,
  SCENE_VISION_AXES,
  sceneImageCheckShadowOver,
  compareExpectedText,
  parseSceneVisionAnswer,
  sceneVisionSystemPrompt,
  sceneVisionUserPrompt,
  type SceneVisionAnswer,
  type SceneVisionAxis,
  type SceneVisionAxisResult,
} from '../contracts/scene-image-check.js'
import { JSON_OBJECT_OUTPUT_CONTRACT, PROSE_OUTPUT_CONTRACT } from '../lib/json-output-contract.js'
import { getApiKey } from './app-secrets-store.js'
import type { ScenePlan } from '../models/types.js'

/** The picture sent to the model: the same low-network shape the free check uses. */
const VISION_IMAGE_WIDTH = 640
const VISION_IMAGE_QUALITY = 80

export type SceneVisionCheckState = 'checked' | 'not_checked'

export interface SceneVisionCheckResult {
  state: SceneVisionCheckState
  /** All three axes, always — a missing axis must not look like silence. */
  axes: Record<SceneVisionAxis, SceneVisionAxisResult>
  /** Flattened for the badge and the job log; the axes keep their own lists. */
  findings: string[]
  confidence: number | null
  model_id?: string
  model_name?: string
  /** The provider the catalogue publishes for that row, shown where it is published (§2). */
  provider_name?: string
  /** The string the text layer was drawn from, when Story knew it. */
  expected_text?: string
  checked_at: string
  shadow_mode: boolean
  /** True when this picture IS the automatic remake of an earlier failed axis. */
  remade: boolean
  reason?: string
}

export interface SceneImageVisionConfig {
  /** The opt-in switch. OFF by default. */
  enabled: boolean
  /** The chosen catalogue row, by id. Absent means nothing is selected. */
  model?: string
  /** Per-axis auto-remake. All OFF by default, and locked until shadow_until. */
  auto_remake: Record<SceneVisionAxis, boolean>
}

/** The channel's settings, defaulted. Never cached past the read (§1). */
export function sceneImageVisionConfig(config: unknown): SceneImageVisionConfig {
  const raw = (config as any)?.scene_image_check?.vision
  const auto = raw?.auto_remake && typeof raw.auto_remake === 'object' ? raw.auto_remake : {}
  return {
    enabled: raw?.enabled === true,
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    auto_remake: {
      anatomy: auto.anatomy === true,
      face: auto.face === true,
      text: auto.text === true,
    },
  }
}

/** The shadow end date is the free check's — one window for both, so they cannot drift apart. */
export function sceneImageVisionShadowUntil(config: unknown): string {
  const raw = (config as any)?.scene_image_check?.shadow_until
  return typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? raw : SCENE_IMAGE_CHECK_SHADOW_UNTIL
}

/** Shadow mode is findings-only: nothing is remade while the window is open. */
export function sceneImageVisionShadowMode(config: unknown, now = Date.now()): boolean {
  return !sceneImageCheckShadowOver(sceneImageVisionShadowUntil(config), now)
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Replaces the live catalogue read. */
let catalogReader: (() => Promise<GenStudioChatModel[]>) | null = null
export function _setSceneVisionCatalogForTesting(reader: (() => Promise<GenStudioChatModel[]>) | null): void {
  catalogReader = reader
}

export interface SceneVisionEvaluatorInput {
  imagePath: string
  modelId: string
  system: string
  user: string
  expectedText: string | null
  structuredOutput: boolean
}
/** Replaces the network call. Returns the model's raw answer text. */
let evaluator: ((input: SceneVisionEvaluatorInput) => Promise<string>) | null = null
export function _setSceneVisionEvaluatorForTesting(fn: typeof evaluator): void { evaluator = fn }

// ── Model choice ─────────────────────────────────────────────────────────────

/** A row this check may use: available, sellable, and able to carry a picture. */
export function eligibleSceneVisionModels(rows: GenStudioChatModel[]): GenStudioChatModel[] {
  return rows.filter(row =>
    row.available === true
    && row.locked !== true
    && row.qualification_only === false
    && chatImageEligibility(row).eligible)
}

async function liveChatModels(): Promise<GenStudioChatModel[]> {
  if (catalogReader) return catalogReader()
  const apiKey = (await getApiKey('genstudio').catch(() => '')).trim()
  if (!apiKey) throw new Error('No Gateway API Key is configured, so no model could be resolved.')
  return listChatModels(apiKey)
}

type ResolvedVisionModel =
  | { ok: true; model: GenStudioChatModel }
  | { ok: false; reason: string }

/**
 * Which model runs the check.
 *
 * A row that has left the catalogue, stopped accepting images, or was never
 * named records `not_checked` with the reason — never a substitute product
 * (§1: no fallback model), and never "the first one" on the owner's behalf.
 */
export async function resolveSceneVisionModel(
  config: unknown,
  rows?: GenStudioChatModel[],
): Promise<ResolvedVisionModel> {
  const cfg = sceneImageVisionConfig(config)
  if (!cfg.model) {
    return { ok: false, reason: 'No vision model is selected for this channel, so the picture was not checked.' }
  }
  let catalog: GenStudioChatModel[]
  try { catalog = rows ?? await liveChatModels() } catch (error: any) {
    return { ok: false, reason: `The Gateway catalogue could not be read (${error?.message || 'unknown error'}), so the picture was not checked.` }
  }
  const row = catalog.find(item => item.id === cfg.model)
  if (!row) {
    return { ok: false, reason: `${cfg.model} is not in the Gateway catalogue any more, so the picture was not checked. Choose a vision model again.` }
  }
  const eligibility = chatImageEligibility(row)
  if (!eligibility.eligible) {
    return { ok: false, reason: `${eligibility.reason} So the picture was not checked. Choose another vision model.` }
  }
  if (row.available !== true || row.locked === true || row.qualification_only !== false) {
    return { ok: false, reason: `${row.display_name || row.id} is not available right now, so the picture was not checked.` }
  }
  return { ok: true, model: row }
}

// ── The call ─────────────────────────────────────────────────────────────────

/** 640 px q80 JPEG — the same encoding the free check sends, and its SHA-256 for the request identity. */
async function encodeSceneVisionImage(imagePath: string): Promise<{ dataUri: string; sha256: string; bytes: number }> {
  const jpeg = await sharp(imagePath)
    .resize({ width: VISION_IMAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: VISION_IMAGE_QUALITY })
    .toBuffer()
  return {
    dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    sha256: crypto.createHash('sha256').update(jpeg).digest('hex'),
    bytes: jpeg.length,
  }
}

async function askTheModel(input: SceneVisionEvaluatorInput & { model: GenStudioChatModel }): Promise<string> {
  if (evaluator) return evaluator(input)
  const apiKey = await getApiKey('genstudio')
  const image = await encodeSceneVisionImage(input.imagePath)
  const result = await callChatWithGenStudio(apiKey, {
    modelId: input.model.id,
    system: input.system,
    userMessage: input.user,
    // Temperature 0 and an identical prompt: the same picture must get the same
    // verdict, or the verdict means nothing (FINDINGS §3).
    temperature: 0,
    outputBudget: 'short',
    // `json_object` ONLY where the row publishes structured output. A product
    // that publishes `none` gets the shape in words from the rubric instead —
    // asking it for a field it never advertised is the invented-parameter bug.
    outputContract: input.structuredOutput ? JSON_OBJECT_OUTPUT_CONTRACT : PROSE_OUTPUT_CONTRACT,
    inputImage: { dataUri: image.dataUri, sha256: image.sha256 },
    // Content-derived, so a retry of the SAME picture and model replays the
    // settled job instead of buying a second answer.
    requestIdentity: `scene-vision:${image.sha256}:${input.model.id}`,
  })
  return result.text
}

// ── Running one check ────────────────────────────────────────────────────────

function emptyAxes(): Record<SceneVisionAxis, SceneVisionAxisResult> {
  const axes = {} as Record<SceneVisionAxis, SceneVisionAxisResult>
  for (const axis of SCENE_VISION_AXES) axes[axis] = { verdict: 'could_not_check', findings: [] }
  return axes
}

function unmeasuredAxes(reason: string): Record<SceneVisionAxis, SceneVisionAxisResult> {
  const axes = emptyAxes()
  for (const axis of SCENE_VISION_AXES) axes[axis] = { verdict: 'could_not_check', findings: [reason] }
  return axes
}

/** Flatten the axes for the badge and the job log, naming the axis each finding belongs to. */
export function sceneVisionFindings(axes: Record<SceneVisionAxis, SceneVisionAxisResult>): string[] {
  return SCENE_VISION_AXES.flatMap(axis => axes[axis].findings.map(finding => `${axis}: ${finding}`))
}

/**
 * Run the check for one scene image. Never throws: a broken check is recorded
 * as `not_checked` with the reason a person can act on.
 */
export async function runSceneVisionCheck(input: {
  sceneId: string
  imagePath: string
  visualPrompt: string
  /** The exact string Story drew the text layer from, when it knows it. */
  expectedText?: string | null
  planPath?: string | null
  config?: unknown
  remade?: boolean
}): Promise<SceneVisionCheckResult> {
  const cfg = sceneImageVisionConfig(input.config)
  const base = {
    checked_at: new Date().toISOString(),
    shadow_mode: sceneImageVisionShadowMode(input.config),
    remade: input.remade === true,
  }
  const record = async (result: SceneVisionCheckResult): Promise<SceneVisionCheckResult> => {
    await recordSceneVisionCheck(input.planPath, input.sceneId, input.imagePath, result).catch(() => undefined)
    return result
  }
  const notChecked = (reason: string, model?: GenStudioChatModel): Promise<SceneVisionCheckResult> => record({
    ...base,
    state: 'not_checked',
    axes: unmeasuredAxes(reason),
    findings: [],
    confidence: null,
    expected_text: input.expectedText?.trim() || undefined,
    reason,
    ...(model ? { model_id: model.id, model_name: model.display_name, provider_name: model.provider_name } : {}),
  })

  if (!cfg.enabled) {
    // When off, no call is made and nothing is recorded — the same rule the
    // free check follows, so an off feature cannot leave paid evidence behind.
    return {
      ...base, state: 'not_checked', axes: emptyAxes(), findings: [], confidence: null,
      remade: false, reason: 'The stronger vision check is turned off in project settings.',
    }
  }

  const resolved = await resolveSceneVisionModel(input.config)
  if (!resolved.ok) return notChecked(resolved.reason)
  const model = resolved.model

  let answer: SceneVisionAnswer
  try {
    const raw = await askTheModel({
      imagePath: input.imagePath,
      model,
      modelId: model.id,
      system: sceneVisionSystemPrompt(),
      user: sceneVisionUserPrompt({ visualPrompt: input.visualPrompt, expectedText: input.expectedText }),
      expectedText: input.expectedText?.trim() || null,
      // Decided from the row that was actually resolved, not from a constant.
      structuredOutput: model.structured_output_mode !== 'none',
    })
    answer = parseSceneVisionAnswer(raw)
  } catch (error: any) {
    const message = String(error?.message || 'unknown error').trim().slice(0, 400)
    // A provider failure, a truncated answer and an unreadable answer are all
    // "the picture was not checked" — never a pass, and never a remake trigger.
    return notChecked(
      `The vision check could not run (${message}), so the picture was not checked.`,
      model,
    )
  }

  const axes = { ...answer.axes }
  const expected = (input.expectedText || '').trim()
  if (expected) {
    // Story drew the words, so the comparison is objective and outranks
    // whatever the model thought of its own OCR (FINDINGS §3). Khmer inside
    // `compareExpectedText` answers `could_not_check`, and says so.
    axes.text = compareExpectedText(expected, axes.text.transcription || '')
  }
  const findings = sceneVisionFindings(axes)
  return record({
    ...base,
    state: 'checked',
    axes,
    findings,
    confidence: answer.confidence,
    model_id: model.id,
    model_name: model.display_name,
    provider_name: model.provider_name,
    expected_text: expected || undefined,
  })
}

/**
 * Does any per-axis auto-remake switch actually act right now?
 *
 * False while the shadow window is open — the same window the free check is
 * locked by — and false when every switch is off. Only then does a check have
 * to finish before the job does.
 */
export function sceneVisionAutoRemakeActive(config: unknown, now = Date.now()): boolean {
  if (sceneImageVisionShadowMode(config, now)) return false
  const cfg = sceneImageVisionConfig(config)
  return SCENE_VISION_AXES.some(axis => cfg.auto_remake[axis])
}

/**
 * The axes this picture should be remade for. Empty in shadow mode, empty when
 * every switch is off, and empty when the axis did not fail — so a switch can
 * only ever act on a defect it was told to act on.
 */
export function sceneVisionAxesToRemake(result: SceneVisionCheckResult, config: unknown, now = Date.now()): SceneVisionAxis[] {
  if (result.state !== 'checked' || result.remade) return []
  if (sceneImageVisionShadowMode(config, now)) return []
  const cfg = sceneImageVisionConfig(config)
  return SCENE_VISION_AXES.filter(axis => cfg.auto_remake[axis] && result.axes[axis]?.verdict === 'fail')
}

// ── Recording ────────────────────────────────────────────────────────────────

/** Write the verdict beside the image and onto the scene's plan entry, under the plan's lock. */
export async function recordSceneVisionCheck(
  planPath: string | null | undefined,
  sceneId: string,
  imagePath: string,
  result: SceneVisionCheckResult,
): Promise<void> {
  // BESIDE the free check's `<name>.check.json`, never over it.
  const sidecar = path.join(path.dirname(imagePath), `${path.basename(imagePath, path.extname(imagePath))}.vision-check.json`)
  await fs.writeFile(sidecar, JSON.stringify(result, null, 2), 'utf8').catch(() => undefined)
  if (!planPath) return
  await withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes?.find(item => item.id === sceneId)
    if (!scene) return
    ;(scene as any).vision_check = result
    await writeJsonAtomic(planPath, plan, { compact: true })
  })
}

/** One line for the job log: what was judged, and whether anything was changed. */
export function describeSceneVisionCheck(result: SceneVisionCheckResult): string {
  const model = result.model_name ? ` (${result.model_name})` : ''
  const shadow = result.shadow_mode ? ' [shadow — nothing changed]' : ''
  if (result.state === 'not_checked') return `Vision check: not checked — ${result.reason || 'no answer'}`
  const axes = SCENE_VISION_AXES
    .map(axis => `${axis} ${result.axes[axis].verdict}`)
    .join(', ')
  const findings = result.findings.length ? ` — ${result.findings.join('; ')}` : ''
  return `Vision check${model}: ${axes}${findings}${shadow}`
}

// ── The bounded background queue ─────────────────────────────────────────────

const BACKGROUND_VISION_CHECKS_MAX = 2
const backgroundVisionChecks: Array<() => Promise<unknown>> = []
let backgroundVisionChecksRunning = 0

export function queueSceneVisionCheck(input: Parameters<typeof runSceneVisionCheck>[0]): void {
  const cfg = sceneImageVisionConfig(input.config)
  if (!cfg.enabled) return
  backgroundVisionChecks.push(() => runSceneVisionCheck(input))
  pumpBackgroundVisionChecks()
}

function pumpBackgroundVisionChecks(): void {
  while (backgroundVisionChecksRunning < BACKGROUND_VISION_CHECKS_MAX && backgroundVisionChecks.length) {
    const task = backgroundVisionChecks.shift()!
    backgroundVisionChecksRunning++
    void task().catch(() => undefined).finally(() => {
      backgroundVisionChecksRunning--
      pumpBackgroundVisionChecks()
    })
  }
}

/** Test seam: wait until every queued vision check finished (or failed soft). */
export async function _drainSceneVisionCheckQueueForTesting(): Promise<void> {
  while (backgroundVisionChecksRunning || backgroundVisionChecks.length) await new Promise(resolve => setTimeout(resolve, 5))
}
