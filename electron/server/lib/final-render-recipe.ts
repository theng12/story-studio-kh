import { canonicalRenderValue, renderHash } from './render-hash-v1.js'

export type RenderPacketSyntax = {
  recipe: Record<string, unknown>
  manifest: Record<string, unknown>[]
  recipe_digest: string
  manifest_digest: string
  packet_digest: string
}

type JsonObject = Record<string, unknown>
type AssetRole = 'base_video' | 'premixed_audio' | 'overlay' | 'frame_background' | 'logo' | 'cue_label' | 'subtitle_ass' | 'subtitle_font'

const SHA256 = /^[0-9a-f]{64}$/
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const SAFE_NAME = /^(?<id>[a-z][a-z0-9_-]{0,63})\.(?<extension>mp4|mov|webm|wav|png|jpg|webp|gif|bmp|tiff|ass|ttf|otf)$/
const COLOR = /^(?:#[0-9A-F]{6}|black)$/
const HEX_COLOR = /^#[0-9A-F]{6}$/
const FPS = new Set([5, 24, 25, 30, 60])
const DECODERS = new Set(['png', 'mjpeg', 'webp', 'gif', 'bmp', 'tiff'])
const STAGES = [
  'overlay_layer',
  'classic_color_grade',
  'classic_vignette',
  'classic_film_grain',
  'aged_archive_film',
  'classic_letterbox',
  'presentation_frame',
  'subtitle_stage',
  'late_label_stage',
  'logo',
] as const

function invalid(reason: string): never {
  throw new Error(`Invalid render packet: ${reason}`)
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`)
  return value as JsonObject
}

function exact(value: unknown, keys: readonly string[], path: string): JsonObject {
  const result = object(value, path)
  const actual = Object.keys(result)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) {
    invalid(`${path} has missing or unknown fields`)
  }
  return result
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.includes('\0')) invalid(`${path} must be NUL-free text`)
  return value
}

function oneOf(value: unknown, allowed: readonly string[], path: string): string {
  const result = text(value, path)
  if (!allowed.includes(result)) invalid(`${path} is unsupported`)
  return result
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be finite`)
  return value
}

function integer(value: unknown, path: string): number {
  const result = number(value, path)
  if (!Number.isSafeInteger(result)) invalid(`${path} must be a safe integer`)
  return result
}

function range(value: unknown, minimum: number, maximum: number, path: string): number {
  const result = number(value, path)
  if (result < minimum || result > maximum) invalid(`${path} is out of range`)
  return result
}

function integerRange(value: unknown, minimum: number, maximum: number, path: string): number {
  const result = integer(value, path)
  if (result < minimum || result > maximum) invalid(`${path} is out of range`)
  return result
}

function assetRef(value: unknown, path: string): string {
  const ref = exact(value, ['type', 'logical_id'], path)
  if (ref.type !== 'asset_ref') invalid(`${path}.type must be asset_ref`)
  const id = text(ref.logical_id, `${path}.logical_id`)
  if (!ID.test(id)) invalid(`${path}.logical_id is invalid`)
  return id
}

function inputMode(value: unknown, path: string): void {
  const mode = object(value, path)
  if (mode.kind === 'single' || mode.kind === 'loop_stream') {
    exact(mode, ['kind'], path)
    return
  }
  if (mode.kind === 'loop_still') {
    exact(mode, ['kind', 'decoder'], path)
    if (!DECODERS.has(text(mode.decoder, `${path}.decoder`))) invalid(`${path}.decoder is unsupported`)
    return
  }
  invalid(`${path}.kind is unsupported`)
}

function effectsGate(value: unknown, duration: number, path: string): void {
  const gate = exact(value, ['start_sec', 'end_sec'], path)
  for (const key of ['start_sec', 'end_sec'] as const) {
    if (gate[key] !== null) {
      const point = number(gate[key], `${path}.${key}`)
      if (point <= 0 || point >= duration) invalid(`${path}.${key} must be interior`)
    }
  }
  if (gate.start_sec !== null && gate.end_sec !== null
      && (gate.start_sec as number) >= (gate.end_sec as number)) invalid(`${path} must be ordered`)
}

