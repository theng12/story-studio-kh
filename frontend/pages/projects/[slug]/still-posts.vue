<!--
  Still Posts — one channel's production path, as five steps (owner, 2026-10-30):
  Channel look → Write → Draw → Review → Publish. Each step is a sidebar entry and a tab of this page,
  the same pattern as Thumbnails. Old `/still-posts` links land on the step where the work is.

  What the page never does: choose a model, guess whether a post is finished, or draw text with an
  image model. Model lists are live from the Gateway, the "done" verdict comes from the server (which
  reads the files), and every word is drawn by our own renderer.
-->
<template>
  <div class="workspace-page sp">
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Still Posts</h1>
      <p class="page-sub">
        One short line, one illustrated picture, your characters. Work through the five steps; each one says
        what is done and what comes next. The words are never drawn by the image model; our own renderer letters them.
      </p>
    </div>

    <p v-if="loadError" class="sp-notice sp-notice-error" role="alert">
      {{ loadError }}
      <button type="button" class="btn btn-sm btn-ghost" :disabled="loading" @click="load">Retry</button>
    </p>

    <template v-if="workspace">
      <StillPostsStepRail :active="tab" />
      <StillPostsLook v-if="tab === 'look'" />
      <StillPostsWrite v-else-if="tab === 'write'" />
      <StillPostsDraw v-else-if="tab === 'draw'" />
      <StillPostsReview v-else-if="tab === 'review'" />
      <StillPostsPublish v-else />
    </template>

    <p v-else-if="loading" class="sp-help">Loading Still Posts…</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { projectSlug } from '~/utils/project-slug'
import { isStillPostTab, type StillPostTab } from '~/utils/still-posts-flow'
import { provideStillPosts, useStillPostsWorkspace } from '~/composables/useStillPostsWorkspace'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const router = useRouter()
const slug = computed(() => projectSlug(route.params.slug) || '')
const ws = useStillPostsWorkspace(slug)
provideStillPosts(ws)
const { workspace, loading, loadError, landing, load, loadModels, loadPublishing } = ws

/** The step on screen: the URL's tab when it names one, otherwise the step where the work is. */
const tab = computed<StillPostTab>(() => (isStillPostTab(route.query.tab) ? route.query.tab : landing.value))

// An old link (no tab) lands on the step with the work, and the address is made to say which step it is,
// so the sidebar highlights the same entry the page shows.
watch(() => [loading.value, workspace.value !== null, route.query.tab] as const, ([isLoading, hasWorkspace]) => {
  if (isLoading || !hasWorkspace || isStillPostTab(route.query.tab)) return
  void router.replace({ path: route.path, query: { ...route.query, tab: landing.value } })
}, { immediate: true })

onMounted(() => {
  void load()
  void loadModels()
  void loadPublishing()
})
</script>

<style>
/*
 * Unscoped on purpose: the five steps are child components, and a scoped rule on this page would not
 * reach them. Every class here is `sp-`-prefixed, so nothing outside Still Posts is touched.
 */
