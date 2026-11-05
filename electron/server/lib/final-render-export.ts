import { compileFinalRenderPacket } from './final-render-compiler.js'
import { validateFinalRenderEncode, validateRenderPacketSyntax, type RenderPacketSyntax } from './final-render-recipe.js'
import { renderHash } from './render-hash-v1.js'

import type { PreparedLateLabel } from './final-render-label-assets.js'
import type { PreparedSubtitleAssets, SubtitlePreparation } from './final-render-subtitle-assets.js'
import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities, FinalRenderEncodeEntry } from './final-render-gateway-client.js'
import type { VideoOverlay } from '../models/types.js'

export type FinalRenderAssetRole = 'base_video' | 'premixed_audio' | 'overlay' | 'frame_background' | 'logo' | 'cue_label' | 'subtitle_ass' | 'subtitle_font'
export type FinalRenderInputMode =
  | { kind: 'single' }
  | { kind: 'loop_stream' }
  | { kind: 'loop_still'; decoder: string | null }

export interface FinalRenderSourceRequirement {
  logical_id: string
  role: FinalRenderAssetRole
  source_path: string
}

export interface FinalRenderCompositionRecord {
  execution_strategy: 'whole_video'
  local_segmentation_offered: boolean
  still_tail_from_sec: number | null
  recipe_sha256: string
}

export interface FinalRenderExportDescription {
  kind: 'exportable'
  recipe: Record<string, any>
  source_requirements: FinalRenderSourceRequirement[]
  composition: FinalRenderCompositionRecord
}

export interface FinalRenderVerifiedAsset {
  logical_id: string
  role: FinalRenderAssetRole
  safe_name: string
  size_bytes: number
  sha256: string
  input_mode: FinalRenderInputMode
}

export type FinalRenderExportResult = FinalRenderExportDescription | { kind: 'local-only'; reason: string }

const HEX_COLOR = /^#[0-9A-F]{6}$/
const LATE_LABEL_MOTIONS = new Set(['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'])
const ANCHORS = new Set(['center', 'top-third', 'bottom-third', 'lower-right', 'lower-left'])
const LOGO_ANCHORS = new Set([
  'top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
])
const CONTAINERS = new Set(['mp4', 'mov', 'webm'])
const CPU_PRESETS = new Set(['ultrafast', 'medium', 'slow'])
const EFFORTS = new Set(['ultrafast', 'medium', 'slow', 'hardware'])

function local(reason: string): FinalRenderExportResult {
  return { kind: 'local-only', reason }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function closedColor(value: unknown): value is string {
  return value === 'black' || (typeof value === 'string' && HEX_COLOR.test(value))
}

function source(id: string, role: FinalRenderAssetRole, sourcePath: unknown): FinalRenderSourceRequirement | null {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.includes('\0')) return null
  return { logical_id: id, role, source_path: sourcePath }
}

/**
 * The exact six-field encode tuple, built once from the composition.
 *
 * The packet recipe and the request-scoped capability query both read this one
 * builder, so discovery and packet can never describe different encodes. A null
 * cap is "no cap", never a wildcard; a positive cap stays its exact integer.
 */
export function finalRenderEncodeTuple(opts: Readonly<CompositionOpts>): FinalRenderEncodeEntry {
  const container = opts.format as FinalRenderEncodeEntry['container']
  const codec = (opts.codec ?? 'h264') as FinalRenderEncodeEntry['requested_codec']
  const effort = (opts.encodingEffort ?? opts.quality.preset) as FinalRenderEncodeEntry['requested_effort']
  const preset = opts.quality.preset as FinalRenderEncodeEntry['quality_cpu_preset']
  return {
    container,
    requested_codec: codec,
    requested_effort: effort,
    crf: opts.quality.crf,
    quality_cpu_preset: preset,
    bitrate_kbps: opts.videoBitrateKbps ?? null,
  }
}

/**
 * The same tuple, but only when it is inside the closed bounds Story renders
 * with. `null` means this composition has no requestable encode: the caller
 * then asks the Gateway the old way and the recipe validator stays authoritative.
 */
