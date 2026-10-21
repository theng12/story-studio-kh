import type {
  VideoAgedArchiveFilm,
  VideoColorGrading,
  VideoFilmGrain,
  VideoFrameConfig,
  VideoLetterbox,
  VideoLogoConfig,
  VideoOverlay,
  VideoVignetteConfig,
} from '../models/types.js'
import {
  buildFinalArchiveFilters,
  buildFinalEncodeTiers,
  buildFinalFilmGrainFilters,
  buildFinalInputArgs,
  buildFinalLogoFilters,
  buildFinalOverlayFilters,
  buildFinalVignetteFilters,
  describeFinalBurnIns,
  type EncodeTier,
  type FinalInputMode,
} from './final-render-core.js'
import { validateRenderPacketSyntax } from './final-render-recipe.js'
import { buildVideoFrameFilter } from './video-frame-filter.js'
import {
  buildColorGradingFilters,
  buildGateEnable,
  buildLetterboxFilter,
} from './video-effects.js'
import { letterboxBarHeight } from './scene-effect-compiler.js'

type AssetRef = { type: 'asset_ref'; logical_id: string }
type InputMode = Exclude<FinalInputMode, { kind: 'loop_still' }> | { kind: 'loop_still'; decoder: string }
type OverlayOperation = {
  kind: 'overlay_layer'
  asset: AssetRef
  input_mode: InputMode
  opacity: number
  sizing: { mode: 'cover' | 'contain' | 'native' } | { mode: 'width_fraction'; value: number }
  placement: { mode: 'origin' } | { mode: 'anchor'; value: VideoOverlay['position_anchor'] }
  time_range: { start_sec: number; end_sec: number | null } | null
  chroma: { color: string; similarity: number; blend: number } | null
}
type GradeOperation = Omit<VideoColorGrading, 'enabled'> & { kind: 'classic_color_grade' }
type VignetteOperation = { kind: 'classic_vignette'; strength: number }
type GrainOperation = { kind: 'classic_film_grain'; strength: number }
type ArchiveOperation = { kind: 'aged_archive_film'; strength: number }
type LetterboxOperation = { kind: 'classic_letterbox'; ratio: VideoLetterbox['ratio']; mode: 'fit' | 'cover'; color: string }
type FrameOperation = {
  kind: 'presentation_frame'
  inset_pct: number
  border_width: number
  corner_radius: number
  border_color: string
  background_color: string
  fit: 'cover' | 'contain'
  background: { kind: 'solid' } | { kind: 'asset'; asset: AssetRef; input_mode: InputMode }
}
type LogoOperation = {
  kind: 'logo'
  asset: AssetRef
  opacity: number
  scale: number
  anchor: Exclude<VideoLogoConfig['position'], 'custom'>
  margin_px: number
  gate: 'effects_gate' | 'after_10_seconds' | 'always'
}
type Operation = OverlayOperation | GradeOperation | VignetteOperation | GrainOperation | ArchiveOperation | LetterboxOperation | FrameOperation | LogoOperation
type Recipe = {
  base_video: AssetRef
  premixed_audio: AssetRef
  canvas: { width: number; height: number; working_fps: number }
  target_duration_sec: number
  effects_gate: { start_sec: number | null; end_sec: number | null }
  operations: Operation[]
  encode: {
    container: 'mp4' | 'mov' | 'webm'
    requested_codec: 'h264' | 'h265'
    requested_effort: 'ultrafast' | 'medium' | 'slow' | 'hardware'
    crf: number
    quality_cpu_preset: 'ultrafast' | 'medium' | 'slow'
    bitrate_kbps: number | null
  }
}
type ManifestEntry = { logical_id: string }

export type UnsupportedFinalRenderReason =
  | 'letterbox_skip'
  | 'letterbox_noop'
  | 'logo_gate_precedence'
  | 'logo_margin_default'

export class UnsupportedFinalRenderCombination extends Error {
  constructor(public readonly reason: UnsupportedFinalRenderReason) {
    super(`Unsupported final render combination: ${reason}`)
    this.name = 'UnsupportedFinalRenderCombination'
  }
}

