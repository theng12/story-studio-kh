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
        <span v-if="data?.introduction?.wordCount" class="meta-pill">
          {{ data.introduction.wordCount.toLocaleString() }} words
        </span>
        <span v-if="data?.introduction?.modifiedAt" class="meta-pill">
          Updated {{ formatTime(data.introduction.modifiedAt) }}
        </span>
        <button class="btn btn-sm btn-secondary" @click="load" :disabled="loading" title="Refresh">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? '…' : '↻' }}
        </button>
        <button
          v-if="data?.introduction?.content"
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
        Select an episode to preview its introduction.
      </div>
      <div v-else-if="loading && !data" class="preview-empty">
        Loading introduction content…
      </div>
      <div v-else-if="!data?.introduction?.content" class="preview-empty">
        No introduction generated yet for this episode.
        <p class="muted mt-1" style="font-size: 12px;">
          Generate the script first, then click "Generate Introduction" to create one.
        </p>
      </div>
      <pre v-else class="preview-content">{{ data.introduction.content }}</pre>
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

async function load() {
  if (!props.episodeId) {
    data.value = null
    return
  }
  loading.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    data.value = await get(`/projects/${props.projectSlug}/episodes/${props.episodeId}/script-content${titleParam}`)
  } catch (e) {
    data.value = null
  } finally {
    loading.value = false
  }
}

async function copyContent() {
  if (!data.value?.introduction?.content) return
  await navigator.clipboard.writeText(data.value.introduction.content)
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
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
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
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0;
}
</style>