export function finalRenderRequestedEncode(opts: Readonly<CompositionOpts>): FinalRenderEncodeEntry | null {
  const tuple = finalRenderEncodeTuple(opts)
  try {
    validateFinalRenderEncode(tuple)
    return tuple
  } catch {
    return null
  }
}

export function isStaticImagePath(mediaPath: string): boolean {
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(mediaPath)
}

function unresolvedInputMode(sourcePath: string, loop: boolean): FinalRenderInputMode {
  if (!loop) return { kind: 'single' }
  return isStaticImagePath(sourcePath)
    ? { kind: 'loop_still', decoder: null }
    : { kind: 'loop_stream' }
}

function exactOriginPlacement(layer: VideoOverlay): boolean {
  return !layer.position || (layer.position.x === '0' && layer.position.y === '0')
}

export interface FinalRenderLabelOperation {
  /** Index into `recipe.operations` this cue's stage occupies — the asset naming index. */
  index: number
  operation: Record<string, any>
  /** Distinct cue assets in manifest order (sorted logical_id), as verified-asset facts. */
  assets: Array<{ logical_id: string; safe_name: string; sha256: string; size_bytes: number }>
}

export interface LateLabelPreparation {
  labels: readonly PreparedLateLabel[]
  drawtext_cue_ids: readonly string[]
  unknown_cue_ids: readonly string[]
}

/** The logo already cut to its chosen shape at its rendered width (lib/logo-shape.ts). */
export interface PreparedLogoAsset {
  path: string
}

/**
 * Purely describes an already-resolved local composition. Compatibility is not
 * execution authority: the caller still owns profile eligibility and dispatch.
 *
 * `lateLabels` carries the cue assets already rendered by
 * `prepareFinalRenderLabelAssets` — this function does no IO of its own. When a
 * composition has image-backed cues, its local refusal reason is named exactly
 * (`contextual_cues_drawtext`, `contextual_cues_unknown_template`) so the
 * render stays local for the reason the contract gives, never a partial stage.
 *
 * `subtitles` carries the ASS document and verified bundled font closure already
 * prepared by `prepareFinalRenderSubtitleAssets`, or that preparation's failed
 * result — a failed preparation returns its own exact reason (`subtitles_font_
 * unresolved`, …) rather than the umbrella. A subtitle composition without the
 * Gateway's scoped `studio.render.subtitle.v1` capability stays local with
 * `subtitles_capability_unavailable`; without a prepared payload it stays local
 * with `subtitles_ass_unavailable`, never a partial stage.
 *
 * `logoAsset` carries the logo already cut to its chosen shape by
 * `writeShapedLogo`, at the same rendered width the recipe's scale resolves to.
 * The recipe has no shape field, so a shaped logo without that prepared asset
 * stays local with `logo_shape` rather than sending the unshaped original.
 */
