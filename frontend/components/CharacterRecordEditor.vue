<!--
  Shared Channel Character record editor — moved out of pages/character-library.vue
  so the Character Sheet roster can host the same editor instead of linking away.

  Behaviour preserved from the library editor:
  - staged draft: nothing persists until Save Character; Cancel/close never save
  - dirty gating: no backdrop-close, Escape closes only while unchanged
  - partial-reference-upload recovery: record saves first, the pending image
    uploads after; a failed upload keeps the editor open pointing at the saved
    record so the next Save retries the upload instead of creating a duplicate
  - reference images: preview-failure states, Make Portrait, Delete (library
    records only — the project route has no reference-image DELETE)

  `origin` is the source of the canonical record: 'library' records edit through
  /character-library (shared identity, channel labels, per-channel voice
  profiles); 'project' records are legacy per-project files whose folder IS the
  assignment (no channel labels, top-level speech only).
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
          <span class="workspace-section-eyebrow">{{ editing ? 'Edit shared record' : 'Create shared record' }}</span>
          <h2 id="character-record-editor-title">{{ editing ? (draft.name || editing.name) : 'New channel character' }}</h2>
        </div>
        <button type="button" class="btn btn-sm btn-secondary" @click="requestClose">Close</button>
      </header>

      <div class="editor-scroll">
        <WorkspaceNotice
          v-if="sharedWithNames.length"
          class="mt-3"
          tone="info"
          title="Shared with other channels"
        >
          Identity, description and reference images are one shared record — changes here also apply to
          {{ sharedWithNames.join(', ') }}.
        </WorkspaceNotice>
        <WorkspaceNotice
          v-else-if="editing && recordOrigin === 'project'"
          class="mt-3"
          tone="info"
          title="Lives in this channel only"
        >
          This record is stored inside this channel, so it cannot be assigned to other channels from here.
        </WorkspaceNotice>

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
              <small>Stored with the shared character and reused by every assigned channel. Max 5 MB. The first image is the portrait.</small>
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
                    v-if="recordOrigin === 'library'"
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

        <section v-if="recordOrigin === 'library'" class="editor-section">
          <div class="section-body">
            <h3>Channel labels</h3>
            <p class="section-help">Select every channel where this character should appear. This controls availability; it does not make copies. Unchecking this channel removes the character from this channel only — the shared record and its other channels stay.</p>
            <div class="channel-options">
              <label v-for="channel in channels" :key="channel.slug" :class="['channel-option', { selected: selectedChannels.has(channel.slug) }]">
                <input type="checkbox" :checked="selectedChannels.has(channel.slug)" @change="toggleChannel(channel.slug)" />
                <span><strong>{{ channel.name }}</strong><small>{{ channel.slug }}</small></span>
              </label>
            </div>
          </div>
        </section>

        <section v-if="voiceSlugs.length" class="editor-section">
          <div class="section-body">
            <h3>Channel voice profiles</h3>
            <p class="section-help">Each channel may use a different Gateway voice and delivery note for this same character. Voices are read live from your Gateway.</p>
            <div class="voice-profile-list">
              <div v-for="voiceSlug in voiceSlugs" :key="voiceSlug" class="voice-profile-card">
                <div class="voice-profile-title">
                  <div><strong>{{ channelName(voiceSlug) }}</strong><span>{{ voiceSlug }}</span></div>
                  <span :class="['profile-state', { ready: profileFor(voiceSlug).voiceId }]">{{ profileFor(voiceSlug).voiceId ? 'Voice set' : 'Uses default' }}</span>
                </div>
                <div class="voice-fields">
                  <label class="form-group voice-picker-field">
                    <span>Voice</span>
                    <VoicePicker
                      :model-value="profileFor(voiceSlug).voiceId || null"
                      :project-slug="voiceSlug"
                      :scope-to-model="false"
                      default-label="Use channel default"
                      @update:model-value="profileFor(voiceSlug).voiceId = $event || undefined"
                    />
                  </label>
                </div>
                <label class="form-group">
                  <span>Delivery note</span>
                  <input v-model.trim="profileFor(voiceSlug).tonation" class="input" placeholder="soft, slow, reassuring" />
                </label>
              </div>
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

type RecordOrigin = 'library' | 'project'

const props = defineProps<{
  visible: boolean
  /** Full canonical record (channel_profiles intact). Null = create. */
  character: Character | null
  origin: RecordOrigin
  /** The channel hosting the roster — always assignable, never removable on create. */
  slug: string
  channels: Array<{ slug: string; name: string }>
}>()

const emit = defineEmits<{
  close: []
  saved: [character: Character]
}>()

