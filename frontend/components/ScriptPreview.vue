<!--
  Script preview panel — shows the latest generated chapter content for an
  episode. Fetches from the backend route that extracts text from the
  saved .docx file. Refreshes when episode_id or refreshKey changes.
-->
<template>
  <div class="preview-card">
    <div class="preview-header">
      <h3 class="preview-title">📖 Script Preview</h3>
      <div class="preview-meta">
        <span v-if="data?.script?.wordCount" class="meta-pill">
          {{ data.script.wordCount.toLocaleString() }} words
        </span>
        <span v-if="data?.script?.modifiedAt" class="meta-pill">
          Updated {{ formatTime(data.script.modifiedAt) }}
        </span>
        <button class="btn btn-sm btn-secondary" @click="load" :disabled="loading" title="Refresh">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? '…' : '↻' }}
        </button>
        <button
          v-if="data?.script?.content"
          class="btn btn-sm btn-secondary"
          @click="copyContent"
          title="Copy to clipboard"
        >
          {{ copied ? '✓ Copied' : '📋 Copy' }}
        </button>
      </div>
    </div>

    <div class="preview-body">
      <div v-if="!episodeId" class="preview-empty">
        Select an episode to preview its script.
      </div>
      <div v-else-if="loading && !data" class="preview-empty">
        Loading script content…
      </div>
      <div v-else-if="!data?.script?.content" class="preview-empty">
        No script generated yet for this episode.
        <p class="muted mt-1" style="font-size: 12px;">
          On the Outline tab, click "Create outline", then "Expand all" to write the chapters.
        </p>
      </div>
      <pre v-else class="preview-content">{{ data.script.content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  projectSlug: string
  episodeId: string
  title?: string
  refreshKey?: number
}>()

const { get } = useApi()
const data = ref<any>(null)
const loading = ref(false)
const copied = ref(false)

let loadSequence = 0
async function load() {
  const requestSequence = ++loadSequence
  const { projectSlug, episodeId, title } = props
  if (!episodeId) {
    data.value = null
    return
  }
  loading.value = true
  try {
    const titleParam = title ? `?title=${encodeURIComponent(title)}` : ''
    const loaded = await get(`/projects/${projectSlug}/episodes/${episodeId}/script-content${titleParam}`)
    if (requestSequence !== loadSequence || props.projectSlug !== projectSlug || props.episodeId !== episodeId || props.title !== title) return
    data.value = loaded
  } catch (e) {
    if (requestSequence !== loadSequence || props.projectSlug !== projectSlug || props.episodeId !== episodeId || props.title !== title) return
    data.value = null
  } finally {
    if (requestSequence === loadSequence && props.projectSlug === projectSlug && props.episodeId === episodeId && props.title === title) loading.value = false
  }
}

async function copyContent() {
  if (!data.value?.script?.content) return
  await navigator.clipboard.writeText(data.value.script.content)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
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

watch(() => [props.episodeId, props.title, props.refreshKey], load, { immediate: true })
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

.preview-body {
  padding: 16px;
  max-height: 480px;
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
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0;
}
</style>
