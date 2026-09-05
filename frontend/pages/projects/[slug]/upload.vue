<template>
  <div class="upload-center workspace-page">
    <WorkspaceHero
      eyebrow="YouTube"
      title="Upload Center"
      description="Everything this channel publishes to YouTube, and what needs a decision."
    >
      <template #aside>
        <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="uc-settings">Manage YouTube connection</NuxtLink>
      </template>
    </WorkspaceHero>

    <nav class="uc-areas workspace-command-surface upload-tab-panel" aria-label="Upload Center areas">
      <NuxtLink :to="`/projects/${slug}/upload`" class="uc-area" exact-active-class="active">
        Overview
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload/publish`" class="uc-area" active-class="active">
        Publish
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload/library`" class="uc-area" active-class="active">
        Library
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload/reconcile`" class="uc-area" active-class="active">
        Reconcile
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload/comments`" class="uc-area" active-class="active">
        Comments
      </NuxtLink>
      <NuxtLink :to="`/projects/${slug}/upload/analytics`" class="uc-area" active-class="active">
        Analytics
      </NuxtLink>
    </nav>

    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)

// Every area now has its own page: Analytics was the last one still handed
// over to the legacy screen, so `pendingAreas` has no members and is gone
// rather than left as an empty list nothing renders.
</script>

<style scoped>
.upload-center { display: grid; gap: 16px; min-width: 0; }
.uc-settings { display: inline-block; color: var(--accent); font-size: var(--font-xs); }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }

.uc-areas { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 4px; }
.uc-area {
  display: inline-flex; align-items: baseline; gap: 6px;
  padding: 8px 14px; border: 1px solid var(--border); border-radius: 999px;
  color: var(--text-secondary); font-size: 13px; text-decoration: none; white-space: nowrap;
}
.uc-area:hover { border-color: var(--accent); color: var(--text-primary); }
.uc-area.active { background: var(--accent); border-color: var(--accent); color: var(--accent-on); }
</style>
