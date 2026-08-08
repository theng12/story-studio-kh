<template><div /></template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const slug = String(route.params.slug || '')
await navigateTo({ path: '/character-library', query: { channel: slug, project: slug } }, { replace: true })
</script>
