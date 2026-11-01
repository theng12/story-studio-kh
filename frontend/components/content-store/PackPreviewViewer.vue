<template>
  <!--
    A pack's preview pictures, full size.

    This is a lightbox: the one place a modal is the right shape, because the
    task is "look at this one picture closely" — protected focus, Esc to leave.
    Everything is keyboard-driven (Esc / ← / →), because a picture wall that
    only answers to a mouse is unusable from the keyboard and from a trackpad
    the arrows are faster than aiming at an edge control.
  -->
  <Teleport to="body">
    <div
      v-if="picture" class="pack-viewer" role="dialog" aria-modal="true"
      :aria-label="`${title}, picture ${index + 1} of ${pictures.length}`"
      @click.self="$emit('close')"
    >
      <header class="pack-viewer-bar">
        <div class="pack-viewer-title">
          <p>{{ title }}</p>
          <!-- A count that is absent for one picture, rather than a "1 of 1"
               that promises navigation the arrows cannot do. -->
          <span v-if="pictures.length > 1">{{ index + 1 }} of {{ pictures.length }}</span>
        </div>
        <button type="button" class="pack-viewer-close" aria-label="Close preview" @click="$emit('close')">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
        </button>
      </header>

      <div class="pack-viewer-stage">
        <button
          v-if="pictures.length > 1" type="button" class="pack-viewer-nav pack-viewer-prev"
          aria-label="Previous picture" @click="step(-1)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 2.5L4.5 8l5.5 5.5" /></svg>
        </button>

        <figure class="pack-viewer-figure">
          <img
            v-if="!broken" :key="picture.src" :src="picture.src"
            :alt="picture.alt || title" decoding="async" @error="broken = true"
          />
          <!-- A picture that will not load says so, with the reason, instead of
               leaving a hole. Retrying rebuilds the request from scratch. -->
          <div v-else class="pack-viewer-broken" role="alert">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 7v6M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
            <p><strong>Couldn't load this preview</strong><span>The picture did not arrive from the Gateway.</span></p>
            <button type="button" class="btn btn-secondary" @click="retry">Try again</button>
          </div>
          <figcaption v-if="picture.alt">{{ picture.alt }}</figcaption>
        </figure>

        <button
          v-if="pictures.length > 1" type="button" class="pack-viewer-nav pack-viewer-next"
          aria-label="Next picture" @click="step(1)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 2.5L11.5 8 6 13.5" /></svg>
        </button>
      </div>

      <!-- A strip only when there is something to choose between: one picture
           needs no second way to reach itself. -->
      <footer v-if="pictures.length > 1" class="pack-viewer-strip">
        <button
          v-for="(row, position) in pictures" :key="row.src" type="button"
          class="pack-viewer-thumb" :data-current="position === index ? 'true' : undefined"
          :aria-label="`Show picture ${position + 1}`" :aria-current="position === index ? 'true' : undefined"
          @click="goTo(position)"
        >
          <img :src="row.src" :alt="''" loading="lazy" decoding="async" />
        </button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * The gallery's pictures, and nothing else. Callers decide what a pack's
 * pictures are — the viewer never guesses, and a pack with none renders no
 * viewer at all (the detail view says so in words instead).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface PackPicture {
  src: string
  alt: string
}

const props = defineProps<{
  pictures: readonly PackPicture[]
  /** Which picture is showing. Advanced by the arrows and the strip. */
  index: number
  title: string
}>()

const emit = defineEmits<{ close: []; 'update:index': [index: number] }>()

const broken = ref(false)
const picture = computed<PackPicture | null>(() => props.pictures[props.index] ?? null)

// A new picture is a new request: a failure on the last one must not paint
// over the next.
watch(() => picture.value?.src, () => { broken.value = false })

function step(delta: number): void {
  if (props.pictures.length < 2) return
  emit('update:index', (props.index + delta + props.pictures.length) % props.pictures.length)
}
function goTo(position: number): void {
  emit('update:index', position)
}
function retry(): void {
  broken.value = false
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { emit('close'); return }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
}

onMounted(() => { window.addEventListener('keydown', onKeydown) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown) })
</script>

<style scoped>
.pack-viewer {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  padding: clamp(12px, 2vw, 22px);
  background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
  /* Backdrop, not decoration: it is what separates the picture from the page
     underneath without a second box drawn on top of the first. */
  backdrop-filter: blur(10px);
}

.pack-viewer-bar { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.pack-viewer-title { display: grid; gap: 2px; min-width: 0; }
.pack-viewer-title p { overflow: hidden; color: var(--text-primary); font-size: var(--font-lg); font-weight: 700; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
.pack-viewer-title span { color: var(--text-secondary); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }
.pack-viewer-close {
  flex: none;
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}
.pack-viewer-close:hover { border-color: var(--border-light); color: var(--text-primary); }
.pack-viewer-close:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.pack-viewer-close svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }

/* The stage takes the height the bar and strip leave, and the picture fits
   inside it rather than the other way round — a tall original on a short
   window must not push the controls off the screen. */
.pack-viewer-stage { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 0; }
.pack-viewer-figure { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 8px; min-width: 0; min-height: 0; margin: 0; justify-items: center; }
.pack-viewer-figure img { width: auto; height: auto; max-width: 100%; max-height: 100%; border-radius: var(--radius-lg); background: var(--bg-secondary); object-fit: contain; }
.pack-viewer-figure figcaption { max-width: 70ch; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.45; text-align: center; }

.pack-viewer-nav {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-secondary) 90%, transparent);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease;
}
.pack-viewer-nav:hover { border-color: var(--accent); background: var(--bg-secondary); }
.pack-viewer-nav:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.pack-viewer-nav svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

.pack-viewer-broken {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 12px;
  min-width: min(100%, 320px);
  padding: clamp(24px, 5vw, 44px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  text-align: center;
}
.pack-viewer-broken svg { width: 34px; height: 34px; fill: none; stroke: var(--warning); stroke-width: 1.6; stroke-linecap: round; }
.pack-viewer-broken p { display: grid; gap: 3px; margin: 0; }
.pack-viewer-broken strong { color: var(--text-primary); font-size: var(--font-md); }
.pack-viewer-broken span { color: var(--text-secondary); font-size: var(--font-sm); }

.pack-viewer-strip { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }
.pack-viewer-thumb {
  width: 72px;
  padding: 0;
  overflow: hidden;
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
  opacity: .62;
  transition: opacity 140ms ease, border-color 140ms ease;
}
.pack-viewer-thumb:hover { opacity: .9; }
.pack-viewer-thumb:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
/* The current picture is marked by the border, never by colour alone. */
.pack-viewer-thumb[data-current] { border-color: var(--accent); opacity: 1; }
.pack-viewer-thumb img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }

@media (max-width: 560px) {
  .pack-viewer-stage { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  /* On a narrow screen the arrows sit under the picture where a thumb can
     reach them, instead of eating the width the picture needs. */
  .pack-viewer-prev, .pack-viewer-next { justify-self: center; }
  .pack-viewer-stage { align-content: center; }
  .pack-viewer-prev { grid-row: 2; }
  .pack-viewer-next { grid-row: 2; }
  .pack-viewer-figure { grid-row: 1; grid-column: 1; }
  .pack-viewer-nav { width: 48px; height: 48px; }
}
</style>
