<template>
  <div class="voice-picker" @click.stop>
    <!-- Trigger row: current selection + star + expand chevron -->
    <button type="button" class="vp-trigger" :class="{ open: expanded }" @click="toggle">
      <span class="vp-current" :title="currentVoice?.description || currentVoice?.name || defaultLabel">
        {{ currentVoice?.name || defaultLabel }}
      </span>
      <span v-if="currentVoice && isFavourite(currentVoice.voice_id)" class="vp-star-badge" title="Favourited" aria-hidden="true">★</span>
      <span v-if="currentVoice" class="vp-badge" :class="`cat-${currentVoice.category}`">
        {{ categoryLabel(currentVoice.category) }}
      </span>
      <span class="vp-chev" aria-hidden="true">▾</span>
    </button>

    <!-- Expanded panel -->
    <div v-if="expanded" class="vp-panel">
      <!-- Prominent loading banner: the ElevenLabs fetch can take 3–8 s on -->
      <!-- a cold open, especially with 100+ shared voices. Users were -->
      <!-- wondering why the panel was empty (test feedback). -->
      <div v-if="loading || refreshing" class="vp-loading-banner">
        <LoadingSpinner size="sm" />
        <span>{{ refreshing ? 'Refreshing voice catalog from ElevenLabs…' : 'Fetching voice catalog — may take a few seconds…' }}</span>
      </div>

      <!-- No-key banner: show when the catalog resolved as `snapshot` (i.e. -->
      <!-- no ElevenLabs key configured). Actionable link into Settings. -->
      <div v-if="!loading && !refreshing && source === 'snapshot' && hasElevenLabsKey === false" class="vp-nokey-banner">
        <div class="vp-nokey-title">Add your ElevenLabs API key to unlock 100+ voices</div>
        <div class="vp-nokey-body">
          You're seeing the offline snapshot ({{ catalog.length }} voices). Paste your key in
          <a :href="`/projects/${props.projectSlug}/settings#api-keys`" class="vp-nokey-link" @click.prevent="goToSettings">Settings → API Keys</a>
          (ElevenLabs → ElevenLabs). Then hit Refresh.
        </div>
      </div>

      <!-- Toolbar: search + refresh + source chip -->
      <div class="vp-toolbar">
        <input
          v-model="search"
          type="text"
          class="input input-sm vp-search"
          placeholder="Search voices by name, accent, use case…"
          autofocus
        />
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="refreshing"
          :title="refreshing ? 'Refreshing…' : 'Re-fetch the latest catalog from ElevenLabs'"
          @click="refreshCatalog"
        >
          <LoadingSpinner v-if="refreshing" size="sm" />
          <span v-else aria-hidden="true">⟳</span>
          Refresh
        </button>
      </div>
      <div class="vp-source-row">
        <span class="vp-source" :title="sourceTooltip">{{ sourceLabel }}</span>
        <span v-if="loadError" class="vp-error" :title="loadError">⚠ {{ loadError }}</span>
      </div>

      <!-- Filters -->
      <div class="vp-filters">
        <select v-model="filterGender" class="select select-sm">
          <option value="">Any gender</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="neutral">Neutral</option>
        </select>
        <select v-model="filterUseCase" class="select select-sm">
          <option value="">Any use case</option>
          <option v-for="u in useCaseOptions" :key="u" :value="u">{{ u }}</option>
        </select>
        <button
          v-if="search || filterGender || filterUseCase"
          type="button"
          class="btn btn-sm btn-ghost"
          @click="clearFilters"
        >
          Clear
        </button>
      </div>

      <div class="vp-list">
        <!-- Default / clear selection row -->
        <button
          type="button"
          class="vp-row default-row"
          :class="{ selected: modelValue === null }"
          @click="select(null)"
        >
          <span class="vp-row-name">{{ defaultLabel }}</span>
          <span class="vp-row-meta">Use whatever the model defaults to</span>
        </button>

        <!-- Favourites -->
        <div v-if="favouriteVoices.length" class="vp-section">
          <div class="vp-section-heading">★ Favourites ({{ favouriteVoices.length }})</div>
          <div v-for="v in favouriteVoices" :key="'fav-' + v.voice_id" class="vp-row" :class="{ selected: modelValue === v.voice_id, unavailable: !isAvailable(v.voice_id) }">
            <button type="button" class="vp-star favourited" @click.stop="toggleFavourite(v.voice_id)" :title="'Unfavourite ' + v.name">★</button>
            <button type="button" class="vp-select" @click="select(v.voice_id)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span v-if="v.gender && v.gender !== 'unknown'" class="vp-chip">{{ v.gender }}</span>
                <span v-if="v.accent" class="vp-chip">{{ v.accent }}</span>
                <span v-if="v.use_case" class="vp-chip">{{ v.use_case }}</span>
                <span v-if="!isAvailable(v.voice_id)" class="vp-chip warn">unavailable</span>
              </span>
            </button>
            <button type="button" class="vp-preview" :disabled="!v.voice_id" title="Preview voice" @click.stop="$emit('preview', v.voice_id)" aria-label="Preview">▶</button>
          </div>
        </div>

        <!-- My Custom Voices (project presets) -->
        <div v-if="filteredCustomVoices.length" class="vp-section">
          <div class="vp-section-heading">My Custom Voices ({{ filteredCustomVoices.length }})</div>
          <div v-for="v in filteredCustomVoices" :key="'custom-' + v.voice_id" class="vp-row" :class="{ selected: modelValue === v.voice_id }">
            <button type="button" class="vp-star" :class="{ favourited: isFavourite(v.voice_id) }" @click.stop="toggleFavourite(v.voice_id)" :title="isFavourite(v.voice_id) ? 'Unfavourite' : 'Favourite this voice'">
              {{ isFavourite(v.voice_id) ? '★' : '☆' }}
            </button>
            <button type="button" class="vp-select" @click="select(v.voice_id)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span class="vp-chip subtle">saved voice</span>
              </span>
            </button>
            <button type="button" class="vp-preview" title="Preview voice" @click.stop="$emit('preview', v.voice_id)" aria-label="Preview">▶</button>
          </div>
        </div>

        <!-- Catalog -->
        <div v-if="filteredCatalogVoices.length" class="vp-section">
          <div class="vp-section-heading">
            Catalog ({{ filteredCatalogVoices.length }}<span v-if="search || filterGender || filterUseCase"> filtered</span>)
          </div>
          <div
            v-for="v in visibleCatalogVoices"
            :key="'cat-' + v.voice_id"
            class="vp-row"
            :class="{ selected: modelValue === v.voice_id }"
          >
            <button
              type="button"
              class="vp-star"
              :class="{ favourited: isFavourite(v.voice_id) }"
              :title="isFavourite(v.voice_id) ? 'Unfavourite' : 'Favourite this voice'"
              @click.stop="toggleFavourite(v.voice_id)"
            >{{ isFavourite(v.voice_id) ? '★' : '☆' }}</button>
            <button type="button" class="vp-select" @click="select(v.voice_id)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span v-if="v.gender && v.gender !== 'unknown'" class="vp-chip">{{ v.gender }}</span>
                <span v-if="v.accent" class="vp-chip">{{ v.accent }}</span>
                <span v-if="v.use_case" class="vp-chip">{{ v.use_case }}</span>
                <span v-if="v.language && v.language !== 'en'" class="vp-chip subtle">{{ v.language }}</span>
              </span>
            </button>
            <button type="button" class="vp-preview" title="Preview voice" @click.stop="$emit('preview', v.voice_id)" aria-label="Preview">▶</button>
          </div>

          <!-- Lazy load the rest: we cap at 60 rows initially to keep DOM cheap. -->
          <button
            v-if="filteredCatalogVoices.length > visibleCatalogVoices.length"
            type="button"
            class="btn btn-sm btn-ghost vp-load-more"
            @click="showAllCatalog = true"
          >
            Show {{ filteredCatalogVoices.length - visibleCatalogVoices.length }} more
          </button>
        </div>

        <div
          v-if="!loading && !favouriteVoices.length && !filteredCustomVoices.length && !filteredCatalogVoices.length"
          class="vp-empty"
        >
          No voices match. Try clearing filters, or hit Refresh if the catalog is empty.
        </div>
        <div v-if="loading" class="vp-loading">
          <LoadingSpinner size="sm" /> Loading catalog…
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * VoicePicker — rich catalog browser with three stacked sections:
 *   1. Favourites (pinned per-project, server-persisted)
 *   2. My Custom Voices (project.voice_presets)
 *   3. Catalog (live ElevenLabs pull via /voices/catalog, cached 24h)
 *
 * Emits `update:modelValue` on select and `preview` on ▶-click so the
 * parent (audio.vue) can drive the TTS preview call with its current
 * model + slider state. The picker itself doesn't know about TTS.
 */

