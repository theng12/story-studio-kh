/**
 * Atmosphere loops — the ONE particle and noise program behind both the baked
 * render layer and the in-browser live preview.
 *
 * ZERO RUNTIME DEPENDENCIES ON PURPOSE (same rule as `scene-effects.ts`): the
 * Effects Library page imports this module through `@shared` and runs it on a
 * `<canvas>`, and the backend runs the very same functions to bake a grey
 * H.264 loop through FFmpeg. One program, so the live preview and the render
 * cannot drift apart.
 *
 * ── Seamless by construction ──────────────────────────────────────────────
 *
 * Every motion is periodic in the loop phase `t ∈ [0, 1)`: a particle falls,
 * rises, sways or blinks a WHOLE number of times per loop, so frame N equals
 * frame 0 and the loop has no seam. A particle that crosses the frame respawns
 * at the same spot off-screen, which is why every falling or rising variant
 * keeps a margin larger than the particle itself.
 *
 * Noise variants (fog, cloud shadows) cannot be made periodic by scrolling —
 * scrolling a noise field wraps with a visible seam, measured in the music
 * format study. Instead two copies of the field scroll one loop-length apart
 * and are cross-faded with variance-preserving weights, so `t = 1` lands back
 * exactly on `t = 0`.
 *
 * ── Units ──────────────────────────────────────────────────────────────────
 *
 * Positions are fractions of the frame, so a loop drawn at 480x270 for the
 * preview and at 1920x1080 for the render shows the same particles in the same
 * places. Sizes are pixels at a 1080-line frame, scaled by `h / 1080`, the rule
 * every `_px` field in the effect contract follows.
 */

export const LOOP_VARIANTS = [
  'rain', 'snow', 'fireflies', 'bokeh', 'dust', 'embers', 'stars', 'petals',
  'fog', 'cloud-shadows', 'light-rays',
  // E1 (1.4.287) — sky, water, glass, paper and film layers. Band versions: no model needed.
  'aurora', 'moon-glow', 'sky-clouds', 'caustics', 'window-drops', 'paper', 'film-dust',
] as const
/**
 * Baked like a loop but placed by its effect, not laid over the whole frame: the shooting star's
 * streak is a small sprite that the `shooting-star` overlay drops at seeded moments and places.
 */
export const SPRITE_VARIANTS = ['shooting-star'] as const
export type LoopVariant = (typeof LOOP_VARIANTS)[number] | (typeof SPRITE_VARIANTS)[number]

/** How the loop is drawn — shown as the badge on the effect card. */
export type LoopMethod = 'particle' | 'noise' | 'light'

export interface LoopVariantInfo {
  method: LoopMethod
  /** Particles at amount 100 %. Fog and cloud shadows read `amount` as density. */
  max_count: number
  /** What one particle is called, for "1,400 drops". Empty for noise. */
  unit: string
  default_loop_sec: number
  /**
   * Share of the output size the loop is baked at. Soft layers (fog, rays,
   * bokeh) lose nothing at a quarter or half size, and FFmpeg scales the grey
   * mask back up for a fraction of what drawing it full size costs.
   */
  bake_scale: number
  /** Bake every Nth output frame; slow drifts hold each frame for N frames. */
  fps_divisor: number
  /** Which fields change this variant's picture, for the parameter panel. */
  fields: readonly LoopShapeField[]
}

export type LoopShapeField =
  'amount' | 'size' | 'speed' | 'wind_deg' | 'sway' | 'layers' | 'twinkle'
  | 'region_top' | 'region_bottom' | 'scale' | 'beam' | 'seed' | 'loop_sec'

const PARTICLE_COMMON: LoopShapeField[] = ['amount', 'size', 'speed', 'seed', 'loop_sec']

export const LOOP_VARIANT_INFO: Record<LoopVariant, LoopVariantInfo> = {
  rain: { method: 'particle', max_count: 4000, unit: 'drops', default_loop_sec: 2, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'wind_deg', 'layers'] },
  snow: { method: 'particle', max_count: 3000, unit: 'flakes', default_loop_sec: 12, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'wind_deg', 'sway', 'layers'] },
  fireflies: { method: 'particle', max_count: 300, unit: 'lights', default_loop_sec: 12, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'sway', 'twinkle', 'region_top', 'region_bottom'] },
  bokeh: { method: 'particle', max_count: 80, unit: 'orbs', default_loop_sec: 12, bake_scale: 0.5, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'sway', 'twinkle', 'region_top', 'region_bottom'] },
  dust: { method: 'particle', max_count: 2000, unit: 'motes', default_loop_sec: 12, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'sway', 'beam'] },
  embers: { method: 'particle', max_count: 800, unit: 'embers', default_loop_sec: 6, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'sway', 'twinkle', 'region_top', 'region_bottom'] },
  stars: { method: 'particle', max_count: 3000, unit: 'stars', default_loop_sec: 12, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'twinkle', 'region_top', 'region_bottom'] },
  petals: { method: 'particle', max_count: 300, unit: 'petals', default_loop_sec: 12, bake_scale: 1, fps_divisor: 1,
    fields: [...PARTICLE_COMMON, 'wind_deg', 'sway'] },
  fog: { method: 'noise', max_count: 0, unit: '', default_loop_sec: 20, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'scale', 'speed', 'region_top', 'region_bottom', 'seed', 'loop_sec'] },
  'cloud-shadows': { method: 'noise', max_count: 0, unit: '', default_loop_sec: 20, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'scale', 'speed', 'seed', 'loop_sec'] },
  'light-rays': { method: 'light', max_count: 12, unit: 'rays', default_loop_sec: 12, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'size', 'speed', 'wind_deg', 'sway', 'twinkle', 'region_bottom', 'seed', 'loop_sec'] },
  aurora: { method: 'light', max_count: 8, unit: 'curtains', default_loop_sec: 30, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'size', 'speed', 'sway', 'twinkle', 'region_top', 'region_bottom', 'seed', 'loop_sec'] },
  'moon-glow': { method: 'light', max_count: 1, unit: '', default_loop_sec: 20, bake_scale: 0.25, fps_divisor: 4,
    fields: ['size', 'speed', 'twinkle', 'beam', 'region_top', 'loop_sec'] },
  'sky-clouds': { method: 'noise', max_count: 0, unit: '', default_loop_sec: 20, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'scale', 'speed', 'region_bottom', 'seed', 'loop_sec'] },
  caustics: { method: 'noise', max_count: 0, unit: '', default_loop_sec: 12, bake_scale: 0.25, fps_divisor: 2,
    fields: ['amount', 'scale', 'speed', 'region_top', 'region_bottom', 'seed', 'loop_sec'] },
  'window-drops': { method: 'particle', max_count: 600, unit: 'drops', default_loop_sec: 20, bake_scale: 0.5, fps_divisor: 1,
    fields: ['amount', 'size', 'speed', 'seed', 'loop_sec'] },
  // A still texture: two identical frames, so it never moves and costs one tiny bake.
  paper: { method: 'noise', max_count: 0, unit: '', default_loop_sec: 1, bake_scale: 0.5, fps_divisor: 24,
    fields: ['amount', 'scale', 'seed'] },
  'film-dust': { method: 'particle', max_count: 40, unit: 'specks a frame', default_loop_sec: 24, bake_scale: 0.5, fps_divisor: 1,
    fields: ['amount', 'size', 'layers', 'seed', 'loop_sec'] },
  // The sprite: one streak's whole life, `loop_sec` long, in a box `size` times 420x140 px at 1080.
  'shooting-star': { method: 'light', max_count: 1, unit: '', default_loop_sec: 1.2, bake_scale: 1, fps_divisor: 1,
    fields: ['size'] },
}

