<template>
  <Modal :visible="visible" size="md" labelledby="override-title" @close="onClose">
    <div class="dialog-head">
      <h2 id="override-title">Edit asset overrides — {{ episodeCode }}</h2>
      <p class="text-muted dialog-sub">
        Pin individual asset states for this episode. <strong>Detect</strong> uses
        normal file detection (default). <strong>Force ✓</strong> tells the
        pipeline this asset is done even when no file exists.
        <strong>Force ✗</strong> reports it as missing even when a file is on disk.
      </p>
    </div>

    <div class="dialog-body override-grid">
      <div v-for="field in FIELDS" :key="field.id" class="override-row">
        <div class="override-label">
          <span class="override-icon" aria-hidden="true">{{ field.icon }}</span>
          <div class="override-text">
            <strong>{{ field.label }}</strong>
            <span class="override-hint">{{ field.hint }}</span>
          </div>
        </div>
        <div class="override-controls" role="radiogroup" :aria-label="`Override for ${field.label}`">
          <label
            v-for="opt in TRI_OPTIONS"
            :key="opt.value"
            :class="['tri-btn', `tri-${opt.value}`, { active: state[field.id] === opt.value }]"
            :title="opt.title"
          >
            <input
              type="radio"
              :name="`override-${field.id}`"
              :value="opt.value"
              v-model="state[field.id]"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>
      </div>
    </div>

    <div class="dialog-foot">
      <button
        class="btn btn-ghost btn-sm"
        :disabled="saving || allDetect"
        title="Set every field back to Detect (clears all overrides for this episode)"
        @click="resetAll"
      >Reset all to Detect</button>
      <span class="text-muted dirty-summary">
        <template v-if="dirtyCount === 0">No changes pending</template>
        <template v-else>{{ dirtyCount }} unsaved change{{ dirtyCount === 1 ? '' : 's' }}</template>
      </span>
      <div class="action-cluster">
        <button class="btn btn-secondary" :disabled="saving" @click="onClose">Cancel</button>
        <button class="btn btn-primary" :disabled="saving || dirtyCount === 0" @click="save">
          <LoadingSpinner v-if="saving" size="sm" />
          {{ saving ? 'Saving…' : 'Save overrides' }}
        </button>
      </div>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Tri-state override picker for one episode's per-asset booleans.
 *
 * State model: each EpisodeStatus boolean field maps to one of three
 * tri-states: 'detect' (no override — let file detection decide),
 * 'true' (force ✓), 'false' (force ✗).
 *
 * The backend's status_overrides field is a Partial<EpisodeStatus> —
 * a key being present === overridden. We translate that on load + save:
 *   - state[k] === 'detect'  → omit from payload
 *   - state[k] === 'true'    → payload[k] = true
 *   - state[k] === 'false'   → payload[k] = false
 *
 * Saving with every field set to 'detect' is shorthand for clearing all
 * overrides — the route accepts `null` for a full clear, which is
 * cleaner than a 0-key object.
 */

type TriState = 'detect' | 'true' | 'false'
type FieldId = 'script' | 'introduction' | 'thumb_prompts'
  | 'metadata' | 'thumbnails' | 'audio' | 'merged_audio'
  | 'subtitles' | 'scene_plan' | 'scene_review' | 'motion_review' | 'video_assembly'

interface FieldMeta { id: FieldId; label: string; icon: string; hint: string }

const FIELDS: FieldMeta[] = [
  { id: 'script',         label: 'Script (chapters)', icon: '📝', hint: 'Per-chapter docx files' },
  { id: 'introduction',   label: 'Introduction',      icon: '🎙', hint: 'Intro docx file' },
  { id: 'thumb_prompts',  label: 'Thumbnail Prompts', icon: '🖼', hint: 'Image-prompt docx for thumbs' },
  { id: 'metadata',       label: 'YouTube Finalizer', icon: '📄', hint: 'Final upload-ready YouTube package' },
  { id: 'thumbnails',     label: 'Thumbnail Images',  icon: '🖼', hint: 'Generated thumbnail PNGs' },
  { id: 'audio',          label: 'Audio (TTS)',       icon: '🎙', hint: 'Per-chapter narration mp3s' },
  { id: 'merged_audio',   label: 'Merged Audio',      icon: '🎛', hint: 'Single unified narration mp3' },
  { id: 'subtitles',      label: 'Subtitles',          icon: '🔤', hint: 'Every narration section transcribed' },
  { id: 'scene_plan',     label: 'Scene Plan',         icon: '📚', hint: 'Timeline and visual prompts complete' },
  { id: 'scene_review',   label: 'Scene Review',       icon: '✅', hint: 'Every planned scene has an image' },
  { id: 'motion_review',  label: 'Motion Review',      icon: '🎬', hint: 'Optional clips reviewed or stills chosen' },
  { id: 'video_assembly', label: 'Video Assembly',    icon: '🎞', hint: 'Final assembled video' },
]

