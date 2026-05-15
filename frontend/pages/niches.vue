<!--
  v1.0.96+ — The standalone Niches page is retired. The full library
  (browse / create custom / delete custom) now lives inside each project's
  Settings → Niche tab. This stub stays so old bookmarks / deep-links don't
  404; it sends the user to the projects list with a brief explanation of
  where the feature moved.
-->
<template>
  <div class="niches-moved">
    <div class="moved-card">
      <h1>Niches moved</h1>
      <p class="text-muted">
        The niche library is now part of each project's
        <strong>Settings → Niche → Niche library</strong> sub-tab. The full
        feature set (browse built-ins, create custom niches, delete unused ones)
        moved along with it.
      </p>
      <p class="text-muted">
        We made this change so niche stuff has ONE home: the same place where
        you assign the niche to a project. Pick a project below to get there.
      </p>
      <div class="moved-actions mt-3">
        <NuxtLink to="/" class="btn btn-primary">Open projects list</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Niches moved')
</script>

<style scoped>
.niches-moved {
  display: flex;
  justify-content: center;
  padding-top: 60px;
}
.moved-card {
  max-width: 560px;
  padding: 24px 28px;
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent, #6c8fff);
  border-radius: var(--radius-md, 6px);
}
.moved-card h1 {
  margin: 0 0 12px 0;
  font-size: 20px;
}
.moved-card p {
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 8px;
}
.moved-actions {
  display: flex;
  gap: 8px;
}
</style>
