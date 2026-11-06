<!--
  Channel Character record editor — hosted by the Character Sheet roster.

  A character belongs to exactly one channel (owner, 2026-11-06). Every read
  and write goes through /projects/:slug/characters, so this editor never
  touches the global character-library store and never offers channel
  assignment or multi-channel voice profiles.

  Behaviour preserved from the library editor:
  - staged draft: nothing persists until Save Character; Cancel/close never save
  - dirty gating: no backdrop-close, Escape closes only while unchanged
  - partial-reference-upload recovery: record saves first, the pending image
    uploads after; a failed upload keeps the editor open pointing at the saved
    record so the next Save retries the upload instead of creating a duplicate
  - reference images: preview-failure states, Make Portrait, Delete
-->
<template>
  <Modal
    :visible="visible"
    size="xxl"
    dialog-class="modal-flush"
    :close-on-backdrop="false"
    :close-on-escape="!editorDirty"
    labelledby="character-record-editor-title"
    @close="requestClose"
  >
    <form class="character-editor" @submit.prevent="saveCharacter">
      <header class="editor-header">
        <div>
          <span class="workspace-section-eyebrow">{{ editing ? 'Edit channel character' : 'New channel character' }}</span>
          <h2 id="character-record-editor-title">{{ editing ? (draft.name || editing.name) : 'New channel character' }}</h2>
        </div>
        <button type="button" class="btn btn-sm btn-secondary" @click="requestClose">Close</button>
      </header>

      <div class="editor-scroll">
        <section class="editor-section">
          <div class="section-body">
            <h3>Identity</h3>
            <div class="field-grid">
              <label class="form-group">
                <span>Name *</span>
                <input v-model.trim="draft.name" class="input" placeholder="Aria the Knight" />
              </label>
              <label class="form-group">
                <span>Role</span>
                <select v-model="draft.archetype" class="select">
                  <option value="">Recurring character</option>
                  <option>protagonist</option><option>antagonist</option><option>mentor</option>
                  <option>narrator</option><option>supporting</option><option>mascot</option>
                </select>
              </label>
            </div>
            <label class="form-group">
              <span>Description *</span>
              <small>Concrete appearance and personality details flow into every script and visual prompt.</small>
              <textarea v-model.trim="draft.description" class="input" rows="5" />
            </label>
            <label class="form-group">
              <span>Reference image</span>
              <small>Stored on this channel only. Max 5 MB. The first image is the portrait.</small>
              <input class="input file-input" type="file" accept="image/*" @change="onReferencePicked" />
            </label>
            <div v-if="draftImages.length" class="reference-strip">
              <div v-for="filename in draftImages" :key="filename" class="reference-card">
                <img
                  v-if="!referencePreviewFailed(filename)"
                  :src="referenceUrl(filename)"
                  :alt="filename"
                  @error="markReferencePreviewFailed(filename)"
                  @load="markReferencePreviewLoaded(filename)"
                />
                <div v-else class="reference-preview-error">
                  <strong>Preview unavailable</strong>
                  <span>{{ filename }}</span>
                  <button type="button" class="btn btn-sm btn-secondary" @click="retryReferencePreview(filename)">Retry Preview</button>
                </div>
                <small class="reference-filename">{{ filename }}</small>
                <div class="reference-actions">
                  <span v-if="draftImages[0] === filename" class="text-xs text-muted">Portrait</span>
                  <button v-else type="button" class="btn btn-sm btn-ghost" title="Use this image as the character's portrait" @click="makePortrait(filename)">Make Portrait</button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    :title="`Delete ${filename}`"
                    aria-label="Delete reference image"
                    @click="removeReference(filename)"
                  >✕</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="editor-section">
          <div class="section-body">
            <h3>Voice</h3>
            <p class="section-help">This channel's voice for the character. Voices are read live from your Gateway; the channel default is used when none is set.</p>
            <div class="voice-fields">
              <label class="form-group voice-picker-field">
                <span>Voice</span>
                <VoicePicker
                  :model-value="voice.voiceId || null"
                  :project-slug="slug"
                  :scope-to-model="false"
                  default-label="Use channel default"
                  @update:model-value="voice.voiceId = $event || undefined"
                />
              </label>
              <label class="form-group">
                <span>Delivery note</span>
                <input v-model.trim="voice.tonation" class="input" placeholder="soft, slow, reassuring" />
              </label>
            </div>
          </div>
        </section>
      </div>

      <footer class="editor-footer">
        <span class="editor-spacer" />
        <button type="button" class="btn btn-secondary" @click="requestClose">Cancel</button>
        <button class="btn btn-primary" :disabled="saving || !canSave">{{ saving ? 'Saving…' : 'Save Character' }}</button>
      </footer>
    </form>
  </Modal>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch } from 'vue'
