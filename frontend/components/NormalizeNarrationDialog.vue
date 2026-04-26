<template>
  <Modal :visible="visible" size="md" labelledby="normalize-title" @close="onClose">
    <div class="dialog-head">
      <h2 id="normalize-title">Normalize legacy narration — {{ episodeCode }}</h2>
      <p class="text-muted dialog-sub">
        Re-structure a pre-Story-Studio narration docx into the canonical
        per-chapter format. The original is backed up before any write.
        <br />
        <strong>Idempotent:</strong> already-canonical files are skipped without an LLM call.
      </p>
    </div>

    <div class="dialog-body">
      <!-- Source picker -->
      <div class="form-group">
        <label>Source narration docx</label>
        <div class="picker-row">
          <input
            v-model="sourcePath"
            type="text"
            class="input"
            placeholder="/path/to/legacy_narration.docx"
            :disabled="busy"
          />
          <button
            class="btn btn-sm btn-secondary"
            :disabled="busy"
            @click="pickFile"
          >Browse…</button>
        </div>
        <p class="text-muted hint">
          Or drag a docx onto the field above. The path must be a readable
          file on this machine — the LLM will be sent the extracted text.
        </p>
      </div>

      <!-- Model picker -->
      <div class="form-group mt-2">
        <label>Model</label>
        <ModelSelector v-model="model" :project-slug="slug" />
        <p class="text-muted hint">
          Larger models (gpt-4o, claude-sonnet-4) follow the format-preservation
          rules more reliably. Smaller models occasionally paraphrase paragraphs.
        </p>
      </div>

      <!-- Result panel -->
      <div v-if="result" class="result-panel mt-3" :class="result.skipped ? 'skipped' : 'ok'">
        <strong v-if="result.skipped">⏭ Skipped — already canonical</strong>
        <strong v-else>✓ Normalised</strong>
        <ul v-if="!result.skipped" class="result-list">
          <li><strong>{{ result.chapters_written }}</strong> chapters written</li>
          <li v-if="result.introduction_written">Introduction written</li>
          <li v-if="result.backup_at">
            Backup at <code>{{ result.backup_at }}</code>
          </li>
          <li v-if="result.unified_narration_at">
            Unified narration at <code>{{ result.unified_narration_at }}</code>
          </li>
        </ul>
        <p v-else class="text-muted hint">
          {{ result.reason || 'The source already has chapter scaffolding.' }}
        </p>
      </div>
    </div>

    <div class="dialog-foot">
      <button class="btn btn-secondary" :disabled="busy" @click="onClose">
        {{ result && !result.skipped ? 'Close' : 'Cancel' }}
      </button>
      <button
        class="btn btn-primary"
        :disabled="busy || !sourcePath || !model"
        @click="run"
      >
        <LoadingSpinner v-if="busy" size="sm" />
        {{ busy ? 'Normalising…' : (result ? 'Run again' : 'Normalize') }}
      </button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Single-step UI for invoking the legacy-narration normaliser.
 *
 * The endpoint is idempotent + LLM-backed:
 *   - source already in canonical format → no-op (skipped: true)
 *   - flat-text source → LLM restructures it into per-chapter docx files,
 *     with the original backed up alongside
 *
 * UX notes:
 *  - We don't auto-close on success because the user typically wants to
 *    see the backup path (so they can recover if anything looks off).
 *  - The button label changes to "Run again" after a result so re-running
 *    on a different source path doesn't require closing + reopening.
 */

const props = defineProps<{
  visible: boolean
  slug: string
  episodeCode: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'normalized', result: any): void
}>()

const { post, get, put } = useApi()
const { success, error: showError } = useToast()

const sourcePath = ref('')
const model = ref('')
const busy = ref(false)
const result = ref<any>(null)

/**
 * Project-config key for the last-used model. Mirrors the `_last_preset`
 * convention used elsewhere (scripts/audio/image presets). Per-project
 * so each project remembers its own preferred model.
 */
const LAST_MODEL_KEY = 'narration_normalizer_last_model'

// Tracks what we loaded from disk so we don't write it back unchanged on
// every dialog open. Empty string means "haven't loaded yet" — the
// initial empty model.value is also empty, so the watch below skips
// firing until loadLastUsedModel resolves and the user actually picks.
const loadedModel = ref('')