function timeRange(value: unknown, duration: number, path: string): void {
  if (value === null) return
  const interval = exact(value, ['start_sec', 'end_sec'], path)
  const start = number(interval.start_sec, `${path}.start_sec`)
  if (start < 0 || start >= duration) invalid(`${path}.start_sec is out of range`)
  if (interval.end_sec !== null) {
    const end = number(interval.end_sec, `${path}.end_sec`)
    if (end <= start || end > duration) invalid(`${path}.end_sec is out of range`)
  }
}

function addRef(refs: Map<string, AssetRole>, id: string, role: AssetRole): void {
  const existing = refs.get(id)
  if (existing !== undefined && existing !== role) invalid(`asset ${id} has incompatible roles`)
  refs.set(id, role)
}

function lateLabelRef(value: unknown, path: string, expected: string, refs: Map<string, AssetRole>): void {
  const id = assetRef(value, path)
  if (id !== expected) invalid(`${path} has an invalid late-label asset name`)
  addRef(refs, id, 'cue_label')
}

/**
 * The singleton subtitle stage (`studio.render.subtitle.v1`): one ASS document
 * plus its verified bundled font closure. Font ids are the generated
 * `subtitle_font_<4-digit>` names in ascending order — the deterministic order
 * Story mints them in (sorted by the source bundled-manifest id) — so a reader
 * never sees a source filename, bracketed or otherwise, and the list order is
 * fixed on the wire. Every font record's sha256 must equal its manifest hash;
 * that equality is checked in the manifest loop below, where the staged bytes
 * are known.
 */
function subtitleOperation(value: unknown, refs: Map<string, AssetRole>, index: number): void {
  const path = `recipe.operations[${index}]`
  const op = exact(value, ['kind', 'contract', 'ass', 'fonts'], path)
  if (op.kind !== 'subtitle_stage' || op.contract !== 'studio.render.subtitle.v1') invalid(`${path} contract is unsupported`)
  addRef(refs, assetRef(op.ass, `${path}.ass`), 'subtitle_ass')
  if (!Array.isArray(op.fonts) || op.fonts.length < 1) invalid(`${path}.fonts must be a nonempty array`)
  op.fonts.forEach((raw, fontIndex) => {
    const fontPath = `${path}.fonts[${fontIndex}]`
    const font = exact(raw, ['asset', 'family', 'sha256'], fontPath)
    const id = assetRef(font.asset, `${fontPath}.asset`)
    if (id !== `subtitle_font_${String(fontIndex).padStart(4, '0')}`) {
      invalid(`${fontPath}.asset must be the ordered generated font id`)
    }
    addRef(refs, id, 'subtitle_font')
    const family = text(font.family, `${fontPath}.family`)
    // The family is the bundled manifest's family name, never a filesystem path.
    if (!family.trim() || family.includes('/') || family.includes('\\')) invalid(`${fontPath}.family is invalid`)
    if (!SHA256.test(text(font.sha256, `${fontPath}.sha256`))) invalid(`${fontPath}.sha256 is invalid`)
  })
}