import type { Character, CharacterSpeech } from '../composables/useCharacters.js'

const props = defineProps<{
  visible: boolean
  /** Full channel record. Null = create. */
  character: Character | null
  /** The channel this character belongs to. */
  slug: string
}>()

const emit = defineEmits<{
  close: []
  saved: [character: Character]
}>()

const chars = useCharacters(() => props.slug)
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const editing = ref<Character | null>(null)
const saving = ref(false)
const draft = reactive({ name: '', archetype: '', description: '' })
const voice = reactive<CharacterSpeech>({})
const pendingReference = ref<File | null>(null)
// Staged reference changes: the visible image order and the images marked for
// deletion. Nothing here touches the server until Save — Cancel discards both.
const draftImages = ref<string[]>([])
const stagedDeletes = ref<string[]>([])
// Bumped by every seed (record/channel switch) and by Cancel/close. An async
// save captures it once and checks it after each await, so a late completion
// can never write into a different record's editor state.
let editorSession = 0
const canSave = computed(() => !!draft.name.trim() && !!draft.description.trim())
const editorSnapshot = ref('')
const editorState = () => JSON.stringify([draft, { ...voice }, draftImages.value, stagedDeletes.value, !!pendingReference.value])
const editorDirty = computed(() => props.visible && editorState() !== editorSnapshot.value)

function resetVoice() {
  for (const key of Object.keys(voice)) delete (voice as Record<string, unknown>)[key]
}

function resetEditor() {
  draft.name = ''
  draft.archetype = ''
  draft.description = ''
  resetVoice()
  pendingReference.value = null
  draftImages.value = []
  stagedDeletes.value = []
  editing.value = null
}

/** Seed the staged draft from the channel record every time the modal opens. */
function seed() {
  editorSession++
  saving.value = false
  resetEditor()
  const c = props.character
  if (!c) {
    editorSnapshot.value = editorState()
    return
  }
  editing.value = c
  draft.name = c.name
  draft.archetype = c.archetype || ''
  draft.description = c.description
  draftImages.value = [...(c.references?.images || [])]
  Object.assign(voice, c.speech || {})
  editorSnapshot.value = editorState()
}

watch(() => props.visible, (open) => { if (open) seed() }, { immediate: true })

function requestClose() {
  // End the session first: a save still in flight must not write its result
  // into whatever opens next.
  editorSession++
  emit('close')
}

async function saveCharacter() {
  if (!canSave.value || saving.value) return
  const session = editorSession
  const stale = () => session !== editorSession
  saving.value = true
  try {
    // Staged deletions first: DELETE removes the record entry and moves the
    // file to the channel's Trash in one step; the record save below then
    // writes the final staged image list (order included) over the top.
    while (stagedDeletes.value.length && editing.value) {
      const filename = stagedDeletes.value[0]
      const targetId = editing.value.id
      await chars.removeReferenceImage(targetId, filename)
      // Stale check BEFORE touching state: a seed() during the await means
      // stagedDeletes now belongs to the newly opened record, and filtering
      // here would drain the new session's staged list.
      if (stale()) return
      stagedDeletes.value = stagedDeletes.value.filter(f => f !== filename)
    }

    const payload: Partial<Character> & Pick<Character, 'name' | 'description'> = {
      name: draft.name.trim(),
      archetype: draft.archetype,  // '' clears the role
      description: draft.description.trim(),
      speech: Object.values(voice).some(Boolean) ? { ...voice } : {},
      // Staged order/deletions land here; a create has no images yet (the
      // pending upload below adds the first one after the record exists).
      ...(editing.value ? { references: { ...editing.value.references, images: [...draftImages.value] } } : {}),
    }
    // From here on this is an existing record: if the upload below fails, the
    // next Save updates it instead of creating a duplicate.
    let saved: Character = editing.value
      ? await chars.update(editing.value.id, payload)
      : await chars.create(payload)
    // A record/channel switch (seed) or Cancel during an await ends this
    // session: keep the roster honest with server truth, but never touch the
    // editor state that now belongs to another record.
    if (stale()) { emit('saved', saved); return }
    editing.value = saved
    draftImages.value = [...(saved.references?.images || draftImages.value)]
    emit('saved', saved)
    if (pendingReference.value) {
      try {
        await chars.uploadReferenceImage(saved.id, pendingReference.value)
      } catch (e: any) {
        if (!stale()) showError(`"${saved.name}" was saved, but the image could not be added: ${e?.data?.detail || e?.message || 'upload failed'}`)
        return
      }
      saved = await chars.getOne(saved.id)
      if (stale()) { emit('saved', saved); return }
      editing.value = saved
      draftImages.value = [...(saved.references?.images || draftImages.value)]
      emit('saved', saved)
    }
    if (stale()) return
    success(`Saved "${saved.name}"`)
    emit('close')
  } catch (e: any) {
    if (!stale()) showError(e?.data?.detail || e?.message || 'Character could not be saved')
  } finally {
    if (!stale()) saving.value = false
  }
}

