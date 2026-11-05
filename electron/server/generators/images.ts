/**
 * Image generator — port of generate_images.py.
 * Generates scene and thumbnail images through the GenStudio KH image API.
 */

import { existsSync } from 'fs'
import path from 'path'
import { findDirsLevelOrder } from '../lib/dir-search.js'
import { episodeDirNameMatchesCode } from '../services/asset-status.js'
import { parseImagePromptsDocx, type ParsedPrompts } from '../lib/docx-parser.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import { resolveOutputFormat } from '../services/generation-compression.js'
import { isDecodableImage } from '../lib/image-validation.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { registry } from '../providers/registry.js'
import { recordTask, recordTaskStrict, hashInput, type TaskManifestEntry } from '../services/task-manifest.js'
import { trashRootFor } from '../lib/trash-move.js'
import { resolveSubfolderNames, resolveEpisodePathsByCode } from '../services/utils.js'
import { resolveReadPath } from '../lib/episode-artifacts.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { fileExistsWithContent } from '../lib/http-retry.js'
import {
  isTerminalGenStudioImageTaskFailure,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
  type ImageRecoveryOutcome,
} from '../lib/manifest-recovery.js'
import { buildGenStudioImageIdempotencyKey, GenStudioImageTerminalFailureError, isGenStudioPaymentRefusal, isGenStudioRouteExhausted, refreshGenStudioAdmission } from '../lib/genstudio-client.js'
import { readManifest, type Manifest } from '../services/task-manifest.js'
import { findReferencedCharacters } from '../lib/character-name-match.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { nonRetryable } from '../services/job-retry-policy.js'
import {
  assertPromptWithinCap,
  measureAssemblyOverhead,
  PromptLengthExceededError,
  type AssemblyOverhead,
} from '../services/prompt-char-cap.js'
import { delayUnlessAborted } from '../services/tts-capacity-retry.js'
import {
  IMAGE_ROUTE_RETRY_MAX_ATTEMPTS,
  imageRouteRetryDelayMs,
} from '../services/image-route-retry.js'
import { isFleetBusyFailure, fleetBusyRetryPlan, freeMacWaitLine, isFreeMacPlan, waitUnlessStopped } from '../lib/genstudio-fleet-busy.js'
import type { Character, JobItemAttempt } from '../models/types.js'
import type { GenerateImagesRequest, Job, ImageModelConfig } from '../models/types.js'
import { resolveConfiguredAspectRatio, resolveConfiguredOutputOption, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { resolveImageProviderParams } from '../models/image-provider-params.js'
import { getApiKey } from '../services/app-secrets-store.js'
import fs from 'fs/promises'
import { checkpointGenStudioAsset } from '../services/genstudio-recovery.js'
import {
  assertReleasedZeroSettlementImageRetrySubmit,
  authoritativePaidImageSettledCredits,
  buildPaidImageOriginalIdentity,
  capturePaidImageReferenceIdentity,
  decidePaidImageReplacement,
  isReleasedZeroSettlementImageRetry,
  readPaidImageOriginalRequest,
  revalidatePaidImageOutputPath,
  type PaidImageOutputSelector,
} from '../services/image-paid-replacement.js'
import { isFreeFleetModelId } from '../contracts/provider-task-state.js'

// NOTE (v1.0.224): the old `enhanceThumbnailPrompt` + hardcoded gold/glowing
// `THUMB_TEXT_STYLES` were removed. They force-appended a sleep-story title
// instruction to EVERY thumbnail at render time, overriding the user's picks
// and ignoring the format. The thumbnail prompt now arrives from
// generators/image-prompts.ts already carrying the correct (format-aware)
// title-text directive. The render path uses `thumb.prompt` verbatim so the
// chosen image model produces the complete thumbnail, including its title.

export type ThumbnailReferenceStrength = 'loose' | 'balanced' | 'strong'

export function thumbnailReferenceGuidance(strength: ThumbnailReferenceStrength): string {
  return {
    loose:
      'Use the attached thumbnail only as loose inspiration for mood, palette, contrast, and visual energy. Create a clearly new composition for this episode. Do not copy its people, objects, words, logo, branding, or story details.',
    balanced:
      'Adapt the attached thumbnail’s composition, focal hierarchy, camera distance, color balance, lighting, contrast, and title-safe negative space to this episode. Replace all original people, objects, words, branding, and story details with the prompt content.',
    strong:
      'Closely follow the attached thumbnail’s structural layout, framing, subject scale, focal hierarchy, lighting pattern, contrast, and title-safe spacing, while fully replacing its people, objects, text, logo, branding, and narrative content with this episode.',
  }[strength]
}

export function thumbnailReferenceStrengthValue(strength: ThumbnailReferenceStrength): number {
  return { loose: 0.3, balanced: 0.6, strong: 0.85 }[strength]
}

/**
 * The exact text the saved-thumbnail-reference guidance contributes to a render
 * prompt. Extracted from the render path so the character ceiling a thumbnail
 * prompt is written under can be computed from the SAME text the render sends.
 */
export function savedThumbnailReferenceGuidance(reframingPrompt: unknown): string {
  return 'Reference-guided generation: use the supplied reference only for broad composition, hierarchy, framing, and visual rhythm. '
    + 'Create a new original image for this episode. Do not reproduce logos, identifying text, branded elements, characters, or a near-identical copy of the reference. '
    + String(reframingPrompt || '').trim()
}

/**
 * The guidance the RENDER will append for the project's saved thumbnail
 * reference — or '' when there is no saved reference, or its file is gone.
 *
 * One definition, used by the render and by the prompt writer that reserves
 * room for it. The writer must not reserve guidance the render will never
 * append (that would silently shorten every prompt body), and the two must not
 * disagree about WHEN the guidance appears (that would let the assembled
 * prompt over the model's ceiling).
 */
export function savedThumbnailReferenceGuidanceFor(projectDir: string, asset: unknown): string {
  const record = asset as { id?: unknown; filename?: unknown; reframing_prompt?: unknown } | null | undefined
  if (!record?.id || typeof record.filename !== 'string' || !record.filename) return ''
  const file = path.join(projectDir, 'thumbnail-reference-assets', record.filename)
  if (!existsSync(file)) return ''
  return savedThumbnailReferenceGuidance(record.reframing_prompt)
}

/**
 * The exact text the matched characters' style keywords contribute to a render
 * prompt — the trailing `, kw1, kw2` clause image models read as modifiers.
 */
export function styleKeywordClause(keywords: readonly string[]): string {
  return keywords.length ? `, ${keywords.join(', ')}` : ''
}

/**
 * De-duplicate style keywords the way the render does: trimmed, first spelling
 * wins, case-insensitively. "Cel-shaded" and "cel-shaded" must not both land
 * in the prompt.
 */
function dedupeStyleKeywords(groups: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const kw of group || []) {
      const norm = kw.trim()
      if (!norm) continue
      const key = norm.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(norm)
    }
  }
  return out
}

/**
 * The style keywords the render appends for the characters a prompt mentions.
 *
 * The SAME name matching and de-duplication the render uses, exported so that a
 * character ceiling computed from it describes the prompt the model actually
 * receives rather than an estimate of it.
 */
export function matchedStyleKeywords<T extends { name: string }>(
  promptText: string,
  cast: readonly T[],
): string[] {
  const matched = findReferencedCharacters(promptText, cast as T[])
  return dedupeStyleKeywords(
    (matched as Array<T & { references?: { style_keywords?: string[] } | null }>)
      .map(c => c.references?.style_keywords || []),
  )
}

/**
 * EVERY style keyword the render could append for a cast — the largest set,
 * de-duplicated the same way.
 *
 * Used when the prompt does not exist yet, so which characters it will mention
 * is unknown. An over-reservation here costs prompt length; it never costs
 * correctness, because the render measures the assembled prompt before it
 * submits and refuses an over-length one there.
 */
export function castStyleKeywordBound<T extends { name: string }>(
  cast: readonly T[],
): string[] {
  return dedupeStyleKeywords(
    (cast as Array<T & { references?: { style_keywords?: string[] } | null }>)
      .map(c => c.references?.style_keywords || []),
  )
}

/**
 * The pieces the FINAL thumbnail render appends to the stored prompt.
 *
 * The stored prompt is not what the model receives: the render guidance and the
 * style keywords land on top of it. Both are measured here — from the same text
 * the render appends — so the character ceiling the prompt writer is given and
 * the prompt the model actually receives cannot drift apart.
 *
 * WHAT THIS IS NOT
 * ----------------
 * A bound, not an accounting of one item. The style keywords here are the
 * LARGEST set the render could append for the cast; which characters a given
 * prompt actually mentions is known only once the prompt exists. The render
 * guidance comes from the generator tab at render time, so it can differ from
 * what the writer reserved for. The reserve is therefore SAFE — it can
 * over-reserve, never under-reserve — and the render still measures the
 * assembled prompt before it submits and refuses an over-length one there.
 */
export interface ThumbnailRenderAssembly {
  /** Render-time guidance from the generator tab. */
  extraDetails?: string
  /** The reference guidance the render appends, when it has one. */
  referenceGuidance?: string
  /** The style keywords the render appends. */
  styleKeywords?: readonly string[]
}

/** The characters the render adds on top of the stored prompt, measured from
 *  the text it appends. A SAFE BOUND, not an item-exact accounting: the render
 *  guidance can differ at render time, and the keywords here are the largest
 *  set the render could append for the cast. */
export function thumbnailRenderAssemblyOverhead(assembly: ThumbnailRenderAssembly): AssemblyOverhead {
  const extra = (assembly?.extraDetails || '').trim()
  const reference = (assembly?.referenceGuidance || '').trim()
  const renderGuidance = [extra, reference].filter(Boolean).join('\n\n')
  // The SAME keyword list the assembly appends, filtered the same way — so the
  // measured overhead matches the characters those keywords really add rather
  // than a guess at them.
  const keywords = (assembly?.styleKeywords || []).filter(keyword => typeof keyword === 'string' && keyword.trim())
  const styleClause = styleKeywordClause(keywords)
  return measureAssemblyOverhead([
    // The separator is part of what is appended, so it is counted with it.
    { label: 'render guidance', text: renderGuidance ? `\n\n${renderGuidance}` : '' },
    { label: 'style keywords', text: styleClause },
  ])
}

/**
 * The FINAL prompt a thumbnail render sends: the stored prompt, plus the render
 * guidance, plus the style keywords.
 *
 * One implementation, used by the render itself and by the character ceiling
 * the thumbnail prompt writer is given. A second copy of this assembly is how
 * a compliant prompt ends up over the published ceiling: the writer was given
 * a budget that did not know what the render would add.
 */
export function assembleThumbnailRenderPrompt(storedPrompt: string, assembly: ThumbnailRenderAssembly): string {
  const extra = (assembly?.extraDetails || '').trim()
  const reference = (assembly?.referenceGuidance || '').trim()
  const renderGuidance = [extra, reference].filter(Boolean).join('\n\n')
  const withGuidance = renderGuidance ? `${storedPrompt}\n\n${renderGuidance}` : storedPrompt
  const keywords = (assembly?.styleKeywords || []).filter(keyword => typeof keyword === 'string' && keyword.trim())
  if (!keywords.length) return withGuidance
  return `${withGuidance.replace(/[\s,]+$/, '')}${styleKeywordClause(keywords)}`
}

/** What a retryable image failure buys: how long to wait, and what to tell the owner. */
export interface ImageRetryPlan {
  waitMs: number
  reason: string
  /** Total attempts allowed for THIS kind of refusal, including the first. */
  maxAttempts: number
}

/**
 * The only two image failures worth asking again about — and the wait each earns.
 *
 * Both prove no provider did any work and the whole reservation came back, so a
 * second attempt costs time and nothing else. Every OTHER terminal code may
 * describe work a provider already performed, returns `null` here, and fails
 * fast at the call site rather than being paid for twice. That asymmetry is the
 * entire point: a "Repair & Retry all" button was removed in v1.0.114 because
 * it did not make it.
 *
 *   CLOUD_PROVIDER_EXHAUSTED — every route GenStudio ranked for this product
 *     declined the request. Handled here since the image retry shipped.
 *
 *   SITE_PLACEMENT_EXHAUSTED / SITE_CAPACITY_UNAVAILABLE (v1.4.26) — GenStudio
 *     could not find a free MACHINE, which is a different thing from a provider
 *     declining and was not covered until now. Images are 100% fleet-placed and
 *     the highest-volume operation in the app (7,419 attempts in 30 days); they
 *     have simply not met a burst yet. Transcription did, and lost 122 of 353
 *     items in one; TTS did, and lost 5 that nobody noticed for two days.
 *
 * The two waits are deliberately different. A busy fleet is declared only AFTER
 * GenStudio has already held the job in a fifteen-minute placement window, so
 * anything reaching here means the fleet is genuinely saturated and the shared
 * minutes-long schedule applies — a 15-second retry would just rejoin the same
 * jam and burn an attempt. A declined route is a per-second condition and keeps
 * its own jittered seconds-long backoff.
 *
 * Exported as a pure function so the decision can be tested on its own, without
 * driving a whole 333-scene batch to observe it.
 *
 * @param attemptNum the 1-based attempt that just failed.
 */
