<template><div /></template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
await navigateTo({ path: '/character-library', query: { channel: String(route.params.slug || '') } }, { replace: true })
</script>