interface VoiceMeta {
  voice_id: string
  name: string
  category: 'premade' | 'cloned' | 'generated' | 'library' | 'professional' | 'unknown'
  gender: 'male' | 'female' | 'neutral' | 'unknown'
  language: string
  accent?: string
  age?: string
  use_case?: string
  description?: string
  preview_url?: string | null
  popularity?: number
}

interface VoicePreset { name: string; voice_id: string }

interface CatalogResponse {
  source: 'live' | 'cache' | 'snapshot'
  fetched_at: string | null
  voices: VoiceMeta[]
  has_elevenlabs_key?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  projectSlug: string
  customVoices?: VoicePreset[]
  defaultLabel?: string
}>(), {
  customVoices: () => [],
  defaultLabel: 'Default (let model pick)',
})

const emit = defineEmits<{
  'update:modelValue': [voiceId: string | null]
  preview: [voiceId: string]
}>()

const { get, post, put } = useApi()
const { success, error: showError } = useToast()

const expanded = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const loadError = ref('')

const catalog = ref<VoiceMeta[]>([])
const favouriteIds = ref<string[]>([])
const source = ref<'live' | 'cache' | 'snapshot' | null>(null)
const hasElevenLabsKey = ref<boolean | null>(null)
const fetchedAt = ref<string | null>(null)

