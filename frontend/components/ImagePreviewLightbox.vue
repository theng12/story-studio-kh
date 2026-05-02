<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="ipl-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="positionLabel + ' — ' + currentFilename"
      @click.self="close"
    >
      <!-- Top bar: position indicator + filename + ✕ -->
      <header class="ipl-topbar">
        <div class="ipl-position">
          <strong>{{ positionLabel }}</strong>
          <span class="ipl-filename" :title="currentFilename">{{ currentFilename }}</span>
        </div>
        <button
          type="button"
          class="ipl-icon-btn"
          aria-label="Close preview (Escape)"
          title="Close (Esc)"
          @click="close"
        >✕</button>
      </header>

      <!-- Image stage -->
      <div class="ipl-stage">
        <button
          v-if="images.length > 1"
          type="button"
          class="ipl-arrow ipl-arrow-prev"
          :disabled="atStart"
          aria-label="Previous image (Left arrow)"
          title="Previous (←)"
          @click.stop="goPrev"
        >‹</button>

        <div class="ipl-image-wrap">
          <img
            v-if="currentImage"
            :key="currentImage.path"
            :src="previewUrl"
            :alt="currentFilename"
            class="ipl-image"
            @load="imgLoading = false"
            @error="onImgError"
          />
          <div v-if="imgLoading" class="ipl-image-loading" aria-hidden="true">
            <LoadingSpinner size="sm" />
          </div>
          <div v-if="loadError" class="ipl-image-error">
            ⚠ Couldn't load preview — the file may have moved or been deleted.
          </div>
        </div>

        <button
          v-if="images.length > 1"
          type="button"
          class="ipl-arrow ipl-arrow-next"
          :disabled="atEnd"
          aria-label="Next image (Right arrow)"
          title="Next (→)"
          @click.stop="goNext"
        >›</button>
      </div>

      <!-- Bottom bar: edit CTA + keyboard hint -->
      <footer class="ipl-bottombar">
        <span class="ipl-shortcut-hint" aria-hidden="true">
          <kbd>Esc</kbd> close · <kbd>←</kbd> / <kbd>→</kbd> browse · <kbd>Enter</kbd> edit
        </span>
        <button
          type="button"
          class="btn btn-primary ipl-edit-btn"
          :disabled="!currentImage || loadError"
          @click="emitEdit"
        >
          ✨ Edit with AI
        </button>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Fullscreen image lightbox + carousel — view one image at ~90vw / 85vh,
 * browse the supplied list with ← / → (or the side-arrow buttons), close
 * with Escape, and trigger an edit with Enter (or the bottom CTA).
 *
 * Built as a custom Teleport overlay (rather than wrapping Modal.vue)
 * because Modal.vue caps at 880 px max-width and we want a true large
 * preview. Pattern mirrors ImageEditDialog's overlay + custom escape
 * handling so behaviour is consistent with the existing edit flow.
 *
 * Self-contained — the parent only needs to mount once and pass images
 * + index. Edits go via the `edit` emit; the parent typically closes
 * this lightbox and opens its existing ImageEditDialog on the same path.
 */

interface PreviewImage {
  filename: string
  path: string
  /** Optional grouping label shown alongside the position indicator. */
  section?: 'scenes' | 'thumbnails'
  /** Scene number when the image is a generated scene; surfaces in the position label. */
  scene_number?: number | null
}

const props = withDefaults(defineProps<{
  visible: boolean
  images: PreviewImage[]
  index: number
  projectSlug: string
}>(), {
  images: () => [],
  index: 0,
})

const emit = defineEmits<{
  'update:visible': [open: boolean]
  'update:index':   [i: number]
  /** Caller should close the lightbox and open whatever edit UI it owns. */
  'edit':           [path: string]
}>()

// ── Image state ─────────────────────────────────────────────────────────
const currentImage = computed<PreviewImage | null>(() => {
  if (!props.images.length) return null
  const i = Math.max(0, Math.min(props.index, props.images.length - 1))
  return props.images[i] || null
})
const currentFilename = computed(() => currentImage.value?.filename || '')

const atStart = computed(() => props.index <= 0)
const atEnd   = computed(() => props.index >= props.images.length - 1)

const positionLabel = computed(() => {
  if (!props.images.length) return ''
  const i = props.index + 1
  const total = props.images.length
  const c = currentImage.value
  if (c?.section === 'scenes') {
    // Same-section count is more useful than the global "of N" when the
    // list is mixed scenes + thumbs — but we'd need section counts
    // passed in. For now use scene_number when present.
    const num = c.scene_number ?? i
    return `Scene ${num} · ${i} / ${total}`
  }
  if (c?.section === 'thumbnails') {
    return `Thumbnail ${i} / ${total}`
  }
  return `${i} / ${total}`
})

