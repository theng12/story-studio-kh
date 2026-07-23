<template>
  <!--
    "What worked" inspiration card. Used on the Ideas + Metadata generator
    pages to surface the top N video titles by views from the connected
    YouTube channel. The same titles are auto-injected into the LLM prompt
    server-side; this card just makes that visible.

    Render branches:
      1. Channel has analytics + at least one row → full card with titles
      2. Channel connected but missing the analytics scope → thin reauth CTA
         so the user knows the feature exists and how to enable it
      3. No account / no data / any other error → hide silently (don't
         clutter the page when the feature isn't applicable)
  -->
  <div v-if="state === 'data'" class="inspiration-card">
    <div class="inspiration-header">
      <span class="inspiration-icon" aria-hidden="true">📈</span>
      <strong>Inspired by your top performers</strong>
      <NuxtLink :to="`/projects/${slug}/upload`" class="inspiration-link">View Analytics →</NuxtLink>
    </div>
    <ul class="inspiration-list">
      <li v-for="p in performers" :key="p.video_id">
        <span class="inspiration-title">"{{ p.title }}"</span>
        <span class="inspiration-meta">
          {{ formatViews(p.views) }}<template v-if="p.ctr_percentage != null"> · {{ p.ctr_percentage.toFixed(1) }}% CTR</template>
        </span>
      </li>
    </ul>
    <p class="inspiration-hint text-muted">
      Auto-included in the generator's LLM prompt as a vibe reference. Refresh on the Analytics tab to update.
    </p>
  </div>

  <div v-else-if="state === 'reauth'" class="inspiration-cta">
    <span aria-hidden="true">💡</span>
    <span>
      <strong>Connect YouTube Analytics</strong> to feed this generator with what already works on your channel.
    </span>
    <NuxtLink :to="`/projects/${slug}/upload`" class="inspiration-link">Reconnect on Upload Center →</NuxtLink>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  slug: string
  /** How many performers to show (and inject into the prompt). Defaults to 5. */
  limit?: number
}>()

interface AnalyticsRow {
  video_id: string
  title: string
  views: number
  ctr_percentage?: number
}

type State = 'idle' | 'loading' | 'data' | 'reauth' | 'hidden'
const state = ref<State>('idle')
const performers = ref<AnalyticsRow[]>([])

async function load() {
  if (!props.slug) {
    state.value = 'hidden'
    return
  }
  state.value = 'loading'
  performers.value = []
  try {
    const { get } = useApi()
    const limit = Math.max(props.limit ?? 5, 1)
    // Pull a slightly bigger window than we render so titles without
    // metadata (rare) don't leave us short.
    const r = await get<{ rows: AnalyticsRow[] }>(`/projects/${props.slug}/upload/analytics?max_results=${limit * 2}`)
    const filtered = (r.rows || []).filter(row => row.title && row.title.trim()).slice(0, limit)
    if (filtered.length) {
      performers.value = filtered
      state.value = 'data'
    } else {
      // Channel connected with scope but no rows yet (e.g. brand-new channel
      // or zero views in the default 90-day window). Hide rather than show
      // an empty card.
      state.value = 'hidden'
    }
  } catch (e: any) {
    // Nuxt's $fetch throws FetchError; the response body lives on e.data
    // and the status code on e.statusCode (or e.response.status as a fallback).
    const code = e?.statusCode || e?.response?.status || e?.status
    const data = e?.data || e?.response?._data
    if (code === 403 && data?.reauth_required) {
      state.value = 'reauth'
    } else {
      // 400 (no account), 404 (no tokens), 500, network errors — all hide.
      // Surfacing every failure mode would overwhelm a generator page; the
      // Analytics tab is the right place to debug.
      state.value = 'hidden'
    }
  }
}

function formatViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M views'
  if (n >= 10_000) return (n / 1000).toFixed(0) + 'K views'
  return n.toLocaleString() + ' views'
}

onMounted(load)
watch(() => props.slug, load)
</script>

<style scoped>
.inspiration-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.inspiration-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
}
.inspiration-icon { font-size: 14px; }
.inspiration-link {
  margin-left: auto;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  white-space: nowrap;
}
.inspiration-link:hover { color: var(--accent-hover); text-decoration: underline; }

.inspiration-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.inspiration-list li {
  padding: 4px 0;
  font-size: 13px;
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
.inspiration-title { color: var(--text-primary); }
.inspiration-meta {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.inspiration-hint {
  margin: 8px 0 0;
  font-size: var(--font-xs);
}

.inspiration-cta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px dashed var(--border);
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.inspiration-cta strong { color: var(--text-primary); }
.inspiration-cta .inspiration-link { margin-left: auto; }
</style>