const search = ref('')
const filterGender = ref('')
const filterUseCase = ref('')
const showAllCatalog = ref(false)

// Lookup helpers — derived from the current catalog. `voice_id → meta`
// makes favouriteVoices / customVoices resolution cheap.
const catalogById = computed(() => {
  const m = new Map<string, VoiceMeta>()
  for (const v of catalog.value) m.set(v.voice_id, v)
  return m
})

const currentVoice = computed<VoiceMeta | null>(() => {
  if (!props.modelValue) return null
  const fromCatalog = catalogById.value.get(props.modelValue)
  if (fromCatalog) return fromCatalog
  // Fall back to project preset if user selected a custom voice not in catalog.
  const preset = props.customVoices.find(p => p.voice_id === props.modelValue)
  if (preset) {
    return {
      voice_id: preset.voice_id,
      name: preset.name,
      category: 'cloned',
      gender: 'unknown',
      language: 'en',
    }
  }
  // Unknown voice — show the id so users notice it and can unfavourite.
  return {
    voice_id: props.modelValue,
    name: props.modelValue.slice(0, 12) + '…',
    category: 'unknown',
    gender: 'unknown',
    language: 'en',
  }
})

function isFavourite(voiceId: string): boolean {
  return favouriteIds.value.includes(voiceId)
}

function isAvailable(voiceId: string): boolean {
  // Available = present in the catalog. Custom voices are always
  // available (they're user-owned). Snapshots don't probe availability.
  if (source.value === 'snapshot') return true
  if (props.customVoices.some(p => p.voice_id === voiceId)) return true
  return catalogById.value.has(voiceId)
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'premade': return 'Premade'
    case 'cloned': return 'Custom'
    case 'generated': return 'Generated'
    case 'library': return 'Library'
    case 'professional': return 'Pro'
    default: return ''
  }
}

const useCaseOptions = computed(() => {
  const set = new Set<string>()
  for (const v of catalog.value) if (v.use_case) set.add(v.use_case)
  return Array.from(set).sort()
})

