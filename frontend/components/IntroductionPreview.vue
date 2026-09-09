<!--
  Introduction preview panel — mirror of ScriptPreview but for the
  intro file (`*_Script_Narration_Introduction.docx`). Both share the
  same backend route, so this component just reads the `introduction`
  field from the response.
-->
<template>
  <div class="preview-card">
    <div class="preview-header">
      <h3 class="preview-title">🎙️ Introduction Preview</h3>
      <div class="preview-meta">
        <span v-if="wordCount" class="meta-pill">
          {{ wordCount.toLocaleString() }} words
        </span>
        <span v-if="data?.introduction?.modifiedAt" class="meta-pill">
          Updated {{ formatTime(data.introduction.modifiedAt) }}
        </span>
        <span v-if="dirty" class="meta-pill meta-pill-dirty">Unsaved edits</span>
        <button
          class="btn btn-sm btn-secondary"
          @click="load"
          :disabled="loading || savingAny"
          title="Refresh introduction"
        >
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? 'Refreshing…' : 'Refresh' }}
        </button>
        <button
          v-if="displayedContent"
          class="btn btn-sm btn-secondary"
          @click="copyContent"
          title="Copy to clipboard"
        >
          {{ copied ? '✓ Copied' : '📋 Copy' }}
        </button>
        <button
          v-if="displayedContent && !editing"
          ref="editButton"
          class="btn btn-sm btn-primary"
          @click="beginEdit"
          :disabled="savingAny"
        >
          Edit
        </button>
        <template v-if="editing">
          <button class="btn btn-sm btn-secondary" @click="cancelEdit" :disabled="savingAny">
            Cancel
          </button>
          <button class="btn btn-sm btn-primary" @click="saveEdit" :disabled="savingAny || loading || !draftText.trim()">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </template>
      </div>
    </div>

    <div class="preview-body">
      <div v-if="!episodeId" class="preview-empty">
        Select an episode to preview its introduction.
      </div>
      <template v-else-if="editing">
        <label class="editor-label" :for="editorId">Introduction narration</label>
        <textarea
          :id="editorId"
          ref="editor"
          v-model="draftText"
          class="introduction-editor"
          rows="14"
          spellcheck="true"
          :disabled="saving"
        />
      </template>
      <div v-else-if="loading && !data" class="preview-empty">
        Loading introduction content…
      </div>
      <div v-else-if="saveError && !data" class="preview-empty save-error" role="alert">
        {{ saveError }}
      </div>
      <div v-else-if="!data?.introduction?.content" class="preview-empty">
        No introduction generated yet for this episode.
        <p class="muted mt-1" style="font-size: 12px;">
          {{ data?.introduction_ready
            ? 'Use “Write this episode’s opening” above to create one.'
            : 'Generate a script first, then write this episode’s opening.' }}
        </p>
      </div>
      <pre v-else class="preview-content">{{ displayedContent }}</pre>
    </div>
    <p v-if="saveError && data" class="save-error save-error-footer" role="alert">{{ saveError }}</p>
  </div>
</template>

<script setup lang="ts">
type IntroductionContent = {
  content: string
  modifiedAt: string
  wordCount: number
}

type PreviewPayload = {
  introduction_ready?: boolean
  script: unknown
  introduction: IntroductionContent | null
}

type Draft = {
  text: string
  savedText: string
}

const props = defineProps<{
  projectSlug: string
  episodeId: string
  title?: string
  refreshKey?: number
}>()
const emit = defineEmits<{
  savingChange: [saving: boolean]
  scriptReadiness: [readiness: { projectSlug: string; episodeId: string; state: 'loading' | 'ready' | 'missing' | 'error' }]
}>()

const { get, put } = useApi()
const dataByEpisode = ref<Record<string, PreviewPayload>>({})
const drafts = ref<Record<string, Draft>>({})
const loading = ref(false)
const copied = ref(false)
const saveError = ref('')
const savingKey = ref('')
const editor = ref<HTMLTextAreaElement | null>(null)
const editButton = ref<HTMLButtonElement | null>(null)
let loadSequence = 0

const activeKey = computed(() => `${props.projectSlug}/${props.episodeId}`)
const data = computed(() => dataByEpisode.value[activeKey.value] || null)
const editing = computed(() => !!drafts.value[activeKey.value])
const saving = computed(() => savingKey.value === activeKey.value)
const savingAny = computed(() => !!savingKey.value)
const displayedContent = computed(() => drafts.value[activeKey.value]?.text
  ?? data.value?.introduction?.content
  ?? '')
