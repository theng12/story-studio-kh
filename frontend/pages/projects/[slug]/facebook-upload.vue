<template>
  <div>
    <div class="upload-header">
      <h1>ⓕ Facebook Upload</h1>
    </div>

    <div class="card mt-2 tab-placeholder">
      <h3>Coming in v2</h3>
      <p class="text-muted" style="font-size: 13px; max-width: 640px; margin: 8px auto;">
        Facebook Graph API page-video publishing needs a separate OAuth app (a Business/Creator app with page-access
        scopes) from the YouTube one. When this ships, this page will host its own accounts + queue + scheduling
        controls, keeping Meta's link-preview / cross-posting-to-Instagram options scoped away from YouTube's
        <code>publishAt</code>.
      </p>
      <p class="text-muted" style="font-size: 12px; max-width: 640px; margin: 16px auto;">
        Per project = per Facebook Page. One project can't fan out to multiple pages — create a second Story Studio
        project if you publish to multiple brands.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
</script>

<style scoped>
.upload-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-top: 16px;
  flex-wrap: wrap; gap: 10px;
}
.upload-header h1 { margin: 0; font-size: 22px; }

.tab-placeholder {
  padding: 48px 24px;
  text-align: center;
  color: var(--text-secondary);
}
.tab-placeholder h3 { margin: 0; }
</style>
