<!--
  Shared tab nav for the video pipeline. Renders on
  /projects/:slug/video-assembly, /broll, and /timestamp-assemble.

  v1.0.345 — keep every assembler reachable. The project-native pipeline still
  gets labelled, but advanced users can jump to the richer scene editor from a
  timestamp project when they want its timeline/effects/subtitle controls.
-->
<template>
  <nav class="pipeline-tabs" aria-label="Video pipeline">
    <component
      v-for="t in tabs"
      :key="t.id"
      :is="'NuxtLink'"
      :to="t.to"
      class="pipeline-tab"
      :class="{ active: activeTab === t.id, alternate: isAlternate(t.id) }"
      :title="isAlternate(t.id) ? `Alternate assembler; this project's default is ${pipelineLabel}` : undefined"
    >
      {{ t.label }}
    </component>
  </nav>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { normalizeVisualSource } from '~/composables/useProjectFlow'

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
    const fmt = await get<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug.value}/effective-format`)
    // v1.0.280+ — normalize the unified `scenes` format (visualSource
    // 'scene-images' + sceneAlignment) onto the pipeline vocabulary.
    const vs = normalizeVisualSource(fmt?.visualSource, fmt?.sceneAlignment)
    if (vs === 'broll') { applicableTab.value = 'broll'; pipelineLabel.value = 'Stock Footage' }
    else if (vs === 'timestamp-driven' || vs === 'continuity-chain' || vs === 'narrated-scenes') { applicableTab.value = 'timestamps'; pipelineLabel.value = 'sentence-timed scenes' }
    else { applicableTab.value = 'scenes'; pipelineLabel.value = 'chapter-distributed scenes' }
  } catch { applicableTab.value = null }
}

// A tab is marked alternate only when the pipeline is known, it's not the
// default one, and it's not the tab you're currently on.
function isAlternate(id: string): boolean {
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
.pipeline-tab.alternate {
  opacity: 0.62;
}
</style>
