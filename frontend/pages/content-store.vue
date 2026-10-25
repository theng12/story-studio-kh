<template>
  <div />
</template>

<script setup lang="ts">
/**
 * The old address. Kept as a redirect rather than deleted so bookmarks, the
 * app's own older links and anything else holding `/content-store` still land
 * on the Studio Library.
 */
const route = useRoute()
const productId = typeof route.params.productId === 'string' ? route.params.productId : ''
await navigateTo(productId ? `/library/${productId}` : '/library', { replace: true, redirectCode: 301 })
</script>