.sp { display: flex; flex-direction: column; gap: 14px; }
.page-sub { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; max-width: 78ch; }
.sp-step { display: flex; flex-direction: column; gap: 14px; }
.sp-section { padding: 16px 18px; }
.sp-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sp-h2 { margin: 0; font-size: 20px; }
.sp-h3 { margin: 0; font-size: 16px; }
.sp-h4 { margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); }
.sp-kicker { margin: 0 0 2px; color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.sp-count { color: var(--text-secondary); font-weight: 500; }
.sp-help { display: block; margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.sp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sp-two { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
.sp-grow { flex: 1 1 320px; }
.sp-narrow { flex: 0 0 120px; }
.sp-model { margin-top: 12px; max-width: 420px; }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 10px; }
.sp-field { display: flex; flex-direction: column; gap: 4px; }
.sp-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.sp-checks { display: flex; gap: 12px; flex-wrap: wrap; }
.sp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.sp-draw-mode { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.sp-cost { margin: 6px 0 0; }
.sp-cost.basis-unpublished { color: var(--text-secondary); font-style: italic; }
.sp-draw-actions { margin-top: 12px; }
.sp-pool { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; }
.sp-pool-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sp-pool-summary { margin: 0; }
.sp-pool-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sp-pool-order { min-width: 44px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.sp-pool-face { flex: 1 1 180px; }
.sp-pool-weight { display: inline-flex; align-items: center; gap: 6px; }
.sp-pool-weight .input { width: 72px; }
.sp-pool-pct { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.sp-range { width: 100%; }
.sp-note { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 12%, transparent); font-size: 13px; }
.sp-notice-error, .sp-note-error { background: color-mix(in srgb, #c0392b 16%, transparent); }
.sp-notice { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
.sp-link { color: var(--accent); text-decoration: underline; font-size: 12px; }

/* The step rail and the step head */
.sp-rail-list { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.sp-rail-step { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 9px; align-items: center; padding: 9px 11px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-secondary); color: var(--text-primary); text-decoration: none; }
.sp-rail-step.is-active { border-color: var(--accent); box-shadow: var(--focus-ring); }
.sp-rail-number { grid-row: 1 / span 2; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--bg-tertiary); font-size: 12px; font-weight: 700; }
.sp-rail-step.is-done .sp-rail-number { background: color-mix(in srgb, #2e7d32 30%, transparent); }
.sp-rail-step.is-failed .sp-rail-number { background: color-mix(in srgb, #c0392b 30%, transparent); }
.sp-rail-label { font-size: 13px; font-weight: 600; }
.sp-rail-state { font-size: var(--font-xs); color: var(--text-secondary); }
.sp-stephead { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 14px 18px; border: 1px solid var(--border); border-radius: 13px; background: var(--surface-raised); }
.sp-stephead-copy { min-width: 0; flex: 1 1 360px; }
.sp-stephead-reason { max-width: 72ch; font-size: 13px; }
.sp-stephead-side { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* The collapsed one-line summaries of settled groups */
.sp-fold { padding: 0; }
.sp-fold-summary { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 14px 18px; cursor: pointer; list-style: none; }
.sp-fold-summary::-webkit-details-marker { display: none; }
.sp-fold-summary::before { content: '▸'; color: var(--text-secondary); font-size: 12px; }
.sp-fold[open] > .sp-fold-summary::before { content: '▾'; }
.sp-fold-line { color: var(--text-secondary); font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.sp-fold-body { padding: 0 18px 16px; }
.sp-fold-intro { margin: 0 0 8px; }

.sp-empty-state { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px; border: 1px dashed var(--border); border-radius: 12px; }
.sp-batches { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.sp-batch { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.sp-draw-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.sp-draw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.sp-cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-top: 8px; }
.sp-cast-item { display: flex; gap: 10px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
.sp-cast-item.is-on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.sp-cast-item.is-off { opacity: 0.55; cursor: not-allowed; }
.sp-cast-portrait { width: 38px; height: 38px; object-fit: cover; border-radius: 8px; }
.sp-cast-placeholder { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 8px; background: var(--bg-tertiary); }
.sp-cast-text { display: flex; flex-direction: column; min-width: 0; }
.sp-posts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-top: 12px; }
.sp-post { display: flex; flex-direction: column; gap: 6px; padding: 8px; text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
.sp-post.is-selected { border-color: var(--accent); box-shadow: var(--focus-ring); }
.sp-post-image { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; display: block; }
.sp-post-empty { display: grid; place-items: center; aspect-ratio: 1; border-radius: 8px; background: var(--bg-tertiary); font-size: 12px; color: var(--text-secondary); }
.sp-post-meta { display: flex; flex-direction: column; gap: 2px; }
.sp-post-text { font-size: 13px; line-height: 1.35; }
.sp-pill { align-self: flex-start; padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 600; white-space: nowrap; }
.sp-pill.is-done { background: color-mix(in srgb, #2e7d32 22%, transparent); }
.sp-pill.is-in-progress { background: color-mix(in srgb, #b26a00 24%, transparent); }
.sp-pill.is-running { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.sp-pill.is-failed { background: color-mix(in srgb, #c0392b 24%, transparent); }
.sp-pill.is-not-started { background: var(--bg-tertiary); color: var(--text-secondary); }
.sp-empty { padding: 10px 0; }
.sp-editor-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 18px; margin-top: 12px; }
.sp-editor-fields { display: flex; flex-direction: column; gap: 10px; }
.sp-panel-fields { display: flex; flex-direction: column; gap: 8px; }
.sp-editor-preview { display: flex; flex-direction: column; gap: 10px; }
.sp-tabs { display: flex; gap: 6px; }
.sp-tab { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
.sp-tab.is-active { border-color: var(--accent); color: var(--text-primary); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sp-preview-panel { display: flex; flex-direction: column; gap: 4px; }
.sp-preview-image { width: 100%; border-radius: 10px; display: block; }
@media (max-width: 1100px) {
  .sp-editor-grid { grid-template-columns: 1fr; }
  .sp-rail-list { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
}
@media (max-width: 720px) {
  .sp-section, .sp-fold-body { padding-left: 12px; padding-right: 12px; }
  .sp-fold-summary { padding: 12px; }
  .sp-stephead { padding: 12px; }
}
</style>
