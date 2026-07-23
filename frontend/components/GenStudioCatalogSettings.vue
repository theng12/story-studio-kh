<template>
  <section class="catalog-settings">
    <header class="catalog-header">
      <div>
        <span class="eyebrow">Connected account</span>
        <h3>GenStudio Catalog &amp; Access</h3>
        <p>Read-only availability and account access shared by every Story Studio project on this Mac.</p>
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
        <span>Current plan</span>
        <strong>{{ access?.plan_name || 'Unavailable' }}</strong>
        <small>Owned by the connected GenStudio account</small>
      </article>
      <article>
        <span>Credits</span>
        <strong>{{ formattedCredits }}</strong>
        <small>Authoritative GenStudio balance</small>
      </article>
      <article>
        <span>Last refresh</span>
        <strong>{{ lastRefreshLabel }}</strong>
        <small>{{ loading ? 'Checking live account data…' : 'Catalogs are never saved to the project' }}</small>
      </article>
    </div>

    <WorkspaceNotice
      v-if="combinedErrors.length"
      tone="warning"
      title="Some GenStudio account data is unavailable"
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
                <small>{{ item.id }}</small>
              </span>
              <em :class="{ available: item.available }">{{ item.available ? 'Available' : 'Unavailable' }}</em>
            </li>
          </ul>
        </section>
      </div>
    </details>

    <footer class="catalog-footer">
      <p>{{ planNotice }}</p>
      <div>
        <NuxtLink class="btn btn-secondary btn-sm" to="/usage">Credits &amp; settlement</NuxtLink>
        <a
          v-if="access?.plan_portal_available && access.plan_portal_url"
          class="btn btn-secondary btn-sm"
          :href="access.plan_portal_url"
          target="_blank"
          rel="noopener"
        >
          Manage plan
        </a>
        <button
          v-else
          type="button"
          class="btn btn-secondary btn-sm"
          disabled
          title="The GenStudio plan website is not hosted yet."
        >
          Manage plan · coming soon
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
const { get } = useApi()
const {
  models: imageModels,
  error: imageError,
  refresh: refreshImages,
} = useGenStudioImageModels()
const {
  voiceModels,
  videoModels,
  error: mediaError,
  refresh: refreshMedia,
} = useGenStudioMediaModels()

interface CatalogEntry {
  id: string
  display_name?: string
  name?: string
  voice_name?: string
  available?: boolean
  generation_enabled?: boolean
}

interface CatalogDiagnostic {
  id: string
  name: string
  available: boolean
}

const chatModels = ref<CatalogEntry[]>([])
const transcriptionModels = ref<CatalogEntry[]>([])
const voices = ref<CatalogEntry[]>([])
const accountConfigured = ref(false)
const configurationChecked = ref(false)
const loading = ref(false)
const requestErrors = ref<string[]>([])
const lastRefreshedAt = ref<Date | null>(null)
const {
  access,
  error: accessError,
  planNotice,
  refresh: refreshAccess,
} = useGenStudioAccess()

function isAvailable(entry: CatalogEntry): boolean {
  return entry.available !== false && entry.generation_enabled !== false
}

const summaries = computed(() => [
  { label: 'LLM', total: chatModels.value.length, available: chatModels.value.filter(isAvailable).length },
  { label: 'Images', total: imageModels.value.length, available: imageModels.value.filter(isAvailable).length },
  { label: 'TTS models', total: voiceModels.value.length, available: voiceModels.value.filter(isAvailable).length },
  { label: 'Voices', total: voices.value.length, available: voices.value.filter(isAvailable).length },
  { label: 'Transcription', total: transcriptionModels.value.length, available: transcriptionModels.value.filter(isAvailable).length },
  { label: 'Video', total: videoModels.value.length, available: videoModels.value.filter(isAvailable).length },
])

function diagnosticRows(entries: readonly CatalogEntry[]): CatalogDiagnostic[] {
  return entries.map(entry => ({
    id: entry.id,
    name: entry.display_name || entry.voice_name || entry.name || entry.id,
    available: isAvailable(entry),
  }))
}

const catalogGroups = computed(() => [
  { label: 'Language models', items: diagnosticRows(chatModels.value) },
  { label: 'Image models', items: diagnosticRows(imageModels.value) },
  { label: 'TTS models', items: diagnosticRows(voiceModels.value) },
  { label: 'Voices', items: diagnosticRows(voices.value) },
  { label: 'Transcription models', items: diagnosticRows(transcriptionModels.value) },
  { label: 'Video models', items: diagnosticRows(videoModels.value) },
])

const combinedErrors = computed(() => Array.from(new Set([
  ...requestErrors.value,
  accessError.value,
  imageError.value,
  mediaError.value,
].filter(Boolean))))

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
  if (access.value) {
    return { label: 'Connected', detail: 'Live account data received', tone: 'success' }
  }
  return { label: 'Checking…', detail: 'Waiting for GenStudio', tone: 'muted' }
})

const formattedCredits = computed(() =>
  typeof access.value?.credit_balance === 'number'
    ? access.value.credit_balance.toLocaleString()
    : 'Unavailable',
)

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
    const [keys, chat, transcription, voiceResult] = await Promise.allSettled([
      get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys', { cache: 'no-store' }),
      get<{ models: CatalogEntry[] }>('/app-settings/genstudio/chat-models', { cache: 'no-store' }),
      get<{ models: CatalogEntry[] }>('/app-settings/genstudio/transcription-models', { cache: 'no-store' }),
      get<{ voices: CatalogEntry[] }>('/app-settings/genstudio/voices', { cache: 'no-store' }),
      refreshImages(true),
      refreshMedia(true),
      refreshAccess(true),
    ])

    if (keys.status === 'fulfilled') {
      accountConfigured.value = (keys.value.providers || []).some(row => row.providerId === 'genstudio' && row.hasKey)
    } else {
      accountConfigured.value = false
      requestErrors.value.push(errorMessage(keys.reason, 'Could not verify the GenStudio API key.'))
    }
    configurationChecked.value = true

    if (chat.status === 'fulfilled') chatModels.value = chat.value.models || []
    else {
      chatModels.value = []
      requestErrors.value.push(errorMessage(chat.reason, 'Language model catalog unavailable.'))
    }

    if (transcription.status === 'fulfilled') transcriptionModels.value = transcription.value.models || []
    else {
      transcriptionModels.value = []
      requestErrors.value.push(errorMessage(transcription.reason, 'Transcription model catalog unavailable.'))
    }

    if (voiceResult.status === 'fulfilled') voices.value = voiceResult.value.voices || []
    else {
      voices.value = []
      requestErrors.value.push(errorMessage(voiceResult.reason, 'Voice catalog unavailable.'))
    }
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
.catalog-detail-grid li em { flex: 0 0 auto; color: var(--text-muted); font-size: var(--font-xs); font-style: normal; }
.catalog-detail-grid li em.available { color: var(--success); }
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