function lateLabelOperation(value: unknown, duration: number, refs: Map<string, AssetRole>, index: number, fps: number): void {
  const path = `recipe.operations[${index}]`
  const op = exact(value, ['kind', 'contract', 'cue_id', 'enable', 'placement', 'motion', 'label', 'reveal', 'line', 'line_reveal'], path)
  if (op.kind !== 'late_label_stage' || op.contract !== 'studio.render.late-label.v3') invalid(`${path} contract is unsupported`)
  const cueId = text(op.cue_id, `${path}.cue_id`)
  if (!ID.test(cueId)) invalid(`${path}.cue_id is invalid`)
  const enable = exact(op.enable, ['start_sec', 'end_sec'], `${path}.enable`)
  const start = number(enable.start_sec, `${path}.enable.start_sec`)
  const end = number(enable.end_sec, `${path}.enable.end_sec`)
  if (start < 0 || start >= duration || end <= start || end > duration) invalid(`${path}.enable is out of range`)
  const placement = exact(op.placement, ['x_px', 'y_px'], `${path}.placement`)
  if (integer(placement.x_px, `${path}.placement.x_px`) < 0 || integer(placement.y_px, `${path}.placement.y_px`) < 0) invalid(`${path}.placement is out of range`)
  const motion = exact(op.motion, ['kind', 'entrance_sec'], `${path}.motion`)
  const kind = oneOf(motion.kind, ['none', 'pop', 'slide', 'float', 'pulse', 'wipe', 'line-draw'], `${path}.motion.kind`)
  if (motion.entrance_sec !== 0.3) invalid(`${path}.motion.entrance_sec is unsupported`)
  if (index > 9999) invalid('late-label operation index exceeds 9999')
  const stem = `cue_${String(index).padStart(4, '0')}_`
  const ref = (target: unknown, suffix: string, refPath: string): void => lateLabelRef(target, refPath, `${stem}${suffix}`, refs)
  const reveal = (target: unknown, purpose: 'r' | 'lr', revealPath: string): void => {
    const item = exact(target, ['duration_sec', 'frames'], revealPath)
    if (item.duration_sec !== 0.3 || !Array.isArray(item.frames)) invalid(`${revealPath} is invalid`)
    const count = Math.max(2, Math.ceil(fps * 0.3) + 1)
    if (item.frames.length !== count) invalid(`${revealPath}.frames has an invalid count`)
    item.frames.forEach((raw, frameIndex) => {
      const frame = exact(raw, ['asset', 'progress'], `${revealPath}.frames[${frameIndex}]`)
      if (number(frame.progress, `${revealPath}.frames[${frameIndex}].progress`) !== frameIndex / (count - 1)) invalid(`${revealPath}.frames progress is invalid`)
      ref(frame.asset, `${purpose}${String(frameIndex).padStart(4, '0')}`, `${revealPath}.frames[${frameIndex}].asset`)
    })
  }
  if (kind === 'wipe') {
    if (op.label !== null || op.line_reveal !== null || op.reveal === null) invalid(`${path} wipe fields are invalid`)
    reveal(op.reveal, 'r', `${path}.reveal`)
  } else {
    if (op.label === null || op.reveal !== null) invalid(`${path} label fields are invalid`)
    ref(exact(op.label, ['asset'], `${path}.label`).asset, 'label', `${path}.label.asset`)
    if (kind === 'line-draw') {
      if (op.line !== null || op.line_reveal === null) invalid(`${path} line-draw fields are invalid`)
      reveal(op.line_reveal, 'lr', `${path}.line_reveal`)
    } else if (op.line_reveal !== null) invalid(`${path}.line_reveal must be null`)
  }
  if (op.line !== null) ref(exact(op.line, ['asset'], `${path}.line`).asset, 'line', `${path}.line.asset`)
}

