import { compileFinalRenderPacket } from './final-render-compiler.js'
import { validateRenderPacketSyntax, type RenderPacketSyntax } from './final-render-recipe.js'
import { renderHash } from './render-hash-v1.js'

import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from './final-render-gateway-client.js'
import type { VideoOverlay } from '../models/types.js'

export type FinalRenderAssetRole = 'base_video' | 'premixed_audio' | 'overlay' | 'frame_background' | 'logo'
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

/**
 * Purely describes an already-resolved local composition. Compatibility is not
 * execution authority: the caller still owns profile eligibility and dispatch.
 */
export function describeFinalRenderExport(
  opts: Readonly<CompositionOpts>,
  discovery: Readonly<FinalRenderCapabilities>,
): FinalRenderExportResult {
  if (opts.subtitles?.enabled) return local('subtitles')
  if ((opts.contextualCues?.length ?? 0) > 0) return local('contextual_cues')
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

  const startSec = opts.excludeIntroFromEffects && finite(opts.preSceneDuration) && opts.preSceneDuration > 0
    ? opts.preSceneDuration : null
  const endSec = finite(opts.postAudioStart) && opts.postAudioStart > 0 && opts.postAudioStart < opts.targetDuration
    ? opts.postAudioStart : null
  if (startSec !== null && startSec >= opts.targetDuration) return local('effects_gate')

  if (opts.logo?.enabled) {
    const logo = opts.logo
    if (!logo.image_path) return local('logo_source')
    if (logo.position === 'custom') return local('logo_custom_position')
    if ((logo.shape ?? 'none') !== 'none') return local('logo_shape')
    if (logo.margin === 0) return local('logo_margin_default')
    if (!LOGO_ANCHORS.has(logo.position) || !finite(logo.opacity) || !finite(logo.scale)
      || !Number.isSafeInteger(logo.margin)) return local('logo_settings')
    const requirement = source('logo', 'logo', logo.image_path)
    if (!requirement) return local('logo_source')
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
    encode: {
      container: opts.format,
      requested_codec: opts.codec ?? 'h264',
      requested_effort: effort,
      crf: opts.quality.crf,
      quality_cpu_preset: opts.quality.preset,
      bitrate_kbps: opts.videoBitrateKbps ?? null,
    },
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
      || !/^[a-z][a-z0-9_-]{0,63}\.(?:mp4|mov|webm|wav|png|jpg|webp|gif|bmp|tiff)$/.test(asset.safe_name)
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