const cl = useCharacterLibrary()
const chars = useCharacters(() => props.slug)
const { del, put } = useApi()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const editing = ref<Character | null>(null)
const saving = ref(false)
const draft = reactive({ name: '', archetype: '', description: '' })
const selectedChannels = ref(new Set<string>())
const voiceProfiles = reactive<Record<string, CharacterSpeech>>({})
const pendingReference = ref<File | null>(null)
// Staged reference changes: the visible image order and the images marked for
// deletion. Nothing here touches the server until Save — Cancel discards both.
const draftImages = ref<string[]>([])
const stagedDeletes = ref<string[]>([])
// Bumped by every seed (record/channel switch) and by Cancel/close. An async
// save captures it once and checks it after each await, so a late completion
// can never write into a different record's editor state.
let editorSession = 0
// Which endpoints this record lives on. Create always lands in the library
// (POST /character-library), so a fresh record never starts as 'project'.
const recordOrigin = ref<RecordOrigin>('library')
const canSave = computed(() => !!draft.name.trim() && !!draft.description.trim())
const editorSnapshot = ref('')
// profileFor() adds empty profiles while rendering, so only filled ones count.
const editorState = () => JSON.stringify([draft, [...selectedChannels.value], Object.entries(voiceProfiles).filter(([, p]) => Object.values(p).some(Boolean)), draftImages.value, stagedDeletes.value, !!pendingReference.value])
const editorDirty = computed(() => props.visible && editorState() !== editorSnapshot.value)

function resetEditor() {
  draft.name = ''
  draft.archetype = ''
  draft.description = ''
  selectedChannels.value = new Set()
  for (const key of Object.keys(voiceProfiles)) delete voiceProfiles[key]
  pendingReference.value = null
  draftImages.value = []
  stagedDeletes.value = []
  editing.value = null
}

/** Seed the staged draft from the canonical record every time the modal opens. */
function seed() {
  editorSession++
  saving.value = false
  resetEditor()
  recordOrigin.value = props.character ? props.origin : 'library'
  const c = props.character
  if (!c) {
    selectedChannels.value = new Set([props.slug])
    editorSnapshot.value = editorState()
    return
  }
  editing.value = c
  draft.name = c.name
  draft.archetype = c.archetype || ''
  draft.description = c.description
  draftImages.value = [...(c.references?.images || [])]
  if (recordOrigin.value === 'library') {
    selectedChannels.value = new Set(c.projects?.length ? c.projects : [props.slug])
    for (const slug of selectedChannels.value) {
      voiceProfiles[slug] = { ...(c.channel_profiles?.[slug]?.speech || {}) }
    }
  } else {
    // Per-project record: the folder is the assignment, speech is top-level.
    selectedChannels.value = new Set([props.slug])
    voiceProfiles[props.slug] = { ...(c.speech || {}) }
  }
  editorSnapshot.value = editorState()
}

watch(() => props.visible, (open) => { if (open) seed() }, { immediate: true })

function requestClose() {
  // End the session first: a save still in flight must not write its result
  // into whatever opens next.
  editorSession++
  emit('close')
}

function toggleChannel(slug: string) {
  const next = new Set(selectedChannels.value)
  if (next.has(slug)) {
    next.delete(slug)
    delete voiceProfiles[slug]
  } else {
    next.add(slug)
    voiceProfiles[slug] ||= {}
  }
  selectedChannels.value = next
}

function profileFor(slug: string): CharacterSpeech {
  return (voiceProfiles[slug] ||= {})
}

function channelName(slug: string): string {
  return props.channels.find(channel => channel.slug === slug)?.name || slug
}

/** Other channels whose shared identity/references this edit touches. */
const sharedWithNames = computed(() => {
  if (recordOrigin.value !== 'library' || !editing.value) return []
  return [...selectedChannels.value].filter(slug => slug !== props.slug).map(channelName)
})

/** Voice cards: one per assigned channel (library) or just this channel (project). */
const voiceSlugs = computed(() =>
  recordOrigin.value === 'library' ? [...selectedChannels.value] : (editing.value ? [props.slug] : []),
)

