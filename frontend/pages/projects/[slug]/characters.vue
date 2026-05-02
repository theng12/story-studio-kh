<template>
  <div class="characters-page">
    <header class="page-header">
      <div>
        <h1>Characters</h1>
        <p class="text-muted">
          Persistent cast for this project. Characters stop the LLM from inventing new names every
          episode and keep image generation visually consistent. Episode-scoped characters stay tied
          to specific episodes; project-scoped characters appear for every episode (the brand cast).
        </p>
      </div>
      <button class="btn btn-primary" @click="openCreate()">+ New character</button>
    </header>

    <div v-if="loading" class="muted">Loading…</div>

    <div v-else-if="!characters.length" class="empty">
      No characters yet. Click <strong>+ New character</strong> to create one — or use the
      <em>+ Quick character</em> shortcut on any episode's script page for a one-off.
    </div>

    <div v-else class="char-list">
      <CharacterCard
        v-for="c in characters"
        :key="c.id"
        :character="c"
      >
        <template #actions>
          <button v-if="c.scope === 'episode'" class="btn btn-ghost btn-sm" :title="'Make this character available to every episode in the project'" @click="promote(c)">
            Promote to project
          </button>
          <button class="btn btn-ghost btn-sm" :title="'Snapshot copy into the global character library — reusable across all your projects on this machine'" @click="saveToLibrary(c)">
            Save to library
          </button>
          <button class="btn btn-ghost btn-sm" @click="openEdit(c)">Edit</button>
          <button class="btn btn-ghost btn-sm danger" @click="confirmDelete(c)">Delete</button>
        </template>
      </CharacterCard>
    </div>

    <!-- Editor modal -->
    <div v-if="editorOpen" class="editor-backdrop" @click.self="closeEditor">
      <div class="editor">
        <header class="ed-header">
          <h3>{{ editing ? 'Edit character' : 'New character' }}</h3>
          <button class="btn btn-ghost btn-sm" @click="closeEditor">✕</button>
        </header>

        <div class="ed-body">
          <div class="form-group">
            <label>Name <span class="req">*</span></label>
            <span class="hint">Displayed everywhere; the LLM uses this exact spelling.</span>
            <input v-model="draft.name" class="input" placeholder="e.g. Aria the Knight" />
          </div>

          <div class="form-group">
            <label>Archetype</label>
            <span class="hint">Optional role tag. Used as a hint in the script prompt.</span>
            <select v-model="draft.archetype" class="select">
              <option value="">— none —</option>
              <option>protagonist</option>
              <option>antagonist</option>
              <option>mentor</option>
              <option>narrator</option>
              <option>supporting</option>
              <option>love interest</option>
              <option>foil</option>
            </select>
          </div>

          <div class="form-group">
            <label>Description <span class="req">*</span></label>
            <span class="hint">Physical + personality. Flows verbatim into script + image prompts. Specific concrete details work best ("plate armour with a silver braid down her back" beats "a knight").</span>
            <textarea v-model="draft.description" class="input" rows="4" />
          </div>

          <div class="form-group">
            <label>Scope <span class="req">*</span></label>
            <span class="hint">Episode-only = picker shows this character for the listed episodes only. Project = appears for every episode (channel mascot / brand cast).</span>
            <div class="scope-toggle">
              <label><input type="radio" :value="'episode'" v-model="draft.scope" /> Episode-only</label>
              <label><input type="radio" :value="'project'" v-model="draft.scope" /> Project-wide</label>
            </div>
          </div>

          <div v-if="draft.scope === 'episode'" class="form-group">
            <label>Episode codes <span class="req">*</span></label>
            <span class="hint">Comma-separated episode codes (e.g. <code>EP001, EP002</code>). The character appears in the picker only for these episodes.</span>
            <input v-model="episodeCodesText" class="input" placeholder="EP001, EP002" />
          </div>

          <fieldset class="speech-block">
            <legend>Speech (optional)</legend>
            <div class="form-group">
              <label>Tonation</label>
              <span class="hint">Free-text hint about how the character speaks. Injected into the script prompt as context.</span>
              <input v-model="speechTonation" class="input" placeholder="soft, slow, contemplative" />
            </div>
            <div class="form-group">
              <label>Voice ID</label>
              <span class="hint">TTS voice id (e.g. ElevenLabs voice id). Phase 6 multi-character voice routing reads this. Single-character episodes still use the project narrator.</span>
              <input v-model="speechVoiceId" class="input" placeholder="..." />
            </div>
          </fieldset>

          <div class="form-group">
            <label>Style keywords (optional)</label>
            <span class="hint">
              Visual style words appended to image prompts whenever this character appears
              (e.g. <code>cel-shaded</code>, <code>photoreal</code>, <code>watercolor</code>).
              Keeps a recurring character looking the same across episodes even when the scene prompt changes.
              Press Enter or comma to add. De-duped automatically.
            </span>
            <ChipInput
              v-model="styleKeywords"
              :suggestions="STYLE_KEYWORD_SUGGESTIONS"
              placeholder="e.g. cel-shaded, photoreal…"
              allow-custom
              :max="12"
            />
          </div>

          <div v-if="editing" class="form-group">
            <label>Reference images (optional)</label>
            <span class="hint">
              Drop, paste, or click to upload reference portraits. Used by image generators that support
              reference images (Flux Kontext, Nano Banana, Qwen Image 2). Max 5 MB each.
            </span>

            <div
              :class="['ref-dropzone', { 'is-drag': isDragging, 'is-busy': uploadingImg }]"
              @dragenter.prevent="onDragEnter"
              @dragover.prevent="onDragOver"
              @dragleave.prevent="onDragLeave"
              @drop.prevent="onFilesDropped"
              @paste="onPaste"
              tabindex="0"
              role="button"
              aria-label="Drop, paste, or click to upload a reference image"
              @click="fileInput?.click()"
              @keydown.enter.prevent="fileInput?.click()"
              @keydown.space.prevent="fileInput?.click()"
            >
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                multiple
                class="ref-dropzone-hidden-input"
                @change="onFileInputChange"
              />
              <div class="ref-dropzone-inner">
                <span class="ref-dropzone-icon" aria-hidden="true">📷</span>
                <strong>Drop images here</strong>
                <span class="ref-dropzone-or">— or paste from clipboard, or click to browse</span>
              </div>
              <div v-if="uploadingImg" class="ref-dropzone-busy">
                <LoadingSpinner size="sm" />
                <span>Uploading {{ uploadQueueRemaining }} of {{ uploadQueueTotal }}…</span>
              </div>
            </div>

            <div v-if="draft.references?.images?.length" class="ref-images mt-2">
              <span v-for="img in draft.references.images" :key="img" class="ref-chip">{{ img }}</span>
            </div>
          </div>
        </div>

        <div class="ed-footer">
          <button class="btn btn-ghost" @click="closeEditor">Cancel</button>
          <button class="btn btn-primary" :disabled="saving || !canSave" @click="save">
            {{ saving ? 'Saving…' : editing ? 'Save changes' : 'Create character' }}
          </button>
          <span v-if="saveError" class="error-msg">{{ saveError }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../../../composables/useCharacters.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Characters')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const cm = useCharacters(slug)
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const characters = ref<Character[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    characters.value = await cm.list()
  } catch (e: any) {
    showError(`Failed to load characters: ${e?.data?.detail || e?.message || e}`)
  } finally {
    loading.value = false
  }
}

