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

    <EmptyState
      v-else-if="!characters.length"
      icon="&#127917;"
      title="No characters yet"
      message="Click + New character to create one — or use the + Quick character shortcut on any episode's script page for a one-off."
    />

    <div v-else class="char-list">
      <CharacterCard
        v-for="c in characters"
        :key="c.id"
        :character="c"
        :thumbnail-url="cardThumb(c)"
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
          <!-- v1.0.192 — two ways to create a character. "From description" is
               the classic text-first flow; "From character sheet" makes the
               reference-image upload primary (it stages + uploads when you
               create). Edit mode hides the toggle (you're past creation). -->
          <div v-if="!editing" class="create-mode-toggle">
            <button
              type="button"
              :class="['cmt-btn', { active: createMode === 'description' }]"
              @click="createMode = 'description'"
            >✍️ From description</button>
            <button
              type="button"
              :class="['cmt-btn', { active: createMode === 'sheet' }]"
              @click="createMode = 'sheet'"
            >🖼 From character sheet</button>
          </div>

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
            <span class="hint">
              Physical + personality. Flows verbatim into script + visual prompts. Specific concrete details work best
              ("plate armour with a silver braid down her back" beats "a knight").
              <template v-if="editing && (draft.references?.images?.length || 0) > 0">
                Or click <strong>✨ Describe from image</strong> on any reference below to bootstrap.
              </template>
              <template v-else-if="!editing && createMode === 'sheet'">
                Drop your character sheet below — it uploads when you create. A short description still helps the
                script + prompts; you can refine it with <strong>✨ Describe from image</strong> afterward.
              </template>
              <template v-else-if="!editing">
                Tip: switch to <strong>🖼 From character sheet</strong> above to build this character from a
                reference image. Reference portraits can also be uploaded after creating.
              </template>
            </span>
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
            <span class="hint">
              Pick the episodes this character appears in. The picker on Prompts / Scripts
              only surfaces this character when one of these codes matches the active episode.
              Click an episode to add it. Episode codes are matched exactly — typing <code>EP001</code>
              when your project uses <code>EP0001</code> means the character will silently never show up.
            </span>
            <!-- Real episodes pulled from the project — beats the old comma-
                 separated text input where users could fat-finger the code
                 format and end up with a character that never appears in
                 any picker. Each project's actual codes come from
                 useEpisodes(); user clicks to toggle. Manual entry still
                 supported below for episodes that haven't been accepted yet. -->
            <div v-if="projectEpisodes.length" class="episode-chip-row">
              <button
                v-for="ep in projectEpisodes"
                :key="ep.episode_code"
                type="button"
                :class="['episode-chip', { active: selectedEpisodeCodes.has(ep.episode_code) }]"
                :title="`${ep.episode_code} — ${ep.title || '(no title)'}`"
                @click="toggleEpisodeCode(ep.episode_code)"
              >
                {{ ep.episode_code }}
                <span v-if="ep.title" class="episode-chip-title">{{ shortTitle(ep.title) }}</span>
              </button>
            </div>
            <input
              v-model="episodeCodesText"
              class="input mt-1"
              :placeholder="episodeCodesPlaceholder"
            />
            <span v-if="unknownEpisodeCodes.length" class="hint" style="color: rgb(220, 38, 38);">
              ⚠ Unknown episode code(s): <code>{{ unknownEpisodeCodes.join(', ') }}</code> — these don't match any episode in this project. Did you mean <code>{{ projectEpisodes[0]?.episode_code || 'EP0001' }}</code>?
            </span>
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
              Visual style words appended to visual prompts whenever this character appears
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

          <div v-if="editing || createMode === 'sheet'" class="form-group">
            <label>
              Reference images
              <span class="text-muted" style="font-weight:400">{{ !editing && createMode === 'sheet' ? '(your character sheet)' : '(optional)' }}</span>
            </label>
            <span class="hint">
              Drop, paste, or click to upload reference portraits — the look anchor. Used by image
              generators that support reference images (Flux Kontext, Nano Banana, Qwen Image 2). Max 5 MB each.
              <template v-if="!editing && createMode === 'sheet'"> They upload automatically when you create the character.</template>
            </span>

            <ReferenceDropzone
              multiple
              :busy="uploadingImg"
              :total="uploadQueueTotal"
              :remaining="uploadQueueRemaining"
              @files="onRefFiles"
            />

            <!-- Staged-on-create previews: files wait here until the character
                 exists, then upload on Create. (Edit mode uploads immediately.) -->
            <div v-if="!editing && stagedPreviews.length" class="staged-refs">
              <div v-for="(url, i) in stagedPreviews" :key="i" class="staged-ref">
                <img :src="url" alt="staged reference" />
                <button type="button" class="staged-ref-x" title="Remove" @click="removeStaged(i)">✕</button>
              </div>
            </div>

            <!-- Vision-model picker (sits above the per-image Describe buttons
                 since the same choice applies to every click). Options the
                 user doesn't have a key for are kept visible but disabled so
                 they know which providers they could enable. -->
            <div v-if="draft.references?.images?.length" class="ref-vision-model">
              <label>Vision model for ✨ Describe:</label>
              <select v-model="visionModel" class="select" :disabled="visionModelsLoading">
                <option v-if="visionModelsLoading" value="">Loading models…</option>
                <option v-else value="">Auto (pick whichever I have a key for)</option>
                <option
                  v-for="m in visionModelOptions"
                  :key="m.id"
                  :value="m.id"
                  :disabled="!m.has_key"
                >
                  {{ m.label }}{{ m.has_key ? '' : ' — no key configured' }}
                </option>
              </select>
              <button
                v-if="visionModelOptions.some(m => !m.has_key)"
                type="button"
                class="cap-link"
                @click="openAppSettings"
                title="Add API keys in Settings → API Keys to enable more vision models."
              >
                Add keys →
              </button>
            </div>

            <div v-if="draft.references?.images?.length" class="ref-images mt-2">
              <div v-for="img in draft.references.images" :key="img" class="ref-card">
                <img
                  :src="referenceImageUrl(img)"
                  :alt="img"
                  class="ref-thumb"
                />
                <div class="ref-card-body">
                  <span class="ref-card-name" :title="img">{{ img }}</span>
                  <div class="ref-card-actions">
                    <button
                      type="button"
                      class="btn btn-sm btn-secondary"
                      :disabled="describingFrom === img"
                      :title="describeButtonTitle"
                      @click="describeFromImage(img)"
                    >
                      <LoadingSpinner v-if="describingFrom === img" size="sm" />
                      <span v-else aria-hidden="true">✨</span>
                      {{ describingFrom === img ? 'Describing…' : 'Describe from image' }}
                    </button>
                  </div>
                </div>
              </div>
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
const { get: apiGet, post } = useApi()

// Real episodes for this project — feeds the click-to-pick chip row in
// the editor so users can't typo the episode code format (EP001 vs
// EP0001 vs S01E03). useEpisodes is shared-cache so it's near-instant on
// every editor open.
const { episodes: projectEpisodes } = useEpisodes(slug)

function shortTitle(t: string, max = 24): string {
  if (!t) return ''
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
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

/** Parse the comma-separated codes input into a normalised array. */
function parseEpisodeCodes(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}
const selectedEpisodeCodes = computed(() => new Set(parseEpisodeCodes(episodeCodesText.value)))

/** Warn the user when a typed code doesn't match any project episode —
 *  flushes out the EP001 vs EP0001 footgun before they save and silently
 *  break the picker on Prompts / Scripts. */
const unknownEpisodeCodes = computed(() => {
  const known = new Set(projectEpisodes.value.map(e => e.episode_code))
  return parseEpisodeCodes(episodeCodesText.value).filter(code => !known.has(code))
})

/** Suggest the user's actual episode-code format in the placeholder so
 *  freshly-created characters can't be silently scoped to a non-existent
 *  episode (the original cause of "I can't see my character in the
 *  picker" reports). */
const episodeCodesPlaceholder = computed(() => {
  const first = projectEpisodes.value[0]?.episode_code
  const second = projectEpisodes.value[1]?.episode_code
  if (first && second) return `${first}, ${second}`
  if (first) return first
  return 'EP0001, EP0002'
})

function toggleEpisodeCode(code: string) {
  const current = parseEpisodeCodes(episodeCodesText.value)
  const idx = current.indexOf(code)
  if (idx >= 0) current.splice(idx, 1)
  else current.push(code)
  episodeCodesText.value = current.join(', ')
}

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

// v1.0.192 — create modes + upload-at-create staging. In create mode the
// dropzone stages File objects (with object-URL previews) instead of uploading
// — there's no character id yet — and save() uploads them right after
// cm.create(). Edit mode keeps uploading immediately.
const createMode = ref<'description' | 'sheet'>('description')
const stagedFiles = ref<File[]>([])
const stagedPreviews = ref<string[]>([])

function clearStaged() {
  for (const u of stagedPreviews.value) URL.revokeObjectURL(u)
  stagedFiles.value = []
  stagedPreviews.value = []
}
function stageFiles(files: File[]) {
  for (const f of files) {
    const why = rejectReason(f)
    if (why) { showError(why); continue }
    stagedFiles.value.push(f)
    stagedPreviews.value.push(URL.createObjectURL(f))
  }
}
function removeStaged(i: number) {
  URL.revokeObjectURL(stagedPreviews.value[i])
  stagedFiles.value.splice(i, 1)
  stagedPreviews.value.splice(i, 1)
}
/** Dropzone output router: edit mode uploads now; create mode stages. */
function onRefFiles(files: File[]) {
  if (editing.value) void uploadFiles(files)
  else stageFiles(files)
}

function openCreate() {
  editing.value = null
  draft.value = { name: '', description: '', scope: 'episode', archetype: '' }
  episodeCodesText.value = ''
  speechTonation.value = ''
  speechVoiceId.value = ''
  styleKeywords.value = []
  createMode.value = 'description'
  clearStaged()
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
  clearStaged()
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
      let created = await cm.create(payload)
      // Upload any staged sheet images now that the character exists, then
      // re-fetch so the new list card shows its thumbnail + reference count.
      if (stagedFiles.value.length) {
        let upErr: string | null = null
        for (const f of stagedFiles.value) {
          try { await cm.uploadReferenceImage(created.id, f) }
          catch (e: any) { if (!upErr) upErr = e?.data?.detail || e?.message || 'Image upload failed' }
        }
        try { created = await cm.getOne(created.id) } catch { /* keep created as-is */ }
        clearStaged()
        if (upErr) showError(upErr)
      }
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

// ── Reference image upload (drag/paste/click handled by <ReferenceDropzone>) ──
const uploadingImg = ref(false)

// Per-image "Describe from image" state — tracks WHICH reference filename
// is currently being analysed so the spinner shows on the right card.
const describingFrom = ref<string | null>(null)

// ── Vision-model picker (powers ✨ Describe from image) ─────────────────
// Loads from GET /vision/caps so disabled options reflect whichever keys
// the user has configured. Persisted in localStorage so the user's pick
// survives across editor open/close cycles.
interface VisionModelOption { id: string; provider: string; has_key: boolean; label: string }
const VISION_MODEL_LABELS: Record<string, string> = {
  'claude-sonnet-4-6':         'Claude Sonnet 4.6 (Anthropic) — best quality',
  'claude-opus-4-7':           'Claude Opus 4.7 (Anthropic)',
  'claude-3-5-sonnet-latest':  'Claude 3.5 Sonnet (Anthropic)',
  'claude-3-5-sonnet-20241022':'Claude 3.5 Sonnet 2024-10-22 (Anthropic)',
  'claude-3-opus-20240229':    'Claude 3 Opus (Anthropic)',
  'gpt-4o':                    'GPT-4o (OpenAI) — fast & cheap',
  'gpt-4o-mini':               'GPT-4o mini (OpenAI) — cheapest',
  'gpt-4-turbo':               'GPT-4 Turbo (OpenAI)',
  'gpt-5':                     'GPT-5 (OpenAI)',
}
const VISION_MODEL_STORAGE_KEY = 'storyStudio:visionModel'
const visionModel = ref<string>(typeof localStorage !== 'undefined' ? (localStorage.getItem(VISION_MODEL_STORAGE_KEY) || '') : '')
const visionModelsLoading = ref(false)
const visionModelOptionsRaw = ref<VisionModelOption[]>([])

const visionModelOptions = computed(() =>
  visionModelOptionsRaw.value
    .map(m => ({ ...m, label: VISION_MODEL_LABELS[m.id] || m.id }))
    .sort((a, b) => {
      // Available models first, then by label
      if (a.has_key !== b.has_key) return a.has_key ? -1 : 1
      return a.label.localeCompare(b.label)
    }),
)

const describeButtonTitle = computed(() => {
  const id = visionModel.value
  if (!id) return 'Run a vision-LLM pass on this image to generate a rigid appearance description. Auto-picks whichever provider you have a key for. Replaces the current Description field. Cost: ~$0.005–0.02 per click.'
  const m = visionModelOptions.value.find(o => o.id === id)
  const label = m ? m.label : id
  return `Run vision analysis on this image using ${label}. Replaces the current Description field.`
})

async function loadVisionCaps() {
  if (visionModelOptionsRaw.value.length) return
  visionModelsLoading.value = true
  try {
    const caps = await apiGet<{ models: VisionModelOption[]; default: string }>(
      `/projects/${slug.value}/vision/caps`,
    )
    visionModelOptionsRaw.value = caps?.models || []
    // If the user's persisted choice is no longer key-backed, fall back to auto.
    const stillUsable = visionModelOptionsRaw.value.find(m => m.id === visionModel.value && m.has_key)
    if (visionModel.value && !stillUsable) visionModel.value = ''
  } catch {
    visionModelOptionsRaw.value = []
  } finally {
    visionModelsLoading.value = false
  }
}

// Refresh caps whenever the editor opens — picks up newly-added API keys
// from Settings without a hard page reload.
watch(editorOpen, (open) => { if (open) void loadVisionCaps() })

// Persist the user's pick across editor opens (and across browser
// reloads). Empty string = "auto-pick" which the backend interprets
// correctly even when the localStorage entry is missing.
watch(visionModel, (v) => {
  if (typeof localStorage === 'undefined') return
  if (v) localStorage.setItem(VISION_MODEL_STORAGE_KEY, v)
  else localStorage.removeItem(VISION_MODEL_STORAGE_KEY)
})

// API keys are per-machine ("This Mac" settings). The quick "Add keys →"
// link opens the singleton This-Mac modal so the user can drop in a key
// without leaving the character editor. (The same settings also live in
// Settings → This Mac → API Keys, reachable from the sidebar.)
const appSettingsModal = useAppSettingsModal()
function openAppSettings() {
  appSettingsModal.open()
}

/**
 * Public URL for an uploaded reference image. Backed by the new
 * GET /characters/:id/reference-image/:filename route — defensive by
 * design (only files registered on the character resolve, never raw
 * filesystem paths from the URL).
 */
function referenceImageUrl(filename: string): string {
  if (!editing.value) return ''
  return `/api/projects/${slug.value}/characters/${editing.value.id}/reference-image/${encodeURIComponent(filename)}`
}

// v1.0.191 — first reference image as a list-card thumbnail (undefined when the
// character has none). Same URL shape as referenceImageUrl but per-character so
// the library list + the continuity Character Sheet render identical cards.
function cardThumb(c: Character): string | undefined {
  const img = c.references?.images?.[0]
  return img
    ? `/api/projects/${slug.value}/characters/${c.id}/reference-image/${encodeURIComponent(img)}`
    : undefined
}

/**
 * One-click bootstrap: run a vision-LLM pass on the uploaded reference and
 * drop the resulting rigid appearance description into the editor's
 * Description field. The biggest continuity lever for image generation —
 * the same prompt-words feed every scene render, so the model produces
 * recognisably the same character across the episode.
 *
 * Confirms before overwriting any non-empty description so the user
 * doesn't lose hand-typed notes by accident.
 */
async function describeFromImage(filename: string) {
  if (!editing.value || describingFrom.value) return
  const hasExisting = !!(draft.value.description?.trim())
  if (hasExisting) {
    const ok = await ask({
      title: 'Replace existing description?',
      body: 'The Description field already has text. Running vision analysis will overwrite it. Continue?',
      confirmLabel: 'Replace',
    })
    if (!ok) return
  }
  describingFrom.value = filename
  try {
    const r = await post<{ description: string; model_used: string }>(
      `/projects/${slug.value}/characters/${editing.value.id}/describe-from-image`,
      // Empty visionModel = "auto" → backend picks Claude if Anthropic key
      // exists, otherwise GPT-4o. An explicit pick wins as long as the
      // user has the matching provider key configured.
      { filename, ...(visionModel.value ? { model: visionModel.value } : {}) },
    )
    draft.value.description = r.description
    success(`Described from ${filename} (${r.model_used})`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Description generation failed')
  } finally {
    describingFrom.value = null
  }
}
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
}
// v1.0.192 — the drag/paste/click handlers + drag-depth tracking moved into
// the shared <ReferenceDropzone>; the editor just routes its `files` event to
// uploadFiles (edit) or stageFiles (create) via onRefFiles above.
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

.ref-images { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.ref-chip { font-size: 10px; background: var(--bg-tertiary); padding: 3px 6px; border-radius: 3px; }
.ref-card {
  display: flex; gap: 10px; align-items: stretch;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  padding: 8px;
  width: 100%;
  max-width: 420px;
}
.ref-thumb {
  width: 96px; height: 96px;
  object-fit: cover;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--bg-primary);
}
.ref-card-body {
  display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1;
}
.ref-card-name {
  font-size: 11px; color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ref-card-actions { margin-top: auto; }

/* Vision-model picker — sits above the per-image Describe buttons. */
.ref-vision-model {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.ref-vision-model label {
  font-size: 11px; color: var(--text-muted);
}
.ref-vision-model select {
  font-size: 12px;
  padding: 3px 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  flex: 1 1 280px;
  min-width: 200px;
}
.cap-link {
  font-size: 11px;
  background: none; border: none;
  color: var(--accent, #6c8fff);
  cursor: pointer; padding: 0;
  text-decoration: underline;
}
.cap-link:hover { color: var(--text-primary); }

/* Episode-code chip picker — replaces the freeform text input footgun.
   Clicking a chip toggles inclusion; selected chips highlight in accent. */
.episode-chip-row {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin-bottom: 6px;
}
.episode-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-primary);
  cursor: pointer;
}
.episode-chip:hover { border-color: var(--accent, #6c8fff); }
.episode-chip.active {
  background: rgba(108, 143, 255, 0.18);
  border-color: var(--accent, #6c8fff);
  color: var(--accent, #6c8fff);
  font-weight: 600;
}
.episode-chip.active::before { content: '✓ '; }
.episode-chip-title {
  font-family: var(--font-sans);
  font-weight: 400;
  color: var(--text-muted);
  font-size: 11px;
}
.episode-chip.active .episode-chip-title { color: var(--accent, #6c8fff); }

/* v1.0.192 — the drop-zone styles moved into the shared <ReferenceDropzone>
   component (components/ReferenceDropzone.vue). */

.ed-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}

/* v1.0.192 — create-mode toggle (segmented) + staged-on-create previews. */
.create-mode-toggle {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  margin-bottom: 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.cmt-btn {
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.cmt-btn:hover:not(.active) { background: var(--bg-hover); color: var(--text-primary); }
.cmt-btn.active { background: var(--accent); color: var(--accent-on); }

.staged-refs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.staged-ref {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.staged-ref img { width: 100%; height: 100%; object-fit: cover; }
.staged-ref-x {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.staged-ref-x:hover { background: rgba(0, 0, 0, 0.85); }

.error-msg {
  font-size: 11px;
  color: var(--error, #e25c5c);
  flex: 1;
  text-align: left;
}
</style>
