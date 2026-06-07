<!--
  Shared tab nav for the video pipeline. Renders on
  /projects/:slug/video-assembly, /broll, and /timestamp-assemble.

  v1.0.265 — the tab that matches the project's pipeline (from the effective
  format's visualSource) is the active/usable one; the other two are greyed out
  + non-clickable, so a timestamp project doesn't invite you into the Scenes or
  B-Roll assemblers that don't apply. The currently-open tab is never greyed
  (you're on it), and if the format can't be determined all tabs stay enabled.
-->
<template>
  <nav class="pipeline-tabs" aria-label="Video pipeline">
    <component
      v-for="t in tabs"
      :key="t.id"
      :is="isDisabled(t.id) ? 'span' : 'NuxtLink'"
      :to="isDisabled(t.id) ? undefined : t.to"
      class="pipeline-tab"
      :class="{ active: activeTab === t.id, disabled: isDisabled(t.id) }"
      :title="isDisabled(t.id) ? `Not used by this project's pipeline (${pipelineLabel})` : undefined"
      :aria-disabled="isDisabled(t.id) ? 'true' : undefined"
    >
      {{ t.label }}
    </component>
  </nav>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const route = useRoute()
const { get } = useApi()
const slug = computed(() => route.params.slug as string)

const tabs = computed(() => [
  { id: 'scenes', label: '🎞 Scenes', to: `/projects/${slug.value}/video-assembly` },
  { id: 'broll', label: '🎬 B-Roll', to: `/projects/${slug.value}/broll` },
  { id: 'timestamps', label: '🕐 Timestamps', to: `/projects/${slug.value}/timestamp-assemble` },
])

const activeTab = computed<'scenes' | 'broll' | 'timestamps'>(() => {
  if (route.path.endsWith('/timestamp-assemble')) return 'timestamps'
  if (route.path.endsWith('/broll')) return 'broll'
  return 'scenes'
})

// Which tab this project's pipeline actually uses. null = unknown (leave all on).
const applicableTab = ref<'scenes' | 'broll' | 'timestamps' | null>(null)
const pipelineLabel = ref('')

async function loadPipeline(): Promise<void> {
  applicableTab.value = null
  if (!slug.value) return
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    const vs = fmt?.visualSource
    if (vs === 'broll') { applicableTab.value = 'broll'; pipelineLabel.value = 'B-Roll' }
    else if (vs === 'timestamp-driven' || vs === 'continuity-chain' || vs === 'narrated-scenes') { applicableTab.value = 'timestamps'; pipelineLabel.value = 'timestamp-driven' }
    else { applicableTab.value = 'scenes'; pipelineLabel.value = 'scene-images' }
  } catch { applicableTab.value = null }
}

// A tab is greyed only when the pipeline is known, it's not the applicable one,
// and it's not the tab you're currently on.
function isDisabled(id: string): boolean {
  return !!applicableTab.value && id !== applicableTab.value && id !== activeTab.value
}

watch(slug, () => { void loadPipeline() }, { immediate: true })
</script>

<style scoped>
.pipeline-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin: 8px 0 16px;
}
.pipeline-tab {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.pipeline-tab:hover:not(.disabled) {
  color: var(--text-primary);
}
.pipeline-tab.active {
  color: var(--accent, #6c8fff);
  border-bottom-color: var(--accent, #6c8fff);
  font-weight: 600;
}
.pipeline-tab.disabled {
  opacity: 0.38;
  cursor: not-allowed;
  pointer-events: none;
}
</style>