watch(slug, load, { immediate: true })

// ── Editor state ────────────────────────────────────────────────────────────
const editorOpen = ref(false)
const editing = ref<Character | null>(null)  // null = create mode
const saving = ref(false)
const saveError = ref('')
const draft = ref<Partial<Character>>({
  name: '', description: '', scope: 'episode', archetype: '',
})
const episodeCodesText = ref('')
const speechTonation = ref('')
const speechVoiceId = ref('')

// Style keywords are persisted in `references.style_keywords`. We store
// them in a separate ref while editing so the ChipInput's reactivity
// doesn't fight the partial-Character draft (which only carries
// references on edit, not on create).
const styleKeywords = ref<string[]>([])

/**
 * A short list of common visual styles users tend to reach for —
 * surfaced as one-click suggestions in the ChipInput. Free-text additions
 * are still supported via `allow-custom`. Order is "most common for
 * sleep-story / cozy content first" since that's the project's primary
 * use case.
 */
const STYLE_KEYWORD_SUGGESTIONS = [
  'photoreal', 'cinematic', 'cel-shaded', 'watercolor', 'oil painting',
  'storybook illustration', 'anime', 'pixel art', 'pencil sketch',
  '3D render', 'flat vector', 'low-poly', 'cyberpunk', 'noir',
  'pastel', 'muted palette',
]