const previewUrl = computed(() => {
  const c = currentImage.value
  if (!c) return ''
  // Same endpoint images.vue + video-assembly already use for in-app
  // image previews. Cache-bust with the path so swaps render the
  // right pixels even when the lightbox stays mounted.
  return `/api/projects/${props.projectSlug}/video-editor/preview-image?path=${encodeURIComponent(c.path)}`
})

// ── Loading state ───────────────────────────────────────────────────────
const imgLoading = ref(false)
const loadError = ref(false)

watch(currentImage, (cur, prev) => {
  if (cur && cur.path !== prev?.path) {
    imgLoading.value = true
    loadError.value = false
  }
})
function onImgError() {
  imgLoading.value = false
  loadError.value = true
}

// ── Navigation ──────────────────────────────────────────────────────────
function goPrev() {
  if (atStart.value) return
  emit('update:index', props.index - 1)
}
function goNext() {
  if (atEnd.value) return
  emit('update:index', props.index + 1)
}
function close() {
  emit('update:visible', false)
}
function emitEdit() {
  if (!currentImage.value || loadError.value) return
  emit('edit', currentImage.value.path)
}

// ── Keyboard handling ───────────────────────────────────────────────────
// Document-level so it works no matter what's focused inside the overlay.
// Attached/detached on visibility change to avoid intercepting keys for
// other surfaces (notably: the parent's ImageEditDialog when the user
// triggers `edit` and the lightbox closes).
function onKeydown(e: KeyboardEvent) {
  if (!props.visible) return
  // Don't fight a user typing into a hypothetical input inside the
  // lightbox (none today, but defensive — Enter-to-edit shouldn't fire
  // while typing into a search box added later).
  const target = e.target as HTMLElement | null
  const isFormControl = !!target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      close()
      break
    case 'ArrowLeft':
      e.preventDefault()
      goPrev()
      break
    case 'ArrowRight':
      e.preventDefault()
      goNext()
      break
    case 'Enter':
      if (isFormControl) return
      e.preventDefault()
      emitEdit()
      break
  }
}

watch(() => props.visible, (open) => {
  if (open) {
    // Reset loading flag for the first frame; <img>'s @load will clear it.
    imgLoading.value = !!currentImage.value
    loadError.value = false
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKeydown)
    }
  } else {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onKeydown)
    }
  }
})

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onKeydown)
  }
})
</script>

<style scoped>
/* Highest z-index in the app — outranks ImageEditDialog (9999). When the
 * user triggers Edit, we close this layer first, so the dialog ends up
 * alone on top regardless of stacking order. */
.ipl-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  flex-direction: column;
  user-select: none;
}

/* ── Top bar ───────────────────────────────────────────────────────── */
.ipl-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  color: rgba(255, 255, 255, 0.92);
  flex-shrink: 0;
}
.ipl-position {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.ipl-position strong {
  font-size: 14px;
  letter-spacing: 0.02em;
}
.ipl-filename {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.ipl-icon-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.85);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s;
}
.ipl-icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.4);
}

/* ── Stage (image + side arrows) ──────────────────────────────────── */
.ipl-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  min-height: 0;
  padding: 0 16px;
}

.ipl-image-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 90vw;
  max-height: 85vh;
  width: 100%;
  height: 100%;
}
.ipl-image {
  display: block;
  max-width: 90vw;
  max-height: 85vh;
  width: auto;
  height: auto;
  object-fit: contain;
  /* A faint border helps see the image edges against the dark backdrop
   * when the source has near-black borders (common on cinematic shots). */
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
.ipl-image-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.ipl-image-error {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(245, 158, 11, 0.18);
  color: rgb(252, 211, 77);
  border: 1px solid rgba(245, 158, 11, 0.45);
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
}

/* Side arrows — large hit targets that don't overlap the image since
 * they sit in the padding gutter. Hidden via v-if when only 1 image. */
.ipl-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.92);
  width: 56px;
  height: 56px;
  border-radius: 50%;
  font-size: 32px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  z-index: 1;
}
.ipl-arrow:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.65);
  border-color: rgba(255, 255, 255, 0.4);
}
.ipl-arrow:active:not(:disabled) {
  transform: translateY(-50%) scale(0.95);
}
.ipl-arrow:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}
.ipl-arrow-prev { left: 16px; }
.ipl-arrow-next { right: 16px; }

/* ── Bottom bar ───────────────────────────────────────────────────── */
.ipl-bottombar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  color: rgba(255, 255, 255, 0.7);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.ipl-shortcut-hint {
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ipl-shortcut-hint kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
}
.ipl-edit-btn {
  flex-shrink: 0;
}

/* Tighten the chrome on narrow viewports — the Electron window can get
 * pretty small if the user shrinks it. */
@media (max-height: 600px) {
  .ipl-topbar { padding: 8px 16px; }
  .ipl-bottombar { padding: 8px 16px; }
  .ipl-arrow { width: 44px; height: 44px; font-size: 26px; }
  .ipl-image { max-height: 75vh; }
}
</style>
