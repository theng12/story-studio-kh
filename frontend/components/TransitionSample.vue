<template>
  <span v-if="!shape" class="ts-none">No sample yet</span>
  <!-- Decorative: the card's label already names the option for assistive tech. -->
  <svg v-else class="ts-frame" viewBox="0 0 160 90" aria-hidden="true">
    <!-- Scene A always starts as the whole frame; B is the incoming scene. -->
    <rect width="160" height="90" :fill="A" />

    <template v-if="shape.t === 'cut'">
      <rect x="80" width="80" height="90" :fill="B" />
    </template>

    <template v-else-if="throughPanels.length">
      <rect
        v-for="(p, i) in throughPanels" :key="i"
        :x="p.x" :width="p.w" height="90" :fill="p.fill"
      />
    </template>

    <template v-else-if="shape.t === 'overlap'">
      <rect x="55" width="105" height="90" :fill="B" opacity="0.55" />
    </template>

    <template v-else-if="shape.t === 'grain'">
      <circle v-for="(d, i) in grainDots" :key="i" :cx="d.x" :cy="d.y" r="2.6" :fill="B" />
    </template>

    <template v-else-if="shape.t === 'blocks'">
      <rect
        v-for="(d, i) in blockCells" :key="i"
        :x="d.x" :y="d.y" width="16" height="16" :fill="B"
      />
    </template>

    <template v-else-if="shape.t === 'blur'">
      <rect x="110" width="50" height="90" :fill="B" />
      <rect
        v-for="(s, i) in blurSlices" :key="i"
        :x="s.x" :width="s.w" height="90" :fill="B" :opacity="s.o"
      />
    </template>

    <template v-else-if="edgeShape">
      <polygon
        :points="edgePoints" :fill="B"
        :class="{ 'ts-soft': edgeShape.soft }"
        :transform="edgeShape.soft ? SOFT_EXPAND : undefined"
      />
      <line :x1="arrow.x1" :y1="arrow.y1" :x2="arrow.x2" :y2="arrow.y2" stroke="#0b0d12" stroke-width="3" stroke-linecap="round" />
      <polygon :points="arrow.head" fill="#0b0d12" />
    </template>
  </svg>
</template>

<script setup lang="ts">
/**
 * A drawn sample of what one transition does to the frame.
 *
 * Every sample is built from the same two scenes — A (blue) fills the frame,
 * B (amber) is the incoming one — so a card reads at a glance: a cut is a bare
 * seam, a crossfade is B half over A, a wipe is a hard edge with an arrow for
 * the direction the edge travels.
 *
 * The still only claims what a still can show. Speed-only variants
 * (`fade-fast`, `fade-slow`) and the shapes this component does not draw
 * (`distance`, the bleeds, the slices, the crops) render "No sample yet"
 * rather than a picture that would only pretend.
 */
const props = defineProps<{ kind: string }>()

const A = '#4b7bd1'
const B = '#d08a3e'
/** Wipes read as soft-edged by blurring a polygon grown past the frame. */
const SOFT_EXPAND = 'translate(80,45) scale(1.3) translate(-80,-45)'

type Shape =
  | { t: 'cut' }
  | { t: 'overlap' }
  | { t: 'through'; mid: string; hold?: boolean }
  | { t: 'grain' }
  | { t: 'blocks' }
  | { t: 'blur' }
  | { t: 'edge'; dir: string; soft?: boolean }

/** Unit vectors for the direction the transition front travels. */
const DIRS: Record<string, [number, number]> = {
  left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  tl: [-0.7071, -0.7071], tr: [0.7071, -0.7071],
  bl: [-0.7071, 0.7071], br: [0.7071, 0.7071],
}

const edge = (dir: string, soft = false): Shape => ({ t: 'edge', dir, soft })