export function imageRetryPlan(e: unknown, attemptNum: number): ImageRetryPlan | null {
  if (isFleetBusyFailure(e, 'image')) {
    // Bounded by the shared schedule's own length, not by the image route
    // constant, so retuning one can never silently walk off the end of the other.
    return fleetBusyRetryPlan(e, 'image', attemptNum - 1)
  }
  if (isGenStudioRouteExhausted(e) && attemptNum < IMAGE_ROUTE_RETRY_MAX_ATTEMPTS) {
    return {
      waitMs: imageRouteRetryDelayMs(attemptNum - 1),
      reason: 'No image route would accept this request',
      maxAttempts: IMAGE_ROUTE_RETRY_MAX_ATTEMPTS,
    }
  }
  return null
}

/**
 * Search recursively for a file matching any of the candidate filenames.
 * Returns the first match found.
 */
// Find the highest-PRIORITY candidate present anywhere under `dir`. `candidates`
// is an ordered preference list (e.g. .md before legacy .docx). v1.0.436: the
// previous implementation returned whichever match it hit first in directory
// order, which broke the preference — when both `${code}_Scene_Prompts.md` (240
// scenes) and a stale `${code}_Scene_Prompts.docx` (12 scenes) sit in the same
// folder, readdir lists ".docx" before ".md" (alphabetical), so the stale Word
// file won and only 12 scenes generated. Now we collect ALL matches and return
// the one with the best (lowest) rank in `candidates`, so the .md always wins.
async function findFileRecursive(
  dir: string,
  candidates: string[],
  options: { strictIo?: boolean } = {},
): Promise<string | null> {
  const ref: { path: string; rank: number } = { path: '', rank: Infinity }
  const walk = async (d: string): Promise<void> => {
    try {
      const entries = await fs.readdir(d, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name)
        if (entry.isFile()) {
          const rank = candidates.indexOf(entry.name)
          if (rank >= 0 && rank < ref.rank) { ref.path = fullPath; ref.rank = rank }
        } else if (entry.isDirectory()) {
          await walk(fullPath)
        }
      }
    } catch (error) {
      if (options.strictIo && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  await walk(dir)
  return ref.rank === Infinity ? null : ref.path
}

/**
 * The best-ranked prompts file for one episode.
 *
 * Looks inside the episode's own folder(s) only. This used to walk the ENTIRE
 * project on every call — every episode's scene-image folder included — and the
 * status, audit and review routes make that call per episode, so a 160-episode
 * project cost ~0.6 M `readdir` calls per audit (measured). A project with no
 * folder for the episode keeps the old whole-tree search.
 */
async function findPromptsFile(
  outputRoot: string,
  code: string,
  candidates: string[],
  options: { strictIo?: boolean; noTreeFallback?: boolean } = {},
): Promise<string | null> {
  const rethrow = options.strictIo ? (error: unknown) => (error as NodeJS.ErrnoException)?.code !== 'ENOENT' : undefined
  const dirs = await findDirsLevelOrder(outputRoot, 4, name => episodeDirNameMatchesCode(name, code), rethrow)
  if (!dirs.length) return options.noTreeFallback ? null : findFileRecursive(outputRoot, candidates, options)
  let best: { path: string; rank: number } | null = null
  for (const dir of dirs) {
    const found = await findFileRecursive(dir, candidates, options)
    const rank = found ? candidates.indexOf(path.basename(found)) : -1
    if (found && (!best || rank < best.rank)) best = { path: found, rank }
  }
  return best?.path ?? null
}

export class ImagePromptsMissingError extends Error {
  readonly code = 'IMAGE_PROMPTS_MISSING' as const
  /** Bad input: the prompts file is absent, so running the job again stops here again — no automatic retry (services/job-retry-policy.ts isNonRetryableError). Manual Retry works once the prompts exist. */
  readonly retryable = false

  constructor(readonly kind: 'scene' | 'thumbnail', readonly episodeId: string) {
    const code = episodeId.toUpperCase()
    super(`Could not find ${kind} prompts for ${code}. Generate the prompts first.`)
    this.name = 'ImagePromptsMissingError'
  }
}

export async function findScenePromptsFile(
  slug: string,
  episodeId: string,
  options: { strictIo?: boolean } = {},
): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Prefer .md (current), then legacy .docx; new separate file before old combined.
  const candidates = [
    `${code}_Scene_Prompts.md`,
    `${code}_Scene_Prompts.docx`,
    `${code}_Image_Prompts.md`,
    `${code}_Image_Prompts.docx`,
  ]
  const found = await findPromptsFile(outputRoot, code, candidates, options)
  if (found) return found
  throw new ImagePromptsMissingError('scene', code)
}

export async function findThumbPromptsFile(
  slug: string,
  episodeId: string,
  // preferred: the canonical prompts path (resolveEpisodePaths().thumb_prompts_docx); looked up when omitted.
  // noTreeFallback: bulk status callers must not walk the whole output tree for an episode with no folder yet.
  options: { strictIo?: boolean; noTreeFallback?: boolean; preferred?: string } = {},
): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // One resolver: the canonical folder wins whenever it has the file, so a stale duplicate folder that sorts
  // first can never redirect the reader (status) or the writer (generator, repair) away from it.
  const preferred = resolveReadPath(options.preferred ?? (await resolveEpisodePathsByCode(slug, code)).thumb_prompts_docx)
  if (existsSync(preferred)) return preferred

  // Prefer .md (current), then legacy .docx; new separate file before old combined.
  const candidates = [
    `${code}_Thumbnail_Prompts.md`,
    `${code}_Thumbnail_Prompts.docx`,
    `${code}_Image_Prompts.md`,
    `${code}_Image_Prompts.docx`,
  ]
  const found = await findPromptsFile(outputRoot, code, candidates, options)
  if (found) return found
  throw new ImagePromptsMissingError('thumbnail', code)
}

export async function resolveImageDirs(projectSlug: string, promptsPath: string, episodeId: string): Promise<{ bgDir: string; thumbDir: string; episodeDir: string }> {
  const code = episodeId.toUpperCase()

  // Walk up from prompts file to find the episode dir
  // The prompts file lives inside a subfolder (Scene Prompts / Thumbnail Prompts / Image Prompts / Script)
  let episodeDir = path.dirname(promptsPath)
  const parentName = path.basename(episodeDir).replace(/^✅\s*/, '').toLowerCase()
  if (parentName.includes('prompt') || parentName.includes('script')) {
    episodeDir = path.dirname(episodeDir)
  }

  // Read configured subfolder names from project config
  const names = await resolveSubfolderNames(projectSlug, code)
  const bgConfigName = names.images       // e.g. "TN0024 - 05 Scene Images"
  const thumbConfigName = names.thumbnails // e.g. "TN0024 - 06 Thumbnail Images"

  // Default to config-based paths
  let bgDir = path.join(episodeDir, bgConfigName)
  let thumbDir = path.join(episodeDir, thumbConfigName)

  // Scan for existing folders (handles ✅ prefix and old/new names)
  try {
    const entries = await fs.readdir(episodeDir)
    for (const entry of entries) {
      const clean = entry.replace(/^✅\s*/, '')
      // Match config name (with or without ✅)
      if (clean === bgConfigName) bgDir = path.join(episodeDir, entry)
      if (clean === thumbConfigName) thumbDir = path.join(episodeDir, entry)
      // Also match legacy names for backward compatibility
      const lc = clean.toLowerCase()
      if (lc === `${code.toLowerCase()} - background images` || lc === `${code.toLowerCase()} - scene images`) {
        if (!entries.some(e => e.replace(/^✅\s*/, '') === bgConfigName)) {
          bgDir = path.join(episodeDir, entry)
        }
      }
      if (lc === `${code.toLowerCase()} - thumbnails` || lc === `${code.toLowerCase()} - thumbnail images`) {
        if (!entries.some(e => e.replace(/^✅\s*/, '') === thumbConfigName)) {
          thumbDir = path.join(episodeDir, entry)
        }
      }
    }
  } catch { /* fall back to config defaults */ }

  // Level B (opt-in): if the project routes heavy media to an external root,
  // redirect the image/thumbnail dirs there. Non-split projects keep the
  // iCloud dirs resolved above (incl. the legacy-name fallbacks).
  const { mediaEpisodeBaseForCode } = await import('../services/media-root.js')
  const mediaBase = await mediaEpisodeBaseForCode(projectSlug, code)
  if (mediaBase) {
    const { resolveSubfolder } = await import('../lib/folder-resolver.js')
    bgDir = await resolveSubfolder(mediaBase, bgConfigName)
    thumbDir = await resolveSubfolder(mediaBase, thumbConfigName)
  }

  return { bgDir, thumbDir, episodeDir }
}

/**
 * The image model this job asked for — **refused if it asked for none.**
 *
 * This line read `req.model || 'grok-imagine'`. `grok-imagine` is a hardcoded product id, and by
 * the time anyone looked it had been retired from the live catalogue — so a job arriving without a
 * model was routed at a product nobody had chosen, at that product's price, and the failure it
 * eventually produced named a model the operator had never selected. `resolveImageModelConfig`
 * already refuses an id that is not in the catalogue; the defect was that this line supplied one
 * rather than asking for it.
 *
 * The form's own default is `model: ''`, so the empty case is reachable — from the page before a
 * picker is touched, and from any caller that forgets the field. Rule 7's *"never hardcode a paid
 * model as the form default"* and rule 1's *"never invent a fallback"* are one requirement seen from
 * two sides: the selection belongs to the caller, and a generator that guesses it is spending money
 * on a choice nobody made. Named rather than inlined so a test can call it — the previous shape
 * could only be pinned by reading the source, which cannot tell a live rule from a comment.
 */
export function requestedImageModelName(model: string | undefined | null): string {
  const name = (model || '').trim()
  if (!name) {
    throw new Error('No image model was named for this job. Choose one and start it again.')
  }
  return name
}