const canSave = computed(() => {
  if (!draft.value.name?.trim() || !draft.value.description?.trim()) return false
  if (draft.value.scope === 'episode' && !episodeCodesText.value.trim()) return false
  return true
})

function openCreate() {
  editing.value = null
  draft.value = { name: '', description: '', scope: 'episode', archetype: '' }
  episodeCodesText.value = ''
  speechTonation.value = ''
  speechVoiceId.value = ''
  styleKeywords.value = []
  saveError.value = ''
  editorOpen.value = true
}

function openEdit(c: Character) {
  editing.value = c
  draft.value = {
    name: c.name, description: c.description, scope: c.scope, archetype: c.archetype || '',
    references: c.references ? { ...c.references } : undefined,
  }
  episodeCodesText.value = (c.episode_codes || []).join(', ')
  speechTonation.value = c.speech?.tonation || ''
  speechVoiceId.value = c.speech?.voiceId || ''
  styleKeywords.value = [...(c.references?.style_keywords || [])]
  saveError.value = ''
  editorOpen.value = true
}

function closeEditor() {
  editorOpen.value = false
}

async function save() {
  saving.value = true
  saveError.value = ''
  try {
    // Compose the references block: preserve any existing image filenames
    // (uploaded earlier in the editor's lifetime) and overlay the latest
    // style_keywords list. Sending an empty references object on create
    // is fine; the backend treats an empty array as "no keywords".
    const refs: { images?: string[]; style_keywords?: string[] } = {}
    const existingImages = draft.value.references?.images
    if (existingImages?.length) refs.images = existingImages
    const cleanedKeywords = styleKeywords.value
      .map(s => s.trim())
      .filter(Boolean)
    if (cleanedKeywords.length) refs.style_keywords = cleanedKeywords
    const hasRefs = !!(refs.images?.length || refs.style_keywords?.length)

    const payload: Partial<Character> & { name: string; description: string } = {
      name: draft.value.name!.trim(),
      description: draft.value.description!.trim(),
      scope: draft.value.scope,
      archetype: draft.value.archetype?.trim() || undefined,
      episode_codes: draft.value.scope === 'episode'
        ? episodeCodesText.value.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      speech: (speechTonation.value || speechVoiceId.value)
        ? { tonation: speechTonation.value || undefined, voiceId: speechVoiceId.value || undefined }
        : undefined,
      references: hasRefs ? refs : undefined,
    }

    if (editing.value) {
      const updated = await cm.update(editing.value.id, payload)
      const idx = characters.value.findIndex(c => c.id === updated.id)
      if (idx >= 0) characters.value.splice(idx, 1, updated)
      success(`Updated "${updated.name}"`)
    } else {
      const created = await cm.create(payload)
      characters.value = [created, ...characters.value]
      success(`Created "${created.name}"`)
    }
    closeEditor()
  } catch (e: any) {
    saveError.value = e?.data?.detail || e?.message || 'Save failed'
  } finally {
    saving.value = false
  }
}

const cl = useCharacterLibrary()