const KNOWN: Record<string, Shape> = {
  none: { t: 'cut' },
  crossfade: { t: 'overlap' },
  'fade-black': { t: 'through', mid: '#0a0a0c' },
  'fade-white': { t: 'through', mid: '#f2f4f8' },
  'fade-grays': { t: 'through', mid: '#7d8494' },
  'dip-black': { t: 'through', mid: '#0a0a0c', hold: true },
  dissolve: { t: 'grain' },
  pixelize: { t: 'blocks' },
  hblur: { t: 'blur' },
  'blur-dissolve': { t: 'blur' },
  'wipe-left': edge('left'), 'wipe-right': edge('right'),
  'wipe-up': edge('up'), 'wipe-down': edge('down'),
  'diag-tl': edge('tl'), 'diag-tr': edge('tr'),
  'diag-bl': edge('bl'), 'diag-br': edge('br'),
  'smooth-left': edge('left', true), 'smooth-right': edge('right', true),
  'smooth-up': edge('up', true), 'smooth-down': edge('down', true),
  // Slides, covers and reveals are the same still as a wipe at the halfway
  // mark: both scenes are full height and meet at the moving seam. Only the
  // motion behind the seam differs, and a still cannot show motion.
  'slide-left': edge('left'), 'slide-right': edge('right'),
  'slide-up': edge('up'), 'slide-down': edge('down'),
  'cover-left': edge('left'), 'cover-right': edge('right'),
  'cover-up': edge('up'), 'cover-down': edge('down'),
  'reveal-left': edge('left'), 'reveal-right': edge('right'),
  'reveal-up': edge('up'), 'reveal-down': edge('down'),
}

const shape = computed<Shape | null>(() => KNOWN[props.kind] ?? null)
const edgeShape = computed(() => {
  const s = shape.value
  return s?.t === 'edge' ? s : null
})

const throughPanels = computed(() => {
  const s = shape.value
  if (s?.t !== 'through') return []
  const fills = s.hold ? [A, s.mid, s.mid, B] : [A, s.mid, B]
  const gap = 5
  const w = (160 - gap * (fills.length - 1)) / fills.length
  return fills.map((fill, i) => ({ fill, x: i * (w + gap), w }))
})

/** Half of the frame behind the moving front — the side B has already taken. */
const edgePoints = computed(() => {
  const dir = edgeShape.value?.dir
  if (!dir || !DIRS[dir]) return ''
  const [mx, my] = DIRS[dir]
  const ring: Array<[number, number]> = [[0, 0], [160, 0], [160, 90], [0, 90]]
  const side = ([x, y]: [number, number]) => (x - 80) * mx + (y - 45) * my
  const pts: string[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const fa = side(a)
    const fb = side(b)
    if (fa < 0) pts.push(`${a[0]},${a[1]}`)
    if (fa < 0 !== fb < 0) {
      const t = fa / (fa - fb)
      pts.push(`${a[0] + (b[0] - a[0]) * t},${a[1] + (b[1] - a[1]) * t}`)
    }
  }
  return pts.join(' ')
})

const arrow = computed(() => {
  const dir = edgeShape.value?.dir
  const [mx, my] = dir && DIRS[dir] ? DIRS[dir] : [1, 0]
  const reach = 26
  const head = 10
  const half = 5.5
  const tipX = 80 + mx * reach
  const tipY = 45 + my * reach
  const baseX = tipX - mx * head
  const baseY = tipY - my * head
  const px = -my
  const py = mx
  return {
    x1: 80 - mx * reach,
    y1: 45 - my * reach,
    x2: baseX,
    y2: baseY,
    head: `${tipX},${tipY} ${baseX + px * half},${baseY + py * half} ${baseX - px * half},${baseY - py * half}`,
  }
})

/** Deterministic scatter: a still that reads as grain, not as a texture. */
const grainDots: Array<{ x: number; y: number }> = []
for (let y = 7; y < 90; y += 10) {
  for (let x = 7; x < 160; x += 10) {
    if (((x * 7 + y * 13) >> 2) % 3 === 0) continue
    grainDots.push({ x, y })
  }
}

const blockCells: Array<{ x: number; y: number }> = []
for (let y = 0; y < 90; y += 16) {
  for (let x = 0; x < 160; x += 16) {
    if (((x / 16) * 3 + (y / 16) * 5) % 4 >= 2) continue
    blockCells.push({ x, y })
  }
}

const blurSlices = Array.from({ length: 12 }, (_, i) => ({ x: 50 + i * 5, w: 5, o: (i + 1) / 12 }))
</script>

<style scoped>
.ts-none {
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.ts-frame {
  display: block;
  width: 100%;
  height: 100%;
}
.ts-soft {
  filter: blur(4px);
}
</style>
