<!--
  Shared tab nav for the video pipeline. Renders on
  /projects/:slug/video-assembly, /broll, and /timestamp-assemble.

  v1.0.346 — keep every assembler visibly reachable. Audio-paced projects use
  the full Scenes editor as the main Video Assembly page, with Timestamps kept
  as the fast/simple assembler tab.
-->
<template>
  <nav class="pipeline-tabs" aria-label="Video pipeline">
    <NuxtLink
      v-for="t in tabs"
      :key="t.id"
      :to="t.to"
      class="pipeline-tab"
      :class="{ active: activeTab === t.id }"
      :title="tabTitle(t.id)"
    >
      {{ t.label }}
    </NuxtLink>
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
  // v1.0.409 — Image Pool slideshow assembler lives alongside the others.
  { id: 'image-pool', label: '🖼 Image Slideshow', to: `/projects/${slug.value}/image-pool` },
  { id: 'timestamps', label: '🕐 Timestamps', to: `/projects/${slug.value}/timestamp-assemble` },
])

const activeTab = computed<'scenes' | 'broll' | 'image-pool' | 'timestamps'>(() => {
  if (route.path.endsWith('/timestamp-assemble')) return 'timestamps'
  if (route.path.endsWith('/broll')) return 'broll'
  if (route.path.endsWith('/image-pool')) return 'image-pool'
  return 'scenes'
})

// Which tab this project's pipeline actually uses. null = unknown (leave all on).
const applicableTab = ref<'scenes' | 'broll' | 'image-pool' | 'timestamps' | null>(null)
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
    else if (vs === 'image-pool') { applicableTab.value = 'image-pool'; pipelineLabel.value = 'Image Pool slideshow' }
    else if (vs === 'timestamp-driven' || vs === 'continuity-chain' || vs === 'narrated-scenes') { applicableTab.value = 'scenes'; pipelineLabel.value = 'full scene editor' }
    else { applicableTab.value = 'scenes'; pipelineLabel.value = 'chapter-distributed scenes' }
  } catch { applicableTab.value = null }
}

function tabTitle(id: string): string | undefined {
  if (!applicableTab.value || id === applicableTab.value) return undefined
  return `Alternate assembler; this project's default is ${pipelineLabel.value}`
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
.pipeline-tab:hover {
  color: var(--text-primary);
}
.pipeline-tab.active {
  color: var(--accent, #6c8fff);
  border-bottom-color: var(--accent, #6c8fff);
  font-weight: 600;
}
</style>
