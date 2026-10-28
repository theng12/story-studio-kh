<template>
  <div />
</template>

<script setup lang="ts">
/**
 * The old Sound Design address — the same redirect as `/contextual-cues`, for
 * the same reason. Both pages were merged into Sound & Labels (v1.4.365);
 * neither one's data moved, and nothing on disk was rewritten.
 */
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const slug = String(route.params.slug || '')
await navigateTo(`/projects/${encodeURIComponent(slug)}/sound-and-labels`, { replace: true, redirectCode: 301 })
</script>