// Reference ordering and deletion are STAGED in draftImages/stagedDeletes —
// no write happens until Save. Cancel discards them untouched.

async function removeReference(filename: string) {
  if (!editing.value) return
  // Capture identity before the confirm dialog: if the record/channel switches
  // while it is open, resolving it must not stage anything in the new session.
  const session = editorSession
  const targetId = editing.value.id
  if (!await ask({ title: `Delete ${filename}?`, message: 'The image is removed from this character on this channel. A copy is kept in the channel’s _trash folder.', confirmLabel: 'Delete Image', danger: true })) return
  if (session !== editorSession || editing.value?.id !== targetId) return
  draftImages.value = draftImages.value.filter(f => f !== filename)
  if (!stagedDeletes.value.includes(filename)) stagedDeletes.value = [...stagedDeletes.value, filename]
}

function makePortrait(filename: string) {
  if (!editing.value || draftImages.value[0] === filename) return
  draftImages.value = [filename, ...draftImages.value.filter(f => f !== filename)]
}

function onReferencePicked(event: Event) {
  pendingReference.value = (event.target as HTMLInputElement).files?.[0] || null
}

// ── Reference previews ───────────────────────────────────────────────────────
const referencePreviewStates = ref<Record<string, 'failed' | 'loaded'>>({})
const referencePreviewVersion = ref(0)

function referencePreviewFailed(filename: string): boolean {
  return referencePreviewStates.value[`${editing.value?.id}:${filename}`] === 'failed'
}
function markReferencePreviewFailed(filename: string) {
  referencePreviewStates.value = { ...referencePreviewStates.value, [`${editing.value?.id}:${filename}`]: 'failed' }
}
function markReferencePreviewLoaded(filename: string) {
  const key = `${editing.value?.id}:${filename}`
  if (referencePreviewStates.value[key] === 'loaded') return
  referencePreviewStates.value = { ...referencePreviewStates.value, [key]: 'loaded' }
}
function retryReferencePreview(filename: string) {
  const key = `${editing.value?.id}:${filename}`
  const next = { ...referencePreviewStates.value }
  delete next[key]
  referencePreviewStates.value = next
  referencePreviewVersion.value += 1
}
function referenceUrl(filename: string): string {
  const id = encodeURIComponent(editing.value?.id || '')
  const file = encodeURIComponent(filename)
  const path = `/api/projects/${encodeURIComponent(props.slug)}/characters/${id}/reference-image/${file}`
  return referencePreviewVersion.value ? `${path}?preview=${referencePreviewVersion.value}` : path
}
</script>

<style scoped>
.character-editor { background: var(--bg-primary); }
.editor-header, .editor-footer { position: sticky; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 18px 22px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); }
.editor-header { top: 0; justify-content: space-between; }
.editor-header h2 { margin: 3px 0 0; }
.editor-footer { bottom: 0; border-top: 1px solid var(--border); border-bottom: 0; }
.editor-spacer { flex: 1; }
.editor-scroll { padding: 4px 22px 22px; }
.editor-section { padding: 20px 0; border-bottom: 1px solid var(--border); }
.editor-section:last-child { border-bottom: 0; }
.section-body h3 { margin: 3px 0 5px; }
.section-help, .form-group small { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.field-grid, .voice-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-group { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; font-size: 12px; }
.file-input { padding: 8px; }
.voice-picker-field :deep(.voice-picker) { width: 100%; }
.reference-strip { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.reference-card { width: 132px; display: flex; flex-direction: column; gap: 6px; }
.reference-strip img, .reference-preview-error { width: 132px; height: 132px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); }
.reference-preview-error { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; padding: 12px; background: rgba(231, 103, 103, .08); color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.reference-preview-error strong { color: #f08f8f; font-size: var(--font-xs); }
.reference-actions { display: flex; align-items: center; gap: 6px; }
.reference-filename { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) { .field-grid, .voice-fields { grid-template-columns: 1fr; } }
</style>