export function describeFinalRenderExport(
  opts: Readonly<CompositionOpts>,
  discovery: Readonly<FinalRenderCapabilities>,
  lateLabels?: Readonly<LateLabelPreparation>,
  subtitles?: Readonly<PreparedSubtitleAssets | SubtitlePreparation>,
  logoAsset?: Readonly<PreparedLogoAsset>,
): FinalRenderExportResult {
  if (opts.subtitles?.enabled && !discovery.subtitles) return local('subtitles_capability_unavailable')
  const cues = opts.contextualCues ?? []
  if ((lateLabels?.drawtext_cue_ids.length ?? 0) > 0) return local('contextual_cues_drawtext')
  if ((lateLabels?.unknown_cue_ids.length ?? 0) > 0) return local('contextual_cues_unknown_template')
  if (cues.length > 0 && (!lateLabels || lateLabels.labels.length === 0)) return local('contextual_cues')
  if (opts.sceneEffects?.enabled) return local('scene_effects')
  if ((opts.episodeStack?.entries?.length ?? 0) > 0) return local('episode_stack')
  if (opts.segmentation?.checkpoint?.final_stage) return local('saved_final_recovery')

  if (!CONTAINERS.has(opts.format) || !CPU_PRESETS.has(opts.quality.preset)) return local('encode_settings')
  const effort = opts.encodingEffort ?? opts.quality.preset
  if (!EFFORTS.has(effort)) return local('encode_settings')
  if (!finite(opts.targetDuration) || opts.targetDuration <= 0
    || !Number.isSafeInteger(opts.w) || opts.w < 2 || opts.w % 2 !== 0
    || !Number.isSafeInteger(opts.h) || opts.h < 2 || opts.h % 2 !== 0
    || !Number.isSafeInteger(opts.quality.fps)
    || !Number.isSafeInteger(opts.quality.crf)) return local('composition_bounds')

  const sources: FinalRenderSourceRequirement[] = []
  const base = source('base', 'base_video', opts.videoInputPath)
  const audio = source('audio', 'premixed_audio', opts.premixedAudioPath)
  if (!base || !audio) return local('source_path')
  sources.push(base, audio)

  const operations: Array<Record<string, any>> = []
  const layers: NonNullable<CompositionOpts['overlays']>['layers'] = []
  if (opts.overlays?.enabled && Array.isArray(opts.overlays.layers)) {
    layers.push(...opts.overlays.layers.filter(layer => layer.enabled))
  } else if (opts.chromaKey?.enabled) {
    if (!opts.chromaKey.source_path) return local('overlay_source')
    layers.push({
      id: 'legacy-chromakey', enabled: true, source_path: opts.chromaKey.source_path,
      chroma_key: {
        color: opts.chromaKey.color || '#00FF00',
        similarity: opts.chromaKey.similarity ?? 0.15,
        blend: opts.chromaKey.blend ?? 0.1,
      },
    })
  }
  for (const [index, layer] of layers.entries()) {
    const id = `overlay_${String(index + 1).padStart(4, '0')}`
    const requirement = source(id, 'overlay', layer.source_path)
    if (!requirement) return local('overlay_source')
    if (layer.position_anchor && !ANCHORS.has(layer.position_anchor)) return local('overlay_custom_position')
    if (!layer.position_anchor && !exactOriginPlacement(layer)) return local('overlay_custom_position')
    if (layer.scale_pct !== undefined && (!finite(layer.scale_pct) || layer.scale_pct <= 0 || layer.scale_pct > 0.95)) {
      return local('overlay_scale')
    }
    const opacity = layer.opacity ?? 1
    if (!finite(opacity) || opacity < 0 || opacity > 1) return local('overlay_opacity')
    const chroma = layer.chroma_key == null ? null : {
      color: layer.chroma_key.color,
      similarity: layer.chroma_key.similarity ?? 0.15,
      blend: layer.chroma_key.blend ?? 0.1,
    }
    if (chroma && (!HEX_COLOR.test(chroma.color) || !finite(chroma.similarity)
      || chroma.similarity < 0.01 || chroma.similarity > 1
      || !finite(chroma.blend) || chroma.blend < 0 || chroma.blend > 1)) return local('overlay_chroma')
    const timeRange = layer.time_range === undefined ? null : {
      start_sec: layer.time_range.start_s,
      end_sec: layer.time_range.end_s,
    }
    if (timeRange && (!finite(timeRange.start_sec) || timeRange.start_sec < 0
      || timeRange.start_sec >= opts.targetDuration
      || (timeRange.end_sec !== null && (!finite(timeRange.end_sec)
        || timeRange.end_sec <= timeRange.start_sec || timeRange.end_sec > opts.targetDuration)))) return local('overlay_time_range')
    sources.push(requirement)
    operations.push({
      kind: 'overlay_layer',
      asset: { type: 'asset_ref', logical_id: id },
      input_mode: unresolvedInputMode(layer.source_path, layer.loop !== false),
      opacity,
      sizing: layer.scale_pct !== undefined
        ? { mode: 'width_fraction', value: layer.scale_pct }
        : { mode: layer.scale ?? 'cover' },
      placement: layer.position_anchor
        ? { mode: 'anchor', value: layer.position_anchor }
        : { mode: 'origin' },
      time_range: timeRange,
      chroma,
    })
  }

  if (opts.colorGrading?.enabled) {
    const grade = opts.colorGrading
    operations.push({
      kind: 'classic_color_grade', preset: grade.preset, brightness: grade.brightness,
      contrast: grade.contrast, saturation: grade.saturation, warmth: grade.warmth, tint: grade.tint,
    })
  }
  if (opts.vignette?.enabled) operations.push({ kind: 'classic_vignette', strength: opts.vignette.strength ?? 0.7 })
  if (opts.filmGrain?.enabled) operations.push({ kind: 'classic_film_grain', strength: Math.round(opts.filmGrain.strength ?? 15) })
  if (opts.agedArchiveFilm?.enabled) operations.push({ kind: 'aged_archive_film', strength: opts.agedArchiveFilm.strength })
  if (opts.letterbox?.enabled) {
    if (!closedColor(opts.letterbox.color)) return local('letterbox_color')
    operations.push({
      kind: 'classic_letterbox', ratio: opts.letterbox.ratio,
      mode: opts.letterbox.mode === 'cover' ? 'cover' : 'fit', color: opts.letterbox.color || 'black',
    })
  }
  if (opts.frame?.enabled) {
    const frame = opts.frame
    if (![frame.inset_pct, frame.border_width, frame.corner_radius].every(finite)
      || !closedColor(frame.border_color) || !closedColor(frame.background_color)) return local('frame_settings')
    let background: Record<string, any> = { kind: 'solid' }
    if (frame.background_path) {
      const requirement = source('frame', 'frame_background', frame.background_path)
      if (!requirement) return local('frame_source')
      sources.push(requirement)
      background = {
        kind: 'asset', asset: { type: 'asset_ref', logical_id: 'frame' },
        input_mode: unresolvedInputMode(frame.background_path, true),
      }
    }
    operations.push({
      kind: 'presentation_frame', inset_pct: frame.inset_pct, border_width: frame.border_width,
      corner_radius: frame.corner_radius, border_color: frame.border_color,
      background_color: frame.background_color, fit: frame.fit ?? 'cover', background,
    })
  }

  // Subtitle stage (studio.render.subtitle.v1): after the presentation frame
  // and before the late-label stage and logo, matching the local composition's
  // burn order (video.ts §6b sits between the frame and the logo). The ASS
  // bytes and font closure were prepared before this call; only their facts are
  // named here. Without them — or with a system face that no bundled bytes can
  // back — the composition stays local under the exact contract reason.
  if (opts.subtitles?.enabled) {
    if (subtitles && 'ok' in subtitles && !subtitles.ok) return local(subtitles.reason)
    const prepared = subtitles && 'ok' in subtitles ? subtitles.prepared : subtitles
    if (!prepared || !prepared.ass
      || typeof prepared.ass.path !== 'string' || !prepared.ass.path
      || typeof prepared.ass.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(prepared.ass.sha256)
      || !Number.isSafeInteger(prepared.ass.size_bytes) || prepared.ass.size_bytes <= 0) {
      return local('subtitles_ass_unavailable')
    }
    if (!Array.isArray(prepared.fonts) || prepared.fonts.length < 1) return local('subtitles_font_unresolved')
    const fontRecords: Array<Record<string, any>> = []
    for (const font of prepared.fonts) {
      if (typeof font.family !== 'string' || !font.family.trim()
        || font.family.includes('/') || font.family.includes('\\')) return local('subtitles_font_unresolved')
      if (typeof font.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(font.sha256)
        || !Number.isSafeInteger(font.size_bytes) || font.size_bytes <= 0
        || typeof font.path !== 'string' || !font.path) return local('subtitles_font_integrity')
      const logicalId = `subtitle_font_${String(fontRecords.length).padStart(4, '0')}`
      // The prepared list is already sorted by source bundled-manifest id; the
      // generated ids preserve that order and are the only names on the wire.
      if (font.id !== undefined && font.id !== logicalId) return local('subtitles_font_unresolved')
      sources.push({ logical_id: logicalId, role: 'subtitle_font', source_path: font.path })
      fontRecords.push({ asset: { type: 'asset_ref', logical_id: logicalId }, family: font.family, sha256: font.sha256 })
    }
    sources.push({ logical_id: 'subtitle_ass', role: 'subtitle_ass', source_path: prepared.ass.path })
    operations.push({
      kind: 'subtitle_stage',
      contract: 'studio.render.subtitle.v1',
      ass: { type: 'asset_ref', logical_id: 'subtitle_ass' },
      fonts: fontRecords,
    })
  }

  const startSec = opts.excludeIntroFromEffects && finite(opts.preSceneDuration) && opts.preSceneDuration > 0
    ? opts.preSceneDuration : null
  const endSec = finite(opts.postAudioStart) && opts.postAudioStart > 0 && opts.postAudioStart < opts.targetDuration
    ? opts.postAudioStart : null
  if (startSec !== null && startSec >= opts.targetDuration) return local('effects_gate')

  // Late-label stage (studio.render.late-label.v3, freeze revision 1): image-backed
  // `label:` cues render after the presentation frame and before the logo, exactly
  // as the local lane burns them (video.ts §6c before §7). The assets were already
  // rendered by `prepareFinalRenderLabelAssets`; this function does no IO — it only
  // names them. The naming index is the cue's ACTUAL index in recipe.operations
  // (naming_rule: "operation index c"), so ids are derived from the position the
  // op takes here, not from the count of cues. A cue composition without the
  // Gateway's late-label capability (an old Gateway) or with any out-of-contract
  // cue shape stays local with the exact reason, never a partial stage.
  if (cues.length > 0) {
    if (!discovery.late_labels) return local('contextual_cues')
    const revealCount = Math.max(2, Math.ceil(opts.quality.fps * 0.3) + 1)
    for (const prepared of lateLabels!.labels) {
      const index = operations.length
      if (index > 9999) return local('contextual_cues')
      const stem = `cue_${String(index).padStart(4, '0')}_`
      // Each ref is named once; `ref` pushes the source requirement the moment
      // the id is minted, and every field the op carries gets its own distinct id.
      const named: Record<string, { type: 'asset_ref'; logical_id: string }> = {}
      const ref = (purpose: string, file: { path: string; sha256?: string; size_bytes?: number } | null | undefined): boolean => {
        if (named[purpose] !== undefined) return false
        if (!file || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
          || typeof file.size_bytes !== 'number' || !Number.isSafeInteger(file.size_bytes) || file.size_bytes <= 0) return false
        named[purpose] = { type: 'asset_ref' as const, logical_id: `${stem}${purpose}` }
        sources.push({ logical_id: `${stem}${purpose}`, role: 'cue_label', source_path: file.path })
        return true
      }
      const revealBlock = (purpose: 'r' | 'lr', reveal: NonNullable<PreparedLateLabel['reveal']>) => {
        const frames = []
        for (let frameIndex = 0; frameIndex < reveal.frames.length; frameIndex++) {
          const file = reveal.frames[frameIndex]
          if (!ref(`${purpose}${String(frameIndex).padStart(4, '0')}`, file)) return null
          frames.push({ asset: named[`${purpose}${String(frameIndex).padStart(4, '0')}`], progress: frameIndex / (revealCount - 1) })
        }
        return { duration_sec: 0.3, frames }
      }
      const motion = prepared.motion
      const wipe = motion === 'wipe'
      const lineDraw = motion === 'line-draw'
      if (!LATE_LABEL_MOTIONS.has(motion)
        || !finite(prepared.start_sec) || !finite(prepared.end_sec)
        || prepared.start_sec < 0 || prepared.start_sec >= opts.targetDuration
        || prepared.end_sec <= prepared.start_sec || prepared.end_sec > opts.targetDuration
        || !Number.isSafeInteger(prepared.x_px) || prepared.x_px < 0
        || !Number.isSafeInteger(prepared.y_px) || prepared.y_px < 0) return local('contextual_cues')
      // Exactly the frozen per-cue invariants, checked before any ref is minted.
      if (wipe !== (prepared.label === null)) return local('contextual_cues')
      if (wipe !== (prepared.reveal !== null)) return local('contextual_cues')
      if (lineDraw !== (prepared.line_reveal !== null)) return local('contextual_cues')
      if (lineDraw && prepared.line !== null) return local('contextual_cues')
      if (prepared.reveal && (prepared.reveal.frames.length !== revealCount
        || prepared.reveal.frames.some((frame, frameIndex) => frame.progress !== frameIndex / (revealCount - 1)))) return local('contextual_cues')
      if (prepared.line_reveal && (prepared.line_reveal.frames.length !== revealCount
        || prepared.line_reveal.frames.some((frame, frameIndex) => frame.progress !== frameIndex / (revealCount - 1)))) return local('contextual_cues')
      if (prepared.label && (prepared.label.width <= 0 || prepared.label.height <= 0
        || prepared.x_px + prepared.label.width > opts.w || prepared.y_px + prepared.label.height > opts.h)) return local('contextual_cues')
      if (prepared.line && (prepared.line.width !== opts.w || prepared.line.height !== opts.h)) return local('contextual_cues')
      const labelRef = wipe ? null : ref('label', prepared.label) ? named['label'] : null
      if (!wipe && !labelRef) return local('contextual_cues')
      const reveal = wipe ? revealBlock('r', prepared.reveal!) : null
      if (wipe && !reveal) return local('contextual_cues')
      const lineRef = prepared.line ? (ref('line', prepared.line) ? named['line'] : null) : null
      if (prepared.line && !lineRef) return local('contextual_cues')
      const lineReveal = lineDraw ? revealBlock('lr', prepared.line_reveal!) : null
      if (lineDraw && !lineReveal) return local('contextual_cues')
      operations.push({
        kind: 'late_label_stage',
        contract: 'studio.render.late-label.v3',
        cue_id: prepared.cue_id,
        enable: { start_sec: prepared.start_sec, end_sec: prepared.end_sec },
        placement: { x_px: prepared.x_px, y_px: prepared.y_px },
        motion: { kind: motion, entrance_sec: 0.3 },
        // The frozen recipe takes {asset: asset_ref} for BOTH fields, never the ref bare.
        label: labelRef ? { asset: labelRef } : null,
        reveal,
        line: lineRef ? { asset: lineRef } : null,
        line_reveal: lineReveal,
      })
    }
  }

  if (opts.logo?.enabled) {
    const logo = opts.logo
    if (logo.position === 'custom') return local('logo_custom_position')
    if (logo.margin === 0) return local('logo_margin_default')
    if (!LOGO_ANCHORS.has(logo.position) || !finite(logo.opacity) || !finite(logo.scale)
      || !Number.isSafeInteger(logo.margin)) return local('logo_settings')
    const original = source('logo', 'logo', logo.image_path)
    if (!original) return local('logo_source')
    // A chosen shape was cut into a still PNG before this call; the recipe has
    // no shape field, so the mask must already be in the asset. Without it the
    // composition stays local rather than sending the unshaped logo.
    const requirement = (logo.shape ?? 'none') !== 'none'
      ? logoAsset && source('logo', 'logo', logoAsset.path)
      : original
    if (!requirement) return local('logo_shape')
    sources.push(requirement)
    operations.push({
      kind: 'logo', asset: { type: 'asset_ref', logical_id: 'logo' }, opacity: logo.opacity ?? 1,
      scale: logo.scale || 0.1, anchor: logo.position, margin_px: logo.margin || 20,
      gate: startSec !== null || endSec !== null
        ? 'effects_gate'
        : logo.hide_during_intro ? 'after_10_seconds' : 'always',
    })
  }

  const recipe = {
    namespace: 'studio.render.final.v1',
    profile_digest: discovery.profile_digest,
    base_video: { type: 'asset_ref', logical_id: 'base' },
    premixed_audio: { type: 'asset_ref', logical_id: 'audio' },
    canvas: { width: opts.w, height: opts.h, working_fps: opts.quality.fps },
    target_duration_sec: opts.targetDuration,
    effects_gate: { start_sec: startSec, end_sec: endSec },
    operations,
    encode: finalRenderEncodeTuple(opts),
  }
  try {
    const recipeSha256 = renderHash('recipe', recipe)
    return {
      kind: 'exportable', recipe, source_requirements: structuredClone(sources),
      composition: {
        execution_strategy: 'whole_video',
        local_segmentation_offered: opts.segmentation !== undefined,
        still_tail_from_sec: opts.stillTailFromSec ?? null,
        recipe_sha256: recipeSha256,
      },
    }
  } catch {
    return local('unrepresentable')
  }
}