async function saveCharacter() {
  if (!canSave.value || saving.value) return
  const session = editorSession
  const stale = () => session !== editorSession
  saving.value = true
  try {
    // Staged deletions first: the library DELETE removes the record entry and
    // moves the file to Trash in one step; the record save below then writes
    // the final staged image list (order included) over the top.
    while (stagedDeletes.value.length && editing.value) {
      if (recordOrigin.value !== 'library') { stagedDeletes.value = []; break }
      const filename = stagedDeletes.value[0]
      const targetId = editing.value.id
      await del<Character>(`/character-library/${encodeURIComponent(targetId)}/reference-image/${encodeURIComponent(filename)}`)
      // Stale check BEFORE touching state: a seed() during the await means
      // stagedDeletes now belongs to the newly opened record, and filtering
      // here would drain the new session's staged list.
      if (stale()) return
      stagedDeletes.value = stagedDeletes.value.filter(f => f !== filename)
    }

    let saved: Character
    if (recordOrigin.value === 'library') {
      const profiles: NonNullable<Character['channel_profiles']> = {}
      for (const slug of selectedChannels.value) {
        const speech = voiceProfiles[slug]
        if (speech && Object.values(speech).some(Boolean)) {
          profiles[slug] = { speech: { ...speech, voiceProvider: 'genstudio' } }
        }
      }
      const payload: Partial<Character> & Pick<Character, 'name' | 'description'> = {
        name: draft.name.trim(),
        archetype: draft.archetype,  // '' clears the role
        description: draft.description.trim(),
        projects: [...selectedChannels.value],
        channel_profiles: profiles,
        scope: 'project',
        // Staged order/deletions land here; a create has no images yet (the
        // pending upload below adds the first one after the record exists).
        ...(editing.value ? { references: { ...editing.value.references, images: [...draftImages.value] } } : {}),
      }
      // From here on this is an existing record: if the upload below fails, the
      // next Save updates it instead of creating a duplicate.
      saved = editing.value
        ? await cl.update(editing.value.id, payload)
        : await cl.create(payload)
    } else {
      const speech = voiceProfiles[props.slug]
      const payload: Partial<Character> & Pick<Character, 'name' | 'description'> = {
        name: draft.name.trim(),
        archetype: draft.archetype,
        description: draft.description.trim(),
        speech: speech && Object.values(speech).some(Boolean) ? { ...speech } : {},
        references: { ...editing.value!.references, images: [...draftImages.value] },
      }
      saved = await cmUpdate(editing.value!.id, payload)
    }
    // A record/channel switch (seed) or Cancel during an await ends this
    // session: keep the roster honest with server truth, but never touch the
    // editor state that now belongs to another record.
    if (stale()) { emit('saved', saved); return }
    editing.value = saved
    draftImages.value = [...(saved.references?.images || draftImages.value)]
    emit('saved', saved)
    if (pendingReference.value) {
      try {
        await uploadReference(saved.id, pendingReference.value)
      } catch (e: any) {
        if (!stale()) showError(`"${saved.name}" was saved, but the image could not be added: ${e?.data?.detail || e?.message || 'upload failed'}`)
        return
      }
      saved = await fetchCanonical(saved.id)
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

// ── Origin-routed persistence ────────────────────────────────────────────────
// The resolved project view collapses channel speech, so reads and writes
// always follow the record's source origin — never the collapsed project view.

async function cmUpdate(id: string, payload: Partial<Character>): Promise<Character> {
  return await put<Character>(`/projects/${encodeURIComponent(props.slug)}/characters/${encodeURIComponent(id)}`, payload)
}

async function fetchCanonical(id: string): Promise<Character> {
  return recordOrigin.value === 'library' ? await cl.getOne(id) : await chars.getOne(id)
}

async function uploadReference(id: string, file: File): Promise<unknown> {
  return recordOrigin.value === 'library'
    ? await cl.uploadReferenceImage(id, file)
    : await chars.uploadReferenceImage(id, file)
}

// Reference ordering and deletion are STAGED in draftImages/stagedDeletes —
// no write happens until Save. Cancel discards them untouched.

async function removeReference(filename: string) {
  if (recordOrigin.value !== 'library' || !editing.value) return
  // Capture identity before the confirm dialog: if the record/channel switches
  // while it is open, resolving it must not stage anything in the new session.
  const session = editorSession
  const targetId = editing.value.id
  if (!await ask({ title: `Delete ${filename}?`, message: 'The image is removed from this character for every channel. A copy is kept in the character’s _trash folder.', confirmLabel: 'Delete Image', danger: true })) return
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
  const path = recordOrigin.value === 'library'
    ? `/api/character-library/${id}/reference-image/${file}`
    : `/api/projects/${encodeURIComponent(props.slug)}/characters/${id}/reference-image/${file}`
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
.channel-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin-top: 14px; }
.channel-option { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; background: var(--bg-secondary); }
.channel-option.selected { border-color: var(--accent); background: rgba(245, 193, 88, .08); }
.channel-option span, .channel-option small { display: block; }
.channel-option small { color: var(--text-muted); margin-top: 2px; }
.voice-profile-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.voice-profile-card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.voice-profile-title { display: flex; justify-content: space-between; gap: 10px; }
.voice-profile-title div span { display: block; color: var(--text-muted); font-size: var(--font-xs); margin-top: 2px; }
.profile-state { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .09em; }
.profile-state.ready { color: #63d995; }
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