function operation(value: unknown, duration: number, refs: Map<string, AssetRole>, index: number, fps: number): number {
  const op = object(value, `recipe.operations[${index}]`)
  const kind = text(op.kind, `recipe.operations[${index}].kind`)
  const stage = STAGES.indexOf(kind as typeof STAGES[number])
  if (stage < 0) invalid(`recipe.operations[${index}].kind is unsupported`)
  const path = `recipe.operations[${index}]`
  if (kind === 'overlay_layer') {
    const item = exact(op, ['kind', 'asset', 'input_mode', 'opacity', 'sizing', 'placement', 'time_range', 'chroma'], path)
    addRef(refs, assetRef(item.asset, `${path}.asset`), 'overlay')
    inputMode(item.input_mode, `${path}.input_mode`)
    range(item.opacity, 0, 1, `${path}.opacity`)
    const sizing = object(item.sizing, `${path}.sizing`)
    if (sizing.mode === 'cover' || sizing.mode === 'contain' || sizing.mode === 'native') {
      exact(sizing, ['mode'], `${path}.sizing`)
    } else if (sizing.mode === 'width_fraction') {
      const closed = exact(sizing, ['mode', 'value'], `${path}.sizing`)
      const fraction = number(closed.value, `${path}.sizing.value`)
      if (fraction <= 0 || fraction > 0.95) invalid(`${path}.sizing.value is out of range`)
    } else invalid(`${path}.sizing.mode is unsupported`)
    const placement = object(item.placement, `${path}.placement`)
    if (placement.mode === 'origin') exact(placement, ['mode'], `${path}.placement`)
    else if (placement.mode === 'anchor') {
      const closed = exact(placement, ['mode', 'value'], `${path}.placement`)
      oneOf(closed.value, ['center', 'top-third', 'bottom-third', 'lower-right', 'lower-left'], `${path}.placement.value`)
    } else invalid(`${path}.placement.mode is unsupported`)
    timeRange(item.time_range, duration, `${path}.time_range`)
    if (item.chroma !== null) {
      const chroma = exact(item.chroma, ['color', 'similarity', 'blend'], `${path}.chroma`)
      if (!HEX_COLOR.test(text(chroma.color, `${path}.chroma.color`))) invalid(`${path}.chroma.color is invalid`)
      range(chroma.similarity, 0.01, 1, `${path}.chroma.similarity`)
      range(chroma.blend, 0, 1, `${path}.chroma.blend`)
    }
  } else if (kind === 'classic_color_grade') {
    const item = exact(op, ['kind', 'preset', 'brightness', 'contrast', 'saturation', 'warmth', 'tint'], path)
    oneOf(item.preset, ['none', 'warm-night', 'cool-moonlight', 'cinematic', 'vintage', 'dreamy-haze', 'golden-hour', 'noir'], `${path}.preset`)
    range(item.brightness, -1, 1, `${path}.brightness`)
    range(item.contrast, 0, 3, `${path}.contrast`)
    range(item.saturation, 0, 3, `${path}.saturation`)
    range(item.warmth, -1, 1, `${path}.warmth`)
    range(item.tint, -1, 1, `${path}.tint`)
  } else if (kind === 'classic_vignette') {
    range(exact(op, ['kind', 'strength'], path).strength, 0, 1, `${path}.strength`)
  } else if (kind === 'classic_film_grain') {
    integerRange(exact(op, ['kind', 'strength'], path).strength, 0, 100, `${path}.strength`)
  } else if (kind === 'aged_archive_film') {
    integerRange(exact(op, ['kind', 'strength'], path).strength, 1, 100, `${path}.strength`)
  } else if (kind === 'classic_letterbox') {
    const item = exact(op, ['kind', 'ratio', 'mode', 'color'], path)
    oneOf(item.ratio, ['2.35:1', '2.00:1', '1.85:1'], `${path}.ratio`)
    oneOf(item.mode, ['fit', 'cover'], `${path}.mode`)
    if (!COLOR.test(text(item.color, `${path}.color`))) invalid(`${path}.color is invalid`)
  } else if (kind === 'presentation_frame') {
    const item = exact(op, ['kind', 'inset_pct', 'border_width', 'corner_radius', 'border_color', 'background_color', 'fit', 'background'], path)
    range(item.inset_pct, 0, 25, `${path}.inset_pct`)
    range(item.border_width, 0, 160, `${path}.border_width`)
    range(item.corner_radius, 0, 300, `${path}.corner_radius`)
    for (const key of ['border_color', 'background_color'] as const) {
      if (!COLOR.test(text(item[key], `${path}.${key}`))) invalid(`${path}.${key} is invalid`)
    }
    oneOf(item.fit, ['cover', 'contain'], `${path}.fit`)
    const background = object(item.background, `${path}.background`)
    if (background.kind === 'solid') exact(background, ['kind'], `${path}.background`)
    else if (background.kind === 'asset') {
      const closed = exact(background, ['kind', 'asset', 'input_mode'], `${path}.background`)
      addRef(refs, assetRef(closed.asset, `${path}.background.asset`), 'frame_background')
      inputMode(closed.input_mode, `${path}.background.input_mode`)
    } else invalid(`${path}.background.kind is unsupported`)
  } else if (kind === 'late_label_stage') {
    lateLabelOperation(op, duration, refs, index, fps)
  } else if (kind === 'subtitle_stage') {
    subtitleOperation(op, refs, index)
  } else {
    const item = exact(op, ['kind', 'asset', 'opacity', 'scale', 'anchor', 'margin_px', 'gate'], path)
    addRef(refs, assetRef(item.asset, `${path}.asset`), 'logo')
    range(item.opacity, 0, 1, `${path}.opacity`)
    range(item.scale, 0.01, 1, `${path}.scale`)
    oneOf(item.anchor, ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'], `${path}.anchor`)
    integerRange(item.margin_px, 0, 200, `${path}.margin_px`)
    oneOf(item.gate, ['effects_gate', 'after_10_seconds', 'always'], `${path}.gate`)
  }
  return stage
}

export function validateFinalRenderEncode(value: unknown): void {
  const encode = exact(value, ['container', 'requested_codec', 'requested_effort', 'crf', 'quality_cpu_preset', 'bitrate_kbps'], 'recipe.encode')
  oneOf(encode.container, ['mp4', 'mov', 'webm'], 'recipe.encode.container')
  oneOf(encode.requested_codec, ['h264', 'h265'], 'recipe.encode.requested_codec')
  oneOf(encode.requested_effort, ['ultrafast', 'medium', 'slow', 'hardware'], 'recipe.encode.requested_effort')
  const crf = integer(encode.crf, 'recipe.encode.crf')
  const preset = oneOf(encode.quality_cpu_preset, ['ultrafast', 'medium', 'slow'], 'recipe.encode.quality_cpu_preset')
  if (!new Set(['32/ultrafast', '28/ultrafast', '23/medium', '18/slow', '23/ultrafast']).has(`${crf}/${preset}`)) {
    invalid('recipe.encode quality pair is unsupported')
  }
  if (encode.bitrate_kbps !== null) integerRange(encode.bitrate_kbps, 500, 100000, 'recipe.encode.bitrate_kbps')
}

function validate(value: unknown): RenderPacketSyntax {
  canonicalRenderValue(value)
  const packet = exact(value, ['recipe', 'manifest', 'recipe_digest', 'manifest_digest', 'packet_digest'], 'packet')
  const recipe = exact(packet.recipe, ['namespace', 'profile_digest', 'base_video', 'premixed_audio', 'canvas', 'target_duration_sec', 'effects_gate', 'operations', 'encode'], 'recipe')
  if (recipe.namespace !== 'studio.render.final.v1') invalid('recipe.namespace is unsupported')
  if (!SHA256.test(text(recipe.profile_digest, 'recipe.profile_digest'))) invalid('recipe.profile_digest is invalid')
  const refs = new Map<string, AssetRole>()
  addRef(refs, assetRef(recipe.base_video, 'recipe.base_video'), 'base_video')
  addRef(refs, assetRef(recipe.premixed_audio, 'recipe.premixed_audio'), 'premixed_audio')
  const canvas = exact(recipe.canvas, ['width', 'height', 'working_fps'], 'recipe.canvas')
  const width = integer(canvas.width, 'recipe.canvas.width')
  const height = integer(canvas.height, 'recipe.canvas.height')
  const fps = integer(canvas.working_fps, 'recipe.canvas.working_fps')
  if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0) invalid('recipe.canvas dimensions must be positive even values')
  if (!FPS.has(fps)) invalid('recipe.canvas.working_fps is unsupported')
  if (!Number.isSafeInteger(width * height) || !Number.isSafeInteger(width * height * fps)) invalid('recipe.canvas products are unsafe')
  const duration = number(recipe.target_duration_sec, 'recipe.target_duration_sec')
  if (duration <= 0) invalid('recipe.target_duration_sec must be positive')
  effectsGate(recipe.effects_gate, duration, 'recipe.effects_gate')
  if (!Array.isArray(recipe.operations)) invalid('recipe.operations must be an array')
  let lastStage = -1
  const cueIds = new Set<string>()
  const seen = new Set<string>()
  recipe.operations.forEach((item, index) => {
    const raw = object(item, `recipe.operations[${index}]`)
    const kind = text(raw.kind, `recipe.operations[${index}].kind`)
    const stage = operation(item, duration, refs, index, fps)
    if (kind === 'late_label_stage') {
      const cueId = text(raw.cue_id, `recipe.operations[${index}].cue_id`)
      if (cueIds.has(cueId)) invalid('recipe.operations cue_id is duplicated')
      cueIds.add(cueId)
    }
    if (stage < lastStage) invalid('recipe.operations stage order is invalid')
    if (kind !== 'overlay_layer' && kind !== 'late_label_stage' && seen.has(kind)) invalid(`recipe.operations repeats singleton ${kind}`)
    seen.add(kind)
    lastStage = stage
  })
  validateFinalRenderEncode(recipe.encode)

  if (!Array.isArray(packet.manifest)) invalid('manifest must be an array')
  const ids = new Set<string>()
  const names = new Set<string>()
  let previous = ''
  for (const [index, raw] of packet.manifest.entries()) {
    const path = `manifest[${index}]`
    const entry = exact(raw, ['logical_id', 'safe_name', 'role', 'sha256', 'size_bytes'], path)
    const id = text(entry.logical_id, `${path}.logical_id`)
    if (!ID.test(id) || id <= previous || ids.has(id)) invalid(`${path}.logical_id is invalid or unordered`)
    previous = id
    ids.add(id)
    const safeName = text(entry.safe_name, `${path}.safe_name`)
    const match = SAFE_NAME.exec(safeName)
    if (match?.groups?.id !== id || names.has(safeName)) invalid(`${path}.safe_name is invalid`)
    names.add(safeName)
    const role = oneOf(entry.role, ['base_video', 'premixed_audio', 'overlay', 'frame_background', 'logo', 'cue_label', 'subtitle_ass', 'subtitle_font'], `${path}.role`) as AssetRole
    if (role === 'cue_label' && match?.groups?.extension !== 'png') invalid(`${path}.safe_name must be PNG for a cue label`)
    if (role === 'subtitle_ass' && match?.groups?.extension !== 'ass') invalid(`${path}.safe_name must be ASS for a subtitle document`)
    if (role === 'subtitle_font' && !['ttf', 'otf'].includes(match?.groups?.extension ?? '')) {
      invalid(`${path}.safe_name must be TTF or OTF for a subtitle font`)
    }
    if (refs.get(id) !== role) invalid(`${path} does not match an exact recipe reference`)
    if (!SHA256.test(text(entry.sha256, `${path}.sha256`))) invalid(`${path}.sha256 is invalid`)
    if (integer(entry.size_bytes, `${path}.size_bytes`) <= 0) invalid(`${path}.size_bytes must be positive`)
    // A font record's sha256 is the staged bytes' hash: the recipe promise and
    // the manifest fact must be the same value, never two hashes of one file.
    if (role === 'subtitle_font') {
      const record = (recipe.operations as JsonObject[]).find(operationValue =>
        operationValue.kind === 'subtitle_stage'
        && Array.isArray(operationValue.fonts)
        && (operationValue.fonts as JsonObject[]).some(font => (font.asset as JsonObject)?.logical_id === id))
      const fontRecord = (record?.fonts as JsonObject[] | undefined)?.find(font => (font.asset as JsonObject)?.logical_id === id)
      if (!fontRecord || fontRecord.sha256 !== entry.sha256) invalid(`${path} does not match its subtitle font record`)
    }
  }
  if (ids.size !== refs.size || [...refs.keys()].some(id => !ids.has(id))) invalid('manifest/reference bijection is incomplete')

  const recipeDigest = text(packet.recipe_digest, 'packet.recipe_digest')
  const manifestDigest = text(packet.manifest_digest, 'packet.manifest_digest')
  const packetDigest = text(packet.packet_digest, 'packet.packet_digest')
  if (![recipeDigest, manifestDigest, packetDigest].every(digest => SHA256.test(digest))) invalid('packet digest syntax is invalid')
  if (renderHash('recipe', recipe) !== recipeDigest) invalid('recipe digest mismatch')
  if (renderHash('manifest', packet.manifest) !== manifestDigest) invalid('manifest digest mismatch')
  if (renderHash('packet', { recipe_digest: recipeDigest, manifest_digest: manifestDigest }) !== packetDigest) {
    invalid('packet digest mismatch')
  }
  return packet as RenderPacketSyntax
}

/**
 * Validate only the closed render packet syntax and R/M/P identity.
 * This does not qualify a profile, verify files, authenticate, compile, or make the packet executable.
 */
export function validateRenderPacketSyntax(value: unknown): RenderPacketSyntax {
  try {
    return validate(value)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid render packet:')) throw error
    invalid(error instanceof Error ? error.message : 'unknown validation failure')
  }
}
