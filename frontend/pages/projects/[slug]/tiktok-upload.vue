<template>
  <div>
    <div class="upload-header">
      <h1>◉ TikTok Upload</h1>
    </div>

    <div class="card mt-2 tab-placeholder">
      <h3>Coming in v2</h3>
      <p class="text-muted" style="font-size: 13px; max-width: 640px; margin: 8px auto;">
        TikTok's Content Posting API has tighter quota + review requirements than YouTube. When it lands, this page
        will host its own <strong>Accounts</strong>, <strong>Upload Queue</strong>, and <strong>Scheduling</strong>
        controls — distinct from YouTube so per-platform caption length, hashtags, duet policy, and scheduled-post
        rules don't get crossed with each other.
      </p>
      <p class="text-muted" style="font-size: 12px; max-width: 640px; margin: 16px auto;">
        Per project = per TikTok account (or Creator Account). One project can't fan out to multiple TikTok accounts —
        create a second Story Studio project if you run multiple TikTok handles.
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
