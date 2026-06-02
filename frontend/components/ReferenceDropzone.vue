<template>
  <div
    :class="['ref-dropzone', { 'is-drag': isDragging, 'is-busy': busy }]"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
    @paste="onPaste"
    tabindex="0"
    role="button"
    :aria-label="ariaLabel"
    @click="openPicker"
    @keydown.enter.prevent="openPicker"
    @keydown.space.prevent="openPicker"
  >
    <input
      ref="input"
      type="file"
      accept="image/*"
      :multiple="multiple"
      class="ref-dropzone-hidden-input"
      @change="onInputChange"
    />
    <div class="ref-dropzone-inner">
      <span class="ref-dropzone-icon" aria-hidden="true">📷</span>
      <strong><slot name="title">Drop images here</slot></strong>
      <span class="ref-dropzone-or"><slot name="hint">— or paste from clipboard, or click to browse</slot></span>
    </div>
    <div v-if="busy" class="ref-dropzone-busy">
      <LoadingSpinner size="sm" />
      <span v-if="total > 0">Uploading {{ remaining }} of {{ total }}…</span>
      <span v-else>Uploading…</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * v1.0.192 — shared reference-image dropzone. Drag / paste / click → emits the
 * accepted image File[]; the PARENT decides whether to upload immediately
 * (Characters editor, edit mode) or stage for upload-after-create (create
 * mode) or push to a single-image slot (continuity episode sheet). Extracted
 * from the Characters editor's old inline dropzone so every surface shares one
 * affordance.
 */
import { ref } from 'vue'

withDefaults(defineProps<{
  busy?: boolean
  multiple?: boolean
  /** When busy, show "Uploading {remaining} of {total}…" (0 = generic). */
  total?: number
  remaining?: number
  ariaLabel?: string
}>(), {
  busy: false,
  multiple: false,
  total: 0,
  remaining: 0,
  ariaLabel: 'Drop, paste, or click to upload an image',
})

const emit = defineEmits<{ files: [File[]] }>()

const input = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
// dragenter/leave fire for child elements too — track nested depth so the
// highlight doesn't flicker as the pointer moves over inner elements.
let dragDepth = 0

function openPicker() { input.value?.click() }

function emitImages(list: FileList | File[] | null | undefined): void {
  const files = Array.from(list || []).filter(f => f.type.startsWith('image/'))
  if (files.length) emit('files', files)
}

function onInputChange(e: Event): void {
  const t = e.target as HTMLInputElement
  emitImages(t.files)
  t.value = ''  // allow re-picking the same file
}
function onDragEnter(): void { dragDepth++; isDragging.value = true }
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) isDragging.value = false
}
function onDrop(e: DragEvent): void {
  dragDepth = 0
  isDragging.value = false
  emitImages(e.dataTransfer?.files)
}
function onPaste(e: ClipboardEvent): void {
  const cd = e.clipboardData
  if (!cd) return
  const files: File[] = []
  if (cd.files?.length) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files.item(i)
      if (f && f.type.startsWith('image/')) files.push(f)
    }
  }
  if (!files.length && cd.items?.length) {
    for (let i = 0; i < cd.items.length; i++) {
      const it = cd.items[i]
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  if (files.length) emit('files', files)
}
</script>

<style scoped>
.ref-dropzone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 6px;
  padding: 18px 16px;
  border: 1.5px dashed var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  outline: none;
}
.ref-dropzone:hover { border-color: var(--text-secondary); }
.ref-dropzone:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.ref-dropzone.is-drag {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.ref-dropzone.is-busy { cursor: wait; opacity: 0.85; }

.ref-dropzone-hidden-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
}

.ref-dropzone-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
.ref-dropzone-icon { font-size: 20px; line-height: 1; }
.ref-dropzone-or { font-size: 11px; color: var(--text-muted); }

.ref-dropzone-busy {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--accent);
  margin-top: 6px;
}
</style>
