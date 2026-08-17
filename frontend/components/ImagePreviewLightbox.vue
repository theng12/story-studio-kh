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
            :key="renderKey"
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
            <span>⚠ Couldn't load preview - the file may have moved or been deleted.</span>
            <button type="button" class="ipl-retry-btn" @click.stop="retryPreview">↻ Retry preview</button>
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

      <!-- Bottom bar: preview shortcuts + optional thumbnail pin toggle. -->
      <footer class="ipl-bottombar">
        <span class="ipl-shortcut-hint" aria-hidden="true">
          <kbd>Esc</kbd> close · <kbd>←</kbd> / <kbd>→</kbd> browse
        </span>
        <div class="ipl-actions">
          <button
            v-if="pinEnabled && currentImage"
            type="button"
            :class="['btn btn-sm', currentImage.is_pinned ? 'btn-secondary ipl-pin-btn--active' : 'btn-secondary']"
            :title="currentImage.is_pinned
              ? 'Unpin — uploads will fall back to the auto-picked thumbnail (highest version).'
              : 'Pin this thumbnail — every upload of this episode will use it. Reversible from this same button.'"
            @click="emitPinToggle"
          >
            {{ currentImage.is_pinned ? '📌 Pinned · Unpin' : '📌 Pin for upload' }}
          </button>
        </div>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Fullscreen image lightbox + carousel — view one image at ~90vw / 85vh,
 * browse the supplied list with ← / → (or the side-arrow buttons), and close
 * with Escape.
 *
 * Built as a custom Teleport overlay (rather than wrapping Modal.vue)
 * because Modal.vue caps at 880 px max-width and we want a true large
 * preview. It uses a custom overlay because Modal.vue caps at 880 px.
 *
 * Self-contained — the parent only needs to mount once and pass images
 * + index.
 */

interface PreviewImage {
  filename: string
  path: string
  /** Optional grouping label shown alongside the position indicator. */
  section?: 'scenes' | 'thumbnails'
  /** Scene number when the image is a generated scene; surfaces in the position label. */
  scene_number?: number | null
  /** v1.0.41 — when true, the thumbnail-pin button shows "Pinned" + offers Unpin. */
  is_pinned?: boolean
}

const props = withDefaults(defineProps<{
  visible: boolean
  images: PreviewImage[]
  index: number
  projectSlug: string
  /**
   * v1.0.41 — show a Pin / Unpin button in the bottom bar. The parent
   * decides whether the action is meaningful for the current image
   * (typically: only thumbnails, never scenes) and handles the
   * `pin-toggle` emit.
   */
  pinEnabled?: boolean
  /**
   * v1.2.9 — bumped by the parent whenever the bytes behind these paths may
   * have changed on disk (a per-row or bulk regeneration, a repair, an
   * import). Regeneration overwrites in place, so the path alone cannot tell
   * the browser anything changed: same `src` means no request is issued at
   * all, and no server cache header can help a request that never happens.
   * The version goes into both the URL and the <img> key so the element is
   * remounted rather than patched. Mirrors `cacheKey` in ImageGeneratorPanel,
   * which is why the row thumbnails were already correct while this was not.
   */
  version?: number | string
}>(), {
  images: () => [],
  index: 0,
  pinEnabled: false,
  version: 0,
})

const emit = defineEmits<{
  'update:visible': [open: boolean]
  'update:index':   [i: number]
  /**
   * v1.0.41 — fired when the Pin / Unpin button is clicked. Payload
   * carries the current image path + the desired post-toggle state
   * (true = pin, false = unpin) so the parent can run the right
   * write without re-checking the props.
   */
  'pin-toggle':     [{ path: string; filename: string; pin: boolean }]
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

// Identity of the pixels currently on screen: which file, and which
// generation of that file. Regeneration overwrites in place, so the path
// alone is not enough — see the `version` prop. Used as the <img> :key so a
// new generation remounts the element instead of patching an attribute the
// browser may satisfy from its in-memory image cache.
const renderKey = computed(() => `${currentImage.value?.path ?? ''}#${props.version}`)

const previewUrl = computed(() => {
  const c = currentImage.value
  if (!c) return ''
  // Same endpoint images.vue + video-assembly already use for in-app
  // image previews. Two independent busters, doing two different jobs:
  // `v` tracks new bytes at the same path (parent-driven), `preview_retry`
  // re-asks the server after a failed load (error-driven). Neither
  // substitutes for the other.
  return `/api/projects/${props.projectSlug}/video-editor/preview-image?path=${encodeURIComponent(c.path)}&v=${encodeURIComponent(String(props.version))}&preview_retry=${previewAttempt.value}`
})

// ── Loading state ───────────────────────────────────────────────────────
const imgLoading = ref(false)
const loadError = ref(false)
const previewAttempt = ref(0)

// Keyed on renderKey rather than the image object: the parent's list is
// recomputed (new object identities, same paths) on unrelated changes such
// as a pin toggle, and those must not restart the load.
watch(renderKey, () => {
  if (!currentImage.value) return
  previewAttempt.value = 0
  imgLoading.value = true
  loadError.value = false
})
function onImgError() {
  if (previewAttempt.value === 0) {
    previewAttempt.value++
    imgLoading.value = true
    loadError.value = false
    return
  }
  imgLoading.value = false
  loadError.value = true
}
function retryPreview() {
  previewAttempt.value++
  imgLoading.value = true
  loadError.value = false
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
function emitPinToggle() {
  const c = currentImage.value
  if (!c) return
  emit('pin-toggle', {
    path: c.path,
    filename: c.filename,
    // Toggle the current state — `is_pinned` may be undefined when the
    // parent hasn't supplied it yet, treat that as not-pinned.
    pin: !c.is_pinned,
  })
}

// ── Keyboard handling ───────────────────────────────────────────────────
// Document-level so it works no matter what's focused inside the overlay.
// Attached/detached on visibility change to avoid intercepting keys elsewhere.
function onKeydown(e: KeyboardEvent) {
  if (!props.visible) return
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
  }
}

watch(() => props.visible, (open) => {
  if (open) {
    // Reset loading flag for the first frame; <img>'s @load will clear it.
    previewAttempt.value = 0
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
/* Highest z-index in the app so previews stay above the workspace. */
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
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(90vw, 640px);
}
.ipl-retry-btn {
  flex: 0 0 auto;
  border: 1px solid rgba(252, 211, 77, 0.55);
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.24);
  color: inherit;
  padding: 4px 8px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.ipl-retry-btn:hover {
  background: rgba(252, 211, 77, 0.14);
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
  font-size: var(--font-xs);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ipl-shortcut-hint kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: var(--font-xs);
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
}
.ipl-edit-btn {
  flex-shrink: 0;
}
.ipl-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.ipl-pin-btn--active {
  background: rgba(217, 119, 6, 0.18);
  border-color: rgba(217, 119, 6, 0.55);
  color: rgb(252, 211, 77);
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
