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
] as const
export type LoopVariant = (typeof LOOP_VARIANTS)[number]

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
}

/**
 * Everything that changes the SHAPE of a loop — the fields a bake depends on.
 * Colour, brightness and the picture darkening are applied at composite time
 * and are deliberately absent: changing them never re-bakes.
 */
export interface LoopShape {
  variant: LoopVariant
  /** 0..100. Share of `max_count`, or fog/cloud density. */
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

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** The size a loop is baked at for an output frame. Always even (yuv/gray encoders want it). */
export function loopBakeSize(shape: LoopShape, outW: number, outH: number): { w: number; h: number } {
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
