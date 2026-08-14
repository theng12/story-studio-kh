<template>
  <section class="catalog-settings">
    <header class="catalog-header">
      <div>
        <span class="eyebrow">Connected account</span>
        <h3>GenStudio Catalog</h3>
        <p>Read-only model availability shared by every Story Studio project on this Mac.</p>
      </div>
      <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh">
        {{ loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>

    <div class="account-grid" aria-label="GenStudio account summary">
      <article>
        <span>Connection</span>
        <strong :class="`status-${connectionState.tone}`">{{ connectionState.label }}</strong>
        <small>{{ connectionState.detail }}</small>
      </article>
      <article>
        <span>Last refresh</span>
        <strong>{{ lastRefreshLabel }}</strong>
        <small>{{ loading ? 'Checking live account data…' : `Catalogs are never saved to the project · fresh for ${CATALOG_FRESH_MINUTES}m, unusable past ${CATALOG_CEILING_MINUTES}m` }}</small>
      </article>
    </div>

    <WorkspaceNotice
      v-if="anyExpired"
      tone="error"
      title="Catalog data is too old to use for new work"
    >
      <p>
        {{ expiredSections.join(', ') }} {{ expiredSections.length > 1 ? 'have' : 'has' }} not refreshed in
        over {{ CATALOG_CEILING_MINUTES }} minutes. Availability, pricing, and capabilities shown may no
        longer be real — refresh before starting anything new.
      </p>
    </WorkspaceNotice>
    <WorkspaceNotice
      v-else-if="anyStale"
      tone="warning"
      title="Catalog data is stale"
    >
      <p>
        {{ staleSections.join(', ') }} {{ staleSections.length > 1 ? 'haven\'t' : 'hasn\'t' }} refreshed in the
        last {{ CATALOG_FRESH_MINUTES }} minutes. What's shown below may be out of date — refresh to confirm
        before relying on it.
      </p>
    </WorkspaceNotice>

    <WorkspaceNotice
      v-if="combinedErrors.length"
      tone="warning"
      title="Some GenStudio catalog data is unavailable"
    >
      <ul class="error-list">
        <li v-for="message in combinedErrors" :key="message">{{ message }}</li>
      </ul>
    </WorkspaceNotice>

    <div class="catalog-grid">
      <article v-for="entry in summaries" :key="entry.label">
        <span>{{ entry.label }}</span>
        <strong>{{ entry.available }}/{{ entry.total }}</strong>
        <small>available</small>
        <em
          v-if="freshnessBadge(entry)"
          class="freshness-badge"
          :class="`tone-${freshnessBadge(entry)!.tone}`"
        >{{ freshnessBadge(entry)!.label }}</em>
      </article>
    </div>

    <details class="catalog-details">
      <summary>
        <span>View catalog details</span>
        <small>Diagnostics only</small>
      </summary>
      <div class="catalog-detail-grid">
        <section v-for="group in catalogGroups" :key="group.label">
          <header>
            <strong>{{ group.label }}</strong>
            <span>{{ group.items.length }}</span>
          </header>
          <p v-if="!group.items.length">No entries reported.</p>
          <ul v-else>
            <li v-for="item in group.items" :key="`${group.label}-${item.id}`">
              <span>
                <strong>{{ item.name }}</strong>
                <small>{{ item.providerName ? `${item.id} · ${item.providerName}` : item.id }}</small>
                <small v-if="item.costTier">{{ tierLabel(item.costTier) }}</small>
                <small v-if="item.lockReason" class="catalog-lock-reason">{{ item.lockReason }}</small>
              </span>
              <em :class="`status-${item.statusTone}`">{{ item.statusLabel }}</em>
            </li>
          </ul>
        </section>
      </div>
    </details>

    <footer class="catalog-footer">
      <div>
        <NuxtLink class="btn btn-secondary btn-sm" to="/usage">Credits &amp; settlement</NuxtLink>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { createGenStudioCatalogCache, GENSTUDIO_CATALOG_FRESH_MS, GENSTUDIO_CATALOG_STALE_CEILING_MS } from '../composables/useGenStudioCatalogCache.js'
import { useGenStudioTranscriptionCatalog } from '../composables/useGenStudioTranscription.js'
import { costTierLabel, type GenStudioCostTier } from '../utils/genstudio-cost-tier.js'
import { genStudioModelLockReason } from '../utils/live-genstudio-model-selection.js'

const { get } = useApi()
const {
  models: imageModels,
  error: imageError,
  refresh: refreshImages,
  lastFetchedAt: imageLastFetchedAt,
  isStale: imageIsStale,
  isExpired: imageIsExpired,
} = useGenStudioImageModels()
const {
  voiceModels,
  videoModels,
  error: mediaError,
  refresh: refreshMedia,
  lastFetchedAt: mediaLastFetchedAt,
  isStale: mediaIsStale,
  isExpired: mediaIsExpired,
} = useGenStudioMediaModels()
// Sharing the same underlying catalog cache Subtitles/B-Roll use — this
// panel is read-only diagnostics, it must not fetch a second copy of the
// /app-settings/genstudio/transcription-models list on its own freshness
// clock (see useGenStudioTranscription.ts for the shared cache instance).
const transcriptionCatalog = useGenStudioTranscriptionCatalog()
// No dedicated shared composable owns the chat-model/music catalogs today;
// these two stay component-local but run on the exact same fresh/ceiling
// policy as everything else via the shared cache factory.
const chatModelsCache = createGenStudioCatalogCache<CatalogEntry[]>({
  empty: [],
  fetcher: async () => {
    const response = await get<{ models: CatalogEntry[] }>('/app-settings/genstudio/chat-models', { cache: 'no-store' })
    return Array.isArray(response.models) ? response.models : []
  },
})
const musicModelsCache = createGenStudioCatalogCache<CatalogEntry[]>({
  empty: [],
  fetcher: async () => {
    const response = await get<{ models: CatalogEntry[] }>('/app-settings/genstudio/music-models', { cache: 'no-store' })
    return Array.isArray(response.models) ? response.models : []
  },
})

interface CatalogEntry {
  id: string
  display_name?: string
  name?: string
  voice_name?: string
  provider_name?: string
  available?: boolean
  generation_enabled?: boolean
  coming_soon?: boolean
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string | null
}

interface CatalogDiagnostic {
  id: string
  name: string
  available: boolean
  providerName?: string
  statusLabel: 'Available' | 'Unavailable' | 'Coming soon' | 'Locked'
  statusTone: 'available' | 'unavailable' | 'coming-soon' | 'locked'
  lockReason?: string
  costTier?: GenStudioCostTier
}

const accountConfigured = ref(false)
const configurationChecked = ref(false)
const loading = ref(false)
const requestErrors = ref<string[]>([])
const lastRefreshedAt = ref<Date | null>(null)
function isAvailable(entry: CatalogEntry): boolean {
  return entry.available !== false
    && entry.generation_enabled !== false
    && entry.coming_soon !== true
    && entry.locked !== true
}

const summaries = computed(() => [
  { label: 'LLM', total: chatModelsCache.data.value.length, available: chatModelsCache.data.value.filter(isAvailable).length, ...freshnessOf(chatModelsCache) },
  { label: 'Images', total: imageModels.value.length, available: imageModels.value.filter(isAvailable).length, lastFetchedAt: imageLastFetchedAt.value, isStale: imageIsStale.value, isExpired: imageIsExpired.value },
  { label: 'TTS models', total: voiceModels.value.length, available: voiceModels.value.filter(isAvailable).length, lastFetchedAt: mediaLastFetchedAt.value, isStale: mediaIsStale.value, isExpired: mediaIsExpired.value },
  { label: 'Music models', total: musicModelsCache.data.value.length, available: musicModelsCache.data.value.filter(isAvailable).length, ...freshnessOf(musicModelsCache) },
  { label: 'Transcription', total: transcriptionCatalog.data.value.length, available: transcriptionCatalog.data.value.filter(isAvailable).length, ...freshnessOf(transcriptionCatalog) },
  { label: 'Video', total: videoModels.value.length, available: videoModels.value.filter(isAvailable).length, lastFetchedAt: mediaLastFetchedAt.value, isStale: mediaIsStale.value, isExpired: mediaIsExpired.value },
])

function diagnosticRows(entries: readonly CatalogEntry[]): CatalogDiagnostic[] {
  return entries.map(entry => {
    const comingSoon = entry.coming_soon === true
    const locked = entry.locked === true
    const available = isAvailable(entry)
    return {
      id: entry.id,
      name: entry.display_name || entry.voice_name || entry.name || entry.id,
      available,
      providerName: entry.provider_name,
      statusLabel: locked ? 'Locked' : comingSoon ? 'Coming soon' : available ? 'Available' : 'Unavailable',
      statusTone: locked ? 'locked' : comingSoon ? 'coming-soon' : available ? 'available' : 'unavailable',
      lockReason: genStudioModelLockReason(entry) || undefined,
      costTier: entry.cost_tier,
    }
  })
}

const catalogGroups = computed(() => [
  { label: 'Language models', items: diagnosticRows(chatModelsCache.data.value) },
  { label: 'Image models', items: diagnosticRows(imageModels.value) },
  { label: 'TTS models', items: diagnosticRows(voiceModels.value) },
  { label: 'Music models', items: diagnosticRows(musicModelsCache.data.value) },
  { label: 'Transcription models', items: diagnosticRows(transcriptionCatalog.data.value) },
  { label: 'Video models', items: diagnosticRows(videoModels.value) },
])

const combinedErrors = computed(() => Array.from(new Set([
  ...requestErrors.value,
  imageError.value,
  mediaError.value,
  chatModelsCache.error.value,
  musicModelsCache.error.value,
  transcriptionCatalog.error.value,
].filter(Boolean))))

// ── Staleness visibility (release-hardening requirement: never silently
// present old catalog data as current). Every catalog source above runs on
// the exact same fresh/ceiling policy via the shared cache — this just
// rolls their individual `isStale`/`isExpired`/`lastFetchedAt` up into one
// place the template can render banners and per-tile badges from.
function freshnessOf(source: { lastFetchedAt: { value: number | null }; isStale: { value: boolean }; isExpired: { value: boolean } }) {
  return {
    lastFetchedAt: source.lastFetchedAt.value,
    isStale: source.isStale.value,
    isExpired: source.isExpired.value,
  }
}

const freshnessEntries = computed(() => [
  { label: 'Language models', ...freshnessOf(chatModelsCache) },
  { label: 'Image models', lastFetchedAt: imageLastFetchedAt.value, isStale: imageIsStale.value, isExpired: imageIsExpired.value },
  { label: 'TTS & Video models', lastFetchedAt: mediaLastFetchedAt.value, isStale: mediaIsStale.value, isExpired: mediaIsExpired.value },
  { label: 'Music models', ...freshnessOf(musicModelsCache) },
  { label: 'Transcription models', ...freshnessOf(transcriptionCatalog) },
])

const CATALOG_FRESH_MINUTES = Math.round(GENSTUDIO_CATALOG_FRESH_MS / 60_000)
const CATALOG_CEILING_MINUTES = Math.round(GENSTUDIO_CATALOG_STALE_CEILING_MS / 60_000)

/** Any section past the hard ceiling — must not be treated as usable for new submissions. */
const anyExpired = computed(() => freshnessEntries.value.some(entry => entry.isExpired))
/** Any section past the fresh window but still under the ceiling — displayable, flagged. */
const anyStale = computed(() => freshnessEntries.value.some(entry => entry.isStale && !entry.isExpired))
const staleSections = computed(() => freshnessEntries.value.filter(entry => entry.isStale && !entry.isExpired).map(entry => entry.label))
const expiredSections = computed(() => freshnessEntries.value.filter(entry => entry.isExpired).map(entry => entry.label))

function formatCatalogAge(lastFetchedAt: number | null): string {
  if (lastFetchedAt === null) return 'never fetched'
  const minutes = Math.max(0, Math.round((Date.now() - lastFetchedAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`
}

function freshnessBadge(entry: { isStale: boolean; isExpired: boolean; lastFetchedAt: number | null }): { label: string; tone: 'warning' | 'error' } | null {
  if (entry.isExpired) return { label: `Too old to use · ${formatCatalogAge(entry.lastFetchedAt)}`, tone: 'error' }
  if (entry.isStale) return { label: `Stale · ${formatCatalogAge(entry.lastFetchedAt)}`, tone: 'warning' }
  return null
}

const connectionState = computed(() => {
  if (!configurationChecked.value) {
    return { label: 'Checking…', detail: 'Verifying the GenStudio connection', tone: 'muted' }
  }
  if (!accountConfigured.value) {
    return { label: 'Not configured', detail: 'Add a scoped API key above', tone: 'muted' }
  }
  if (combinedErrors.value.length) {
    return { label: 'Needs attention', detail: 'Connected, with live-data errors', tone: 'warning' }
  }
  return { label: 'Connected', detail: 'Live catalog data received', tone: 'success' }
})

function tierLabel(tier: GenStudioCostTier): string {
  return `${costTierLabel(tier)} cost tier`
}

const lastRefreshLabel = computed(() =>
  lastRefreshedAt.value
    ? lastRefreshedAt.value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Not checked',
)

function errorMessage(cause: any, fallback: string): string {
  return cause?.data?.detail || cause?.message || fallback
}

async function refresh(): Promise<void> {
  loading.value = true
  requestErrors.value = []
  try {
    const [keys] = await Promise.allSettled([
      get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys', { cache: 'no-store' }),
    ])
    // Every catalog fetch below goes through the shared cache's own
    // refresh() — it never throws (failures land in that cache's `error`,
    // already folded into `combinedErrors` above), so a plain `Promise.all`
    // is enough; nothing here needs its own try/catch.
    await Promise.all([
      chatModelsCache.refresh(true),
      transcriptionCatalog.refresh(true),
      musicModelsCache.refresh(true),
      refreshImages(true),
      refreshMedia(true),
    ])

    if (keys.status === 'fulfilled') {
      accountConfigured.value = (keys.value.providers || []).some(row => row.providerId === 'genstudio' && row.hasKey)
    } else {
      accountConfigured.value = false
      requestErrors.value.push(errorMessage(keys.reason, 'Could not verify the GenStudio API key.'))
    }
    configurationChecked.value = true
  } finally {
    lastRefreshedAt.value = new Date()
    loading.value = false
  }
}

onMounted(() => { void refresh() })
</script>

<style scoped>
.catalog-settings { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border); }
.catalog-header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
.catalog-header h3 { margin: 3px 0; }
.catalog-header p { margin: 0; color: var(--text-muted); font-size: var(--font-sm); }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.account-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.account-grid article, .catalog-grid article { min-width: 0; padding: 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); }
.account-grid span, .account-grid small, .catalog-grid span, .catalog-grid small { display: block; color: var(--text-muted); font-size: var(--font-xs); }
.account-grid strong { display: block; overflow: hidden; margin: 4px 0; font-size: var(--font-md); text-overflow: ellipsis; white-space: nowrap; }
.status-success { color: var(--success); }
.status-warning { color: var(--warning); }
.status-muted { color: var(--text-secondary); }
.error-list { margin: 0; padding-left: 18px; }
.error-list li + li { margin-top: 4px; }
.catalog-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
.catalog-grid strong { display: block; margin: 3px 0; font-size: 19px; }
.freshness-badge { display: inline-block; margin-top: 4px; padding: 2px 6px; border-radius: 6px; font-size: var(--font-xs); font-weight: 700; font-style: normal; letter-spacing: .02em; }
.freshness-badge.tone-warning { color: var(--warning); background: color-mix(in srgb, var(--warning) 16%, transparent); }
.freshness-badge.tone-error { color: var(--danger, #dc2626); background: color-mix(in srgb, var(--danger, #dc2626) 16%, transparent); }
.catalog-details { margin-top: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); }
.catalog-details > summary { display: flex; justify-content: space-between; gap: 12px; padding: 13px 14px; cursor: pointer; font-weight: 700; list-style-position: inside; }
.catalog-details > summary small { color: var(--text-muted); font-size: var(--font-xs); font-weight: 500; }
.catalog-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 0 14px 14px; }
.catalog-detail-grid section { min-width: 0; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.catalog-detail-grid section > header { display: flex; justify-content: space-between; padding: 10px 12px; background: var(--bg-secondary); }
.catalog-detail-grid section > p { margin: 0; padding: 12px; color: var(--text-muted); font-size: var(--font-sm); }
.catalog-detail-grid ul { max-height: 230px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.catalog-detail-grid li { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--border); }
.catalog-detail-grid li > span { min-width: 0; }
.catalog-detail-grid li strong, .catalog-detail-grid li small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-detail-grid li small { color: var(--text-muted); font-size: var(--font-xs); }
.catalog-detail-grid li small.catalog-lock-reason { color: var(--warning); white-space: normal; }
.catalog-detail-grid li em { flex: 0 0 auto; color: var(--text-muted); font-size: var(--font-xs); font-style: normal; }
.catalog-detail-grid li em.status-available { color: var(--success); }
.catalog-detail-grid li em.status-coming-soon { color: var(--warning); }
.catalog-detail-grid li em.status-locked { color: var(--warning); }
.catalog-footer { display: flex; justify-content: space-between; gap: 18px; align-items: center; margin-top: 14px; }
.catalog-footer p { max-width: 780px; margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.catalog-footer > div { display: flex; flex: 0 0 auto; gap: 8px; }
@media (max-width: 980px) {
  .account-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .catalog-header, .catalog-footer, .catalog-footer > div { align-items: stretch; flex-direction: column; }
  .catalog-header .btn, .catalog-footer .btn { width: 100%; }
  .account-grid, .catalog-detail-grid { grid-template-columns: 1fr; }
  .catalog-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