async function saveToLibrary(c: Character) {
  try {
    await cl.saveProjectCharacter(slug.value, c.id)
    success(`Saved "${c.name}" to the library`)
  } catch (e: any) {
    const detail = e?.data?.detail || e?.message || 'Save failed'
    if (e?.status === 409 || /already exists/i.test(detail)) {
      const ok = await ask({
        title: `"${c.name}" already exists in the library`,
        body: 'Overwrite the library entry with this version?',
        confirmLabel: 'Overwrite',
        danger: false,
      })
      if (!ok) return
      try {
        await cl.saveProjectCharacter(slug.value, c.id, { overwrite: true })
        success(`Updated "${c.name}" in the library`)
      } catch (e2: any) {
        showError(e2?.data?.detail || e2?.message || 'Overwrite failed')
      }
    } else {
      showError(detail)
    }
  }
}

async function promote(c: Character) {
  try {
    const updated = await cm.promote(c.id)
    const idx = characters.value.findIndex(x => x.id === updated.id)
    if (idx >= 0) characters.value.splice(idx, 1, updated)
    success(`"${updated.name}" promoted to project-wide`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Promotion failed')
  }
}

async function confirmDelete(c: Character) {
  const ok = await ask({
    title: `Delete "${c.name}"?`,
    body: 'The character record and any reference images are permanently removed. Episodes already generated using this character keep their text and audio (the script files on disk aren\'t touched), but new generations will no longer have this character available.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await cm.remove(c.id)
    characters.value = characters.value.filter(x => x.id !== c.id)
    success(`Deleted "${c.name}"`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Reference image upload (drop zone — drag, paste, or click) ───────────
const fileInput = ref<HTMLInputElement | null>(null)
const uploadingImg = ref(false)
const isDragging = ref(false)
// Surfaced as "Uploading X of Y…" when multiple files are batched. Total
// counts every file accepted from the current drop/paste/browse; remaining
// decrements as each upload completes.
const uploadQueueTotal = ref(0)
const uploadQueueRemaining = ref(0)

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_REF_BYTES = 5 * 1024 * 1024

/**
 * Vet a file before upload — same checks the backend enforces, surfaced
 * earlier so the user gets immediate feedback instead of a server-side 4xx
 * for each rejected drop. Returns null on accept; a string explaining the
 * rejection otherwise.
 */
function rejectReason(file: File): string | null {
  if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
    return `Skipped ${file.name} — only PNG / JPEG / WebP / GIF accepted (got ${file.type || 'unknown type'}).`
  }
  if (file.size > MAX_REF_BYTES) {
    return `Skipped ${file.name} — too large (${Math.round(file.size / 1024 / 1024)} MB, max 5 MB).`
  }
  return null
}

/**
 * Drive the multi-file upload. Each file goes through the same single-file
 * REST call (`/projects/:slug/characters/:id/reference-image`) sequentially
 * — sequential keeps the per-character locks happy and avoids racing the
 * fresh-fetch at the end. After all files complete, refresh the draft from
 * the server in one shot so the chip list shows canonical filenames.
 */
async function uploadFiles(files: File[]) {
  if (!editing.value || !files.length) return
  // Pre-filter on the client so a mixed drop (some bad / some good) shows
  // immediate feedback for the rejected ones and proceeds with the good
  // ones.
  const accepted: File[] = []
  for (const f of files) {
    const why = rejectReason(f)
    if (why) showError(why)
    else accepted.push(f)
  }
  if (!accepted.length) return

  uploadingImg.value = true
  uploadQueueTotal.value = accepted.length
  uploadQueueRemaining.value = accepted.length
  let okCount = 0
  let firstError: string | null = null
  for (const file of accepted) {
    try {
      await cm.uploadReferenceImage(editing.value.id, file)
      okCount++
    } catch (e: any) {
      const msg = e?.data?.detail || e?.message || 'Upload failed'
      if (!firstError) firstError = msg
    } finally {
      uploadQueueRemaining.value--
    }
  }
  // Refresh once at the end — single round-trip beats N fresh-fetches.
  try {
    const fresh = await cm.getOne(editing.value.id)
    draft.value.references = fresh.references
  } catch { /* best-effort */ }
  uploadingImg.value = false
  uploadQueueTotal.value = 0
  uploadQueueRemaining.value = 0

  if (okCount > 0) {
    success(`Uploaded ${okCount} reference${okCount === 1 ? '' : 's'}.`)
  }
  if (firstError) {
    showError(firstError + (accepted.length > 1 ? ` (and possibly more — see console)` : ''))
  }
  if (fileInput.value) fileInput.value.value = ''
}

function onFileInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  const files = Array.from(target.files || [])
  if (files.length) void uploadFiles(files)
}

// Drag counter — dragenter/leave fire for child elements too, so a naive
// boolean flicker every time the user moves between the icon and the
// border. Tracking nested-enter depth keeps the highlighted state stable
// for the duration of the drag.
let dragDepth = 0
function onDragEnter(_e: DragEvent) {
  dragDepth++
  isDragging.value = true
}
function onDragOver(_e: DragEvent) {
  // Just preventing default in the @dragover.prevent template binding is
  // enough — the dataTransfer dropEffect default is fine for our case.
}
function onDragLeave(_e: DragEvent) {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) isDragging.value = false
}

function onFilesDropped(e: DragEvent) {
  dragDepth = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
  if (!files.length && e.dataTransfer?.files?.length) {
    // User dropped files but none were images — give them a nudge instead
    // of silently doing nothing.
    showError('Only image files are accepted (PNG, JPEG, WebP, GIF).')
    return
  }
  if (files.length) void uploadFiles(files)
}

/**
 * Pasting an image (e.g. from a screenshot, or copy-from-browser) lands
 * in clipboardData.files when the source is a real image MIME, or in
 * clipboardData.items for some browser flavours. We check both to cover
 * "copy image" from common targets (Finder Quick Look, browser context
 * menu, screenshot tools).
 */
function onPaste(e: ClipboardEvent) {
  if (!editing.value) return
  const cd = e.clipboardData
  if (!cd) return
  const files: File[] = []
  if (cd.files && cd.files.length) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files.item(i)
      if (f && f.type.startsWith('image/')) files.push(f)
    }
  }
  if (!files.length && cd.items && cd.items.length) {
    for (let i = 0; i < cd.items.length; i++) {
      const item = cd.items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  if (files.length) {
    e.preventDefault()
    void uploadFiles(files)
  }
}
</script>

<style scoped>
.characters-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page-header h1 { margin: 0 0 4px; font-size: 20px; }
.page-header .text-muted { font-size: 12px; line-height: 1.5; max-width: 720px; }

.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  background: var(--bg-secondary);
  border-radius: 6px;
}

.char-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.btn-ghost.danger { color: var(--error, #e25c5c); }
.btn-ghost.danger:hover { background: rgba(226, 92, 92, 0.08); }

/* ── Editor modal ─────────────────────────────────────────────── */
.editor-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 24px;
}

.editor {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: min(640px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.ed-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.ed-header h3 { margin: 0; font-size: 15px; }

.ed-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; margin-bottom: 4px; }
.req { color: var(--error, #e25c5c); font-weight: bold; }

.scope-toggle { display: flex; gap: 16px; font-size: 12px; }

.speech-block {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.speech-block legend {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0 6px;
}

.ref-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.ref-chip { font-size: 10px; background: var(--bg-tertiary); padding: 3px 6px; border-radius: 3px; }

/* Reference-image drop zone — drag, paste, or click. Replaces the bare
 * <input type="file"> we used to ship; gives consistent affordance with
 * the rest of the app + multi-file support. */
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
  /* Visually hidden but still focusable + clickable — the wrapper
   * .ref-dropzone proxies clicks to it. */
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

.ed-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}

.error-msg {
  font-size: 11px;
  color: var(--error, #e25c5c);
  flex: 1;
  text-align: left;
}
</style>