interface TriOption { value: TriState; label: string; title: string }
const TRI_OPTIONS: TriOption[] = [
  { value: 'detect', label: 'Detect',  title: 'Use normal file detection (default).' },
  { value: 'true',   label: 'Force ✓', title: 'Override: pipeline treats this as complete regardless of files.' },
  { value: 'false',  label: 'Force ✗', title: 'Override: pipeline treats this as missing regardless of files.' },
]

const props = defineProps<{
  visible: boolean
  slug: string
  episodeCode: string
  /** Current overrides from the episode row (may be null/undefined). */
  initial?: Partial<Record<FieldId, boolean>> | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', overrides: Partial<Record<FieldId, boolean>> | null): void
}>()

const { patch } = useApi()
const { success, error: showError } = useToast()

const saving = ref(false)

// Initialize with all-detect; populated from props.initial when the dialog
// opens. Reactive because the user toggles each row's tri-state.
const state = reactive<Record<FieldId, TriState>>({
  script: 'detect', introduction: 'detect',
  thumb_prompts: 'detect', metadata: 'detect',
  thumbnails: 'detect', audio: 'detect', merged_audio: 'detect',
  subtitles: 'detect', scene_plan: 'detect', scene_review: 'detect',
  motion_review: 'detect', video_assembly: 'detect',
})

// Snapshot of the loaded state — used to compute dirtyCount so the user
// sees how many changes are pending before saving.
const loadedSnapshot = ref<Record<FieldId, TriState>>({} as any)

function loadFromInitial(initial?: Partial<Record<FieldId, boolean>> | null) {
  for (const f of FIELDS) {
    if (initial && f.id in initial) {
      state[f.id] = initial[f.id] === true ? 'true' : 'false'
    } else {
      state[f.id] = 'detect'
    }
  }
  loadedSnapshot.value = { ...state }
}

const allDetect = computed(() => FIELDS.every(f => state[f.id] === 'detect'))

const dirtyCount = computed(() => {
  let n = 0
  for (const f of FIELDS) {
    if (state[f.id] !== loadedSnapshot.value[f.id]) n++
  }
  return n
})

function resetAll() {
  for (const f of FIELDS) state[f.id] = 'detect'
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    // Build the payload. allDetect → null (full clear). Otherwise emit
    // only the fields the user pinned to true/false; "detect" rows are
    // omitted so the override stays narrow.
    let payload: Partial<Record<FieldId, boolean>> | null
    if (allDetect.value) {
      payload = null
    } else {
      payload = {}
      for (const f of FIELDS) {
        if (state[f.id] === 'true')  payload[f.id] = true
        if (state[f.id] === 'false') payload[f.id] = false
      }
    }
    await patch(`/projects/${props.slug}/episodes/${props.episodeCode}/status-overrides`, {
      overrides: payload,
    })
    success(`Overrides ${payload === null ? 'cleared' : 'saved'} for ${props.episodeCode}`)
    loadedSnapshot.value = { ...state }
    emit('saved', payload)
    emit('close')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save overrides')
  } finally {
    saving.value = false
  }
}

function onClose() {
  if (saving.value) return
  emit('close')
}

// Re-load the form whenever the dialog opens — the parent might pass a
// different `initial` per episode, so we can't bake the snapshot at mount.
watch(() => props.visible, (v) => {
  if (v) loadFromInitial(props.initial)
})
// Also react to prop swap (parent rebinds initial without reopening).
watch(() => props.initial, (init) => {
  if (props.visible) loadFromInitial(init)
})
</script>

<style scoped>
.dialog-head { margin-bottom: 12px; }
.dialog-sub { font-size: 12px; line-height: 1.45; margin-top: 4px; }
.dialog-body { min-height: 240px; }

.override-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 2px;
}
.override-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.override-label { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; }
.override-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.override-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.override-text strong { font-size: 13px; font-weight: 600; }
.override-hint { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.35; }

.override-controls {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.tri-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: var(--font-xs);
  font-weight: 500;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.tri-btn input { display: none; }
.tri-btn:hover { border-color: var(--accent); }
.tri-btn.tri-detect.active { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
.tri-btn.tri-true.active   { background: rgba(46, 160, 67, 0.18); color: var(--success, #3fb950); border-color: rgba(46, 160, 67, 0.5); }
.tri-btn.tri-false.active  { background: rgba(248, 113, 113, 0.18); color: var(--error, #ef4444); border-color: rgba(248, 113, 113, 0.5); }

.dialog-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.dirty-summary { font-size: 12px; }
.action-cluster { display: flex; gap: 8px; margin-left: auto; }
</style>