/**
 * Everything that changes the SHAPE of a loop — the fields a bake depends on.
 * Colour, brightness and the picture darkening are applied at composite time
 * and are deliberately absent: changing them never re-bakes.
 */
export interface LoopShape {
  variant: LoopVariant
  /** 0..100. Share of `max_count` (stars: 30 = 900 of 3,000), or fog/cloud density. */
  amount: number
  /** 0.25..4. Multiplies the variant's particle size (rain: streak length). */
  size: number
  /** 0.25..4. Multiplies how fast things fall, rise, drift or blink. */
  speed: number
  /** -45..45. Rain/snow/petal slant; light-ray angle. */
  wind_deg: number
  /** 0..1. How far particles wander off their path. */
  sway: number
  /** 1..3. Depth layers for rain and snow (far layers are smaller and slower). */
  layers: number
  /** 0..1. Blink / twinkle / flicker strength. */
  twinkle: number
  /** 0..1. Top of the band the effect lives in (stars default to the sky). */
  region_top: number
  /** 0..1. Bottom of that band. */
  region_bottom: number
  /** 0.25..4. Noise feature size for fog and cloud shadows. */
  scale: number
  /** 0..1. Dust: how strictly the motes stay inside the light beam. */
  beam: number
  /** Integer seed. Same seed = same particles, everywhere. */
  seed: number
  /** 1..30. Loop length in seconds. */
  loop_sec: number
  /**
   * 0 = every particle. 1 / 2 = the even / odd half, used when an effect has a
   * second colour: the two halves bake as two loops tinted separately.
   */
  subset: 0 | 1 | 2
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function defaultLoopShape(variant: LoopVariant): LoopShape {
  const info = LOOP_VARIANT_INFO[variant]
  const base: LoopShape = {
    variant, amount: 40, size: 1, speed: 1, wind_deg: 0, sway: 0.5, layers: 2, twinkle: 0.5,
    region_top: 0, region_bottom: 1, scale: 1, beam: 0, seed: 7, loop_sec: info.default_loop_sec, subset: 0,
  }
  switch (variant) {
    case 'rain': return { ...base, amount: 35, wind_deg: 8 }
    case 'snow': return { ...base, amount: 30, wind_deg: 4 }
    case 'fireflies': return { ...base, amount: 25, region_top: 0.35, region_bottom: 1 }
    case 'bokeh': return { ...base, amount: 30, sway: 0.4 }
    case 'dust': return { ...base, amount: 35, sway: 0.4, beam: 0.6 }
    case 'embers': return { ...base, amount: 30, region_top: 0.2, region_bottom: 1 }
    case 'stars': return { ...base, amount: 30, region_top: 0, region_bottom: 0.55 }
    case 'petals': return { ...base, amount: 30, wind_deg: 10 }
    case 'fog': return { ...base, amount: 50, region_top: 0.35, region_bottom: 1 }
    case 'cloud-shadows': return { ...base, amount: 45, scale: 1 }
    case 'light-rays': return { ...base, amount: 40, wind_deg: 18, sway: 0.3, twinkle: 0.4, region_bottom: 1 }
    case 'aurora': return { ...base, amount: 50, sway: 0.6, twinkle: 0.5, speed: 0.5, region_top: 0, region_bottom: 0.45 }
    case 'moon-glow': return { ...base, size: 1, speed: 1, twinkle: 0.4, beam: 0.72, region_top: 0.18 }
    case 'sky-clouds': return { ...base, amount: 50, scale: 1, speed: 0.6, region_top: 0, region_bottom: 0.35 }
    case 'caustics': return { ...base, amount: 60, scale: 1, speed: 0.6, region_top: 0, region_bottom: 1 }
    case 'window-drops': return { ...base, amount: 35, size: 1, speed: 1 }
    case 'paper': return { ...base, amount: 60, scale: 1 }
    case 'film-dust': return { ...base, amount: 25, size: 1, layers: 1 }
    case 'shooting-star': return { ...base, size: 1, loop_sec: 1.2 }
  }
}

/** Clamp any stored shape. Never throws. */
export function normalizeLoopShape(input: unknown, variant: LoopVariant): LoopShape {
  const d = defaultLoopShape(variant)
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const top = clampNum(s.region_top, 0, 1, d.region_top)
  const bottom = clampNum(s.region_bottom, 0, 1, d.region_bottom)
  return {
    variant,
    amount: clampNum(s.amount, 0, 100, d.amount),
    size: clampNum(s.size, 0.25, 4, d.size),
    speed: clampNum(s.speed, 0.25, 4, d.speed),
    wind_deg: clampNum(s.wind_deg, -45, 45, d.wind_deg),
    sway: clampNum(s.sway, 0, 1, d.sway),
    layers: Math.round(clampNum(s.layers, 1, 3, d.layers)),
    twinkle: clampNum(s.twinkle, 0, 1, d.twinkle),
    // A band upside down would draw nothing; swap rather than refuse.
    region_top: Math.min(top, bottom),
    region_bottom: Math.max(top, bottom),
    scale: clampNum(s.scale, 0.25, 4, d.scale),
    beam: clampNum(s.beam, 0, 1, d.beam),
    seed: Math.round(clampNum(s.seed, 0, 2 ** 31 - 1, d.seed)),
    loop_sec: clampNum(s.loop_sec, 1, 30, d.loop_sec),
    subset: s.subset === 1 || s.subset === 2 ? s.subset : 0,
  }
}

/** Particles this shape draws (before a colour subset halves it). */
export function loopParticleCount(shape: LoopShape): number {
  const info = LOOP_VARIANT_INFO[shape.variant]
  if (shape.variant === 'light-rays') return Math.max(1, Math.round(1 + (shape.amount / 100) * (info.max_count - 1)))
  return Math.round(info.max_count * shape.amount / 100)
}

/** Stable identity of a shape for caches. Field order is fixed here. */
export function loopShapeKey(shape: LoopShape): string {
  return [
    shape.variant, shape.amount, shape.size, shape.speed, shape.wind_deg, shape.sway, shape.layers,
    shape.twinkle, shape.region_top, shape.region_bottom, shape.scale, shape.beam, shape.seed,
    shape.loop_sec, shape.subset,
  ].map(v => (typeof v === 'number' ? Number(v.toFixed(4)) : v)).join(':')
}

/** The shooting star's sprite box at a 1080-line frame and size 1. */
export const SHOOTING_STAR_BOX = { w: 420, h: 140 } as const

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** The size a loop is baked at for an output frame. Always even (yuv/gray encoders want it). */
export function loopBakeSize(shape: LoopShape, outW: number, outH: number): { w: number; h: number } {
  if (shape.variant === 'shooting-star') {
    const k = (outH / 1080) * shape.size
    return { w: Math.min(even(outW), even(SHOOTING_STAR_BOX.w * k)), h: Math.min(even(outH), even(SHOOTING_STAR_BOX.h * k)) }
  }
  const scale = LOOP_VARIANT_INFO[shape.variant].bake_scale
  return { w: even(outW * scale), h: even(outH * scale) }
}

/** The frame rate a loop is baked at for an output frame rate. */
export function loopBakeFps(shape: LoopShape, outFps: number): number {
  return outFps / LOOP_VARIANT_INFO[shape.variant].fps_divisor
}

/** Frames in one loop at a bake frame rate. At least 2, so a loop always moves. */
export function loopFrameCount(shape: LoopShape, bakeFps: number): number {
  return Math.max(2, Math.round(shape.loop_sec * bakeFps))
}

// ═══════════════════════════════════════════════════════════════════════════
// The renderer
// ═══════════════════════════════════════════════════════════════════════════

const TAU = Math.PI * 2

/** The seeded generator the music-format prototype used; kept so seeds match it. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296)
}

interface Particle {
  x: number; y: number; k: number; a: number; r: number; b: number; m: number; layer: number
}

function frac(v: number): number {
  return v - Math.floor(v)
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** Whole cycles per loop, never zero — the periodicity guarantee lives here. */
function cycles(perSecond: number, shape: LoopShape): number {
  return Math.max(1, Math.round(perSecond * shape.loop_sec * shape.speed))
}

export interface LoopRenderer {
  readonly width: number
  readonly height: number
  readonly frames: number
  /** Draw frame `index` (0..frames-1) as 8-bit grey into `out` (width*height). */
  draw(index: number, out: Uint8Array | Uint8ClampedArray): void
  /** Draw at a raw loop phase. `drawPhase(1)` equals `drawPhase(0)` — that is the seam test. */
  drawPhase(t: number, out: Uint8Array | Uint8ClampedArray): void
}

/**
 * Build a renderer for one shape at one size.
 *
 * `frames` is the loop length in frames; frame `frames` would equal frame 0.
 */
export function createLoopRenderer(shapeInput: LoopShape, width: number, height: number, frames: number): LoopRenderer {
  const shape = normalizeLoopShape(shapeInput, shapeInput.variant)
  const W = Math.max(2, Math.round(width))
  const H = Math.max(2, Math.round(height))
  const N = Math.max(2, Math.round(frames))
  const k = H / 1080
  const buf = new Float32Array(W * H)
  const rnd = seededRandom(shape.seed)
  const count = loopParticleCount(shape)
  const all: Particle[] = []
  for (let i = 0; i < count; i++) {
    all.push({
      x: rnd(), y: rnd(), k: 1 + Math.floor(rnd() * 3), a: rnd() * TAU,
      r: 0.6 + rnd() * 1.8, b: 0.4 + rnd() * 0.6, m: 1 + Math.floor(rnd() * 3),
      layer: 1 + Math.floor(rnd() * shape.layers),
    })
  }
  // Halves for a second colour. Chosen from the full list so a tinted half is
  // exactly the particles the single-colour version would have drawn there.
  const particles = shape.subset === 0 ? all : all.filter((_, i) => (i % 2) === (shape.subset - 1))
  const depth = (layer: number) => shape.layers === 1 ? 1 : 0.45 + 0.55 * (layer - 1) / (shape.layers - 1)
  const tanW = Math.tan(shape.wind_deg * Math.PI / 180)
  const bandTop = shape.region_top * H
  const bandH = Math.max(1, (shape.region_bottom - shape.region_top) * H)

  function dot(cx: number, cy: number, rad: number, val: number): void {
    if (val <= 0.5 || rad <= 0) return
    const R = Math.ceil(rad * 2.5)
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R))
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R))
    const inv = 1 / (rad * rad)
    for (let y = y0; y <= y1; y++) {
      const dy2 = (y - cy) * (y - cy)
      for (let x = x0; x <= x1; x++) {
        const d2 = ((x - cx) * (x - cx) + dy2) * inv
        if (d2 < 6.25) buf[y * W + x]! += val * Math.exp(-d2)
      }
    }
  }

  function ellipse(cx: number, cy: number, ra: number, rb: number, th: number, val: number): void {
    const R = Math.ceil(ra * 1.6)
    const c = Math.cos(th), sn = Math.sin(th)
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R))
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R))
    const rbSafe = Math.max(0.8, rb)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy
        const u = (dx * c + dy * sn) / ra, v = (-dx * sn + dy * c) / rbSafe
        const d = u * u + v * v
        if (d < 1.4) buf[y * W + x]! += val * Math.max(0, 1 - d * d)
      }
    }
  }

  /** A slanted streak from its head back along the fall direction, bright at the head. */
  function streak(hx: number, hy: number, len: number, widthPx: number, val: number): void {
    const steps = Math.max(2, Math.ceil(len))
    const half = Math.max(0, (widthPx - 1) / 2)
    for (let i = 0; i < steps; i++) {
      const along = i / steps
      const y = Math.round(hy - along * len)
      if (y < 0 || y >= H) continue
      const x = hx - along * len * tanW
      const xi = Math.floor(x)
      const f = x - xi
      const v = val * (1 - along)
      const row = y * W
      for (let o = -Math.ceil(half); o <= Math.ceil(half); o++) {
        const xa = xi + o
        if (xa >= 0 && xa < W) buf[row + xa]! += v * (1 - f)
        if (xa + 1 >= 0 && xa + 1 < W) buf[row + xa + 1]! += v * f
      }
    }
  }

  // ── Noise (fog, cloud shadows) ────────────────────────────────────────────
  const noiseSeed = (shape.seed * 2654435761) >>> 0
  function lattice(ix: number, iy: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + noiseSeed) >>> 0
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  function valueNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y)
    const fx = x - ix, fy = y - iy
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
    const a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  function fbm(x: number, y: number): number {
    return 0.57 * valueNoise(x, y) + 0.29 * valueNoise(x * 2.03 + 17.1, y * 2.03 + 3.7) + 0.14 * valueNoise(x * 4.11 + 41.3, y * 4.11 + 29.9)
  }

  function drawNoise(t: number): void {
    const fog = shape.variant === 'fog'
    const freq = (fog ? 2.0 : 3.0) / shape.scale
    const aspect = W / H
    // Drift distance per loop in field units; two copies one loop apart.
    const drift = 0.05 * shape.loop_sec * shape.speed / shape.scale
    const w0 = 1 - t, w1 = t
    const norm = 1 / Math.sqrt(w0 * w0 + w1 * w1)
    const off0 = -drift * t, off1 = -drift * (t - 1)
    const density = shape.amount / 100
    // fbm sits around 0.5 (5th..95th percentile 0.27..0.73), so these
    // thresholds read as coverage: density 0.5 fogs about two thirds of the
    // band softly; cloud shadows at 0.45 cover roughly a third of the frame.
    const lo = fog ? 0.5 - 0.4 * density : 0.7 - 0.3 * density
    const span = fog ? 0.55 : 0.25
    const peak = fog ? 255 * (0.45 + 0.55 * density) : 255
    // Fog is a haze with wisps in it, not cut-out clouds: a floor of even mist
    // that rises with density, and the noise only modulates above it.
    const haze = fog ? 0.25 + 0.3 * density : 0
    for (let y = 0; y < H; y++) {
      const v = (y / H) * freq
      const yf = y / H
      const band = fog
        ? smoothstep(shape.region_top - 0.12, shape.region_top + 0.12, yf) * (1 - smoothstep(shape.region_bottom - 0.02, shape.region_bottom + 0.2, yf))
        : 1
      const row = y * W
      for (let x = 0; x < W; x++) {
        if (band <= 0) { buf[row + x] = 0; continue }
        const u = (x / W) * freq * aspect
        const n0 = fbm(u + off0, v + 0.3 * off0)
        const n1 = fbm(u + off1, v + 0.3 * off1)
        const n = 0.5 + ((n0 - 0.5) * w0 + (n1 - 0.5) * w1) * norm
        buf[row + x] = peak * (haze + (1 - haze) * smoothstep(lo, lo + span, n)) * band
      }
    }
  }

  function drawRays(t: number): void {
    const cosT = Math.cos(shape.wind_deg * Math.PI / 180), sinT = Math.sin(shape.wind_deg * Math.PI / 180)
    const reach = Math.max(0.05, shape.region_bottom) * H
    const rays = particles.map((p) => ({
      ox: (p.x * 1.3 - 0.15) * W,
      width: (0.03 + 0.05 * p.r / 2.4) * W * shape.size,
      sway: shape.sway * 0.03 * W,
      cyc: cycles(p.m / 12, shape),
      pulse: cycles(p.k / 12, shape),
      a: p.a,
      b: p.b,
    }))
    buf.fill(0)
    for (const ray of rays) {
      const ox = ray.ox + ray.sway * Math.sin(TAU * ray.cyc * t + ray.a)
      const level = 190 * ray.b * (1 - shape.twinkle * 0.5 * (1 - Math.sin(TAU * ray.pulse * t + ray.a * 1.7)))
      const inv = 1 / ray.width
      for (let y = 0; y < H; y++) {
        const along = y / reach
        if (along > 1.15) break
        const fade = (1 - smoothstep(0.55, 1.15, along)) * (0.55 + 0.45 * (1 - along))
        const row = y * W
        const base = -y * sinT
        for (let x = 0; x < W; x++) {
          const d = ((x - ox) * cosT + base) * inv
          if (d > 3 || d < -3) continue
          buf[row + x]! += level * fade * Math.exp(-d * d)
        }
      }
    }
  }

  function drawParticles(t: number): void {
    buf.fill(0)
    const variant = shape.variant
    for (const p of particles) {
      if (variant === 'rain') {
        const q = depth(p.layer)
        const len = (26 + 24 * q) * shape.size * k * (0.8 + 0.2 * p.b)
        const span = H + len * 2
        const hy = frac(p.y + cycles(2.5 + 3.5 * q, shape) * t) * span
        // x tied to the fall phase, so the slant respawns where it began.
        const lo = Math.min(0, -tanW * span), hi = W + Math.max(0, -tanW * span)
        const hx = lo + p.x * (hi - lo) + tanW * hy
        streak(hx, hy, len, q > 0.8 ? 1.6 * Math.max(1, k * 1.2) : 1, 200 * p.b * (0.55 + 0.45 * q))
      } else if (variant === 'snow') {
        const q = depth(p.layer)
        const rad = (0.6 + 0.9 * q) * p.r * 1.4 * shape.size * k
        const margin = rad * 3 + 4
        const span = H + margin * 2
        const yy = frac(p.y + cycles(0.07 + 0.13 * q, shape) * t) * span - margin
        const xx = p.x * W + tanW * (yy + margin) + shape.sway * 0.02 * W * Math.sin(TAU * p.m * t + p.a)
        dot(((xx % W) + W) % W, yy, rad, 255 * p.b * (0.55 + 0.45 * q))
      } else if (variant === 'fireflies') {
        const c1 = cycles(p.k / 12, shape), c2 = cycles((p.m + 2) / 12, shape)
        const x = (p.x + shape.sway * (0.1 * Math.sin(TAU * t * c1 + p.a) + 0.04 * Math.sin(TAU * t * c2))) * W
        const y = bandTop + p.y * bandH + shape.sway * 0.08 * H * Math.cos(TAU * t * cycles(p.m / 12, shape) + p.a)
        const pulse = Math.max(0, Math.sin(TAU * cycles(p.m / 12, shape) * t + p.a)) ** 3
        const blink = (1 - shape.twinkle) * 0.75 + shape.twinkle * pulse
        const size = shape.size * k
        dot(x, y, (2.2 + p.r) * size, 255 * blink)
        dot(x, y, (9 + 4 * p.r) * size, 60 * blink)
      } else if (variant === 'bokeh') {
        const x = (p.x + shape.sway * 0.075 * Math.sin(TAU * t * cycles(p.k / 12, shape) + p.a)) * W
        const y = bandTop + (p.y + shape.sway * 0.05 * Math.cos(TAU * t * cycles(p.m / 12, shape) + p.a)) * bandH
        const pulse = 1 - shape.twinkle * 0.4 * (1 - Math.sin(TAU * t * cycles(p.m / 12, shape) + p.a))
        dot(x, y, (18 + 22 * p.r) * shape.size * k, 150 * p.b * pulse)
      } else if (variant === 'embers') {
        const rad = (2 + p.r * 1.3) * shape.size * k
        const margin = rad * 3 + 4
        const span = bandH + margin * 2
        const rise = frac(p.y + cycles(p.k / 6, shape) * t)
        const y = bandTop + bandH + margin - rise * span
        const x = (p.x + shape.sway * 0.03 * Math.sin(TAU * t * cycles((p.m + 1) / 6, shape) + p.a)) * W
        const flick = 1 - shape.twinkle * (0.5 - 0.5 * Math.sin(TAU * t * cycles(p.m * 7 / 6, shape) + p.a))
        const life = Math.sqrt(Math.max(0, Math.min(1, (y - bandTop) / bandH)))
        dot(x, y, rad, 255 * p.b * flick * life)
      } else if (variant === 'stars') {
        const tw = 1 - shape.twinkle * 0.45 * (1 - Math.sin(TAU * t * cycles(p.m / 12, shape) + p.a))
        dot(p.x * W, bandTop + p.y * bandH, (0.7 + p.r * 0.5) * shape.size * k, 255 * p.b * tw)
      } else if (variant === 'dust') {
        const x = frac(p.x + shape.sway * 0.1 * Math.sin(TAU * t * cycles(1 / 12, shape) + p.a)) * W
        const y = frac(p.y + shape.sway * 0.08 * Math.sin(TAU * t * cycles(p.m / 12, shape) + p.a)) * H
        const inBeam = Math.max(0, 1 - Math.abs((x / W) - 0.25 - 0.5 * (y / H)) / 0.18)
        const weight = (1 - shape.beam) + shape.beam * inBeam
        dot(x, y, (1.4 + p.r) * shape.size * k, 255 * p.b * weight)
      } else if (variant === 'petals') {
        const ra = (7 + 3 * p.r) * shape.size * k
        const margin = ra * 2 + 4
        const span = H + margin * 2
        const yy = frac(p.y + cycles(p.k * 0.5 / 12, shape) * t) * span - margin
        const xx = p.x * W + tanW * (yy + margin) + shape.sway * 0.08 * W * Math.sin(TAU * p.m * t + p.a)
        const spin = TAU * t * cycles(p.k / 12, shape) + p.a
        ellipse(((xx % W) + W) % W, yy, ra, (3 + 1.5 * p.r) * shape.size * k * Math.abs(Math.cos(spin)), spin, 230 * p.b)
      }
    }
  }

  // ── E1 (1.4.287) variants ─────────────────────────────────────────────────

  /** Two copies of a field one loop apart, cross-faded with variance-preserving weights (see the header). */
  function seamless(t: number, field: (off: number) => number, drift: number): number {
    const w0 = 1 - t, w1 = t
    const norm = 1 / Math.sqrt(w0 * w0 + w1 * w1)
    return 0.5 + ((field(-drift * t) - 0.5) * w0 + (field(-drift * (t - 1)) - 0.5) * w1) * norm
  }

  /** Clouds high in the frame: the fog noise, harder edged, drifting sideways only, fading out at the band's foot. */
  function drawSkyClouds(t: number): void {
    const freq = 2.4 / shape.scale
    const aspect = W / H
    const drift = 0.05 * shape.loop_sec * shape.speed / shape.scale
    const density = shape.amount / 100
    const lo = 0.62 - 0.3 * density
    for (let y = 0; y < H; y++) {
      const yf = y / H
      const band = 1 - smoothstep(shape.region_bottom - 0.12, shape.region_bottom + 0.04, yf)
      const row = y * W
      const v = yf * freq * 1.6
      for (let x = 0; x < W; x++) {
        if (band <= 0) { buf[row + x] = 0; continue }
        const u = (x / W) * freq * aspect
        const n = seamless(t, off => fbm(u + off, v), drift)
        buf[row + x] = 255 * smoothstep(lo, lo + 0.22, n) * band
      }
    }
  }

  /** Underwater light: bright ridges where two drifting, warped noise fields cross. */
  function drawCaustics(t: number): void {
    const freq = 3.2 / shape.scale
    const aspect = W / H
    const drift = 0.04 * shape.loop_sec * shape.speed / shape.scale
    const gain = 0.6 + 0.9 * shape.amount / 100
    const ridge = (u: number, v: number, off: number) => {
      const a = fbm(u + off, v + 0.6 * off)
      const b = fbm(u * 1.7 - 0.7 * off + 5.2, v * 1.7 + 0.4 * off + 9.1)
      return Math.pow(1 - Math.abs(Math.sin(Math.PI * 4 * (a + 0.6 * b))), 4)
    }
    for (let y = 0; y < H; y++) {
      const yf = y / H
      const band = smoothstep(shape.region_top - 0.08, shape.region_top + 0.08, yf) * (1 - smoothstep(shape.region_bottom - 0.08, shape.region_bottom + 0.08, yf))
      const row = y * W
      const v = yf * freq
      for (let x = 0; x < W; x++) {
        if (band <= 0) { buf[row + x] = 0; continue }
        const u = (x / W) * freq * aspect
        const w1 = t
        buf[row + x] = Math.min(255, 255 * gain * band * (ridge(u, v, -drift * t) * (1 - w1) + ridge(u, v, -drift * (t - 1)) * w1))
      }
    }
  }

  /** Parchment: soft mottling plus fine fibres. Still — `t` is ignored. */
  let paperCache: Float32Array | null = null
  function drawPaper(): void {
    if (!paperCache) {
      paperCache = new Float32Array(W * H)
      const freq = 6 / shape.scale
      const aspect = W / H
      const strength = shape.amount / 100
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const u = (x / W) * freq * aspect, v = (y / H) * freq
          const mottle = fbm(u, v) - 0.5
          const grain = valueNoise(u * 9.7 + 3.1, v * 9.7 + 7.7) - 0.5
          paperCache[y * W + x] = 255 * Math.max(0, Math.min(1, 0.55 + strength * (1.1 * mottle + 0.35 * grain)))
        }
      }
      // Fibres: short, faint, slightly curved strokes.
      const fibres = Math.round(400 * strength * (W * H) / (960 * 540))
      const fr = seededRandom(shape.seed * 31 + 5)
      for (let i = 0; i < fibres; i++) {
        let x = fr() * W, y = fr() * H
        let a = fr() * TAU
        const len = (8 + fr() * 30) * k * shape.scale
        for (let s = 0; s < len; s++) {
          a += (fr() - 0.5) * 0.2
          x += Math.cos(a); y += Math.sin(a)
          const xi = Math.round(x), yi = Math.round(y)
          if (xi >= 0 && xi < W && yi >= 0 && yi < H) paperCache[yi * W + xi] = Math.min(255, paperCache[yi * W + xi]! + 40)
        }
      }
    }
    buf.set(paperCache)
  }

  /**
   * Aurora: ribbons of light across the sky band. Each ribbon's lower hem waves sideways over time;
   * above it the light fades upward in soft, uneven vertical rays.
   */
  function drawAurora(t: number): void {
    buf.fill(0)
    for (const p of particles) {
      const cx = p.x * W
      const half = (0.18 + 0.14 * p.r / 2.4) * W * shape.size
      const hemBase = bandTop + bandH * (0.5 + 0.35 * p.b)
      const height = bandH * (0.45 + 0.3 * p.r / 2.4)
      const c1 = cycles(p.k / 30, shape), c2 = cycles((p.m + 1) / 30, shape), c3 = cycles((p.m + 2) / 12, shape)
      const glow = 230 * (1 - shape.twinkle * 0.4 * (1 - Math.sin(TAU * cycles(p.m / 20, shape) * t + p.a)))
      const fringe = 0.03 * H
      for (let x = Math.max(0, Math.floor(cx - half)); x < Math.min(W, Math.ceil(cx + half)); x++) {
        const u = Math.abs(x - cx) / half
        const edge = 1 - smoothstep(0.55, 1, u)
        if (edge <= 0) continue
        const hem = hemBase + shape.sway * 0.07 * H * Math.sin(TAU * (x / W * 1.6 + c1 * t) + p.a)
          + shape.sway * 0.025 * H * Math.sin(TAU * (x / W * 4.1 - c2 * t) + 2 * p.a)
        const rays = (0.45 + 0.55 * valueNoise(x / Math.max(1, 5 * k * shape.size) + p.a * 13, 0.5))
          * (0.85 + 0.15 * Math.sin(TAU * c3 * t + x * 0.07 / Math.max(0.25, k)))
        const level = glow * edge * rays
        const y0 = Math.max(0, Math.floor(hem - height)), y1 = Math.min(H - 1, Math.ceil(hem + fringe))
        for (let y = y0; y <= y1; y++) {
          const v = y <= hem ? Math.pow((y - (hem - height)) / height, 1.8) : 1 - (y - hem) / fringe
          if (v > 0) buf[y * W + x]! += level * v
        }
      }
    }
  }

  /** A soft round glow around the moon, slowly breathing. */
  function drawMoonGlow(t: number): void {
    const cx = shape.beam * W, cy = shape.region_top * H
    const R = 0.12 * H * shape.size
    const breath = 1 - shape.twinkle * 0.3 * (1 - Math.cos(TAU * cycles(1 / 10, shape) * t)) / 2
    for (let y = 0; y < H; y++) {
      const row = y * W
      const dy = (y - cy) / R
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / R
        const d2 = dx * dx + dy * dy
        buf[row + x] = 255 * breath * (0.75 * Math.exp(-d2) + 0.25 * Math.exp(-d2 / 6.25))
      }
    }
  }

  /** Raindrops on glass: still beads with a highlight, and every eighth drop sliding down with a trail. */
  function drawWindowDrops(t: number): void {
    buf.fill(0)
    particles.forEach((p, i) => {
      const r = (3.5 + p.r * 3) * shape.size * k
      if (i % 8 === 7) {
        const margin = r * 12
        const span = H + margin * 2
        const y = frac(p.y + cycles(p.k / 20, shape) * t) * span - margin
        const x = p.x * W + 0.01 * W * Math.sin(TAU * cycles(p.m / 20, shape) * t + p.a)
        streak(x, y - r, r * 10, Math.max(1, r * 0.5), 60 * p.b)
        dot(x, y, r * 1.2, 90)
        dot(x - 0.35 * r, y - 0.35 * r, r * 0.35, 220)
      } else {
        const x = p.x * W, y = p.y * H
        dot(x, y, r, 55 * p.b)
        dot(x - 0.35 * r, y - 0.35 * r, r * 0.3, 200 * p.b)
      }
    })
  }

  /** Faint old-film marks: fresh specks every frame and a few hairline scratches drifting slowly. */
  function drawFilmDust(t: number): void {
    buf.fill(0)
    const frameIndex = Math.floor(t * N + 1e-6) % N
    const count = loopParticleCount(shape)
    const fr = seededRandom((shape.seed * 7919 + frameIndex * 104729) >>> 0)
    for (let i = 0; i < count; i++) {
      const x = fr() * W, y = fr() * H, rad = (0.6 + fr() * 1.9) * shape.size * k, val = 120 + fr() * 120
      const hair = fr() < 0.15
      const ang = fr() * TAU
      if (shape.subset !== 0 && (i % 2) !== shape.subset - 1) continue
      if (hair) {
        for (let s = 0; s < 18 * k * shape.size; s++) dot(x + Math.cos(ang + s * 0.08) * s, y + Math.sin(ang + s * 0.08) * s, Math.max(0.6, rad * 0.4), val * 0.7)
      } else {
        dot(x, y, rad, val)
      }
    }
    for (let j = 0; j < shape.layers; j++) {
      if (shape.subset !== 0 && (j % 2) !== shape.subset - 1) continue
      const sr = seededRandom(shape.seed * 13 + j * 977 + 1)
      const base = sr(), phase = sr() * TAU
      const x = (base + 0.03 * Math.sin(TAU * cycles(1 / 12, shape) * t + phase)) * W
      const jitter = (seededRandom((frameIndex + 1) * 7 + j)() - 0.5) * 1.5 * k
      const level = 90 * (0.6 + 0.4 * Math.sin(TAU * cycles(1 / 4, shape) * t + phase))
      for (let y = 0; y < H; y++) {
        const xi = Math.round(x + jitter + 2 * k * Math.sin(y / H * 7 + phase))
        if (xi >= 0 && xi < W) buf[y * W + xi]! += level
      }
    }
  }

  /** One shooting star's life across the sprite box: it streaks down and left, brightens, fades. */
  function drawShootingStar(t: number): void {
    buf.fill(0)
    const env = Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, t))), 0.8)
    if (env <= 0.001) return
    const ease = 1 - (1 - t) * (1 - t)
    const sx = 0.92 * W, sy = 0.1 * H, ex = 0.12 * W, ey = 0.88 * H
    const hx = sx + (ex - sx) * ease, hy = sy + (ey - sy) * ease
    const dx = ex - sx, dy = ey - sy
    const len = Math.hypot(dx, dy)
    const ux = dx / len, uy = dy / len
    const tail = len * 0.45 * Math.min(1, t * 2.5)
    const width = Math.max(0.8, 1.6 * H / 140)
    for (let s = 0; s < tail; s += 0.7) {
      const fall = 1 - s / Math.max(1, tail)
      dot(hx - ux * s, hy - uy * s, width * (0.5 + 0.5 * fall), 200 * env * fall * fall)
    }
    dot(hx, hy, width * 1.6, 255 * env)
    dot(hx, hy, width * 5, 60 * env)
  }

  return {
    width: W,
    height: H,
    frames: N,
    draw(index: number, out: Uint8Array | Uint8ClampedArray): void {
      this.drawPhase((((index % N) + N) % N) / N, out)
    },
    drawPhase(t: number, out: Uint8Array | Uint8ClampedArray): void {
      if (shape.variant === 'fog' || shape.variant === 'cloud-shadows') drawNoise(t)
      else if (shape.variant === 'light-rays') drawRays(t)
      else if (shape.variant === 'sky-clouds') drawSkyClouds(t)
      else if (shape.variant === 'caustics') drawCaustics(t)
      else if (shape.variant === 'paper') drawPaper()
      else if (shape.variant === 'aurora') drawAurora(t)
      else if (shape.variant === 'moon-glow') drawMoonGlow(t)
      else if (shape.variant === 'window-drops') drawWindowDrops(t)
      else if (shape.variant === 'film-dust') drawFilmDust(t - Math.floor(t))
      else if (shape.variant === 'shooting-star') drawShootingStar(t)
      else drawParticles(t)
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]!
        out[i] = v > 255 ? 255 : v < 0 ? 0 : v
      }
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Live light effects — the same maths the compiler writes as FFmpeg expressions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Candle / firelight flicker: a brightness offset in -amount..amount.
 *
 * Three incommensurate sines rather than noise, because FFmpeg's `eq` can only
 * evaluate a closed-form expression of `t` — and the compiler writes exactly
 * this sum, so the canvas and the render flicker identically.
 */
