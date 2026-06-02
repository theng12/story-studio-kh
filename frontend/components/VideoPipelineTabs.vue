<!--
  Shared tab nav for the video pipeline. Renders on both
  /projects/:slug/video-assembly and /projects/:slug/broll so the user
  can flip between the two pipelines from either page.

  Replaces the v1.0.114 "wrong-pipeline" banner: instead of redirecting
  B-Roll-format users away from /video-assembly with a one-way card, this
  exposes both pipelines as always-visible tabs and lets the user pick.

  Active tab is computed from the current route path — no v-model, no
  format-aware default. The URL is the source of truth.
-->
<template>
  <nav class="pipeline-tabs" aria-label="Video pipeline">
    <NuxtLink
      :to="`/projects/${slug}/video-assembly`"
      class="pipeline-tab"
      :class="{ active: activeTab === 'scenes' }"
    >
      🎞 Scenes
    </NuxtLink>
    <NuxtLink
      :to="`/projects/${slug}/broll`"
      class="pipeline-tab"
      :class="{ active: activeTab === 'broll' }"
    >
      🎬 B-Roll
    </NuxtLink>
    <!-- v1.0.145+ — Timestamp tab. Always visible (consistent with the
         Scenes + B-Roll tabs being always visible regardless of format)
         so the user can flip between approaches on the same page. -->
    <NuxtLink
      :to="`/projects/${slug}/timestamp-assemble`"
      class="pipeline-tab"
      :class="{ active: activeTab === 'timestamps' }"
    >
      🕐 Timestamps
    </NuxtLink>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const activeTab = computed<'scenes' | 'broll' | 'timestamps'>(() => {
  if (route.path.endsWith('/timestamp-assemble')) return 'timestamps'
  if (route.path.endsWith('/broll')) return 'broll'
  return 'scenes'
})
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
