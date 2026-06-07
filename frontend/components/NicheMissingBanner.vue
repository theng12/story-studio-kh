<template>
  <div v-if="show" class="niche-missing-banner" role="status">
    <span class="nmb-icon" aria-hidden="true">🎙️</span>
    <div class="nmb-body">
      <strong>This project has no niche.</strong>
      <span class="nmb-detail">
        Ideas, scripts, and metadata will use a generic voice — no distinct vocabulary, title style, or narrator.
        Pick a niche to give your channel its identity.
      </span>
    </div>
    <NuxtLink :to="`/projects/${slug}/settings`" class="btn btn-sm btn-primary nmb-action">
      Choose a niche
    </NuxtLink>
    <button type="button" class="nmb-dismiss" aria-label="Dismiss for this session" @click="dismiss">×</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{
  slug: string
  /** The project's saved niche_id. Empty / undefined → no niche set. */
  nicheId?: string | null
}>()

// Dismiss is per-project, per-session: it should stop nagging within a working
// session but re-surface next launch until the user actually sets a niche.
const dismissed = ref(false)
const storageKey = computed(() => `niche-banner-dismissed:${props.slug}`)

onMounted(() => {
  try {
    if (sessionStorage.getItem(storageKey.value) === '1') dismissed.value = true
  } catch { /* sessionStorage unavailable — just show the banner */ }
})

function dismiss() {
  dismissed.value = true
  try { sessionStorage.setItem(storageKey.value, '1') } catch { /* ignore */ }
}

const show = computed(() => !!props.slug && !props.nicheId && !dismissed.value)
</script>

<style scoped>
.niche-missing-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid var(--warning, #d8a23c);
  border-radius: var(--radius-md, 6px);
  background: var(--warning-dim, rgba(216, 162, 60, 0.1));
  font-size: 13px;
  color: var(--text-primary);
}

.nmb-icon { font-size: 18px; line-height: 1; }

.nmb-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.nmb-detail {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.nmb-action { white-space: nowrap; flex-shrink: 0; }

.nmb-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  flex-shrink: 0;
}
.nmb-dismiss:hover { color: var(--text-primary); }
</style>