async function loadLastUsedModel() {
  try {
    const config = await get<any>(`/projects/${props.slug}/settings/config`)
    const saved = typeof config?.[LAST_MODEL_KEY] === 'string' ? config[LAST_MODEL_KEY] : ''
    if (saved) {
      model.value = saved
      loadedModel.value = saved
    }
  } catch { /* config unreadable → leave empty; ModelSelector will show its default */ }
}

async function saveLastUsedModel() {
  if (!model.value || model.value === loadedModel.value) return
  try {
    await put(`/projects/${props.slug}/settings/config`, {
      [LAST_MODEL_KEY]: model.value,
    })
    loadedModel.value = model.value
  } catch { /* non-fatal: persistence failure shouldn't block the dialog flow */ }
}

// Persist the model the moment the user picks one — don't wait for them
// to click Normalize. ModelSelector emits update:modelValue on every
// pick (and also auto-swaps when the saved model isn't available),
// so this captures both the user's intent AND the auto-fallback. Both
// are equally valid as "last used" — the goal is "open the dialog and
// see whatever I last had selected".
//
// We also debounce by relying on Vue's watch deduplication — back-to-
// back changes within a tick coalesce naturally. The PUT itself is
// fast (~10ms) and idempotent, so even if a few extra fire it's fine.
watch(model, (m, prev) => {
  if (!m || m === prev) return
  // Skip the initial load-from-config write (loadLastUsedModel sets
  // both model.value and loadedModel.value, but the watch fires on the
  // first change too — the loadedModel === model check above guards
  // against the round-trip).
  saveLastUsedModel()
})

interface PickFileResp { path: string | null }

async function pickFile() {
  // Native single-file picker via /system/pick-file with a .docx filter so
  // Finder hides anything that can't be normalised. Returns { path: null }
  // when the user cancels.
  try {
    const r = await post<PickFileResp>('/system/pick-file', {
      title: 'Choose legacy narration docx',
      buttonLabel: 'Use this file',
      filters: [
        { name: 'Word document', extensions: ['docx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (r.path) sourcePath.value = r.path
  } catch (e: any) {
    showError(e?.data?.detail || 'File picker unavailable')
  }
}

async function run() {
  if (busy.value) return
  busy.value = true
  result.value = null
  try {
    const r = await post<any>(
      `/projects/${props.slug}/episodes/${props.episodeCode}/normalize-script`,
      { source_path: sourcePath.value, model: model.value },
    )
    result.value = r
    success(r.skipped
      ? `${props.episodeCode} skipped (already canonical)`
      : `${props.episodeCode} normalised — ${r.chapters_written} chapters written`)
    emit('normalized', r)
    // No explicit save here — the model watch above persists every pick
    // immediately. Removes the "I changed the model but it didn't stick
    // because I never successfully ran" failure mode.
  } catch (e: any) {
    showError(e?.data?.detail || 'Normalisation failed')
  } finally {
    busy.value = false
  }
}

function onClose() {
  if (busy.value) return
  emit('close')
}

watch(() => props.visible, (v) => {
  if (v) {
    sourcePath.value = ''
    result.value = null
    // Load last-used model. If nothing's saved yet, ModelSelector falls
    // back to its first-available default. Awaited via .then so the
    // dialog open isn't blocked on a slow config read.
    loadLastUsedModel().catch(() => {})
  }
})
</script>

<style scoped>
.dialog-head { margin-bottom: 12px; }
.dialog-sub { font-size: 12px; line-height: 1.45; margin-top: 4px; }
.dialog-body { display: flex; flex-direction: column; gap: 8px; min-height: 200px; }

.picker-row { display: flex; gap: 6px; }
.picker-row .input { flex: 1; }

.hint { font-size: 11px; line-height: 1.4; margin-top: 4px; }

.result-panel {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.result-panel.ok { border-color: rgba(46, 160, 67, 0.4); background: rgba(46, 160, 67, 0.06); }
.result-panel.skipped { border-color: rgba(96, 165, 250, 0.4); background: rgba(96, 165, 250, 0.06); }
.result-list { font-size: 12px; line-height: 1.6; padding-left: 18px; margin: 6px 0 0; }
.result-list code { font-size: 10px; word-break: break-all; }

.dialog-foot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
</style>