export function compileFinalRenderPacket(
  value: unknown,
  localAssets: ReadonlyMap<string, string>,
  outputPath: string,
): { tiers: EncodeTier[]; requestedBurnIns: string[]; inputUses: { logicalId: string; index: number }[] } {
  const packet = validateRenderPacketSyntax(value)
  const recipe = packet.recipe as unknown as Recipe
  const manifest = packet.manifest as unknown as ManifestEntry[]
  if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.includes('\0')) {
    throw new Error('Invalid final render output path')
  }
  const manifestIds = new Set(manifest.map(entry => entry.logical_id))
  if (localAssets.size !== manifestIds.size) throw new Error('Final render assets must exactly match the manifest')
  for (const id of manifestIds) {
    const assetPath = localAssets.get(id)
    if (typeof assetPath !== 'string' || assetPath.length === 0 || assetPath.includes('\0')) {
      throw new Error(`Invalid local asset binding: ${id}`)
    }
  }
  for (const id of localAssets.keys()) {
    if (!manifestIds.has(id)) throw new Error(`Unexpected local asset binding: ${id}`)
  }

  const width = recipe.canvas.width
  const height = recipe.canvas.height
  const gateHasBounds = recipe.effects_gate.start_sec !== null || recipe.effects_gate.end_sec !== null
  const logoOperation = recipe.operations.find((operation): operation is LogoOperation => operation.kind === 'logo')
  const letterboxOperation = recipe.operations.find((operation): operation is LetterboxOperation => operation.kind === 'classic_letterbox')
  if (logoOperation?.margin_px === 0) throw new UnsupportedFinalRenderCombination('logo_margin_default')
  if (logoOperation && gateHasBounds && logoOperation.gate !== 'effects_gate') {
    throw new UnsupportedFinalRenderCombination('logo_gate_precedence')
  }
  if (letterboxOperation) {
    const barHeight = letterboxBarHeight(width, height, letterboxOperation.ratio)
    if (barHeight <= 0) throw new UnsupportedFinalRenderCombination('letterbox_noop')
    if (barHeight * 2 > height * 0.5) throw new UnsupportedFinalRenderCombination('letterbox_skip')
  }

  const args: string[] = ['-y']
  const inputUses: { logicalId: string; index: number }[] = []
  let nextInputIndex = 0
  const addInput = (ref: AssetRef, mode: InputMode | { kind: 'single' }): number => {
    const assetPath = localAssets.get(ref.logical_id)!
    const index = nextInputIndex++
    args.push(...buildFinalInputArgs(assetPath, mode))
    inputUses.push({ logicalId: ref.logical_id, index })
    return index
  }
  addInput(recipe.base_video, { kind: 'single' })
  const audioInputIndex = addInput(recipe.premixed_audio, { kind: 'single' })
  const logoInputIndex = logoOperation ? addInput(logoOperation.asset, { kind: 'single' }) : -1
  const overlayInputIndexes: number[] = []
  for (const operation of recipe.operations) {
    if (operation.kind === 'overlay_layer') overlayInputIndexes.push(addInput(operation.asset, operation.input_mode))
  }
  const frameOperation = recipe.operations.find((operation): operation is FrameOperation => operation.kind === 'presentation_frame')
  const frameBackgroundInputIndex = frameOperation?.background.kind === 'asset'
    ? addInput(frameOperation.background.asset, frameOperation.background.input_mode)
    : -1

  const filterParts: string[] = []
  let vIndex = 0
  const allocLabel = () => `[v${vIndex++}]`
  let vLabel = '[0:v]'
  const reset = allocLabel()
  filterParts.push(`${vLabel}setpts=PTS-STARTPTS${reset}`)
  vLabel = reset
  const gateEnable = buildGateEnable(recipe.effects_gate.start_sec ?? 0, recipe.effects_gate.end_sec ?? 0)
  const overlayLayers: VideoOverlay[] = []
  let overlayInputCursor = 0

  for (const operation of recipe.operations) {
    if (operation.kind === 'overlay_layer') {
      const layer: VideoOverlay = {
        id: operation.asset.logical_id,
        enabled: true,
        source_path: localAssets.get(operation.asset.logical_id)!,
        opacity: operation.opacity,
        scale: operation.sizing.mode === 'width_fraction' ? undefined : operation.sizing.mode,
        scale_pct: operation.sizing.mode === 'width_fraction' ? operation.sizing.value : undefined,
        position_anchor: operation.placement.mode === 'anchor' ? operation.placement.value : undefined,
        time_range: operation.time_range ? { start_s: operation.time_range.start_sec, end_s: operation.time_range.end_sec } : undefined,
        chroma_key: operation.chroma,
      }
      overlayLayers.push(layer)
      const part = buildFinalOverlayFilters(
        { input: vLabel, allocLabel }, layer, overlayInputIndexes[overlayInputCursor++]!, width, height, gateEnable,
      )
      filterParts.push(...part.filters)
      vLabel = part.output
    } else if (operation.kind === 'classic_color_grade') {
      const output = allocLabel()
      const statements = buildColorGradingFilters({ ...operation, enabled: true }, gateEnable, { input: vLabel, output, allocLabel })
      if (statements.length) {
        filterParts.push(...statements)
        vLabel = output
      }
    } else if (operation.kind === 'classic_vignette') {
      const config: VideoVignetteConfig = { enabled: true, strength: operation.strength }
      const part = buildFinalVignetteFilters({ input: vLabel, allocLabel }, config, gateEnable)
      filterParts.push(...part.filters)
      vLabel = part.output
    } else if (operation.kind === 'classic_film_grain') {
      const config: VideoFilmGrain = { enabled: true, strength: operation.strength }
      const part = buildFinalFilmGrainFilters({ input: vLabel, allocLabel }, config, gateEnable)
      filterParts.push(...part.filters)
      vLabel = part.output
    } else if (operation.kind === 'aged_archive_film') {
      const config: VideoAgedArchiveFilm = { enabled: true, strength: operation.strength }
      const part = buildFinalArchiveFilters({ input: vLabel, allocLabel }, config, width, height, gateEnable)
      filterParts.push(...part.filters)
      vLabel = part.output
    } else if (operation.kind === 'classic_letterbox') {
      const output = allocLabel()
      const filter = buildLetterboxFilter(vLabel, output, width, height, operation.ratio, operation.color, operation.mode)
      if (!filter) throw new UnsupportedFinalRenderCombination('letterbox_noop')
      filterParts.push(filter)
      vLabel = output
    } else if (operation.kind === 'presentation_frame') {
      const output = allocLabel()
      const config: VideoFrameConfig = {
        enabled: true,
        inset_pct: operation.inset_pct,
        border_width: operation.border_width,
        corner_radius: operation.corner_radius,
        border_color: operation.border_color,
        background_color: operation.background_color,
        background_path: operation.background.kind === 'asset' ? localAssets.get(operation.background.asset.logical_id) : undefined,
        fit: operation.fit,
      }
      filterParts.push(...buildVideoFrameFilter({
        inputLabel: vLabel,
        backgroundInputLabel: frameBackgroundInputIndex >= 0 ? `[${frameBackgroundInputIndex}:v]` : undefined,
        outputLabel: output,
        prefix: `mainframe${vIndex}`,
        width,
        height,
        fps: recipe.canvas.working_fps,
        config,
      }))
      vLabel = output
    } else {
      const logo: VideoLogoConfig = {
        enabled: true,
        image_path: localAssets.get(operation.asset.logical_id)!,
        position: operation.anchor,
        opacity: operation.opacity,
        scale: operation.scale,
        margin: operation.margin_px,
        hide_during_intro: operation.gate === 'after_10_seconds',
      }
      const logoGate = operation.gate === 'effects_gate' ? gateEnable : ''
      const part = buildFinalLogoFilters({ input: vLabel, allocLabel }, logo, logoInputIndex, width, height, logoGate)
      filterParts.push(...part.filters)
      vLabel = part.output
    }
  }

  filterParts.push(`${vLabel}null[vout]`)
  args.push('-filter_complex', filterParts.join(';\n'), '-map', '[vout]', '-map', `${audioInputIndex}:a`)
  const requestedBurnIns = describeFinalBurnIns({
    colorGrading: recipe.operations.some(operation => operation.kind === 'classic_color_grade'),
    vignette: recipe.operations.some(operation => operation.kind === 'classic_vignette'),
    filmGrain: recipe.operations.some(operation => operation.kind === 'classic_film_grain'),
    agedArchiveFilm: recipe.operations.some(operation => operation.kind === 'aged_archive_film'),
    letterbox: Boolean(letterboxOperation),
    frame: Boolean(frameOperation),
    overlayLayers,
    hasLogo: Boolean(logoOperation),
    subtitles: false,
    contextualCueCount: 0,
    stackEntryCount: 0,
  })
  const tiers = buildFinalEncodeTiers({
    format: recipe.encode.container,
    codec: recipe.encode.requested_codec,
    effort: recipe.encode.requested_effort,
    quality: { crf: recipe.encode.crf, preset: recipe.encode.quality_cpu_preset },
    bitrateKbps: recipe.encode.bitrate_kbps,
    preEncoderArgs: args,
    videoInputPath: localAssets.get(recipe.base_video.logical_id)!,
    premixedAudioPath: localAssets.get(recipe.premixed_audio.logical_id)!,
    targetDuration: recipe.target_duration_sec,
    outputFile: outputPath,
  })
  return { tiers, requestedBurnIns, inputUses }
}
