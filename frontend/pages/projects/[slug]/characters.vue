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

          <div v-if="editing" class="form-group">
            <label>Reference images (optional)</label>
            <span class="hint">Images to use as visual references in image generation (Phase 7 wiring). Max 5 MB each.</span>
            <input ref="fileInput" type="file" accept="image/*" @change="onFile" />
            <div v-if="uploadingImg" class="muted">Uploading…</div>
            <div v-if="draft.references?.images?.length" class="ref-images">
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
useHead({ title: 'Characters — Story Studio KH' })

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

// ── Reference image upload ────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)
const uploadingImg = ref(false)

async function onFile(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || !editing.value) return
  uploadingImg.value = true
  try {
    const r = await cm.uploadReferenceImage(editing.value.id, file)
    // Refresh draft refs from the server to pick up the canonical filename.
    const fresh = await cm.getOne(editing.value.id)
    draft.value.references = fresh.references
    success(`Uploaded ${r.relativePath}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Upload failed')
  } finally {
    uploadingImg.value = false
    if (fileInput.value) fileInput.value.value = ''
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