export function flickerOffset(t: number, amount: number, speed: number): number {
  const f = 1.7 * speed
  return amount * (0.5 * Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * f * 2.31 * t + 1.3) + 0.2 * Math.sin(TAU * f * 5.17 * t + 2.1))
}

/**
 * Lightning: 0..1 flash level at time `t`.
 *
 * Time is cut into slots of `period` seconds. A slot flashes when its hash
 * falls under `chance`; the flash lands at a hashed point inside the slot and
 * decays fast, with a weaker second strike 0.18 s later. All of it is a closed
 * form of `t` (FFmpeg has `sin`, `floor`, `exp`), so the render and the preview
 * strike at the same moments for the same seed.
 */
export function lightningLevel(t: number, period: number, chance: number, seed: number): number {
  const slot = Math.floor(t / period)
  if (hash01(slot, seed) >= chance) return 0
  const at = slot * period + period * (0.15 + 0.7 * hash01(slot + 0.5, seed))
  const dt = t - at
  const strike = (d: number) => (d >= 0 ? Math.exp(-d * 9) : 0)
  return Math.min(1, strike(dt) + 0.6 * strike(dt - 0.18))
}

/** GLSL-style hash, written so FFmpeg's expression evaluator can repeat it. */
export function hash01(n: number, seed: number): number {
  const v = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/**
 * Shooting star: where one is in flight at time `t`, or null.
 *
 * Time is cut into slots of `period` seconds, as lightning's is. A slot gets a star when its hash
 * falls under `chance`; the star starts at a hashed moment inside the slot, ROUNDED DOWN to a whole
 * number of lives (`life` = the sprite loop's length), so the looping sprite is at its first frame
 * exactly when the star appears. Its box lands at a hashed place in the band. The compiler writes
 * the same sums as FFmpeg expressions, so preview and render agree.
 */
export function shootingStarAt(t: number, period: number, chance: number, seed: number, life: number):
  { phase: number; x: number; y: number } | null {
  const slot = Math.floor(t / period)
  if (hash01(slot, seed) >= chance) return null
  const at = life * Math.floor((slot * period + period * (0.1 + 0.75 * hash01(slot + 0.25, seed))) / life)
  if (t < at || t >= at + life) return null
  return { phase: (t - at) / life, x: hash01(slot + 0.5, seed), y: hash01(slot + 0.75, seed) }
}

// ═══════════════════════════════════════════════════════════════════════════
// Transition mattes — ink and watercolour bleed (E1, 1.4.287)
// ═══════════════════════════════════════════════════════════════════════════

export const BLEED_VARIANTS = ['ink', 'watercolour'] as const
export type BleedVariant = (typeof BLEED_VARIANTS)[number]

/**
 * The grey matte of a bleed transition: frame 0 all black (the old scene), the last frame all
 * white (the new one), and in between the white spreads through the picture like ink in water.
 * The spread follows a rank-normalised noise field, so the area it covers grows evenly over the
 * transition whatever the noise looks like. Ink: fine, branching, sharp edge. Watercolour: broad,
 * soft edge.
 */
export function createBleedMatte(variant: BleedVariant, width: number, height: number, frames: number, seed = 11): LoopRenderer {
  const W = Math.max(2, Math.round(width)), H = Math.max(2, Math.round(height)), N = Math.max(2, Math.round(frames))
  const ink = variant === 'ink'
  const scale = ink ? 0.55 : 1.3
  const field = new Float32Array(W * H)
  const rnd = seededRandom(seed * 977 + (ink ? 1 : 2))
  const seeds = Array.from({ length: 3 }, () => ({ x: 0.15 + 0.7 * rnd(), y: 0.15 + 0.7 * rnd() }))
  const noiseSeed = (Math.round(seed) * 2654435761) >>> 0
  const lattice = (ix: number, iy: number) => {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + noiseSeed) >>> 0
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const vnoise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
    const a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  const fbm3 = (x: number, y: number) => 0.5 * vnoise(x, y) + 0.3 * vnoise(x * 2.1 + 9.2, y * 2.1 + 1.3) + 0.2 * vnoise(x * 4.3 + 3.3, y * 4.3 + 7.9)
  const freq = 4 / scale
  const aspect = W / H
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * freq * aspect, v = (y / H) * freq
      // Domain warp makes the front branch and curl.
      const wu = u + 1.4 * (fbm3(u + 3.1, v + 7.2) - 0.5), wv = v + 1.4 * (fbm3(u + 8.4, v + 1.9) - 0.5)
      const n = fbm3(wu, wv)
      const near = Math.min(...seeds.map(s => Math.hypot((x / W - s.x) * aspect, y / H - s.y)))
      field[y * W + x] = (ink ? 0.55 : 0.4) * n + (ink ? 0.45 : 0.6) * Math.min(1, near / 0.9)
    }
  }
  // Rank-normalise: the share of the picture already covered equals the threshold.
  const order = Array.from(field.keys()).sort((a, b) => field[a]! - field[b]!)
  order.forEach((idx, rank) => { field[idx] = rank / (order.length - 1) })
  const soft = ink ? 0.025 : 0.11
  return {
    width: W, height: H, frames: N,
    draw(index: number, out: Uint8Array | Uint8ClampedArray): void {
      this.drawPhase(Math.max(0, Math.min(1, index / (N - 1))), out)
    },
    drawPhase(p: number, out: Uint8Array | Uint8ClampedArray): void {
      const eased = smoothstep(0, 1, p)
      const th = -soft + (1 + 2 * soft) * eased
      for (let i = 0; i < field.length; i++) out[i] = Math.round(255 * (1 - smoothstep(th - soft, th + soft, field[i]!)))
    },
  }
}
