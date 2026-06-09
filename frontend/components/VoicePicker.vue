<template>
  <div class="voice-picker" ref="rootEl" @click.stop>
    <!-- Trigger row: current selection + star + expand chevron -->
    <button type="button" class="vp-trigger" :class="{ open: expanded, 'has-unavailable': currentVoice && !isAvailable(currentVoice.voice_id) }" @click="toggle">
      <span class="vp-current" :title="currentVoice?.description || currentVoice?.name || defaultLabel">
        {{ currentVoice?.name || defaultLabel }}
      </span>
      <span v-if="currentVoice && isFavourite(currentVoice.voice_id)" class="vp-star-badge" title="Favourited" aria-hidden="true">★</span>
      <span v-if="currentVoice && !isAvailable(currentVoice.voice_id)" class="vp-badge cat-unavailable" title="This voice isn't available for the selected model. Pick another voice.">unavailable</span>
      <span v-else-if="currentVoice" class="vp-badge" :class="`cat-${currentVoice.category}`">
        {{ categoryLabel(currentVoice.category) }}
      </span>
      <span class="vp-chev" aria-hidden="true">▾</span>
    </button>

    <!-- Expanded panel -->
    <div v-if="expanded" class="vp-panel">
      <!-- Scope banner — names the active model family + what voices apply,
           so the user understands at a glance why only certain voices show.
           Hidden when no model is selected (scope = 'all'). -->
      <div v-if="scope !== 'all'" class="vp-scope" :class="scopeFamily">
        <span class="vp-scope-icon" aria-hidden="true">{{ scopeFamily === 'voicestudio' ? '💻' : '☁︎' }}</span>
        <span class="vp-scope-text" v-html="scopeBanner" />
      </div>

      <!-- v1.0.312 — Loading / no-key banners removed for cloud scopes. The Audio
           picker no longer fetches the live ElevenLabs catalog (saved voices are
           the only source). The 'all' scope (Settings → Add from catalog dialog)
           still fetches and shows its loading state below. -->
      <div v-if="(loading || refreshing) && scope === 'all'" class="vp-loading-banner">
        <LoadingSpinner size="sm" />
        <span>{{ refreshing ? 'Refreshing voice catalog from ElevenLabs…' : 'Fetching voice catalog — may take a few seconds…' }}</span>
      </div>

      <!-- Toolbar: search + (refresh only meaningful for the Settings catalog dialog) -->
      <div class="vp-toolbar">
        <input
          v-model="search"
          type="text"
          class="input input-sm vp-search"
          placeholder="Search voices by name, accent, use case…"
          autofocus
        />
        <button
          v-if="scope === 'all'"
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
        <!-- v1.0.312 — cloud scopes get a direct "+ Add voice by ID" affordance
             and an ElevenLabs Voice Library link. Replaces the live-catalog
             Refresh button (the catalog fetch is gone). -->
        <button
          v-if="scopeFamily === 'cloud'"
          type="button"
          class="btn btn-sm btn-secondary"
          :title="addOpen ? 'Hide the Add panel' : 'Paste an ElevenLabs voice ID and save it to this project'"
          @click="addOpen = !addOpen"
        >
          <span aria-hidden="true">＋</span> Add voice
        </button>
        <a
          v-if="scopeFamily === 'cloud'"
          href="https://elevenlabs.io/app/voice-library"
          target="_blank"
          rel="noopener"
          class="btn btn-sm btn-ghost vp-eleven-link"
          title="Open ElevenLabs Voice Library in your browser. Copy a voice's ID and paste it into the Add panel."
        >ElevenLabs Voices ↗</a>
      </div>
      <div v-if="scope === 'all'" class="vp-source-row">
        <span class="vp-source" :title="sourceTooltip">{{ sourceLabel }}</span>
        <span v-if="loadError" class="vp-error" :title="loadError">⚠ {{ loadError }}</span>
      </div>

      <!-- v1.0.312 — Inline "Add voice by ID" panel (cloud scopes only). Saves
           to config.voice_presets so the new voice shows in the saved list
           below as soon as the parent's config refreshes. -->
      <div v-if="scopeFamily === 'cloud' && addOpen" class="vp-add-panel">
        <div class="vp-add-help">
          1. Open <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener">ElevenLabs Voices ↗</a>
             — pick any voice → copy its <strong>Voice ID</strong>.
          <br />2. Paste it below with a name you'll recognise (e.g. <em>Calm Narrator</em>) → Save.
        </div>
        <div class="vp-add-row">
          <input
            v-model="addName"
            type="text"
            class="input input-sm"
            placeholder="Name (e.g. Calm Narrator)"
            maxlength="80"
            @keydown.enter.prevent="saveNewVoice"
          />
          <input
            v-model="addVoiceId"
            type="text"
            class="input input-sm vp-add-id"
            placeholder="Voice ID (paste from ElevenLabs)"
            spellcheck="false"
            @keydown.enter.prevent="saveNewVoice"
          />
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="addSaving || !addName.trim() || !addVoiceId.trim()"
            @click="saveNewVoice"
          >
            <LoadingSpinner v-if="addSaving" size="sm" />
            {{ addSaving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <div class="vp-list">
        <!-- Default / clear selection row. Hidden when the parent requires an
             explicit pick (audio generator). Copy adapts to the model family. -->
        <button
          v-if="!requireSelection"
          type="button"
          class="vp-row default-row"
          :class="{ selected: modelValue === null }"
          @click="select(null)"
        >
          <span class="vp-row-name">{{ defaultRowLabel }}</span>
          <span class="vp-row-meta">{{ defaultRowMeta }}</span>
        </button>

        <!-- Favourites — filtered to voices compatible with the active model. -->
        <div v-if="favouriteVoices.length" class="vp-section">
          <div class="vp-section-heading">★ Favourites ({{ favouriteVoices.length }})</div>
          <div
            v-for="v in favouriteVoices"
            :key="'fav-' + v.voice_id"
            class="vp-row"
            :class="{ selected: modelValue === v.voice_id }"
          >
            <button type="button" class="vp-star favourited" @click.stop="toggleFavourite(v.voice_id)" :title="'Unfavourite ' + v.name">★</button>
            <button type="button" class="vp-select" @click="select(v.voice_id)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span v-if="v.gender && v.gender !== 'unknown'" class="vp-chip">{{ v.gender }}</span>
                <span v-if="v.accent" class="vp-chip">{{ v.accent }}</span>
                <span v-if="v.use_case" class="vp-chip">{{ v.use_case }}</span>
              </span>
            </button>
            <button type="button" class="vp-preview" :disabled="!v.voice_id" title="Preview voice" @click.stop="$emit('preview', v.voice_id)" aria-label="Preview">▶</button>
          </div>
        </div>

        <!-- Voice Studio (local) — voicepack speakers OR cloning library,
             depending on the selected engine. Shown only for voicestudio scope. -->
        <div
          v-if="scopeFamily === 'voicestudio' && (filteredVoicestudioVoices.length || voicestudioLoading || voicestudioError)"
          class="vp-section vp-section-local"
        >
          <div class="vp-section-heading vp-vs-heading">
            <span>
              {{ voicestudioSectionTitle }}
              <span v-if="filteredVoicestudioVoices.length">({{ filteredVoicestudioVoices.length }})</span>
            </span>
            <span class="vp-vs-actions">
              <button
                type="button"
                class="vp-vs-refresh"
                :disabled="voicestudioLoading"
                title="Re-fetch the live voice list from your Voice Studio modal"
                @click.stop="loadVoicestudioVoices"
              >{{ voicestudioLoading ? '…' : '⟳' }}</button>
              <a
                class="vp-vs-manage"
                href="#"
                title="Open the Voice Studio modal's web UI"
                @click.stop.prevent="openVoiceStudioWeb"
              >open modal UI ↗</a>
            </span>
          </div>
          <div v-if="voicestudioError" class="vp-vs-error">
            ⚠ {{ voicestudioError }} — set the URL in
            <a href="#" class="vp-nokey-link" @click.prevent="goToLocalModelsSettings">Settings → This Mac → Local Models</a>
            and try Refresh.
          </div>
          <div v-else-if="voicestudioLoading" class="vp-loading">
            <LoadingSpinner size="sm" /> Loading {{ isMacosScope ? 'macOS voices' : scope === 'voicestudio-voicepack' ? voicepackEngineLabel + ' speakers' : 'your cloned voices' }}…
          </div>
          <div v-else-if="!filteredVoicestudioVoices.length" class="vp-vs-empty">
            <template v-if="isMacosScope">
              No macOS voices found. Download Enhanced/Premium voices in
              System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, then
              <a href="#" class="vp-nokey-link" @click.prevent="loadVoicestudioVoices">Refresh ↻</a>.
            </template>
            <template v-else-if="scope === 'voicestudio-voicepack'">
              No {{ voicepackEngineLabel }} speakers reported by the modal.
              <a href="#" class="vp-nokey-link" @click.prevent="loadVoicestudioVoices">Retry ↻</a>
            </template>
            <template v-else>
              No voices uploaded to Voice Studio yet — generation will use the engine's zero-shot default.
              <a href="#" class="vp-nokey-link" @click.prevent="openVoiceStudioWeb">Add a clone in the modal UI ↗</a>
            </template>
          </div>
          <div
            v-for="v in filteredVoicestudioVoices"
            :key="'vs-' + v.id"
            class="vp-row"
            :class="{ selected: isSelectedVoicestudio(v) }"
          >
            <button type="button" class="vp-star" :class="{ favourited: isFavourite(v.id) }" @click.stop="toggleFavourite(v.id)" :title="isFavourite(v.id) ? 'Unfavourite' : 'Favourite this voice'">
              {{ isFavourite(v.id) ? '★' : '☆' }}
            </button>
            <button type="button" class="vp-select" @click="selectVoicestudio(v)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span class="vp-chip vp-vs-chip">{{ isMacosScope ? 'macOS' : scope === 'voicestudio-voicepack' ? 'built-in' : 'local clone' }}</span>
                <span v-if="v.gender && v.gender !== 'unknown'" class="vp-chip">{{ v.gender }}</span>
                <span v-if="v.language && v.language !== 'en'" class="vp-chip subtle">{{ v.language }}</span>
                <span v-if="typeof v.duration_seconds === 'number'" class="vp-chip subtle">{{ Math.round(v.duration_seconds) }}s ref</span>
                <!-- v1.0.293 — pool availability badge for clone voices.
                     Shows ✓ on every Mac, or ⚠ when only on a subset (will
                     run serially on those Macs only). Voicepack voices
                     (kokoro/qwen3/bark) skip this — they're built into the
                     model so identical across every Mac by definition. -->
                <span
                  v-if="v.voice_kind === 'voicestudio-pooled' && typeof v.endpoint_count === 'number' && v.endpoint_count > 0"
                  class="vp-chip"
                  :class="v.available_everywhere ? 'vp-chip-pool-ok' : 'vp-chip-pool-partial'"
                  :title="v.available_everywhere
                    ? `Available on all ${v.endpoint_count} Voice Studio endpoint(s) — will dispatch in parallel.`
                    : `Available on ${(v.available_on || []).length} of ${v.endpoint_count} endpoint(s). Audio will route only to: ${(v.available_on || []).join(', ')}. Save this voice in Voice Studio on the other Mac(s) for full parallel speed.`"
                >
                  {{ v.available_everywhere
                    ? `✓ on all ${v.endpoint_count}`
                    : `⚠ ${(v.available_on || []).length} / ${v.endpoint_count} — serial` }}
                </span>
              </span>
            </button>
            <button
              type="button"
              class="vp-preview"
              title="Preview voice"
              @click.stop="$emit('preview', encodeVoiceForStorage(v) || v.id)"
              aria-label="Preview"
            >▶</button>
          </div>
        </div>

        <!-- Saved voices — your ElevenLabs voice ids (project voice_presets).
             v1.0.312 — surfaced for BOTH cloud scopes (direct AND GenAIPro/fal
             proxies). The user confirmed saved voice IDs work the same through
             the proxies as direct, so hiding them was a real bug. -->
        <div v-if="scopeFamily === 'cloud' && filteredCustomVoices.length" class="vp-section vp-section-saved">
          <div class="vp-section-heading">☁︎ Saved voices ({{ filteredCustomVoices.length }})</div>
          <div
            v-for="v in filteredCustomVoices"
            :key="'custom-' + v.voice_id"
            class="vp-row"
            :class="{ selected: modelValue === v.voice_id, unavailable: !isAvailable(v.voice_id) }"
          >
            <button type="button" class="vp-star" :class="{ favourited: isFavourite(v.voice_id) }" @click.stop="toggleFavourite(v.voice_id)" :title="isFavourite(v.voice_id) ? 'Unfavourite' : 'Favourite this voice'">
              {{ isFavourite(v.voice_id) ? '★' : '☆' }}
            </button>
            <button type="button" class="vp-select" @click="select(v.voice_id)">
              <span class="vp-row-name">{{ v.name }}</span>
              <span class="vp-row-meta">
                <span class="vp-chip subtle">saved voice</span>
                <!-- v1.0.312 — "unavailable" badge removed: it relied on the
                     live ElevenLabs catalog (now gone). Generation surfaces a
                     clear provider error if the id is bad. -->
              </span>
            </button>
            <button type="button" class="vp-preview" title="Preview voice" @click.stop="$emit('preview', v.voice_id)" aria-label="Preview">▶</button>
          </div>
        </div>

        <!-- ElevenLabs catalog — v1.0.312: shown only for scope 'all' (the
             Settings → Voices "Add from catalog" dialog). The Audio picker's
             cloud scopes don't fetch the live catalog anymore — saved voices +
             the "+ Add voice" panel above replace it there. -->
        <div v-if="scope === 'all' && filteredCatalogVoices.length" class="vp-section vp-section-eleven">
          <div class="vp-section-heading">
            ☁︎ ElevenLabs voices
            ({{ filteredCatalogVoices.length }}<span v-if="search"> filtered</span>)
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

          <!-- Lazy load the rest: cap at 60 rows initially to keep DOM cheap. -->
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
          v-if="!loading && !voicestudioLoading && !favouriteVoices.length && !filteredCustomVoices.length && !filteredCatalogVoices.length && !filteredVoicestudioVoices.length && !voicestudioError"
          class="vp-empty"
        >
          <template v-if="scopeFamily === 'cloud'">
            No saved voices yet. Click <strong>+ Add voice</strong> above to paste an ElevenLabs voice ID.
          </template>
          <template v-else-if="scope === 'all'">
            No voices to show. Try a different search, or hit Refresh.
          </template>
          <template v-else>
            No voices to show for this model. Try a different search.
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * VoicePicker — model-aware voice browser (v1.0.207+).
 *
 * The picker shows ONLY the voices that work with the currently-selected
 * audio model, in three visually-distinct families:
 *
 *   • ElevenLabs (direct)   → "Saved voices" (your account's voice_presets)
 *                              + the full "ElevenLabs voices" catalog.
 *   • fal.ai / GenAIPro     → "ElevenLabs premade voices" ONLY. The proxies
 *                              call ElevenLabs with THEIR account, so your
 *                              private saved/cloned voice ids don't exist
 *                              there — they're hidden, not just dimmed.
 *   • Voice Studio (local)  → either the engine's built-in voicepack
 *                              (Kokoro / Bark / Qwen3 speakers) OR your
 *                              uploaded clones (VoxCPM / Chatterbox),
 *                              depending on the engine. Local ids live in
 *                              their own space (no ElevenLabs lookup).
 *
 * Incompatible families are hidden entirely (per product decision) so the
 * three never mix. When the model changes such that the current selection
 * no longer works, the picker clears it and toasts — never silently.
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

interface VoiceStudioVoice {
  id: string
  name: string
  language?: string
  gender?: string
  duration_seconds?: number
  has_transcript?: boolean
  created_at?: number
  /**
   * v1.0.293 — clone-engine voices (VoxCPM2 / Chatterbox) live in a
   * per-Mac library with different UUIDs on each machine. The backend
   * pool resolver aggregates them by name and reports which endpoints
   * each voice exists on so the picker can show availability badges.
   * The `id` field on a `voicestudio-pooled` voice is the NAME (not a
   * UUID) — selecting it stores `vsname:<name>` in form.voice so the
   * audio dispatcher knows to resolve per-endpoint UUIDs at call time.
   */
  available_on?: string[]
  available_everywhere?: boolean
  endpoint_count?: number
  voice_kind?: 'voicestudio-pooled'
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  projectSlug: string
  customVoices?: VoicePreset[]
  defaultLabel?: string
  /** Provider id of the selected audio model: 'elevenlabs' | 'fal' | 'genaipro' | 'voicestudio' | ''. */
  audioModelProvider?: string
  /** Selected audio model id (e.g. 'voicestudio-kokoro'). Distinguishes voicepack vs cloning engines. */
  audioModelId?: string
  /**
   * When true, hide the "Default (let model pick)" row so the user MUST pick
   * an explicit voice. The audio generator sets this — a silent default was
   * how a wrong/unset voice slipped through to generation. The Settings
   * catalogue picker leaves it false (null = "clear" is fine there).
   */
  requireSelection?: boolean
}>(), {
  customVoices: () => [],
  defaultLabel: 'Default (let model pick)',
  audioModelProvider: '',
  audioModelId: '',
  requireSelection: false,
})

const emit = defineEmits<{
  'update:modelValue': [voiceId: string | null]
  preview: [voiceId: string]
  /** v1.0.312 — fires after the inline "Add voice by ID" form saves a new
   *  voice into config.voice_presets, so the parent (audio.vue) can refresh
   *  its `config` and immediately show the new voice in the picker. */
  'voice-saved': [voice: { name: string; voice_id: string }]
}>()

const { get, post, put } = useApi()
const { success, error: showError, info: showInfo } = useToast()

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
const showAllCatalog = ref(false)

const voicestudioVoices = ref<VoiceStudioVoice[]>([])
const voicestudioLoading = ref(false)
const voicestudioError = ref('')
const voicestudioBaseUrl = ref<string>('')

// v1.0.312 — inline "Add voice by ID" state for cloud scopes. Lets the user
// paste a voice id from ElevenLabs without leaving the page. Saves into
// config.voice_presets via the same /settings/config endpoint Settings uses,
// then emits voice-saved so the parent refreshes config and the new voice
// shows up in the saved list immediately.
const addOpen = ref(false)
const addName = ref('')
const addVoiceId = ref('')
const addSaving = ref(false)

// ── Scope: the single source of truth for which families are shown ──────────
// Derived deterministically from the model id/provider (no async dependency)
// so sections render correctly the instant the model changes.
type Scope = 'elevenlabs-direct' | 'elevenlabs-proxy' | 'voicestudio-voicepack' | 'voicestudio-cloning' | 'macos-builtin' | 'all'

// Voice Studio engines that ship a built-in voicepack (vs. ones that clone
// from your uploaded reference clips). Mirrors VOICESTUDIO_ENGINES on the
// backend (voiceField !== 'voice_library_id').
const VOICEPACK_MODEL_IDS = new Set(['voicestudio-kokoro', 'voicestudio-qwen3-tts', 'voicestudio-bark'])

const scope = computed<Scope>(() => {
  const p = props.audioModelProvider
  if (p === 'voicestudio') {
    return VOICEPACK_MODEL_IDS.has(props.audioModelId) ? 'voicestudio-voicepack' : 'voicestudio-cloning'
  }
  if (p === 'macos') return 'macos-builtin'
  if (p === 'elevenlabs') return 'elevenlabs-direct'
  if (p === 'fal' || p === 'genaipro') return 'elevenlabs-proxy'
  return 'all'
})

/** Coarse family for styling/branching: 'cloud' | 'voicestudio' | 'all'.
 *  macOS reuses the 'voicestudio' (local) family — same section UI, just a
 *  different fetch source + labels (branched on scope.value below). */
const scopeFamily = computed<'cloud' | 'voicestudio' | 'all'>(() => {
  if (scope.value === 'voicestudio-voicepack' || scope.value === 'voicestudio-cloning' || scope.value === 'macos-builtin') return 'voicestudio'
  if (scope.value === 'elevenlabs-direct' || scope.value === 'elevenlabs-proxy') return 'cloud'
  return 'all'
})
const isMacosScope = computed(() => scope.value === 'macos-builtin')

const cloudProviderLabel = computed(() => {
  switch (props.audioModelProvider) {
    case 'elevenlabs': return 'ElevenLabs (direct)'
    case 'genaipro': return 'GenAIPro'
    case 'fal': return 'fal.ai'
    default: return 'a cloud TTS provider'
  }
})

const voicepackEngineLabel = computed(() => {
  const fam = (props.audioModelId || '').replace(/^voicestudio-/, '').replace(/-mlx$/, '')
  if (!fam) return 'Voicepack'
  return fam.charAt(0).toUpperCase() + fam.slice(1)
})

const voicestudioSectionTitle = computed(() =>
  isMacosScope.value
    ? '💻 macOS built-in voices'
    : scope.value === 'voicestudio-voicepack'
      ? `🎙 ${voicepackEngineLabel.value} voices`
      : '💻 Your cloned voices',
)

const scopeBanner = computed(() => {
  switch (scope.value) {
    case 'elevenlabs-direct':
      return 'Model: <strong>ElevenLabs (direct)</strong> — your <strong>saved voices</strong> below. Add more by ID from <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener">ElevenLabs Voices ↗</a>.'
    case 'elevenlabs-proxy':
      return `Model: <strong>${cloudProviderLabel.value}</strong> — paste any ElevenLabs voice ID below. Find IDs at <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener">ElevenLabs Voices ↗</a>.`
    case 'voicestudio-voicepack':
      return `Model: <strong>${voicepackEngineLabel.value} (local)</strong> — pick from its <strong>built-in voicepack</strong> below.`
    case 'voicestudio-cloning':
      return `Model: <strong>${voicepackEngineLabel.value} (local)</strong> — pick one of <strong>your cloned voices</strong>, or use the zero-shot default.`
    case 'macos-builtin':
      return 'Model: <strong>macOS say (local · free)</strong> — pick a <strong>built-in voice</strong> below. Download Enhanced/Premium voices in System Settings → Accessibility → Spoken Content to add more.'
    default:
      return ''
  }
})

const defaultRowLabel = computed(() => props.defaultLabel)
const defaultRowMeta = computed(() => {
  if (scope.value === 'voicestudio-cloning') return 'Zero-shot — the engine\'s built-in default voice (no clone)'
  if (scope.value === 'voicestudio-voicepack') return 'Use the engine\'s default speaker'
  return 'Use whatever the model defaults to'
})

// ── Lookups ────────────────────────────────────────────────────────────────
const catalogById = computed(() => {
  const m = new Map<string, VoiceMeta>()
  for (const v of catalog.value) m.set(v.voice_id, v)
  return m
})

/** Non-destructive compatibility check used to filter favourites + the trigger. */
function compatibleForScope(id: string): boolean {
  switch (scope.value) {
    case 'all':
      return true
    case 'voicestudio-voicepack':
    case 'voicestudio-cloning':
      return voicestudioVoices.value.some(v => v.id === id)
    case 'elevenlabs-direct':
    case 'elevenlabs-proxy':
      // v1.0.312 — the Audio picker no longer pulls the live ElevenLabs
      // catalog. Saved voices are the source of truth, and an ElevenLabs voice
      // id works the same through the GenAIPro/fal proxies as it does direct
      // (the user confirmed this), so both cloud scopes treat a saved id as
      // compatible. Free-typed ids we can't judge are left alone elsewhere.
      return props.customVoices.some(p => p.voice_id === id)
  }
}

const currentVoice = computed<VoiceMeta | null>(() => {
  if (!props.modelValue) return null
  const fromCatalog = catalogById.value.get(props.modelValue)
  if (fromCatalog) return fromCatalog
  const preset = props.customVoices.find(p => p.voice_id === props.modelValue)
  if (preset) {
    return { voice_id: preset.voice_id, name: preset.name, category: 'cloned', gender: 'unknown', language: 'en' }
  }
  const vs = voicestudioVoices.value.find(v => v.id === props.modelValue)
  if (vs) {
    return { voice_id: vs.id, name: vs.name, category: 'library', gender: (vs.gender as any) || 'unknown', language: vs.language || 'en' }
  }
  return { voice_id: props.modelValue, name: props.modelValue.slice(0, 12) + '…', category: 'unknown', gender: 'unknown', language: 'en' }
})

function isFavourite(voiceId: string): boolean {
  return favouriteIds.value.includes(voiceId)
}

/**
 * Whether a voice is usable with the selected model. Voice Studio ids live in
 * their own space (governed by the local modal, not the ElevenLabs catalog),
 * so we never judge them against the cloud catalogue — that was the v1.0.206
 * "UNAVAILABLE" bug on Kokoro/Chatterbox voices.
 */
function isAvailable(voiceId: string): boolean {
  if (loading.value || refreshing.value || voicestudioLoading.value) return true
  // Local-model scope: availability is the modal's call, not ElevenLabs'.
  if (scopeFamily.value === 'voicestudio') return true
  if (voicestudioVoices.value.some(v => v.id === voiceId)) return true
  if (source.value === 'snapshot' || source.value === null) return true
  return catalogById.value.has(voiceId)
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case 'premade': return 'Premade'
    case 'cloned': return 'Custom'
    case 'generated': return 'Generated'
    case 'library': return 'Local'
    case 'professional': return 'Pro'
    default: return ''
  }
}

function matchesFilters(v: VoiceMeta): boolean {
  if (search.value.trim()) {
    const q = search.value.trim().toLowerCase()
    const haystack = [v.name, v.accent, v.use_case, v.description, v.age].filter(Boolean).join(' ').toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

// Favourites first, filtered to the active scope so incompatible pins hide.
const favouriteVoices = computed<VoiceMeta[]>(() => {
  const out: VoiceMeta[] = []
  for (const id of favouriteIds.value) {
    if (!compatibleForScope(id)) continue
    const fromCatalog = catalogById.value.get(id)
    if (fromCatalog) { if (matchesFilters(fromCatalog)) out.push(fromCatalog); continue }
    const preset = props.customVoices.find(p => p.voice_id === id)
    if (preset) {
      const synthetic: VoiceMeta = { voice_id: preset.voice_id, name: preset.name, category: 'cloned', gender: 'unknown', language: 'en' }
      if (matchesFilters(synthetic)) out.push(synthetic)
      continue
    }
    const vs = voicestudioVoices.value.find(v => v.id === id)
    if (vs) {
      const synthetic: VoiceMeta = { voice_id: vs.id, name: vs.name, category: 'library', gender: (vs.gender as any) || 'unknown', language: vs.language || 'en' }
      if (matchesFilters(synthetic)) out.push(synthetic)
    }
  }
  return out
})

const filteredCustomVoices = computed<VoiceMeta[]>(() => {
  // v1.0.312 — saved voices now show for BOTH ElevenLabs scopes (direct AND the
  // GenAIPro/fal proxies), not just direct. They're the only cloud voice source
  // in the Audio picker now that the live catalog is gone.
  if (scopeFamily.value !== 'cloud') return []
  const favSet = new Set(favouriteIds.value)
  return props.customVoices
    .filter(p => !favSet.has(p.voice_id))
    .map(p => ({ voice_id: p.voice_id, name: p.name, category: 'cloned' as const, gender: 'unknown' as const, language: 'en' }))
    .filter(matchesFilters)
})

const filteredCatalogVoices = computed<VoiceMeta[]>(() => {
  if (scopeFamily.value !== 'cloud') return []
  const favSet = new Set(favouriteIds.value)
  const customSet = new Set(props.customVoices.map(p => p.voice_id))
  const proxyOnly = scope.value === 'elevenlabs-proxy'
  return catalog.value.filter(v => {
    if (favSet.has(v.voice_id)) return false
    // Saved presets surface in their own section under direct; never duplicate.
    if (scope.value === 'elevenlabs-direct' && customSet.has(v.voice_id)) return false
    if (proxyOnly && v.category !== 'premade') return false
    return matchesFilters(v)
  })
})

const filteredVoicestudioVoices = computed<VoiceStudioVoice[]>(() => {
  if (scopeFamily.value !== 'voicestudio') return []
  return voicestudioVoices.value.filter(v => {
    if (search.value.trim()) {
      const q = search.value.trim().toLowerCase()
      const haystack = [v.name, v.language, v.gender].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })
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
function hasValidSlug(): boolean {
  const s = props.projectSlug
  return !!s && s !== 'undefined'
}

async function loadCatalog() {
  if (!hasValidSlug()) return
  // v1.0.312 — the Audio picker (cloud scopes) no longer fetches the live
  // ElevenLabs catalog. It cost the user paid-tier API calls + several seconds
  // of stall every open, just to surface voices they never used anyway — the
  // saved voices in Settings are the actual workflow. The fetch is still made
  // for scope 'all' (the Settings → Voices "Add from catalog" dialog reuses
  // this component) so that escape hatch keeps working for people who want it.
  if (scopeFamily.value === 'cloud') {
    catalog.value = []
    source.value = null
    return
  }
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
    reconcileSelection()
  }
}

async function loadFavourites() {
  if (!hasValidSlug()) return
  try {
    const data = await get<{ voice_ids: string[] }>(`/projects/${props.projectSlug}/voices/favourites`)
    favouriteIds.value = Array.isArray(data.voice_ids) ? data.voice_ids : []
  } catch { /* tolerate — keep empty */ }
}

/**
 * Load the Voice Studio voices for the selected engine: built-in speakers for
 * voicepack engines (Kokoro …), the user's clone library for cloning engines
 * (VoxCPM …). Skipped (and cleared) when the model is a cloud one — those use
 * the ElevenLabs id space, so a stale local list would just confuse things.
 */
async function loadVoicestudioVoices() {
  if (scopeFamily.value === 'cloud') {
    voicestudioVoices.value = []
    voicestudioError.value = ''
    return
  }
  voicestudioLoading.value = true
  voicestudioError.value = ''
  try {
    if (isMacosScope.value) {
      // macOS built-in `say` voices — local, no base URL. Same response shape
      // ({ voices: [{id,name,language}] }); stored plainly (no vsname prefix).
      const data = await get<{ voices: VoiceStudioVoice[]; available?: boolean }>(`/macos/voices`)
      voicestudioVoices.value = Array.isArray(data.voices) ? data.voices : []
      voicestudioBaseUrl.value = ''
      if (data.available === false) {
        voicestudioError.value = 'macOS voices are only available when running on macOS.'
      }
      return
    }
    const qs = props.audioModelId ? `?model=${encodeURIComponent(props.audioModelId)}` : ''
    const data = await get<{ voices: VoiceStudioVoice[]; baseUrl: string; source?: 'library' | 'voicepack' }>(`/voicestudio/voices${qs}`)
    voicestudioVoices.value = Array.isArray(data.voices) ? data.voices : []
    voicestudioBaseUrl.value = data.baseUrl || ''
  } catch (e: any) {
    voicestudioError.value = e?.data?.detail || e?.message
      || (isMacosScope.value ? 'Could not list macOS voices' : 'Voice Studio modal unreachable')
    voicestudioVoices.value = []
  } finally {
    voicestudioLoading.value = false
    reconcileSelection()
  }
}

async function refreshCatalog() {
  if (!hasValidSlug()) return
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

/**
 * v1.0.312 — Save a typed-in voice id into the project's voice_presets, then
 * emit so the parent refreshes its config and the new voice appears in the
 * saved list. Uses the same /settings/config endpoint Settings → Voices uses,
 * so the storage format stays identical (single source of truth).
 */
async function saveNewVoice() {
  if (addSaving.value) return
  const name = addName.value.trim()
  const voiceId = addVoiceId.value.trim()
  if (!name) { showError('Give the voice a name.'); return }
  if (!voiceId) { showError('Paste the voice ID from ElevenLabs.'); return }
  if (props.customVoices.some(p => p.voice_id === voiceId)) {
    showError('That voice ID is already saved.')
    return
  }
  addSaving.value = true
  try {
    // Append to the existing presets — don't read the project from elsewhere;
    // props.customVoices is the parent's authoritative view.
    const next = [...props.customVoices, { name, voice_id: voiceId }]
    await put(`/projects/${props.projectSlug}/settings/config`, { voice_presets: next })
    success(`Saved "${name}". You can pick it now.`)
    emit('voice-saved', { name, voice_id: voiceId })
    // Select the just-added voice so the user can hit Generate next.
    select(voiceId)
    addName.value = ''
    addVoiceId.value = ''
    addOpen.value = false
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save voice')
  } finally {
    addSaving.value = false
  }
}

/**
 * Keep-if-compatible-else-clear. Runs after the relevant voice list for the
 * current scope is loaded, so we only clear a selection we're confident is
 * incompatible — never on a slow fetch and never when the local modal is
 * offline (we can't prove incompatibility then, so we keep the selection).
 */
function reconcileSelection() {
  const id = props.modelValue
  if (!id) return
  const sc = scope.value
  if (sc === 'all') return

  if (scopeFamily.value === 'voicestudio') {
    if (voicestudioLoading.value) return                 // still loading — wait
    if (voicestudioError.value) return                   // modal offline — keep selection
    if (!voicestudioVoices.value.length) return          // can't confirm — keep
    if (voicestudioVoices.value.some(v => v.id === id)) return  // compatible
    return clearIncompatible()                            // cloud id on a local model
  }

  // v1.0.312 — Cloud scopes: with the live catalog removed, we can only judge
  // against saved voices. A saved id is compatible on both direct and proxy
  // (the user confirmed saved voices work everywhere). An unknown id is left
  // alone — could be a free-typed/legacy id we have no way to refute now.
  if (props.customVoices.some(p => p.voice_id === id)) return
  // Unknown id — don't clear it. Worst case the generation fails with a
  // clear provider error, which is better than a surprise clear.
  return
}

function clearIncompatible() {
  emit('update:modelValue', null)
  showInfo("Voice cleared — it isn't available for this model. Pick one below.")
}

// ── Actions ─────────────────────────────────────────────────────────────
// v1.0.293 — Voice Studio cloning voices live in per-Mac libraries with
// different UUIDs on each machine. The pool resolver aggregates them by
// name, and we store `vsname:<name>` in form.voice so the audio dispatcher
// can resolve to the right per-endpoint UUID at TTS call time. Voicepack
// voices (Kokoro/Qwen3/Bark) are model-built-in presets — same id on every
// machine — so they pass through unchanged.
const VSNAME_PREFIX = 'vsname:'
function encodeVoiceForStorage(v: VoiceStudioVoice | { id: string } | null): string | null {
  if (!v) return null
  if ((v as VoiceStudioVoice).voice_kind === 'voicestudio-pooled') {
    // Pooled clone voice — store the NAME with prefix
    return `${VSNAME_PREFIX}${(v as VoiceStudioVoice).name}`
  }
  return v.id
}

function select(voiceId: string | null) {
  emit('update:modelValue', voiceId)
  expanded.value = false
}

function selectVoicestudio(v: VoiceStudioVoice) {
  emit('update:modelValue', encodeVoiceForStorage(v))
  expanded.value = false
}

/**
 * Selected-state matcher for the picker rows. The stored `modelValue` is
 * either a raw id (legacy UUID, preset id, voicepack id) OR `vsname:<name>`
 * for the new pooled voices. This helper resolves both formats so the
 * "currently selected" row highlights correctly.
 */
function isSelectedVoicestudio(v: VoiceStudioVoice): boolean {
  if (!props.modelValue) return false
  if (v.voice_kind === 'voicestudio-pooled') {
    return props.modelValue === `${VSNAME_PREFIX}${v.name}`
  }
  return props.modelValue === v.id
}

async function toggleFavourite(voiceId: string) {
  const cur = [...favouriteIds.value]
  const idx = cur.indexOf(voiceId)
  if (idx >= 0) cur.splice(idx, 1)
  else cur.unshift(voiceId)
  favouriteIds.value = cur
  await saveFavourites(cur)
}

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && !catalog.value.length && !loading.value) {
    void loadCatalog()
    void loadFavourites()
  }
  if (expanded.value && scopeFamily.value === 'voicestudio' && !voicestudioVoices.value.length && !voicestudioLoading.value) {
    void loadVoicestudioVoices()
  }
}

function goToSettings() {
  const router = useRouter()
  void router.push(`/projects/${props.projectSlug}/settings#api-keys`)
  expanded.value = false
}

function goToLocalModelsSettings() {
  const router = useRouter()
  void router.push(`/projects/${props.projectSlug}/settings#local-tts`)
  expanded.value = false
}

function openVoiceStudioWeb() {
  const url = voicestudioBaseUrl.value
  if (!url) {
    showError('Voice Studio URL not set — configure it in Settings → This Mac → Local Models.')
    return
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    window.location.href = url
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) expanded.value = false
}
// v1.0.306 — close on outside click (was: only closable by re-clicking the
// trigger). Root carries @click.stop so inside clicks never reach this; the
// contains() check is defensive.
const rootEl = ref<HTMLElement | null>(null)
function onClickOutside(e: MouseEvent) {
  if (expanded.value && !rootEl.value?.contains(e.target as Node)) expanded.value = false
}

onMounted(() => {
  void loadCatalog()
  void loadFavourites()
  void loadVoicestudioVoices()
  window.addEventListener('keydown', onKey)
  document.addEventListener('click', onClickOutside)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('click', onClickOutside)
})

watch(search, () => { showAllCatalog.value = false })

// Re-fetch the right voice list whenever the model (id-space) changes, then
// reconcile the current selection against the new scope.
watch(() => [props.audioModelId, props.audioModelProvider], () => {
  void loadVoicestudioVoices()
  reconcileSelection()
})
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
.vp-badge.cat-unavailable { background: rgba(245, 158, 11, 0.18); color: rgb(180, 83, 9); }
.vp-trigger.has-unavailable { border-color: rgba(245, 158, 11, 0.5); }
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
.vp-toolbar { display: flex; gap: 8px; padding: 10px 10px 6px; align-items: center; flex-wrap: wrap; }
.vp-search { flex: 1 1 200px; min-width: 120px; }
.vp-source-row { padding: 0 12px 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vp-eleven-link { white-space: nowrap; font-size: 12px; }

/* v1.0.312 — inline Add-voice panel (cloud scopes) */
.vp-add-panel {
  margin: 0 10px 8px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.vp-add-help {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}
.vp-add-help a { color: var(--accent); text-decoration: underline; }
.vp-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.vp-add-row .input { flex: 1 1 140px; min-width: 100px; }
.vp-add-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; flex: 1 1 220px; }

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

/* Family accent stripes so the three groups read distinctly at a glance. */
.vp-section-local  { border-left: 2px solid rgba(74, 222, 128, 0.55); padding-left: 6px; background: rgba(74, 222, 128, 0.04); border-radius: 2px; }
.vp-section-saved  { border-left: 2px solid rgba(167, 139, 250, 0.55); padding-left: 6px; background: rgba(167, 139, 250, 0.04); border-radius: 2px; }
.vp-section-eleven { border-left: 2px solid rgba(96, 165, 250, 0.55); padding-left: 6px; background: rgba(96, 165, 250, 0.04); border-radius: 2px; }

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
/* v1.0.293 — multi-endpoint availability badges for pooled clone voices.
   Green = available on every reachable Voice Studio endpoint (full parallel
   dispatch). Amber = available on a subset (chunks will route only to those
   endpoints — serial when there's only one). The text-transform: none keeps
   the count "2 / 3" readable; the rest of .vp-chip lowercases prose tags. */
.vp-chip-pool-ok { background: rgba(34,197,94,0.15); color: rgb(22,163,74); text-transform: none; }
.vp-chip-pool-partial { background: rgba(245,158,11,0.15); color: rgb(180,83,9); text-transform: none; }

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
.vp-loading { display: flex; gap: 8px; align-items: center; padding: 12px; font-size: 12px; color: var(--text-muted); }

/* Scope banner — names the active model family at the top of the panel. */
.vp-scope {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 12px;
  margin: 8px 12px 0;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  line-height: 1.45;
}
.vp-scope.voicestudio {
  background: rgba(74, 222, 128, 0.08);
  border: 1px solid rgba(74, 222, 128, 0.35);
  color: var(--text-secondary);
}
.vp-scope.cloud {
  background: rgba(96, 165, 250, 0.08);
  border: 1px solid rgba(96, 165, 250, 0.35);
  color: var(--text-secondary);
}
.vp-scope :deep(strong) { color: var(--text-primary); }
.vp-scope-icon { font-size: 14px; line-height: 1.2; flex-shrink: 0; }
.vp-scope-text { flex: 1; }

/* Voice Studio section heading row — heading text + actions on the right. */
.vp-vs-heading {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  flex-wrap: wrap;
}
.vp-vs-actions { display: inline-flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; }
.vp-vs-refresh {
  background: none; border: 1px solid var(--border); border-radius: 4px;
  padding: 0 6px; line-height: 1.8;
  color: var(--text-muted); font-size: 12px;
  cursor: pointer;
}
.vp-vs-refresh:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.vp-vs-refresh:disabled { opacity: 0.5; cursor: default; }
.vp-vs-manage { font-size: 10.5px; color: var(--accent); text-decoration: none; }
.vp-vs-manage:hover { text-decoration: underline; }

.vp-vs-error {
  margin: 4px 12px 0;
  padding: 6px 10px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 4px;
  font-size: 11px;
  color: rgb(180, 83, 9);
  line-height: 1.5;
}
.vp-vs-empty {
  margin: 4px 12px 0;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.vp-vs-chip {
  background: rgba(74, 222, 128, 0.15) !important;
  color: rgb(22, 134, 70) !important;
  text-transform: lowercase;
}
</style>
