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

const { post } = useApi()
const { success, error: showError } = useToast()

const sourcePath = ref('')
const model = ref('')
const busy = ref(false)
const result = ref<any>(null)

interface PickFolderResp { path: string | null }

async function pickFile() {
  // Story Studio's existing folder picker (system/pick-folder) is the only
  // native picker exposed today. Most users will paste/drag the path; this
  // button helps them find their way to the right docx via Finder.
  try {
    const { post: post2 } = useApi()
    const r = await post2<PickFolderResp>('/system/pick-folder', {})
    if (r.path) sourcePath.value = r.path
  } catch (e: any) {
    showError(e?.data?.detail || 'Folder picker unavailable')
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