const draftText = computed({
  get: () => drafts.value[activeKey.value]?.text || '',
  set: (text: string) => {
    const draft = drafts.value[activeKey.value]
    if (draft) drafts.value[activeKey.value] = { ...draft, text }
  },
})
const dirty = computed(() => {
  const draft = drafts.value[activeKey.value]
  return !!draft && draft.text !== draft.savedText
})
const wordCount = computed(() => displayedContent.value.trim().split(/\s+/).filter(Boolean).length)
const editorId = computed(() => `introduction-editor-${props.episodeId}`)

async function load() {
  const requestSequence = ++loadSequence
  const key = activeKey.value
  if (!props.episodeId) {
    return
  }
  loading.value = true
  emit('scriptReadiness', { projectSlug: props.projectSlug, episodeId: props.episodeId, state: 'loading' })
  saveError.value = ''
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const loaded = await get<PreviewPayload>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/script-content${titleParam}`,
      { cache: 'no-store' },
    )
    if (requestSequence === loadSequence && key === activeKey.value) {
      dataByEpisode.value[key] = loaded
      emit('scriptReadiness', { projectSlug: props.projectSlug, episodeId: props.episodeId,
        state: loaded.introduction_ready === true ? 'ready' : 'missing' })
    }
  } catch (e) {
    if (requestSequence === loadSequence && key === activeKey.value) {
      emit('scriptReadiness', { projectSlug: props.projectSlug, episodeId: props.episodeId, state: 'error' })
      saveError.value = errorDetail(e, 'Could not refresh the introduction. Your edits are still here.')
    }
  } finally {
    if (requestSequence === loadSequence && key === activeKey.value) loading.value = false
  }
}

async function beginEdit() {
  const content = data.value?.introduction?.content
  if (!content) return
  drafts.value[activeKey.value] = { text: content, savedText: content }
  saveError.value = ''
  await nextTick()
  editor.value?.focus()
}

async function cancelEdit() {
  delete drafts.value[activeKey.value]
  saveError.value = ''
  await nextTick()
  editButton.value?.focus()
}

async function saveEdit() {
  const key = activeKey.value
  const draft = drafts.value[key]
  if (!draft?.text.trim() || savingKey.value) return
  const episodeId = props.episodeId
  const projectSlug = props.projectSlug
  loadSequence += 1
  loading.value = false
  savingKey.value = key
  emit('savingChange', true)
  saveError.value = ''
  let savedSuccessfully = false
  try {
    const saved = await put<{ ok: true; introduction: IntroductionContent }>(
      `/projects/${projectSlug}/episodes/${episodeId}/introduction-content`,
      { text: draft.text },
    )
    dataByEpisode.value[key] = {
      script: dataByEpisode.value[key]?.script ?? null,
      introduction: saved.introduction,
    }
    delete drafts.value[key]
    savedSuccessfully = true
  } catch (e) {
    if (key === activeKey.value) {
      saveError.value = errorDetail(e, 'Could not save the introduction. Review your edit and try again.')
    }
  } finally {
    if (savingKey.value === key) savingKey.value = ''
    emit('savingChange', false)
  }
  if (savedSuccessfully && key === activeKey.value) {
    await nextTick()
    editButton.value?.focus()
  }
}

async function copyContent() {
  if (!displayedContent.value) return
  await navigator.clipboard.writeText(displayedContent.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

function errorDetail(error: unknown, fallback: string): string {
  const value = error as { data?: { detail?: unknown }; message?: unknown }
  return typeof value?.data?.detail === 'string' && value.data.detail.trim()
    ? value.data.detail
    : typeof value?.message === 'string' && value.message.trim()
      ? value.message
      : fallback
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

watch(() => [props.projectSlug, props.episodeId, props.title, props.refreshKey], load, { immediate: true })
</script>

<style scoped>
.preview-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-top: 16px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 8px;
}

.preview-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.preview-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.meta-pill {
  font-size: var(--font-xs);
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.meta-pill-dirty {
  color: var(--warning-text, #f5c36b);
}

.preview-body {
  padding: 16px;
  max-height: 320px;
  overflow-y: auto;
}

.preview-empty {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 24px 12px;
}

.preview-empty .muted {
  color: var(--text-muted);
  margin: 0;
}

.preview-content {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0;
}

.editor-label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.introduction-editor {
  display: block;
  width: 100%;
  min-height: 240px;
  resize: vertical;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
}

.introduction-editor:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.introduction-editor:disabled {
  opacity: 0.7;
  cursor: wait;
}

.save-error {
  margin: 10px 0 0;
  color: var(--danger, #ef7b7b);
  font-size: 12px;
}

.save-error-footer {
  margin: 0;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--border);
}
</style>
