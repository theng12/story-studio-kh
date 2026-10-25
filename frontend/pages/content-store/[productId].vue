<template>
  <div />
</template>

<script setup lang="ts">
/** The old product address; `/library/:productId` is the real page. */
const route = useRoute()
const productId = typeof route.params.productId === 'string' ? route.params.productId : ''
await navigateTo(productId ? `/library/${productId}` : '/library', { replace: true, redirectCode: 301 })
</script>
