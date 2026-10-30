<template>
  <div class="layout">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <AppHeader />
    <ContentInstallStrip v-if="!signingIn" class="default-install-strip" />
    <main id="main-content" class="page-content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ContentInstallStrip from '~/components/content-store/ContentInstallStrip.vue'

const route = useRoute()
const signingIn = computed(() => route.path.replace(/\/+$/, '') === '/login')
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.default-install-strip {
  flex: 0 0 auto;
  width: min(100%, 620px);
  margin: 6px 12px 0 auto;
  padding: 0;
}
.page-content {
  flex: 1;
  overflow-y: auto;
}
.page-content:focus { outline: none; }
</style>