function matchesFilters(v: VoiceMeta): boolean {
  if (filterGender.value && v.gender !== filterGender.value) return false
  if (filterUseCase.value && v.use_case !== filterUseCase.value) return false
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase()
    const haystack = [v.name, v.accent, v.use_case, v.description, v.age].filter(Boolean).join(' ').toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

// Favourites first — preserve the server's pin order (not alphabetical).
const favouriteVoices = computed<VoiceMeta[]>(() => {
  const out: VoiceMeta[] = []
  for (const id of favouriteIds.value) {
    const fromCatalog = catalogById.value.get(id)
    if (fromCatalog && matchesFilters(fromCatalog)) { out.push(fromCatalog); continue }
    const preset = props.customVoices.find(p => p.voice_id === id)
    if (preset) {
      const synthetic: VoiceMeta = {
        voice_id: preset.voice_id, name: preset.name, category: 'cloned',
        gender: 'unknown', language: 'en',
      }
      if (matchesFilters(synthetic)) out.push(synthetic)
      continue
    }
    // Favourited voice that's no longer in the catalog — surface as
    // unavailable so the user can unfavourite it. Only show when the
    // search/filter doesn't hide it.
    const synthetic: VoiceMeta = {
      voice_id: id, name: id.slice(0, 12) + '… (not in catalog)',
      category: 'unknown', gender: 'unknown', language: 'en',
    }
    if (matchesFilters(synthetic)) out.push(synthetic)
  }
  return out
})

const filteredCustomVoices = computed<VoiceMeta[]>(() => {
  const favSet = new Set(favouriteIds.value)
  return props.customVoices
    .filter(p => !favSet.has(p.voice_id))
    .map(p => ({
      voice_id: p.voice_id, name: p.name, category: 'cloned' as const,
      gender: 'unknown' as const, language: 'en',
    }))
    .filter(matchesFilters)
})

const filteredCatalogVoices = computed<VoiceMeta[]>(() => {
  const favSet = new Set(favouriteIds.value)
  const customSet = new Set(props.customVoices.map(p => p.voice_id))
  return catalog.value.filter(v => !favSet.has(v.voice_id) && !customSet.has(v.voice_id) && matchesFilters(v))
})

const VISIBLE_CAP = 60
const visibleCatalogVoices = computed<VoiceMeta[]>(() =>
  showAllCatalog.value ? filteredCatalogVoices.value : filteredCatalogVoices.value.slice(0, VISIBLE_CAP),
)

function formatRelativeTime(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} days ago`
}

const sourceLabel = computed(() => {
  if (loading.value) return 'Loading…'
  if (!source.value) return ''
  if (source.value === 'live') return `Live catalog · ${formatRelativeTime(fetchedAt.value)}`
  if (source.value === 'cache') return `Cached · ${formatRelativeTime(fetchedAt.value)}`
  return `Offline snapshot (add your ElevenLabs key + refresh for the full catalog)`
})

const sourceTooltip = computed(() => {
  if (source.value === 'live') return 'Freshly fetched from ElevenLabs'
  if (source.value === 'cache') return 'Cached locally — click Refresh to pull the latest'
  if (source.value === 'snapshot') return 'Bundled fallback — no live catalog yet'
  return ''
})

// ── Data loading ────────────────────────────────────────────────────────
async function loadCatalog() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await get<CatalogResponse>(`/projects/${props.projectSlug}/voices/catalog`)
    catalog.value = data.voices || []
    source.value = data.source
    fetchedAt.value = data.fetched_at
    hasElevenLabsKey.value = data.has_elevenlabs_key ?? null
  } catch (e: any) {
    loadError.value = e?.data?.detail || e?.message || 'Failed to load catalog'
  } finally {
    loading.value = false
  }
}

async function loadFavourites() {
  try {
    const data = await get<{ voice_ids: string[] }>(`/projects/${props.projectSlug}/voices/favourites`)
    favouriteIds.value = Array.isArray(data.voice_ids) ? data.voice_ids : []
  } catch { /* tolerate — keep empty */ }
}

async function refreshCatalog() {
  refreshing.value = true
  loadError.value = ''
  try {
    const data = await post<CatalogResponse>(`/projects/${props.projectSlug}/voices/refresh`, {})
    catalog.value = data.voices || []
    source.value = data.source
    fetchedAt.value = data.fetched_at
    success(`Refreshed — ${catalog.value.length} voices`)
  } catch (e: any) {
    const msg = e?.data?.detail || e?.message || 'Refresh failed'
    loadError.value = msg
    showError(msg)
  } finally {
    refreshing.value = false
  }
}

async function saveFavourites(ids: string[]) {
  try {
    await put(`/projects/${props.projectSlug}/voices/favourites`, { voice_ids: ids })
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save favourites')
  }
}

// ── Actions ─────────────────────────────────────────────────────────────
function select(voiceId: string | null) {
  emit('update:modelValue', voiceId)
  expanded.value = false
}

async function toggleFavourite(voiceId: string) {
  const cur = [...favouriteIds.value]
  const idx = cur.indexOf(voiceId)
  if (idx >= 0) {
    cur.splice(idx, 1)
  } else {
    cur.unshift(voiceId)  // Pin to top of favourites list.
  }
  favouriteIds.value = cur
  await saveFavourites(cur)
}

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && !catalog.value.length && !loading.value) {
    void loadCatalog()
    void loadFavourites()
  }
}

function clearFilters() {
  search.value = ''
  filterGender.value = ''
  filterUseCase.value = ''
  showAllCatalog.value = false
}

function goToSettings() {
  // Navigate through Vue Router so we don't lose the app shell + state.
  const router = useRouter()
  void router.push(`/projects/${props.projectSlug}/settings#api-keys`)
  expanded.value = false
}

