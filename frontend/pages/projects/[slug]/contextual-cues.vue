<template>
  <div />
</template>

<script setup lang="ts">
/**
 * The old Contextual Cues address. Kept as a redirect rather than deleted so
 * bookmarks, the app's own older links, Pipeline's step link and anything else
 * holding `/contextual-cues` still land on the page that replaced it.
 */
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const slug = String(route.params.slug || '')
await navigateTo(`/projects/${encodeURIComponent(slug)}/sound-and-labels`, { replace: true, redirectCode: 301 })
</script>