export async function generateImages(job: Job): Promise<jq.JobExecutorResult> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateImagesRequest

  // Phase-wide download metrics: aggregate bytes received across every
  // image we pull from the CDN. Many CDNs omit Content-Length so we skip
  // bytes_total — UI renders an indeterminate bar with a live speed.
  const tracker = new SpeedTracker()
  let cumulativeBytes = 0
  const writeProgress = throttle(() => {
    const { speedBps } = tracker.update(cumulativeBytes)
    job.bytes_done = cumulativeBytes
    job.speed_bps = speedBps
  }, 250)
  /** Returns a fresh per-asset onProgress callback that adds chunk deltas
   *  into the cumulative phase counter. Each downloadImage call gets its
   *  own closure so per-asset `received` resets to 0 cleanly. */
  const makeChunkCb = () => {
    let lastReceived = 0
    return (received: number, _total?: number) => {
      const delta = received - lastReceived
      if (delta > 0) {
        cumulativeBytes += delta
        lastReceived = received
        writeProgress()
      }
    }
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')
  const modelName = requestedImageModelName(req.model)
  // The key is resolved first because the model's capabilities now come from
  // the live GenStudio catalogue rather than a synthesised constant.
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('Add the Gateway API Key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, modelName, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${modelName}`)
  const resolvedModelConfig: ImageModelConfig = modelConfig

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${modelName}" is not routed through the Gateway.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('Image generation through the Gateway is not available right now.')
  // The owner's "smaller files" choice per asset type (Settings, per-project override). Undefined =
  // field omitted = today's PNG. Resolved once per run; the sharp fallback below covers old nodes.
  const sceneOutputFormat = await resolveOutputFormat(project_slug, 'scene_images')
  const thumbOutputFormat = await resolveOutputFormat(project_slug, 'thumbnails')
  // The keyed account burst is advisory local staging only. Exact image
  // admission permits remain mandatory at the provider boundary.
  const admission = await refreshGenStudioAdmission(apiKey)

  // Full generation and both preview surfaces share the same tier resolver.
  // This ensures the selected resolution affects the provider payload as well
  // as the credit estimate.
  const providerParams = resolveImageProviderParams(modelConfig, req.tier)

  // Find the prompt file for the requested independent pool.
  const mode = req.mode
  if (mode !== 'scenes' && mode !== 'thumbs') {
    throw new Error('Image generation mode must be "scenes" or "thumbs"; merged all-mode generation is no longer supported.')
  }
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null

  if (mode === 'scenes') {
    scenePromptsPath = await findScenePromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found scene prompts: ${path.basename(scenePromptsPath)}`)
  }
  if (mode === 'thumbs') {
    // A music (Episode Builder) episode has no Thumbnail Prompts step: its prompts are written from
    // its own scenes and theme the first time, then the owner's image model draws them as usual.
    const { isMusicEpisodeDir, episodeDirFor } = await import('../services/music-episode-store.js')
    if (isMusicEpisodeDir(await episodeDirFor(project_slug, episode_id))) {
      const { writeMusicThumbnailPrompts } = await import('../services/music-episode-thumbnail.js')
      const written = await writeMusicThumbnailPrompts(project_slug, episode_id)
      if (written.written) {
        job.output_lines.push(`Wrote ${written.count} thumbnail prompt(s) from this music episode's scenes and theme.`)
        // Candidates come from distinct scenes, so an episode with fewer scenes
        // than the target can only offer what it has. Said plainly rather than
        // failing a step the customer cannot do better at.
        if (written.count < written.requested) {
          job.output_lines.push(
            `This episode has ${written.count} scene(s), so it has ${written.count} candidate(s) — not the usual ${written.requested}.`,
          )
        }
      }
    }
    thumbPromptsPath = await findThumbPromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found thumbnail prompts: ${path.basename(thumbPromptsPath)}`)
  }

  // Use whichever file we found to resolve image dirs
  const refPath = scenePromptsPath || thumbPromptsPath!
  const { bgDir, thumbDir, episodeDir: resolvedEpDir } = await resolveImageDirs(project_slug, refPath, episode_id)
  await fs.mkdir(bgDir, { recursive: true })
  await fs.mkdir(thumbDir, { recursive: true })

  // Reference-guided thumbnails use the durable project-owned original saved
  // by Thumbnail Prompts. The GenStudio provider uploads this file privately
  // immediately before dispatch; no local path ever crosses that boundary.
  const savedThumbnailReference = mode === 'thumbs'
    ? ((req as any).thumbnail_reference_asset || (config as any).thumbnail_reference_asset || null)
    : null
  const projectRootDir = pm.getProjectDir(project_slug) || path.join(pm.projectsRoot(), project_slug)
  const trashDirFor = (anchor: string, kind: string) => path.join(trashRootFor(anchor, projectRootDir, project_slug), kind)
  const savedThumbnailReferencePath = savedThumbnailReference?.id && typeof savedThumbnailReference?.filename === 'string'
    ? path.join(projectRootDir, 'thumbnail-reference-assets', savedThumbnailReference.filename)
    : ''
  const hasSavedThumbnailReference = !!savedThumbnailReferencePath && existsSync(savedThumbnailReferencePath)

  // Parse prompts from separate or combined files
  let scenes: ParsedPrompts['scenes'] = []
  let thumbnails: ParsedPrompts['thumbnails'] = []

  if (scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(scenePromptsPath)
    scenes = parsed.scenes
    // If the file is a combined file, also grab thumbnails from it
    if (!thumbPromptsPath || thumbPromptsPath === scenePromptsPath) {
      thumbnails = parsed.thumbnails
    }
  }
  if (thumbPromptsPath && thumbPromptsPath !== scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(thumbPromptsPath)
    thumbnails = parsed.thumbnails
    // If no scenes were found yet (mode=thumbs), the scenes stay empty
    if (!scenePromptsPath) scenes = parsed.scenes
  }

  job.output_lines.push(`Parsed: ${scenes.length} scenes, ${thumbnails.length} thumbnails`)
  if (mode === 'scenes' && scenes.length === 0) throw new Error('The scene prompt file contains no usable scene prompts.')
  if (mode === 'thumbs' && thumbnails.length === 0) throw new Error('The thumbnail prompt file contains no usable thumbnail prompts.')
  // A short prompt file (boundful EP0092: 2 of 3) makes the thumbnails it has, and says so.
  if (mode === 'thumbs' && thumbPromptsPath) {
    const { inspectPromptCompletion } = await import('../services/prompt-completion.js')
    const prompts = await inspectPromptCompletion(path.dirname(thumbPromptsPath), episode_id, 'thumbnail')
    if (prompts.expected > thumbnails.length) {
      job.output_lines.push(
        `The thumbnail prompt file has ${thumbnails.length} of the ${prompts.expected} prompts Thumbnail Prompts was asked for; `
        + `making the ${thumbnails.length} it has. Run Thumbnail Prompts again to add the rest.`,
      )
    }
  }
  if (mode === 'scenes' && req.scene_number != null && !scenes.some(scene => scene.number === req.scene_number)) {
    throw new Error(`Scene prompt ${req.scene_number} was not found. Refresh the scene list and choose an available prompt.`)
  }
  if (mode === 'thumbs' && req.thumb_number != null && !thumbnails.some(thumb => thumb.number === req.thumb_number)) {
    throw new Error(`Thumbnail prompt ${req.thumb_number} was not found. Refresh the thumbnail list and choose an available prompt.`)
  }

  if (mode === 'thumbs') {
    const { assertThumbnailOptionsApproved } = await import('../services/thumbnail-option-settings.js')
    await assertThumbnailOptionsApproved(project_slug, episode_id,
      thumbnails.filter(item => req.thumb_number == null || item.number === req.thumb_number))
  }

  // Phase 8 — load this episode's character cast once for reference-image
  // wiring. Auto-detect: scan each scene's prompt text for character names
  // and forward matching characters' reference images to the provider.
  // Models that don't declare supports_reference_images silently ignore
  // the field (text-only path, no overhead).
  const cast = await cm.listCharacters(project_slug, { episodeCode: episode_id })
    .catch(() => [] as Character[])
  const castWithRefs = cast.filter(c => c.references?.images?.length)
  // Phase 8b (2026-05-03) — characters can also carry persistent style
  // keywords ("cel-shaded", "photoreal", etc.) appended to any prompt
  // that mentions them. Separate set from `castWithRefs` because a
  // character can have keywords without uploading a reference image
  // (and vice versa). Both pools feed the same name-match function below.
  const castWithStyle = cast.filter(c => (c.references?.style_keywords?.length ?? 0) > 0)
  // What this model actually does with references, read from the catalogue
  // entry the resolver just carried through. The old text told every user
  // their model ignored references because the flag was a hardcoded `false`.
  const supportsReferences = modelConfig.supports_reference_images === true
  const maxReferences = modelConfig.max_reference_images ?? (supportsReferences ? 1 : 0)
  const minReferences = modelConfig.min_reference_images ?? 0
  if (minReferences > 0) {
    job.output_lines.push(
      `Model '${modelName}' publishes a ${minReferences}-reference minimum — renders without references will be refused before submission.`,
    )
  }
  if (castWithRefs.length) {
    const note = supportsReferences
      ? `model '${modelName}' will receive their references (up to ${maxReferences} per render as published by the Gateway)`
      : `model '${modelName}' publishes no reference-image support — they'll be ignored; pick a reference-capable model for reference-driven gen`
    job.output_lines.push(
      `Cast with reference images: ${castWithRefs.map(c => c.name).join(', ')} — ${note}`,
    )
  }
  if (castWithStyle.length) {
    job.output_lines.push(
      `Cast with style keywords: ${castWithStyle.map(c => `${c.name} (${(c.references!.style_keywords || []).join(', ')})`).join('; ')} — appended to prompts when these characters appear`,
    )
  }

  // v1.0.518 — art-style reference image. The project's active art style
  // (services/art-style-resolver.ts) can carry a rendered preview image; we
  // feed it as an img2img style reference so renders match the picked look.
  // Resolved once here; attached per-scene as the fifth reference source
  // below. Empty for text-only styles.
  const artStyleResolution = await resolveProjectArtStyle(project_slug).catch((error: unknown) => {
    // A style hint never fails the render, but it is not swallowed silently
    // either: the job says the format default is what runs.
    job.output_lines.push(`Art style could not be read, so the format default style is used: ${String((error as { message?: unknown })?.message ?? error ?? '')}`)
    return { style: null, fallback: null }
  })
  const artStyle = artStyleResolution.style
  const artStyleRefPaths = (artStyle?.referenceImagePaths || []).filter(p => existsSync(p))
  if (artStyleResolution.fallback) {
    // A style this channel names that is not on this Mac renders as something
    // else — say which, in the job the customer watches, not only in a log.
    job.output_lines.push(`Art style not used: ${artStyleResolution.fallback.message}`)
  }

  /**
   * Auto-detect which characters appear in a scene by scanning the prompt
   * text for their names (delegated to findReferencedCharacters for the
   * pure boundary-matching logic). Returns absolute paths of every
   * reference image attached to matching characters. Empty array when no
   * names appear — provider call goes through text-only.
   */
  function resolveCharacterReferenceImages(promptText: string): string[] {
    const matched = findReferencedCharacters(promptText, castWithRefs)
    if (!matched.length) return []
    const out: string[] = []
    for (const c of matched) {
      // Linked-aware: characters live under the resolved project dir,
      // not unconditionally under PROJECTS_ROOT — otherwise iCloud-synced
      // projects would silently render scenes without their reference
      // images attached.
      const projDir = pm.getProjectDir(project_slug) || path.join(pm.projectsRoot(), project_slug)
      const charDir = path.join(projDir, 'characters', c.id)
      for (const filename of (c.references!.images || [])) {
        out.push(path.join(charDir, filename))
      }
    }
    return out
  }

  // ── Image-to-image multi-source reference resolution ───────────────────
  //
  // When req.image_mode === 'img2img', the user has opted in to driving
  // image generation with reference images instead of text-only prompts.
  // Reference paths come from up to four configurable sources, all of
  // which stack additively (they're independent toggles in the UI):
  //
  //   1. Master ref:  one image at <episode_dir>/img2img-references/master.png
  //                   sent as a reference for every scene.
  //   2. Per-scene:   <episode_dir>/img2img-references/scene-NN.png — one
  //                   image per scene, overrides nothing else (stacks).
  //   3. Characters:  the same Phase 8 auto-detection that text2img uses
  //                   (always on in img2img mode by default; can be toggled
  //                   off via reference_sources.characters: false).
  //   4. Chain mode:  scene N's previously-rendered output (bgDir/{stem}_v1.png)
  //                   becomes a reference for scene N+1. Forces serial
  //                   execution since scene N+1 depends on scene N's render.
  //
  // The combined list is passed to imageProvider.generateImage's
  // referenceImagePaths; the provider silently ignores it for models that
  // don't declare supports_reference_images, so misconfigured (text-only)
  // models running in img2img mode just produce text2img output (the UI
  // already filters the model dropdown to img2img-capable models, but
  // we're defensive here in case the request comes from elsewhere).
  const imageMode = (req as any).image_mode === 'img2img' ? 'img2img' : 'text2img'
  const refSourcesRaw = (req as any).reference_sources || {}
  const refSources = {
    master: imageMode === 'img2img' && !!refSourcesRaw.master,
    per_scene: imageMode === 'img2img' && !!refSourcesRaw.per_scene,
    // Characters defaults to ON in img2img mode (matches the default the UI
    // toggles when the user enters img2img mode). text2img path is
    // unchanged — character refs are auto-attached as today.
    characters: imageMode === 'img2img' ? refSourcesRaw.characters !== false : true,
    chain: imageMode === 'img2img' && !!refSourcesRaw.chain,
    thumbnail: imageMode === 'img2img' && !!refSourcesRaw.thumbnail,
    // v1.0.518 — the project's art-style reference image (5th source).
    // Defaults ON in img2img mode when the active art style has a preview
    // image; can be toggled off via reference_sources.art_style: false.
    art_style: imageMode === 'img2img' && artStyleRefPaths.length > 0 && refSourcesRaw.art_style !== false,
  }
  if (imageMode === 'img2img' && refSources.art_style) {
    job.output_lines.push(
      `Art-style reference image attached (${artStyle?.name || artStyle?.source || 'active style'})` +
      (supportsReferences ? '' : ` — but model '${modelName}' publishes no reference support; style still applies via the prompt text`),
    )
  }
  const referenceStrength: ThumbnailReferenceStrength = (req.reference_strength === 'loose' || req.reference_strength === 'strong')
    ? req.reference_strength
    : 'balanced'

  function img2imgRefsDir(): string {
    return path.join(resolvedEpDir, 'img2img-references')
  }
  function masterRefPath(): string {
    return path.join(img2imgRefsDir(), 'master.png')
  }
  function thumbnailRefPath(): string {
    return path.join(img2imgRefsDir(), 'thumbnail.png')
  }
  function perSceneRefPath(n: number): string {
    return path.join(img2imgRefsDir(), `scene-${String(n).padStart(2, '0')}.png`)
  }
  function previousSceneRenderPath(n: number): string | null {
    if (n <= 1) return null
    const stem = `${episode_id.toUpperCase()}_Scene${(n - 1).toString().padStart(2, '0')}`
    return path.join(bgDir, `${stem}_v1.png`)
  }

  /** Resolve every reference image path for a scene given the configured
   *  sources. Stacks additively; missing files are silently skipped. */
  function resolveSceneReferenceImages(scene: { number: number; prompt: string }): string[] {
    const out: string[] = []
    if (refSources.master && existsSync(masterRefPath())) out.push(masterRefPath())
    if (refSources.per_scene && existsSync(perSceneRefPath(scene.number))) {
      out.push(perSceneRefPath(scene.number))
    }
    if (refSources.characters) out.push(...resolveCharacterReferenceImages(scene.prompt))
    if (refSources.chain) {
      const prev = previousSceneRenderPath(scene.number)
      if (prev && existsSync(prev)) out.push(prev)
    }
    // v1.0.518 — the project art-style reference image (already existence-
    // filtered) reinforces every scene/thumbnail render.
    if (refSources.art_style) out.push(...artStyleRefPaths)
    // De-dup in case the same image gets attached multiple ways.
    return Array.from(new Set(out))
  }

  /**
   * Phase 8b — collect every style keyword from characters whose names
   * appear in the prompt. De-duped + lowercase-trimmed so "Cel-shaded"
   * vs "cel-shaded" doesn't end up in the prompt twice. Returns [] when
   * no characters match or no characters have keywords. The caller
   * appends these to the prompt sent to the provider so the visual
   * style stays consistent across episodes when a character recurs.
   */
  function resolveSceneStyleKeywords(promptText: string): string[] {
    return matchedStyleKeywords(promptText, castWithStyle)
  }

  /**
   * Append matched-character style keywords to a prompt. Keywords land
   * after the user's prompt as a `, kw1, kw2, kw3` clause — image-gen
   * models read trailing comma-separated keywords as style modifiers,
   * which is the format every kie.ai / fal model in our catalog expects.
   * Returns the original prompt unchanged when no keywords matched.
   */
  function applyStyleKeywords(promptText: string, keywords: string[]): string {
    if (!keywords.length) return promptText
    const trimmed = promptText.replace(/[\s,]+$/, '')
    return `${trimmed}${styleKeywordClause(keywords)}`
  }

  // Defaults from the model's published `default_aspect_ratio` and refuses a
  // ratio it does not publish, before any scene is submitted.
  const aspectRatio = resolveConfiguredAspectRatio(resolvedModelConfig, req.aspect_ratio)
  // The published `(resolution, aspect_ratio)` row this batch renders at, so
  // an unpublished combination fails before any scene is submitted rather than
  // after the first charge. `undefined` = the model publishes no output
  // options, and the run proceeds on aspect ratio alone exactly as before.
  const outputOption = resolveConfiguredOutputOption(resolvedModelConfig, aspectRatio, req.resolution)
  if (outputOption) {
    job.output_lines.push(
      `Output: ${outputOption.resolution} ${outputOption.aspect_ratio} — ${outputOption.width}×${outputOption.height}px.`,
    )
  }
  // v1.0.308 — explicit render dimensions for LOCAL models (Image Studio). The
  // Scene/Thumbnail Generator's Size control sends a downscaled width/height to
  // cut a local model's GPU/VAE memory + render time at lower resolution. The
  // imagestudio provider rounds these to /16 and uses them in place of the
  // aspect preset; cloud providers don't receive them (the UI omits them) and
  // fall back to the aspect string. Mirrors generators/scene-image.ts.
  const renderWidth = typeof req.width === 'number' && req.width > 0 ? req.width : undefined
  const renderHeight = typeof req.height === 'number' && req.height > 0 ? req.height : undefined
  const paidProjectRoot = pm.getProjectDir(project_slug) || path.join(pm.projectsRoot(), project_slug)
  // Free fleet work is never paid-replaced: a terminal fleet task takes the ordinary fresh
  // retry (EP0092/EP0100 thumbnails, 2026-10-10; scenes got the same rule for TN0355).
  const freeFleet = isFreeFleetModelId(resolvedModelConfig.api_model || modelName)
  const paidThumbnailSelector = mode === 'thumbs' && outputOption ? {
    resolution: outputOption.resolution, aspect_ratio: outputOption.aspect_ratio,
    width: outputOption.width, height: outputOption.height, reference_mode: 'normal',
  } satisfies PaidImageOutputSelector : null
  const logicalPaidScope = (entry: TaskManifestEntry | null | undefined, fallback: string): string => {
    const saved = entry?.request_scope || ''
    const marker = saved.indexOf(':selector:')
    return marker > 0 ? saved.slice(0, marker) : fallback
  }
  const force = req.force || false
  const generationAction = (req as { generation_action?: { id?: unknown; kind?: unknown } }).generation_action
  const generationActionId = generationAction?.kind === 'fresh' && typeof generationAction.id === 'string'
    ? generationAction.id
    : ''
  const actionScope = (entry: TaskManifestEntry | null | undefined, baseScope: string): string => (
    force && generationActionId ? baseScope : resolveImageRetryScope(entry, baseScope).scope
  )
  const errors: string[] = []
  /**
   * The items THIS run attempted and could not produce.
   *
   * A file left over from an earlier run is not evidence that this run
   * succeeded. When a targeted re-render (`thumb_number` / `scene_number`) is
   * refused — a prompt over the model's published ceiling, a missing reference
   * — the old file is still on disk, and counting it as this run's output
   * would report a green success over a refused render.
   *
   * These items are therefore counted as MISSING by the completion audit. The
   * file stays on disk (a valid artefact is never deleted), and Retry asks for
   * the item again.
   */
  const failedItems = new Set<string>()
  /**
   * The first DETERMINISTIC refusal in this batch — a prompt the model's own
   * published ceiling rejects.
   *
   * It is kept so the aggregate completion error can carry the refusal's
   * identity. Without that, the job fails with "0/3 required items verified"
   * and the queue reads it as a transient gap, so it runs the whole batch three
   * times over, producing the same three refusals each time. The verified files
   * of the items that DID succeed stay on disk either way.
   */
  let deterministicRefusal: PromptLengthExceededError | null = null
  const noteDeterministicRefusal = (error: unknown): void => {
    if (deterministicRefusal) return
    if (error instanceof PromptLengthExceededError) deterministicRefusal = error
  }
  // Read the per-folder task manifests once at the top so we can attempt
  // free recovery (existing-task poll) before issuing any fresh submit.
  // Best-effort — a missing/corrupt sidecar just means recovery isn't
  // available for those items, fresh generation still works.
  const sceneManifest: Manifest = await readManifest(bgDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )
  const thumbManifest: Manifest = await readManifest(thumbDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )

  let totalToProcess = 0

  // ── Live per-item progress ────────────────────────────────────────────────
  // `job.progress` drives the bar; `job.item_progress` names which scenes are
  // in flight and — once retry (below) is in play — says explicitly when one
  // is sitting out a provider backoff rather than looking hung. Driven by
  // SETTLED counts (completed + failed), never by array index or cursor
  // position, so it stays monotonic and correct while up to
  // `resolveGenStudioLocalFanout`'s full width of workers complete out of
  // order.
  let completedCount = 0
  let failedCount = 0
  let currentConcurrency = 1
  let paidImageWaitRequested = false
  const activeItems = new Map<string, JobItemAttempt>()
  function publishProgress(): void {
    // Matches `generators/audio.ts`'s convention: an empty batch (e.g. a
    // single-scene re-render whose target was already filtered away) reports
    // 100, not an indeterminate bar, since there is genuinely nothing left.
    job.progress = totalToProcess > 0
      ? Math.round(((completedCount + failedCount) / totalToProcess) * 100)
      : 100
    job.item_progress = {
      total: totalToProcess,
      completed: completedCount,
      failed: failedCount,
      concurrency: currentConcurrency,
      // Ordered by label so a re-render doesn't reshuffle rows when a Map
      // entry is replaced in place.
      active: [...activeItems.values()].sort((a, b) => a.label.localeCompare(b.label)),
    }
  }
  async function publishImageQueueState(key: string, label: string, state: string): Promise<void> {
    const current = activeItems.get(key)
    if (!current) return
    activeItems.set(key, {
      label,
      key,
      state: state === 'waiting_account_capacity' ? 'waiting_retry' : 'running',
      attempt: current.attempt,
      max_attempts: current.max_attempts,
      ...(state === 'waiting_account_capacity' ? { reason: 'Waiting for available image capacity' } : {}),
    })
    publishProgress()
    await jq.checkpointJobState(job)
  }

  // Gates ONLY the retry backoff sleep below — never threaded into the
  // provider submit calls themselves, which already cancel through the
  // existing `isCancelled` poll callback. Matches the audio generator's
  // "500 ms cancel watcher" pattern.
  const cancelController = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) cancelController.abort()
  }, 500)

  const providerId = (): string => imageProvider!.meta.providerId || imageProvider!.meta.id

  interface DurableImageAttempt {
    recovery: ImageRecoveryOutcome
    /** Token folded into the idempotency identity for a fresh submission. */
    scope: string
    inputHash: string
    submittedAt: string
    notes: string[]
    /** The attempt chain's root — `resolveImageRetryScope`'s second argument.
     *  Carried through so an in-run route-exhaustion retry can promote the
     *  scope again without re-deriving `force ? …: 'default'` itself. */
    baseScope: string
    original?: Partial<TaskManifestEntry>
    paidReplacement?: boolean
    paidRecovery?: boolean
  }

  /**
   * Decide, for ONE image asset, whether a saved GenStudio job can still be
   * reclaimed and — when it cannot — under which request identity a single
   * fresh job should be submitted.
   *
   * The identity is derived only from persisted values, so a lost submit
   * response replays the same idempotency key (GenStudio hands back the same
   * job) instead of paying for a second render.
   */
  async function prepareImageAttempt(
    dir: string,
    manifest: Manifest,
    filename: string,
    prompt: string,
    paid?: { selector: PaidImageOutputSelector; references: ReturnType<typeof capturePaidImageReferenceIdentity>; outputPath: string },
    explicitLogicalScope?: string,
  ): Promise<DurableImageAttempt> {
    const baseScope = force ? `force:${generationActionId || job.job_id}` : 'default'
    const entry = manifest.tasks[filename] || null
    const retryEntry = entry?.request_scope?.includes(':selector:')
      ? { ...entry, request_scope: logicalPaidScope(entry, baseScope) }
      : entry
    let logicalScope = explicitLogicalScope || actionScope(retryEntry, baseScope)
    let identity = paid ? buildPaidImageOriginalIdentity({
      prompt, selector: paid.selector, references: paid.references.inputs, baseScope: logicalScope,
    }) : null
    let scope = identity?.requestScope || logicalScope
    let inputHash = identity?.inputHash || hashInput(`${scope}\n${prompt}`)
    const notes: string[] = []
    // A pre-scope manifest entry stays reclaimable on its task id alone, which
    // is exactly how this generator behaved before retry scopes existed. What
    // is new is that a job we already know settled is never reopened.
    const reclaimable = !force
      && entry
      && (entry.request_scope ? entry.input_hash === inputHash : true)
      && !isTerminalGenStudioImageTaskFailure(entry)
      ? entry
      : null
    // **A `prepared` entry has reserved an idempotency key and nothing else, so
    // "no such job" for that key is authoritative that no provider work exists.**
    // That is the one reading under which submitting again is safe, and the only
    // one that lets a retry make progress.
    //
    // Without this the recovery fell through to `uncertain`, which this generator
    // throws on — so a job whose submit never landed failed forever, once per
    // attempt, with `Could not confirm the prepared image by its idempotency key:
    // GenStudio KH request failed: No such job.` The gateway had no such job
    // because none was ever created, which is exactly what the message said and
    // exactly what nothing acted on.
    //
    // Mirrors `continuity-render.ts`'s `preparedReplay` and the branch
    // `manifest-recovery.ts` already implements (`!entry.task_id &&
    // entry.last_state === 'prepared'`). Safe because `allowPreparedReplayOnAbsent`
    // only fires when GenStudio *authoritatively* reports the key absent — a 404,
    // never a timeout or an uncertain network answer. `reclaimable` already
    // carries `!force`, so an explicit fresh render still owns a new identity and
    // is never replayed.
    const preparedReplay = Boolean(
      reclaimable
      && !reclaimable.task_id
      && reclaimable.idempotency_key
      && reclaimable.last_state === 'prepared',
    )
    const recovery = await tryRecoverImageFromManifestEntry(
      reclaimable,
      apiKey,
      resolvedModelConfig,
      () => jq.isCancelled(job.job_id),
      { allowPreparedReplayOnAbsent: preparedReplay },
    )
    let carried: TaskManifestEntry | null = entry
    if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
      // Persist the settled outcome first so the promoted retry scope stays
      // reproducible if this run dies before the fresh submission lands.
      carried = terminalImageManifestEntry(entry!, recovery)
      if (paid) await recordTaskStrict(dir, filename, carried)
      else await recordTask(dir, filename, carried)
      const carriedRetry = carried.request_scope?.includes(':selector:')
        ? { ...carried, request_scope: logicalPaidScope(carried, baseScope) }
        : carried
      logicalScope = explicitLogicalScope || actionScope(carriedRetry, baseScope)
      identity = paid ? buildPaidImageOriginalIdentity({
        prompt, selector: paid.selector, references: paid.references.inputs, baseScope: logicalScope,
      }) : null
      scope = identity?.requestScope || logicalScope
      inputHash = identity?.inputHash || hashInput(`${scope}\n${prompt}`)
      notes.push(
        `saved Gateway task ${recovery.taskId.slice(0, 12)}… is terminal ` +
        `(${recovery.kind === 'artifact-unavailable' ? 'artifact expired' : 'failed'}); ` +
        'submitting one fresh job under a new retry identity.',
      )
    }
    const submittedAt = carried?.request_scope === scope && carried.submitted_at
      ? carried.submitted_at
      : new Date().toISOString()
    return {
      recovery, scope, inputHash, submittedAt, notes, baseScope,
      ...(paid ? { original: {
        original_output_selector: paid.selector,
        original_reference_inputs: paid.references.inputs,
        original_reference_identity_hash: paid.references.identity_hash,
        original_output_path: revalidatePaidImageOutputPath(thumbDir, paid.outputPath),
      } } : {}),
    }
  }

  /**
   * Promote a request scope after an in-run route-exhaustion retry —
   * the same deterministic promotion `prepareImageAttempt` performs across
   * separate job runs (via `resolveImageRetryScope`), reused here rather than
   * forked, so a manual Retry and an automatic one derive identically.
   *
   * Never touches the manifest read at the top of this generator (that
   * snapshot is stale the instant this run starts writing to it); the
   * "previous entry" `resolveImageRetryScope` promotes from is built directly
   * from the attempt that just failed, which is exactly what was persisted by
   * the `recordImageState(..., 'failed', ...)` call just before this runs.
   */
  function deriveRouteRetryAttempt(
    previous: DurableImageAttempt,
    failedTaskId: string,
    prompt: string,
    explicitScope?: string,
  ): DurableImageAttempt {
    const failedEntry: TaskManifestEntry = {
      provider: providerId(),
      task_id: failedTaskId,
      submitted_at: previous.submittedAt,
      input_hash: previous.inputHash,
      request_scope: previous.scope?.includes(':selector:')
        ? logicalPaidScope({ request_scope: previous.scope } as any, previous.baseScope)
        : previous.scope,
      operation: 'image',
      last_state: 'failed',
    }
    const logicalScope = explicitScope || actionScope(failedEntry, previous.baseScope)
    const identity = previous.original?.original_output_selector ? buildPaidImageOriginalIdentity({
      prompt,
      selector: previous.original.original_output_selector,
      references: (previous.original.original_reference_inputs || []) as any,
      baseScope: logicalScope,
    }) : null
    const scope = identity?.requestScope || logicalScope
    return {
      recovery: { kind: 'no-saved-job' },
      scope,
      inputHash: identity?.inputHash || hashInput(`${scope}\n${prompt}`),
      submittedAt: new Date().toISOString(),
      notes: [],
      baseScope: previous.baseScope,
      original: previous.original,
      paidReplacement: previous.paidReplacement,
    }
  }

  async function recordImageState(
    dir: string,
    filename: string,
    attempt: DurableImageAttempt,
    state: string,
    taskId: string,
    idempotencyKey: string,
    strict = false,
  ): Promise<void> {
    const payload: TaskManifestEntry = {
      provider: providerId(),
      task_id: taskId,
      submitted_at: attempt.submittedAt,
      input_hash: attempt.inputHash,
      request_scope: attempt.scope,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      operation: 'image',
      last_state: state,
      ...attempt.original,
    }
    if (strict) await recordTaskStrict(dir, filename, payload)
    else await recordTask(dir, filename, payload)
  }

  function uncertainRecoveryError(recovery: ImageRecoveryOutcome & { kind: 'uncertain' }): Error {
    // Never let an unconfirmed outcome become a duplicate paid submission.
    return new Error(
      `Could not confirm Gateway task ${recovery.taskId.slice(0, 12)}… (${recovery.reason}). ` +
      'No duplicate image was submitted; Retry reconnects to the same job.',
    )
  }

  async function runScene(scene: { number: number; title: string; prompt: string }) {
    const stem = `${episode_id.toUpperCase()}_Scene${scene.number.toString().padStart(2, '0')}`
    const v1Path = path.join(bgDir, `${stem}_v1.png`)
    // Only treat the cache as a hit if the file exists AND is non-empty — a
    // zero-byte file from a prior aborted download is NOT a valid skip.
    if (await fileExistsWithContent(v1Path) && !req.scene_number && !force) {
      job.output_lines.push(`Skipping ${stem} (exists)`)
      completedCount++
      publishProgress()
      return
    }
    // Auto-recovery: before issuing a fresh (charged) submit, see if the
    // task-manifest sidecar has a stored task_id from a previous run. If the
    // provider still has the result (succeeded / still running), reclaim it for
    // free. A job GenStudio already settled as failed is NOT reclaimed — it can
    // only ever return the same failure — and an unconfirmed outcome fails this
    // one scene instead of turning into a duplicate paid submission. Everything
    // is inside the try so no single scene can abort the whole batch.
    const filename = `${stem}_v1.png`
    const key = `scene-${scene.number}`
    const label = `Scene ${scene.number}`
    activeItems.set(key, { label, key, state: 'running', attempt: 1, max_attempts: IMAGE_ROUTE_RETRY_MAX_ATTEMPTS })
    publishProgress()
    try {
      // Multi-source reference resolution. text2img mode → only character
      // refs (Phase 8 default); img2img mode → master + per-scene + chars
      // + chain depending on the user's reference_sources toggles. Resolved
      // ONCE — none of it changes between a route-exhaustion retry's attempts.
      const styleKeywords = resolveSceneStyleKeywords(scene.prompt)
      const finalPrompt = applyStyleKeywords(scene.prompt, styleKeywords)
      // Every reference the user configured for this scene, forwarded only
      // when GenStudio publishes reference support for the selected model.
      // Before v1.0.788 this list was computed and then thrown away, so an
      // img2img scene run was silently billed as a text2img render.
      const sceneReferences = supportsReferences
        ? resolveSceneReferenceImages(scene).slice(0, Math.max(maxReferences, 0))
        : []
      if (sceneReferences.length) {
        job.output_lines.push(
          `Scene ${scene.number}: attaching ${sceneReferences.length} reference image(s) — ` +
          sceneReferences.map(p => path.basename(p)).join(', '),
        )
      } else if (!supportsReferences && imageMode === 'img2img') {
        job.output_lines.push(
          `Scene ${scene.number}: model '${modelName}' publishes no reference support — rendering from the prompt text only.`,
        )
      }

      let attempt: DurableImageAttempt | null = null
      for (let attemptNum = 1; ; attemptNum++) {
        let acceptedTaskId = ''
        let acceptedKey = ''
        try {
          // Same rule as the thumbnail path: what the model RECEIVES is the
          // assembled prompt, and it is measured against the ceiling the model
          // publishes right now. Refused before submission, so nothing is
          // charged, and typed, so a retry cannot re-learn the same refusal.
          assertPromptWithinCap(finalPrompt, resolvedModelConfig.prompt_char_cap, {
            modelLabel: resolvedModelConfig.label || modelName,
            what: `the assembled scene prompt for Scene ${scene.number}`,
          })
          if (attemptNum === 1) attempt = await prepareImageAttempt(bgDir, sceneManifest, filename, finalPrompt)
          const current = attempt!
          if (current.recovery.kind === 'uncertain') throw uncertainRecoveryError(current.recovery)
          for (const note of current.notes) job.output_lines.push(`Scene ${scene.number}: ${note}`)
          if (current.recovery.kind === 'recovered') {
            const recovered = current.recovery
            for (let i = 0; i < recovered.urls.length; i++) {
              await saveGenStudioImage(recovered.urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb(), { compress: !!sceneOutputFormat, trashDir: trashDirFor(bgDir, 'scene-images') })
            }
            await recordImageState(bgDir, filename, current, 'succeeded', recovered.taskId, '')
            completedCount++
            job.output_lines.push(
              `Scene ${scene.number}/${totalToProcess}: ${scene.title} — recovered ` +
              `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
            )
            return
          }
          // Persist the request identity BEFORE the charged POST so a lost response
          // replays the same idempotency key instead of creating a second job.
          await recordImageState(bgDir, filename, current, 'prepared', '', '', true)
          const result = await imageProvider!.generateImage({
            prompt: finalPrompt, apiKey, aspectRatio, modelId: resolvedModelConfig.api_model || modelName, providerParams,
            ...(outputOption ? { resolution: outputOption.resolution } : { width: renderWidth, height: renderHeight }),
            seed: req.seed,
            ...(sceneReferences.length ? { referenceImagePaths: sceneReferences } : {}),
            ...(sceneOutputFormat ? { outputFormat: sceneOutputFormat } : {}),
            idempotencyIdentity: `${project_slug}:${episode_id}:scene:${scene.number}:image:${current.scope}`,
            priority: 'background',
            onQueueState: state => publishImageQueueState(key, label, state),
            isCancelled: () => jq.isCancelled(job.job_id),
            onJobAccepted: async (taskId, idempotencyKey) => {
              acceptedTaskId = taskId
              acceptedKey = idempotencyKey
              await recordImageState(bgDir, filename, current, 'accepted', taskId, idempotencyKey, true)
            },
          })
          const urls = result.urls
          if (!urls.length) throw new Error(`${imageProvider!.meta.name} returned no image URL`)
          // Record the provider task id BEFORE downloading. Reasoning: even if
          // a download fails halfway, the manifest still points at the
          // (already-charged) provider job, so the Repair button can recover
          // the rest without billing the user a second time. Same record per
          // variant — the reconciler picks the right URL by parsing the _vN
          // suffix at recovery time.
          if (result.taskId) {
            await Promise.all(urls.map((_, i) => recordImageState(
              bgDir, `${stem}_v${i + 1}.png`, current, 'succeeded', result.taskId!, acceptedKey,
            )))
          }
          for (let i = 0; i < urls.length; i++) {
            await saveGenStudioImage(urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb(), { compress: !!sceneOutputFormat, trashDir: trashDirFor(bgDir, 'scene-images') })
          }
          completedCount++
          job.output_lines.push(`Scene ${scene.number}/${totalToProcess}: ${scene.title} — saved ${urls.length} variant(s)`)
          return
        } catch (e: any) {
          if (isGenStudioPaymentRefusal(e)) throw e
          // Remember a settled provider failure so the next Retry mints a fresh
          // identity instead of replaying this dead job forever.
          //
          // **Not for a job the gateway still holds as an unknown outcome**: it may yet be adopted
          // as `succeeded`, and marking it dead here would mint a fresh identity on the next Retry
          // and render the scene twice.
          if (e instanceof GenStudioImageTerminalFailureError && attempt && !e.unknownOutcome) {
            await recordImageState(bgDir, filename, attempt, 'failed', e.jobId || acceptedTaskId, acceptedKey)
          }
          // The failures worth asking again about: a route that declined the
          // request, and — new in v1.4.26 — a fleet with no free machine. Both
          // prove no provider did any work and the reservation came back whole,
          // so another attempt costs time and nothing else. Every other
          // terminal code may describe work a provider already performed, gets
          // no plan, and fails fast below rather than being paid for twice.
          // See `imageRetryPlan` for the argument and the two schedules.
          const plan = imageRetryPlan(e, attemptNum)
          // Never scheduled once the job is being torn down. A pause is the
          // owner's instruction too, and a busy-fleet wait runs into minutes —
          // do not sit out one he has already stopped. Cancellation is checked
          // here, aborts the wait itself, and is checked again after it.
          const fleetBusy = isFleetBusyFailure(e, 'image')
          if (plan && attempt && !jq.isCancelled(job.job_id)
            && !(fleetBusy && jq.isPauseRequested(job.job_id))) {
            const { waitMs, reason, maxAttempts } = plan
            activeItems.set(key, {
              label,
              key,
              state: 'waiting_retry',
              attempt: attemptNum,
              max_attempts: maxAttempts,
              retry_at: new Date(Date.now() + waitMs).toISOString(),
              reason,
            })
            publishProgress()
            job.output_lines.push(isFreeMacPlan(plan) ? `  ${freeMacWaitLine(`Scene ${scene.number}`, e, waitMs)}` :
              `  Scene ${scene.number}: ${reason.toLowerCase()} — nothing was charged.`
              + ` Retrying in ${Math.round(waitMs / 1000)}s (attempt ${attemptNum + 1} of ${maxAttempts}).`,
            )
            // Derived from the job that just failed, so this retry is
            // repeatable: replaying it returns the job GenStudio already has
            // for it instead of selling a second one. Reuses the same
            // deterministic promotion a manual Retry performs across job
            // runs — see `deriveRouteRetryAttempt`. Chosen over minting a
            // fresh identity (what subtitles.ts must do, having no such chain)
            // precisely because a crash between the wait and the resubmission
            // must not turn one retry into two charges.
            attempt = deriveRouteRetryAttempt(attempt, e.jobId || acceptedTaskId, finalPrompt)
            // v1.4.35 — the fleet-busy wait now ends on Pause too. Both
            // schedules used to share `cancelController`, which the 500ms
            // watcher aborts on CANCEL ONLY, so a Pause pressed mid-wait slept
            // out the remaining time (up to five minutes) before the gate below
            // saw it. Branching here rather than widening that controller keeps
            // the ROUTE-exhaustion path byte-identical: it has never checked
            // pause, and waking it early would turn its paced retry into an
            // immediate one.
            if (fleetBusy) {
              await waitUnlessStopped(
                waitMs,
                () => jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id),
              )
            } else {
              await delayUnlessAborted(waitMs, cancelController.signal)
            }
            if (jq.isCancelled(job.job_id)) {
              job.output_lines.push('  Cancelled.')
              return
            }
            if (fleetBusy && jq.isPauseRequested(job.job_id)) {
              job.output_lines.push('  Paused.')
              return
            }
            activeItems.set(key, {
              label, key, state: 'running', attempt: attemptNum + 1, max_attempts: maxAttempts,
            })
            publishProgress()
            continue
          }
          failedCount++
          job.output_lines.push(`Scene ${scene.number}/${totalToProcess}: FAILED — ${e.message}`)
          errors.push(`Scene ${scene.number}: ${e.message}`)
          failedItems.add(`Scene ${scene.number}`)
          noteDeterministicRefusal(e)
          return
        }
      }
    } finally {
      activeItems.delete(key)
      publishProgress()
    }
  }

  async function runThumb(thumb: { number: number; title: string; prompt: string }) {
    const stem = `${episode_id.toUpperCase()}_Thumb${thumb.number.toString().padStart(2, '0')}`
    const v1Path = path.join(thumbDir, `${stem}_v1.png`)
    const filename = `${stem}_v1.png`
    const existingArtifactEntry = thumbManifest.tasks[filename]
    const submitPermission = existingArtifactEntry
      ? await jq.getPaidImageReplacementSubmitPermission(job, filename, thumbDir, filename, existingArtifactEntry)
      : null
    const submittedArtifactPermission = existingArtifactEntry
      ? jq.getPaidImageReplacementArtifactPermission(job, filename, thumbDir, filename, existingArtifactEntry)
      : null
    const existingArtifactIsUsable = await fileExistsWithContent(v1Path)
    const paidArtifactIsDecodable = (submitPermission || submittedArtifactPermission) && await isDecodableImage(v1Path)
    const reconcilePaidArtifact = paidArtifactIsDecodable && submittedArtifactPermission
    const skipExistingArtifact = paidArtifactIsDecodable || (!req.thumb_number && !force && !submitPermission)
    if (existingArtifactIsUsable && skipExistingArtifact) {
      if (reconcilePaidArtifact) {
        await jq.checkpointPaidImageReplacementAttempt(job, filename, {
          state: 'succeeded', replacement_task_id: submittedArtifactPermission.replacement_task_id,
        })
      }
      job.output_lines.push(`Skipping ${stem} (exists)`)
      completedCount++
      publishProgress()
      return
    }
    // Auto-recovery (same as runScene above) — reclaim a previously-submitted
    // task before charging for a fresh submit, but never reopen a job GenStudio
    // already settled, and never treat an unconfirmed outcome as "nothing was
    // submitted". Inside the try so one thumbnail cannot abort the batch.
    const key = `thumb-${thumb.number}`
    const label = `Thumbnail ${thumb.number}`
    activeItems.set(key, { label, key, state: 'running', attempt: 1, max_attempts: IMAGE_ROUTE_RETRY_MAX_ATTEMPTS })
    publishProgress()
    try {
      if (savedThumbnailReference?.id && !hasSavedThumbnailReference && !existingArtifactEntry?.original_reference_inputs) {
        throw new Error('The saved thumbnail reference is unavailable locally. Re-upload it in Thumbnail Prompts before generating.')
      }
      // The thumbnail prompt already carries its (format-aware) title-text
      // directive from image-prompts.ts — render it verbatim. Character
      // name-matching and style keywords operate on the same prompt.
      // For thumbnails, multi-source img2img refs use the same resolver
      // — master + chars stack additively. Per-scene refs use the thumb
      // number bucket, chain mode reads thumb N-1's render. Most users
      // will only set master + chars for thumbnails since chain
      // continuity matters less for a 1-shot title card. Resolved ONCE —
      // none of it changes between a route-exhaustion retry's attempts.
      const styleKeywords = resolveSceneStyleKeywords(thumb.prompt)
      // v1.0.416 — optional render-time guidance from the generator tab,
      // appended before style keywords so it influences the image without
      // editing the stored prompt.
      const extra = (req.extra_details || '').trim()
      const hasThumbnailReference = hasSavedThumbnailReference || (refSources.thumbnail && existsSync(thumbnailRefPath()))
      const referenceGuidance = hasSavedThumbnailReference
        ? savedThumbnailReferenceGuidanceFor(projectRootDir, savedThumbnailReference)
        : hasThumbnailReference ? thumbnailReferenceGuidance(referenceStrength) : ''
      // ONE assembly, shared with the character ceiling the thumbnail prompt
      // was written under, so the prompt that was measured and the prompt the
      // model receives are the same text.
      const finalPrompt = assembleThumbnailRenderPrompt(thumb.prompt, {
        extraDetails: extra,
        referenceGuidance,
        styleKeywords,
      })
      const strengthValue = thumbnailReferenceStrengthValue(referenceStrength)
      const thumbProviderParams = hasThumbnailReference
        ? { ...providerParams, image_strength: strengthValue }
        : providerParams
      const persistedOriginal = thumbManifest.tasks[filename]
      const paidSelector = persistedOriginal?.original_output_selector || (paidThumbnailSelector ? {
        ...paidThumbnailSelector,
        reference_mode: hasSavedThumbnailReference ? 'reference-guided' as const : 'normal' as const,
      } : null)
      const paidReferences = persistedOriginal?.original_reference_inputs && persistedOriginal.original_reference_identity_hash
        ? { inputs: persistedOriginal.original_reference_inputs, identity_hash: persistedOriginal.original_reference_identity_hash }
        : paidSelector
        ? capturePaidImageReferenceIdentity(
            paidProjectRoot,
            hasSavedThumbnailReference ? [{ role: 'thumbnail-reference', path: savedThumbnailReferencePath }] : [],
          )
        : null

      let attempt: DurableImageAttempt | null = null
      let zeroSettlementRetryPending = false
      let retryDecisionScope: string | undefined
      let currentDecisionOrdinal: number | undefined
      let currentMaxRetries: number | undefined
      for (let attemptNum = 1; ; attemptNum++) {
        let acceptedTaskId = ''
        let acceptedKey = ''
        let releasedZeroSettlementRetry = false
        try {
          // The ceiling for the model that will render this, read live from the
          // catalogue together with the model. What the model RECEIVES is the
          // assembled prompt — the stored prompt plus the render guidance plus
          // the style keywords — so that is what is measured, never the stored
          // text on its own.
          //
          // Refused here, before anything is submitted, so no request and no
          // credit charge is made. The refusal is TYPED: the same stored prompt
          // fails the same way every time, so an automatic retry can only
          // re-learn the same answer.
          assertPromptWithinCap(finalPrompt, resolvedModelConfig.prompt_char_cap, {
            modelLabel: resolvedModelConfig.label || modelName,
            what: `the assembled thumbnail prompt for Thumbnail ${thumb.number}`,
          })
          if (attemptNum === 1) {
            const currentManifest = await readManifest(thumbDir).catch(() => thumbManifest)
            const existing = currentManifest.tasks[filename] || null
            const baseScope = force ? `force:${generationActionId || job.job_id}` : 'default'
            const durablePermission = existing
              ? await jq.getPaidImageReplacementSubmitPermission(job, filename, thumbDir, filename, existing)
              : null
            const submittedRecoveryCandidate = existing
              ? jq.getPaidImageReplacementRecoveryEntry(job, filename, thumbDir, filename, existing)
              : null
            const submittedRecoveryEntry = submittedRecoveryCandidate
              && (!durablePermission || !submittedRecoveryCandidate.idempotency_key)
              ? submittedRecoveryCandidate
              : null
            let committedScope = durablePermission?.replacement_scope || ''
            const sameAction = !force || logicalPaidScope(existing, existing?.request_scope || '').split(':retry:')[0] === baseScope
            if (sameAction && !freeFleet && !committedScope && !submittedRecoveryEntry && paidSelector && existing && isTerminalGenStudioImageTaskFailure(existing) && existing.original_output_selector) {
              const decision = await decidePaidImageReplacement({
                job,
                asset: {
                  assetKey: filename, manifestDir: thumbDir, manifestKey: filename, outputPath: v1Path,
                  owningRoot: paidProjectRoot, referenceRoot: paidProjectRoot, outputRoot: thumbDir,
                  trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(existing, baseScope) },
                  modelId: resolvedModelConfig.api_model || modelName, apiKey,
                },
              })
              if (decision.action === 'wait') {
                paidImageWaitRequested = true
                await jq.checkpointJobState(job)
                return
              }
              if (decision.action === 'recover-original') {
                if (await fileExistsWithContent(v1Path)) { completedCount++; return }
                throw new Error('The original task may still be recoverable; no replacement was submitted.')
              }
              if (decision.action === 'blocked') {
                await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
                jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                throw new Error(jq.paidImageReplacementBlockedMessage(decision.public_reason))
              }
              if (decision.action === 'safe-zero-settlement-retry' || decision.action === 'retry') {
                zeroSettlementRetryPending = true
                if (decision.action === 'retry' && decision.scope) {
                  retryDecisionScope = decision.scope
                  currentDecisionOrdinal = decision.attempt_ordinal
                  currentMaxRetries = decision.max_retries
                }
              }
              if (decision.action === 'commit') committedScope = decision.scope
            }
            attempt = submittedRecoveryEntry ? {
              recovery: await tryRecoverImageFromManifestEntry(
                submittedRecoveryEntry, apiKey, resolvedModelConfig, () => jq.isCancelled(job.job_id),
              ),
              scope: existing!.replacement_scope!, inputHash: existing!.input_hash!,
              submittedAt: existing!.submitted_at, notes: [], baseScope,
              original: {
                original_output_selector: existing!.original_output_selector,
                original_reference_inputs: existing!.original_reference_inputs,
                original_reference_identity_hash: existing!.original_reference_identity_hash,
                original_output_path: existing!.original_output_path,
              },
              paidReplacement: true,
              paidRecovery: true,
            } : committedScope ? {
              recovery: { kind: 'no-saved-job' }, scope: committedScope, inputHash: existing!.input_hash!,
              submittedAt: existing!.submitted_at, notes: [], baseScope,
              original: {
                original_output_selector: existing!.original_output_selector,
                original_reference_inputs: existing!.original_reference_inputs,
                original_reference_identity_hash: existing!.original_reference_identity_hash,
                original_output_path: existing!.original_output_path,
              },
              paidReplacement: true,
            } : await prepareImageAttempt(
              thumbDir, currentManifest, filename, finalPrompt,
              paidSelector && paidReferences ? { selector: paidSelector, references: paidReferences, outputPath: v1Path } : undefined,
              retryDecisionScope,
            )
          }
          const current = attempt!
          if (current.paidRecovery && (current.recovery.kind === 'terminal-failed' || current.recovery.kind === 'artifact-unavailable')) {
            const terminalRecovery = current.recovery
            const recoveryEntry = (await readManifest(thumbDir)).tasks[filename]!
            const acceptedEntry = jq.getPaidImageReplacementRecoveryEntry(job, filename, thumbDir, filename, recoveryEntry)
            if (!acceptedEntry) throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
            if (acceptedEntry.idempotency_key) {
              await checkpointGenStudioAsset(job, filename, {
                operation: 'image', idempotency_key: acceptedEntry.idempotency_key, job_id: terminalRecovery.taskId,
                output_path: v1Path, input_hash: current.inputHash, state: 'failed',
              })
            }
            await jq.checkpointPaidImageReplacementAttempt(job, filename, {
              state: 'failed', replacement_task_id: terminalRecovery.taskId, reason: terminalRecovery.reason,
            })
            throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
          }
          if (!freeFleet && paidSelector && (current.recovery.kind === 'terminal-failed' || current.recovery.kind === 'artifact-unavailable')) {
            const failedEntry = (await readManifest(thumbDir)).tasks[filename]!
            const decision = await decidePaidImageReplacement({
              job,
              asset: {
                assetKey: filename, manifestDir: thumbDir, manifestKey: filename, outputPath: v1Path,
                owningRoot: paidProjectRoot, referenceRoot: paidProjectRoot, outputRoot: thumbDir,
                trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(failedEntry, current.baseScope) },
                modelId: resolvedModelConfig.api_model || modelName, apiKey,
              },
            })
            if (decision.action === 'wait') {
              paidImageWaitRequested = true
              return
            }
            if (decision.action === 'blocked') {
              await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
              jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
              throw new Error(jq.paidImageReplacementBlockedMessage(decision.public_reason))
            }
            if (decision.action === 'safe-zero-settlement-retry' || decision.action === 'retry') {
              zeroSettlementRetryPending = true
              if (decision.action === 'retry' && decision.scope) {
                retryDecisionScope = decision.scope
                currentDecisionOrdinal = decision.attempt_ordinal
                currentMaxRetries = decision.max_retries
              }
            }
          }
          if (current.recovery.kind === 'uncertain') {
            if (current.paidRecovery) throw new Error(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
            throw uncertainRecoveryError(current.recovery)
          }
          for (const note of current.notes) job.output_lines.push(`Thumbnail ${thumb.number}: ${note}`)
          if (current.recovery.kind === 'recovered') {
            const recovered = current.recovery
            for (let i = 0; i < recovered.urls.length; i++) {
              await saveGenStudioImage(recovered.urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb(), { compress: !!thumbOutputFormat, trashDir: trashDirFor(thumbDir, 'thumbnails') })
            }
            if (current.paidRecovery) {
              await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                state: 'succeeded', replacement_task_id: recovered.taskId,
              })
            } else {
              await recordImageState(thumbDir, filename, current, 'succeeded', recovered.taskId, '')
            }
            completedCount++
            job.output_lines.push(
              `Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — recovered ` +
              `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
            )
            return
          }
          const replacementEntry = current.paidReplacement
            ? (await readManifest(thumbDir)).tasks[filename]!
            : null
          const verifiedReplacement = replacementEntry
            ? readPaidImageOriginalRequest(
                replacementEntry, paidProjectRoot,
                { prompt: finalPrompt, baseScope: logicalPaidScope(replacementEntry, current.baseScope) }, thumbDir,
              )
            : null
          const requestSelector = verifiedReplacement?.selector || paidSelector
          const requestReferences = verifiedReplacement
            ? verifiedReplacement.references.map(reference => reference.path)
            : (hasSavedThumbnailReference ? [savedThumbnailReferencePath] : [])
          const preparedKey = buildGenStudioImageIdempotencyKey({
            prompt: finalPrompt, modelId: resolvedModelConfig.api_model || modelName,
            aspectRatio: requestSelector?.aspect_ratio || aspectRatio,
            ...(requestSelector ? { resolution: requestSelector.resolution } : { width: renderWidth, height: renderHeight }),
            seed: req.seed,
            requestIdentity: current.paidReplacement
              ? current.scope
              : `${project_slug}:${episode_id}:thumbnail:${thumb.number}:image:${current.scope}`,
            ...(thumbOutputFormat ? { outputFormat: thumbOutputFormat } : {}),
          })
          if (!current.paidReplacement) {
            await recordImageState(thumbDir, filename, current, 'prepared', '', preparedKey, true)
            await checkpointGenStudioAsset(job, filename, {
              operation: 'image', idempotency_key: preparedKey, output_path: v1Path,
              input_hash: current.inputHash, state: 'prepared',
            })
          }
          const result = await imageProvider!.generateImage({
            prompt: finalPrompt, apiKey, aspectRatio: requestSelector?.aspect_ratio || aspectRatio,
            modelId: resolvedModelConfig.api_model || modelName, providerParams: thumbProviderParams,
            ...(requestSelector ? { resolution: requestSelector.resolution } : { width: renderWidth, height: renderHeight }),
            seed: req.seed,
            ...(requestReferences.length ? { referenceImagePaths: requestReferences } : {}),
            ...(thumbOutputFormat ? { outputFormat: thumbOutputFormat } : {}),
            idempotencyIdentity: current.paidReplacement
              ? current.scope
              : `${project_slug}:${episode_id}:thumbnail:${thumb.number}:image:${current.scope}`,
            idempotencyKey: preparedKey,
            ...(current.paidReplacement && replacementEntry ? {
              beforeSubmit: () => jq.assertPaidImageReplacementSubmitPermission(
                job, filename, thumbDir, filename, replacementEntry,
              ),
            } : zeroSettlementRetryPending ? {
              beforeSubmit: assertReleasedZeroSettlementImageRetrySubmit,
            } : {}),
            onQueueState: state => publishImageQueueState(key, label, state),
            isCancelled: () => jq.isCancelled(job.job_id),
            onJobAccepted: async (taskId, idempotencyKey) => {
              acceptedTaskId = taskId
              acceptedKey = idempotencyKey
              if (current.paidReplacement) {
                const currentPaid = job.paid_image_replacement_attempts?.find(attempt => attempt.asset_key === filename)
                if (currentPaid?.state === 'committed') {
                  await jq.checkpointPaidImageReplacementAttempt(job, filename, { state: 'submitted', replacement_task_id: taskId })
                } else if (currentPaid?.state !== 'submitted' || currentPaid.replacement_task_id !== taskId) {
                  throw new Error('Paid image replacement replay returned a different provider task.')
                }
              } else {
                await recordImageState(thumbDir, filename, current, 'accepted', taskId, idempotencyKey, true)
              }
              await checkpointGenStudioAsset(job, filename, {
                operation: 'image', idempotency_key: idempotencyKey, job_id: taskId,
                output_path: v1Path, input_hash: current.inputHash, state: 'accepted',
              })
            },
          })
          const urls = result.urls
          if (!urls.length) throw new Error(`${imageProvider!.meta.name} returned no image URL`)
          if (result.taskId && !current.paidReplacement) {
            await Promise.all(urls.map((_, i) => recordImageState(
              thumbDir, `${stem}_v${i + 1}.png`, current, 'succeeded', result.taskId!, acceptedKey,
            )))
          }
          for (let i = 0; i < urls.length; i++) {
            await saveGenStudioImage(urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb(), { compress: !!thumbOutputFormat, trashDir: trashDirFor(thumbDir, 'thumbnails') })
          }
          if (current.paidReplacement) {
            const actualSettledCredits = authoritativePaidImageSettledCredits(result.settledCredits)
            await jq.checkpointPaidImageReplacementAttempt(job, filename, {
              state: 'succeeded', replacement_task_id: result.taskId || acceptedTaskId,
              ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
            })
          }
          completedCount++
          job.output_lines.push(`Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — saved ${urls.length} variant(s)`)
          return
        } catch (e: any) {
          if (isGenStudioPaymentRefusal(e)) throw e
          if (e instanceof GenStudioImageTerminalFailureError && attempt) {
            const failedTaskId = e.jobId || acceptedTaskId
            if (attempt.paidReplacement) {
              const currentPaid = job.paid_image_replacement_attempts?.find(candidate => candidate.asset_key === filename)
              if (!failedTaskId || !acceptedKey) {
                throw new Error('Paid image replacement terminal failure lacked a provider task identity or accepted idempotency key.')
              }
              if (currentPaid?.state !== 'submitted' || currentPaid.replacement_task_id !== failedTaskId) {
                throw new Error('Paid image replacement terminal failure did not match the durably submitted provider task.')
              }
              await checkpointGenStudioAsset(job, filename, {
                operation: 'image', idempotency_key: acceptedKey, job_id: failedTaskId,
                output_path: v1Path, input_hash: attempt.inputHash, state: 'failed',
              })
              const actualSettledCredits = authoritativePaidImageSettledCredits(e.settledCredits)
              await jq.checkpointPaidImageReplacementAttempt(job, filename, {
                state: 'failed', replacement_task_id: failedTaskId, reason: e.message,
                ...(actualSettledCredits !== undefined ? { actual_settled_credits: actualSettledCredits } : {}),
              })
              failedCount++
              job.output_lines.push(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
              errors.push(jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE)
              failedItems.add(`Thumbnail ${thumb.number}`)
              return
            } else {
              await recordImageState(thumbDir, filename, attempt, 'failed', failedTaskId, acceptedKey, true)
              if (failedTaskId && acceptedKey) {
                await checkpointGenStudioAsset(job, filename, {
                  operation: 'image', idempotency_key: acceptedKey, job_id: failedTaskId,
                  output_path: v1Path, input_hash: attempt.inputHash, state: 'failed',
                })
              }
              if (paidSelector) {
                const failedEntry = (await readManifest(thumbDir)).tasks[filename]!
                const decision = await decidePaidImageReplacement({
                  job,
                  asset: {
                    assetKey: filename, manifestDir: thumbDir, manifestKey: filename, outputPath: v1Path,
                    owningRoot: paidProjectRoot, referenceRoot: paidProjectRoot, outputRoot: thumbDir,
                    trustedOriginal: { prompt: finalPrompt, baseScope: logicalPaidScope(failedEntry, attempt.baseScope) },
                    modelId: resolvedModelConfig.api_model || modelName, apiKey,
                  },
                })
                releasedZeroSettlementRetry = isReleasedZeroSettlementImageRetry(e, decision)
                zeroSettlementRetryPending ||= releasedZeroSettlementRetry
                if (decision.action === 'retry' && decision.scope) {
                  retryDecisionScope = decision.scope
                  currentDecisionOrdinal = decision.attempt_ordinal
                  currentMaxRetries = decision.max_retries
                }
                if (decision.action === 'wait') {
                  paidImageWaitRequested = true
                  return
                }
                if (decision.action === 'blocked') {
                  await jq.checkpointPaidImageReplacementBlockedIfPresent(job, filename, decision.reason, decision.public_reason)
                  jq.recordPaidImageReplacementPublicReason(job, decision.public_reason)
                  job.output_lines.push(jq.paidImageReplacementBlockedMessage(decision.public_reason))
                }
              }
            }
          }
          // Fleet-busy and route refusals follow `imageRetryPlan`; a fully
          // refunded, policy-approved terminal failure keeps retrying with backoff.
          const plan = imageRetryPlan(e, attemptNum)
            || (releasedZeroSettlementRetry
              ? { waitMs: imageRouteRetryDelayMs(attemptNum - 1), reason: 'The failed image was fully refunded', maxAttempts: (currentMaxRetries ?? 3) + 1 }
              : null)
          const fleetBusy = isFleetBusyFailure(e, 'image')
          const stoppableRetry = fleetBusy || releasedZeroSettlementRetry
          if (plan && attempt && !jq.isCancelled(job.job_id)
            && !(stoppableRetry && jq.isPauseRequested(job.job_id))) {
            const { waitMs, reason, maxAttempts } = plan
            const ordinal = currentDecisionOrdinal ?? attemptNum
            const maxOrd = currentMaxRetries ?? (maxAttempts - 1)
            activeItems.set(key, {
              label,
              key,
              state: 'waiting_retry',
              attempt: ordinal,
              max_attempts: maxOrd + 1,
              retry_at: new Date(Date.now() + waitMs).toISOString(),
              reason,
            })
            publishProgress()
            job.output_lines.push(isFreeMacPlan(plan) ? `  ${freeMacWaitLine(`Thumbnail ${thumb.number}`, e, waitMs)}` :
              `  Thumbnail ${thumb.number}: ${reason.toLowerCase()} — nothing was charged.`
              + ` Retrying in ${Math.round(waitMs / 1000)}s (retry attempt ${ordinal} of ${maxOrd}).`,
            )
            attempt = deriveRouteRetryAttempt(attempt, e.jobId || acceptedTaskId, finalPrompt, retryDecisionScope)
            // v1.4.35 — the fleet-busy wait now ends on Pause too. Both
            // schedules used to share `cancelController`, which the 500ms
            // watcher aborts on CANCEL ONLY, so a Pause pressed mid-wait slept
            // out the remaining time (up to five minutes) before the gate below
            // saw it. Branching here rather than widening that controller keeps
            // the ROUTE-exhaustion path byte-identical: it has never checked
            // pause, and waking it early would turn its paced retry into an
            // immediate one.
            if (stoppableRetry) {
              await waitUnlessStopped(
                waitMs,
                () => jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id),
              )
            } else {
              await delayUnlessAborted(waitMs, cancelController.signal)
            }
            if (jq.isCancelled(job.job_id)) {
              job.output_lines.push('  Cancelled.')
              return
            }
            if (stoppableRetry && jq.isPauseRequested(job.job_id)) {
              job.output_lines.push('  Paused.')
              return
            }
            activeItems.set(key, {
              label, key, state: 'running', attempt: attemptNum + 1, max_attempts: maxAttempts,
            })
            publishProgress()
            continue
          }
          failedCount++
          job.output_lines.push(`Thumbnail ${thumb.number}/${totalToProcess}: FAILED — ${e.message}`)
          errors.push(`Thumbnail ${thumb.number}: ${e.message}`)
          failedItems.add(`Thumbnail ${thumb.number}`)
          noteDeterministicRefusal(e)
          return
        }
      }
    } finally {
      activeItems.delete(key)
      publishProgress()
    }
  }

  /** Run tasks with a concurrency cap (simple pool). Stops picking up new
   *  items as soon as the job is cancelled so the user isn't billed for
   *  work they already aborted — in-flight provider calls can't be
   *  interrupted but at least we won't start new ones.
   *
   *  v1.4.35 — and as soon as it is PAUSED, which it did not do before. This
   *  pool read Cancel and nothing else, so pressing Pause on an image batch
   *  stopped nothing: the workers went on buying every remaining scene and
   *  thumbnail to the end of the run. Pause now stops new items exactly the way
   *  Cancel does, and for the same reason — an in-flight provider call cannot
   *  be interrupted and its result has already been paid for, so it is allowed
   *  to finish and save rather than being thrown away. What separates the two
   *  is what happens afterwards: see the `throwIfPauseRequested` below, which
   *  settles the job as `paused` instead of `error`.
   */
  async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
    const isCancelled = () => jq.isCancelled(job.job_id)
    // Both mean "start nothing new". Named apart from `isCancelled` because the
    // two diverge after the pool drains, and conflating them there is what
    // would turn a deliberate Pause into a failed job.
    const shouldStopStarting = () => isCancelled() || jq.isPauseRequested(job.job_id) || paidImageWaitRequested
    let cursor = 0
    let active = 0
    let launched = 0
    let settled = false
    let fatalError: unknown
    // Stage independent Story assets promptly. GenStudio admission permits own
    // remote image placement; this worker count is local memory/IO fanout only.
    // UNCHANGED — this is the fan-out width, not the retry/progress work
    // above; `currentConcurrency` only mirrors it for the item_progress
    // display, it never feeds back into what `ensureWorkers` does below.
    const maxWorkers = resolveGenStudioLocalFanout(
      items.length,
      admission.burst_concurrency_ceiling,
      jq.getImageFanoutOverride(),
    )
    currentConcurrency = maxWorkers
    publishProgress()

    let resolveAll!: () => void
    const allWorkersDone = new Promise<void>(resolve => { resolveAll = resolve })
    const maybeFinish = () => {
      const ownerStopped = isCancelled() || jq.isPauseRequested(job.job_id)
      if (!settled && (ownerStopped || ((paidImageWaitRequested || fatalError || cursor >= items.length) && active === 0))) {
        settled = true
        resolveAll()
      }
    }

    async function next(): Promise<void> {
      while (cursor < items.length) {
        if (shouldStopStarting() || fatalError) return
        const i = cursor++
        try {
          await worker(items[i]!)
        } catch (error) {
          fatalError = error
          return
        }
      }
    }

    const spawnWorker = () => {
      launched++
      active++
      void next().finally(() => {
        active--
        ensureWorkers()
        maybeFinish()
      })
    }

    const ensureWorkers = () => {
      if (cursor >= items.length || shouldStopStarting() || fatalError) return
      const want = Math.min(maxWorkers, items.length - cursor + active)
      while (active < want) spawnWorker()
    }

    ensureWorkers()
    maybeFinish()

    await allWorkersDone
    if (fatalError && !paidImageWaitRequested) throw fatalError
  }

  try {
    // Scene images
    if (mode === 'scenes') {
      let filteredScenes = scenes
      if (req.scene_number) filteredScenes = filteredScenes.filter(s => s.number === req.scene_number)
      totalToProcess = filteredScenes.length
      publishProgress()
      // Chain mode forces serial execution because scene N+1 reads scene
      // N's rendered output as one of its references. Pool would fire
      // them in parallel and the chain reference would be missing on
      // every scene whose prior scene hadn't finished yet. Sort by
      // chapter number to make the chain dependency well-defined.
      const useChain = imageMode === 'img2img' && refSources.chain
      if (useChain) {
        filteredScenes = [...filteredScenes].sort((a, b) => a.number - b.number)
        job.output_lines.push(
          `Generating ${filteredScenes.length} scene image(s) SERIALLY (chain mode — each scene's render seeds the next)…`,
        )
        currentConcurrency = 1
        publishProgress()
        for (const scene of filteredScenes) {
          if (jq.isCancelled(job.job_id)) break
          // v1.4.35 — chain mode is the serial path and had the same gap as the
          // pool: Cancel stopped it, Pause did not.
          if (jq.isPauseRequested(job.job_id)) break
          await runScene(scene)
        }
      } else {
        job.output_lines.push(
          `Generating ${filteredScenes.length} scene image(s)…`,
        )
        await runPool(filteredScenes, runScene)
      }
    }

    // Thumbnail images
    if (mode === 'thumbs') {
      let thumbs = thumbnails
      if (req.thumb_number) thumbs = thumbs.filter(t => t.number === req.thumb_number)
      totalToProcess = thumbs.length
      publishProgress()
      job.output_lines.push(
        `Generating ${thumbs.length} thumbnail(s)…`,
      )
      await runPool(thumbs, runThumb)
    }
  } finally {
    clearInterval(cancelWatcher)
  }

  if (paidImageWaitRequested) return { kind: 'paid-image-wait' }

  // v1.4.35 — a paused run stops HERE, before the completion audit below.
  //
  // Without this, everything above would work and the owner would still be
  // told his job FAILED: the pool stops early on Pause, so the images he
  // deliberately did not buy are missing from disk, and `requireJobCompletion`
  // reports missing items by throwing — which the queue turns into `error`.
  // Being punished for pressing Pause is not better than Pause doing nothing;
  // it is worse, because it looks like a bug in the run.
  //
  // `throwIfPauseRequested` raises JobPausedError, which the queue settles as
  // `paused`: accepted provider work was allowed to finish and save, and Resume
  // submits only what is still missing on disk. Placed after the `finally` so
  // the cancel watcher is always cleared first, and before the audit so the
  // audit never sees a deliberately short run.
  jq.throwIfPauseRequested(job.job_id)

  // Partial-failure semantics: if ANY item failed, the job must not be
  // stamped "done" — otherwise the UI shows a green success toast while
  // the output folder is half-empty. `requireJobCompletion` below is the
  // ONE place this is enforced (it throws, same as before — the queue
  // runner in job-queue.ts still flips job.status to 'error' with the
  // collected reasons; `partial-failure.test.ts` pins that contract). A
  // cancelled job is also a terminal state — let the queue's cancel check
  // handle that at job-queue.ts:141.
  //
  // `errors` is no longer read here to short-circuit with a 3-item preview.
  // That used to bypass the completion audit entirely, so a batch with any
  // failure reported only the first 3 reasons and never said how many of
  // 333 actually succeeded. `missing` below is computed from what is
  // actually on disk — which is a superset of `errors` (it also catches a
  // scene that never got a chance to run because the job was cancelled) —
  // and `requireJobCompletion` names every missing item, up to 20, plus the
  // true completed/expected counts.
  if (errors.length) job.output_lines.push(`Completed with ${errors.length} error(s)`)
  // A deterministic refusal is named on the job itself, so the reason is not
  // only visible in the per-item lines.
  if (deterministicRefusal) job.output_lines.push(`✗ ${(deterministicRefusal as PromptLengthExceededError).message}`)
  const expectedItems = mode === 'scenes'
    ? (req.scene_number ? scenes.filter(scene => scene.number === req.scene_number) : scenes)
      .map(scene => ({ label: `Scene ${scene.number}`, path: path.join(bgDir, `${episode_id.toUpperCase()}_Scene${scene.number.toString().padStart(2, '0')}_v1.png`) }))
    : (req.thumb_number ? thumbnails.filter(thumb => thumb.number === req.thumb_number) : thumbnails)
      .map(thumb => ({ label: `Thumbnail ${thumb.number}`, path: path.join(thumbDir, `${episode_id.toUpperCase()}_Thumb${thumb.number.toString().padStart(2, '0')}_v1.png`) }))
  const outputReady = await Promise.all(expectedItems.map(item => fileExistsWithContent(item.path)))
  // An item this run FAILED is missing even when an earlier run's file is still
  // on disk: the file is not this run's output, and reporting it as verified
  // would be a green success over a refused render. The file itself is left
  // alone — it is a valid artefact, and Retry asks for the item again.
  const missing = expectedItems
    .filter((item, index) => !outputReady[index] || failedItems.has(item.label))
    .map(item => item.label)
  try {
    requireJobCompletion(job, {
      label: mode === 'scenes' ? 'Scene image generation' : 'Thumbnail generation',
      expected: expectedItems.length,
      completed: expectedItems.length - missing.length,
      missing,
      retry_hint: 'Existing images were kept. Retry generates or recovers only the missing files.',
    })
  } catch (error: any) {
    // The aggregate error is what the queue classifies. A deterministic refusal
    // must not read as a transient gap: the same stored prompt is refused the
    // same way, so re-running the batch would only reproduce it. The verified
    // files of the items that succeeded stay on disk either way, and Retry
    // still asks for the missing ones only.
    if (deterministicRefusal) nonRetryable(error)
    throw error
  }
  job.output_lines.push('All images generated successfully')
  // When the user ran mixed mode (all), reveal the parent episode dir so
  // they can see both scene + thumbnail folders side-by-side. Otherwise
  // drop them straight into the specific folder that just got populated.
  job.output_dir = mode === 'scenes' ? bgDir : mode === 'thumbs' ? thumbDir : resolvedEpDir

  // Thumbnail scoring (owner 2026-11-01): after the thumbnails are VERIFIED
  // done, queue the scoring as its own OPTIONAL job. It never fails this job
  // and never holds an upload — a scoring run that cannot score records
  // "not scored" and finishes.
  if (mode === 'thumbs' && !req.thumb_number) {
    try {
      const scoring = await jq.enqueue({
        project_slug,
        episode_id,
        type: 'thumbnail_score',
        title: `Thumbnail scoring — ${episode_id}`,
        params: { episode_id },
      })
      job.output_lines.push(`→ Queued thumbnail scoring (${scoring.job_id}). It picks the best candidate and never holds this episode up.`)
    } catch (error: any) {
      // A scoring job that could not be queued is a note, never a failure of
      // the thumbnails themselves (AGENTS §8).
      job.output_lines.push(`Thumbnail scoring was not queued (${error?.message || 'unknown error'}). The thumbnails are unaffected.`)
    }
  }
}