// Close on Escape; only when expanded.
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) {
    expanded.value = false
  }
}
onMounted(() => {
  void loadCatalog()
  void loadFavourites()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// Reset lazy-load cap when filters change so results stay ≤ VISIBLE_CAP.
watch([search, filterGender, filterUseCase], () => { showAllCatalog.value = false })
</script>

<style scoped>
.voice-picker { position: relative; width: 100%; }

/* Trigger */
.vp-trigger {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color 0.15s;
}
.vp-trigger:hover { border-color: var(--text-secondary); }
.vp-trigger.open { border-color: var(--accent); }
.vp-current { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vp-star-badge { color: var(--accent); font-size: 12px; }
.vp-badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.3px; }
.vp-badge.cat-premade  { background: rgba(96,165,250,0.15); color: rgb(59,130,246); }
.vp-badge.cat-cloned   { background: rgba(167,139,250,0.15); color: rgb(139,92,246); }
.vp-badge.cat-library  { background: rgba(74,222,128,0.15); color: rgb(22,163,74); }
.vp-badge.cat-professional { background: rgba(250,204,21,0.18); color: rgb(161,98,7); }
.vp-badge.cat-generated { background: rgba(251,146,60,0.15); color: rgb(234,88,12); }
.vp-badge.cat-unknown { background: var(--bg-tertiary); color: var(--text-muted); }
.vp-chev { font-size: 12px; color: var(--text-muted); }
.vp-trigger.open .vp-chev { transform: rotate(180deg); }

/* Panel */
.vp-panel {
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  max-height: 480px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.vp-toolbar { display: flex; gap: 8px; padding: 10px 10px 6px; align-items: center; }
.vp-search { flex: 1; }
.vp-source-row { padding: 0 12px 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.vp-loading-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--accent-dim);
  border-bottom: 1px solid var(--border);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
}

.vp-nokey-banner {
  margin: 10px 12px 0;
  padding: 10px 12px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: var(--radius-sm);
}
.vp-nokey-title { font-size: 12px; font-weight: 600; color: rgb(180, 83, 9); margin-bottom: 4px; }
.vp-nokey-body { font-size: 11px; color: var(--text-secondary); line-height: 1.4; }
.vp-nokey-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
.vp-nokey-link:hover { color: var(--accent); filter: brightness(1.1); }
.vp-source { font-size: 11px; color: var(--text-muted); }
.vp-error { font-size: 11px; color: var(--error, rgb(220,38,38)); }

.vp-filters { display: flex; gap: 6px; padding: 0 10px 8px; align-items: center; flex-wrap: wrap; }

.vp-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; display: flex; flex-direction: column; gap: 2px; }

.vp-section { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.vp-section-heading { font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--text-muted); padding: 4px 8px; font-weight: 600; }

.vp-row, .default-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 6px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid transparent;
  transition: background 0.1s, border-color 0.1s;
}
.vp-row:hover, .default-row:hover { background: var(--bg-tertiary); }
.vp-row.selected, .default-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-row.unavailable { opacity: 0.55; }

.default-row { cursor: pointer; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; width: 100%; padding: 8px 12px; border-radius: var(--radius-sm); background: transparent; border: 1px solid transparent; font: inherit; color: inherit; }
.default-row .vp-row-name { font-size: 13px; font-weight: 600; }
.default-row .vp-row-meta { font-size: 11px; color: var(--text-muted); }

.vp-star {
  background: none; border: none; cursor: pointer;
  font-size: 15px; line-height: 1;
  padding: 2px 4px; flex-shrink: 0;
  color: var(--text-muted);
}
.vp-star:hover { color: var(--accent); }
.vp-star.favourited { color: var(--accent); }

.vp-select {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  background: none; border: none; cursor: pointer;
  color: inherit; font: inherit; text-align: left;
  padding: 2px 4px;
}
.vp-row-name { font-size: 13px; color: var(--text-primary); font-weight: 500; }
.vp-row-meta { display: flex; flex-wrap: wrap; gap: 4px; font-size: 10px; color: var(--text-muted); }
.vp-chip { padding: 1px 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); text-transform: lowercase; }
.vp-chip.subtle { background: transparent; border: 1px solid var(--border); }
.vp-chip.warn { background: rgba(245,158,11,0.15); color: rgb(180,83,9); text-transform: none; }

.vp-preview {
  background: none; border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
  flex-shrink: 0;
}
.vp-preview:hover { background: var(--accent-dim); }
.vp-preview:disabled { opacity: 0.4; cursor: not-allowed; }

.vp-load-more { margin: 6px auto 2px; }
.vp-empty { padding: 24px 16px; text-align: center; font-size: 12px; color: var(--text-muted); }
.vp-loading { display: flex; gap: 8px; align-items: center; padding: 16px; font-size: 12px; color: var(--text-muted); }
</style>