function bindInputModes(recipe: Record<string, any>, assets: ReadonlyMap<string, FinalRenderVerifiedAsset>): void {
  for (const operation of recipe.operations as Array<Record<string, any>>) {
    if (operation.kind === 'overlay_layer') {
      operation.input_mode = structuredClone(assets.get(operation.asset.logical_id)!.input_mode)
    } else if (operation.kind === 'presentation_frame' && operation.background.kind === 'asset') {
      operation.background.input_mode = structuredClone(assets.get(operation.background.asset.logical_id)!.input_mode)
    }
  }
}

export function finalizeFinalRenderPacket(
  description: Readonly<FinalRenderExportDescription>,
  verifiedAssets: readonly FinalRenderVerifiedAsset[],
): { packet: RenderPacketSyntax; source_requirements: FinalRenderSourceRequirement[]; composition: FinalRenderCompositionRecord } {
  const requirements = description.source_requirements
  const required = new Map(requirements.map(item => [item.logical_id, item]))
  const assets = new Map<string, FinalRenderVerifiedAsset>()
  for (const asset of verifiedAssets) {
    const requirement = required.get(asset.logical_id)
    if (!requirement || requirement.role !== asset.role || assets.has(asset.logical_id)
      || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0
      || !/^[0-9a-f]{64}$/.test(asset.sha256)
      || !/^[a-z][a-z0-9_-]{0,63}\.(?:mp4|mov|webm|wav|png|jpg|webp|gif|bmp|tiff|ass|ttf|otf)$/.test(asset.safe_name)
      || !asset.input_mode
      || (asset.input_mode.kind === 'loop_still' && !asset.input_mode.decoder)) {
      throw new Error('Verified final render asset does not match the source requirements or mode facts.')
    }
    assets.set(asset.logical_id, structuredClone(asset))
  }
  if (assets.size !== required.size || [...required.keys()].some(id => !assets.has(id))) {
    throw new Error('Verified final render assets are incomplete.')
  }

  const recipe = structuredClone(description.recipe)
  bindInputModes(recipe, assets)
  const manifest = [...assets.values()]
    .map(({ logical_id, role, safe_name, size_bytes, sha256 }) => ({ logical_id, safe_name, role, sha256, size_bytes }))
    .sort((left, right) => left.logical_id < right.logical_id ? -1 : left.logical_id > right.logical_id ? 1 : 0)
  const recipeDigest = renderHash('recipe', recipe)
  const manifestDigest = renderHash('manifest', manifest)
  const packet = validateRenderPacketSyntax({
    recipe,
    manifest,
    recipe_digest: recipeDigest,
    manifest_digest: manifestDigest,
    packet_digest: renderHash('packet', { recipe_digest: recipeDigest, manifest_digest: manifestDigest }),
  })
  const localAssets = new Map([...assets.values()].map(asset => [asset.logical_id, `/private/${asset.safe_name}`]))
  compileFinalRenderPacket(packet, localAssets, '/private/final-output.mp4')
  return {
    packet,
    source_requirements: structuredClone(description.source_requirements),
    composition: { ...structuredClone(description.composition), recipe_sha256: recipeDigest },
  }
}
