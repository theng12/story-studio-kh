<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Metadata Generator</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      :presets="metadataPresets"
      v-model:episode-id="episodeId"
      filter-field="metadata"
      generate-label="Generate"
      loading-label="Generating…"
      :generate-loading="genAll"
      :generate-disabled="!episodeId || !scriptReady"
      :generate-status="genAll ? `Generating metadata for ${episodeId}…` : (episodeId && !scriptReady ? noScriptTooltip : '')"
      @generate="generateAll"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      SEO title, description, and tags — all saved as a single metadata file per episode.
      Use <strong>Generate</strong> above to run all three sections at once, or the
      <strong>Generate just this</strong> button inside each section to regenerate selectively.
    </p>

    <!-- Shared AI model — applies to every section below. Labelled as -->
    <!-- such so users don't wonder why moving this control changes all -->
    <!-- three generators (consistency with image-prompts, which uses one -->
    <!-- shared model across Scene + Thumbnail pools). -->
    <div class="card mt-3 shared-settings">
      <div class="shared-settings-label">
        <span>AI Model</span>
        <span class="text-muted" style="font-size: 11px; font-weight: normal;">used by all sections below</span>
      </div>
      <div class="form-group" style="max-width: 420px; margin: 0;">
        <ModelSelector v-model="model" :project-slug="slug" />
      </div>
    </div>

    <!-- ═══════ 1. SEO Video Title ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>1. SEO Video Title</h3>
        <p class="text-muted" style="font-size:12px">Generate title options optimized for multiple platforms</p>
      </div>

      <div class="grid-3 mt-1">
        <div class="form-group">
          <label>Platform preset</label>
          <select v-model="titleConfig.preset" @change="onTitlePresetChange" class="select">
            <option value="Universal">Universal (100 — fits all)</option>
            <option value="YouTube">YouTube (100)</option>
            <option value="TikTok">TikTok (100)</option>
            <option value="Facebook">Facebook (255)</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>Max length (characters)</label>
          <input v-model.number="titleConfig.maxLength" type="number" min="10" max="300" class="input" />
        </div>
        <div class="form-group">
          <label>Number of options</label>
          <input v-model.number="titleConfig.count" type="number" min="1" max="20" class="input" />
        </div>
      </div>

      <label class="checkbox-label mt-1">
        <input type="checkbox" v-model="titleConfig.includeScriptContext" />
        Include script context for grounding
      </label>

      <div v-if="titleOptions.length" class="title-options mt-2">
        <div
          v-for="(t, i) in titleOptions"
          :key="i"
          :class="['title-option', { selected: preview.title === t }]"
          @click="preview.title = t"
        >
          <span class="title-option-text">{{ t }}</span>
          <span class="title-option-count">{{ t.length }} / {{ titleConfig.maxLength }}</span>
        </div>
      </div>

      <button
        class="btn btn-sm btn-primary mt-2"
        :disabled="!episodeId || genTitles || genAll || !scriptReady"
        :title="!scriptReady && episodeId ? noScriptTooltip : 'Generate only the SEO title options — description and tags stay untouched.'"
        @click="generateTitles"
      >
        <LoadingSpinner v-if="genTitles" size="sm" />
        {{ genTitles ? 'Generating titles…' : 'Generate Titles Only' }}
      </button>
    </div>

    <!-- ═══════ 2. Description ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>2. Description</h3>
        <p class="text-muted" style="font-size:12px">Toggle sections on/off, drag to reorder. AI fills content per episode.</p>
      </div>

      <div class="form-group mt-1" style="max-width: 280px;">
        <label>Max length (characters) — YouTube max is 5000</label>
        <input v-model.number="descConfig.maxChars" type="number" min="100" max="5000" class="input" />
      </div>

      <p class="text-muted" style="font-size: 12px; margin-top: 8px;">
        <span aria-hidden="true">⋮⋮</span>
        Drag sections to reorder, or use the arrow buttons. Toggle the checkbox to include/exclude.
        <strong>Order matters</strong> — the final description renders each enabled section top-to-bottom in the order shown here.
      </p>

      <div class="section-list mt-1">
        <div
          v-for="(section, i) in sections"
          :key="section.id"
          :class="['section-item', { disabled: !section.enabled, 'drag-over': dragOverIndex === i }]"
          :draggable="true"
          @dragstart="onDragStart(i, $event)"
          @dragover.prevent="onDragOver(i)"
          @dragleave="onDragLeave"
          @drop.prevent="onDrop(i)"
          @dragend="onDragEnd"
        >
          <div class="section-header">
            <div class="section-head-left">
              <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
              <div class="reorder-btns">
                <button
                  class="reorder-btn"
                  type="button"
                  :aria-label="`Move ${section.label} up`"
                  @click="moveSection(i, -1)"
                  :disabled="i === 0"
                >▲</button>
                <button
                  class="reorder-btn"
                  type="button"
                  :aria-label="`Move ${section.label} down`"
                  @click="moveSection(i, 1)"
                  :disabled="i === sections.length - 1"
                >▼</button>
              </div>
              <label class="toggle-label">
                <input type="checkbox" v-model="section.enabled" />
                <strong>{{ section.label }}</strong>
              </label>
            </div>
            <button v-if="section.type === 'custom'" class="btn-icon danger" @click="sections.splice(i, 1)" aria-label="Remove section">✕</button>
          </div>

          <div v-if="section.enabled && section.config" class="section-config">
            <!-- HOOK: characters + optional brand-prefix instead of sentence count -->
            <div v-if="section.id === 'hook'">
              <div class="form-group">
                <label>Hook length (characters)</label>
                <input v-model.number="section.config.characters" type="number" min="80" max="500" step="10" class="input" style="max-width:140px" />
                <p class="text-muted" style="font-size:11px; margin-top:4px;">
                  Soft target the LLM aims for, ±15%. ~250 chars is the YouTube SEO snippet sweet spot.
                </p>
              </div>
              <div class="form-group">
                <label>Starting format <span class="text-muted" style="font-weight:normal">(optional — leave blank for LLM-suggested opener)</span></label>
                <input v-model="section.config.starting_format" class="input" placeholder="e.g. 🌙 Welcome back to [Your Channel Name]." />
                <p class="text-muted" style="font-size:11px; margin-top:4px;">
                  If set, every hook will begin with EXACTLY this text, then continue naturally.
                </p>
              </div>
            </div>

            <!-- NARRATOR: just a name (was bundled inside the old 'metadata' section) -->
            <div v-if="section.id === 'narrator'" class="form-group">
              <label>Narrator name</label>
              <input v-model="section.config.name" class="input" placeholder="e.g. Your Narrator" />
            </div>

            <!-- MUSIC: title + link + disclaimer (NEW dedicated section) -->
            <div v-if="section.id === 'music'">
              <div class="form-group">
                <label>Music title</label>
                <input v-model="section.config.title" class="input" placeholder="e.g. Inner Sound — Jesse Gallagher" />
              </div>
              <div class="form-group">
                <label>Music link</label>
                <input v-model="section.config.link" class="input" placeholder="https://... (YouTube Audio Library, Artlist, etc.)" />
              </div>
              <div class="form-group">
                <label>Music disclaimer</label>
                <textarea v-model="section.config.disclaimer" class="textarea config-textarea" placeholder="License / attribution text" />
              </div>
            </div>

            <!-- CHANNELS: array (own + recommended) using the videos[] pattern -->
            <div v-if="section.id === 'channels'">
              <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">
                Add your own channel(s) and recommended channels. Mark each so the description groups them correctly.
              </label>
              <div v-for="(ch, ci) in section.config.channels" :key="ci" class="link-row">
                <select v-model="ch.kind" class="select" style="max-width:140px">
                  <option value="own">Our channel</option>
                  <option value="recommended">Recommended</option>
                </select>
                <input v-model="ch.name" class="input" placeholder="Channel name" style="flex:1" />
                <input v-model="ch.url" class="input" placeholder="https://youtube.com/@..." style="flex:1.5" />
                <button class="btn-icon danger" @click="section.config.channels.splice(ci, 1)" aria-label="Remove channel">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.channels.push({ name: '', url: '', kind: 'recommended' })">+ Add Channel</button>
            </div>

            <div v-if="section.id === 'videos'">
              <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">Add video links to recommend in the description</label>
              <div v-for="(vid, vi) in section.config.videos" :key="vi" class="link-row">
                <input v-model="vid.name" class="input" placeholder="Video title" style="flex:1" />
                <input v-model="vid.url" class="input" placeholder="https://youtube.com/watch?v=..." style="flex:1.5" />
                <button class="btn-icon danger" @click="section.config.videos.splice(vi, 1)">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.videos.push({ name: '', url: '' })">+ Add Video</button>
            </div>

            <div v-if="section.id === 'playlists'">
              <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">Add playlist links to feature in the description</label>
              <div v-for="(pl, pi) in section.config.playlists" :key="pi" class="link-row">
                <input v-model="pl.name" class="input" placeholder="Playlist name" style="flex:1" />
                <input v-model="pl.url" class="input" placeholder="https://youtube.com/playlist?list=..." style="flex:1.5" />
                <button class="btn-icon danger" @click="section.config.playlists.splice(pi, 1)">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.playlists.push({ name: '', url: '' })">+ Add Playlist</button>
            </div>

            <!-- CTA: subscribe/like only — separate from the support section now.
                 Keeps the "free way to help" ask distinct from the "pay to support"
                 ask, which the user wanted broken apart. -->
            <div v-if="section.id === 'cta'">
              <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">
                Optional custom subscribe/like lines. Leave empty to let the LLM write its own short CTA.
              </label>
              <div v-for="(line, li) in section.config.custom_lines" :key="li" class="link-row">
                <input v-model="section.config.custom_lines[li]" class="input" style="flex:1" placeholder="e.g. Hit the bell so you never miss a new story." />
                <button class="btn-icon danger" @click="section.config.custom_lines.splice(li, 1)" aria-label="Remove line">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.custom_lines.push('')">+ Add CTA Line</button>
            </div>

            <!-- SUPPORT: array of platforms, was Patreon-only on the old cta.
                 Keeps the same UX as videos/channels (kind dropdown + URL +
                 optional label only when kind='custom'). -->
            <div v-if="section.id === 'support'">
              <label style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block">
                Where can viewers support the channel? Patreon, Ko-fi, Buy Me a Coffee, YouTube Members, or any custom platform.
              </label>
              <div v-for="(plat, pi) in section.config.platforms" :key="pi" class="link-row support-row">
                <select v-model="plat.kind" class="select" style="max-width:170px">
                  <option value="patreon">Patreon</option>
                  <option value="kofi">Ko-fi</option>
                  <option value="buymeacoffee">Buy Me a Coffee</option>
                  <option value="youtube-members">YouTube Members</option>
                  <option value="custom">Custom…</option>
                </select>
                <input
                  v-if="plat.kind === 'custom'"
                  v-model="plat.label"
                  class="input"
                  placeholder="Label (e.g. Stripe link)"
                  style="max-width:160px"
                />
                <input v-model="plat.url" class="input" placeholder="https://..." style="flex:1" />
                <button class="btn-icon danger" @click="section.config.platforms.splice(pi, 1)" aria-label="Remove platform">✕</button>
              </div>
              <button class="btn btn-sm btn-secondary mt-1" @click="section.config.platforms.push({ kind: 'patreon', url: '' })">+ Add Platform</button>
            </div>

            <div v-if="section.id === 'affiliate'" class="form-group">
              <label>Affiliate disclaimer text</label>
              <textarea v-model="section.config.text" class="textarea config-textarea" />
            </div>

            <div v-if="section.id === 'ai-disclosure'" class="form-group">
              <label>AI disclosure text</label>
              <textarea v-model="section.config.text" class="textarea config-textarea" />
            </div>

            <div v-if="section.id === 'hashtags'" class="form-group">
              <label>Number of hashtags to generate (inside description)</label>
              <input v-model.number="section.config.count" type="number" min="5" max="30" class="input" style="max-width:120px" />
            </div>

            <div v-if="section.type === 'custom'">
              <div class="form-group">
                <label>Block title</label>
                <input v-model="section.label" class="input" />
              </div>
              <div class="form-group">
                <label>Instructions for AI</label>
                <textarea v-model="section.config.instructions" class="textarea config-textarea" placeholder="Describe what this section should contain..." />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-2 mt-2" style="flex-wrap: wrap;">
        <button class="btn btn-sm btn-secondary" @click="addCustomBlock">+ Add Custom Section</button>
        <button
          class="btn btn-sm btn-primary"
          :disabled="!episodeId || genDesc || genAll || !scriptReady"
          :title="!scriptReady && episodeId ? noScriptTooltip : 'Generate only the description — titles and tags stay untouched.'"
          @click="generateDescription"
        >
          <LoadingSpinner v-if="genDesc" size="sm" />
          {{ genDesc ? 'Generating description…' : 'Generate Description Only' }}
        </button>
      </div>
    </div>

    <!-- ═══════ 3. Tags ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>3. YouTube Tags</h3>
        <p class="text-muted" style="font-size:12px">Tags boost discoverability — separate from in-description hashtags</p>
      </div>
      <div class="form-group mt-1" style="max-width: 200px;">
        <label>Number of tags</label>
        <input v-model.number="tagConfig.count" type="number" min="1" max="50" class="input" />
      </div>
      <button
        class="btn btn-sm btn-primary mt-2"
        :disabled="!episodeId || genTags || genAll || !scriptReady"
        :title="!scriptReady && episodeId ? noScriptTooltip : 'Generate only YouTube tags — titles and description stay untouched.'"
        @click="generateTags"
      >
        <LoadingSpinner v-if="genTags" size="sm" />
        {{ genTags ? 'Generating tags…' : 'Generate Tags Only' }}
      </button>
    </div>


    <!-- ═══════ Preview ═══════ -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>Preview</h3>
        <div class="flex gap-2 items-center">
          <SaveIndicator :state="autoSave.state.value" :saved-at="autoSave.savedAt.value" :error-message="autoSave.errorMessage.value" />
          <span class="text-muted" style="font-size:11px">
            <template v-if="sessionVersion">Editing v{{ sessionVersion }} (auto-saving)</template>
            <template v-else-if="versions.length">Loaded v{{ selectedVersion }} — first edit creates v{{ nextVersionNumber }}</template>
            <template v-else>First save will create v1</template>
          </span>
          <div v-if="versions.length" class="form-group" style="margin-bottom:0">
            <label class="text-muted" style="font-size:11px; display:block; margin-bottom:2px">History</label>
            <select v-model.number="selectedVersion" @change="loadVersion" class="select select-sm" :title="`${versions.length} version(s) on disk`">
              <option v-for="v in versions" :key="v.version" :value="v.version">
                v{{ v.version }}{{ v.savedAt ? ` — ${formatDate(v.savedAt)}` : '' }}
              </option>
            </select>
          </div>
          <button
            class="btn btn-sm btn-secondary"
            :title="'Force a new version snapshot right now (otherwise autosave handles this)'"
            @click="forkToNewVersion"
          >
            🔱 Fork to v{{ nextVersionNumber }}
          </button>
        </div>
      </div>

      <div class="form-group mt-1">
        <label>
          Title
          <span class="char-count" :class="{ 'over-limit': preview.title.length > titleConfig.maxLength }">
            {{ preview.title.length }} / {{ titleConfig.maxLength }}
          </span>
          <button class="btn-icon" @click="copy(preview.title, 'Title')" title="Copy title">📋</button>
        </label>
        <input v-model="preview.title" class="input" placeholder="SEO video title — click an option above or edit here" />
      </div>

      <div class="form-group mt-1">
        <label>
          Description
          <span class="char-count" :class="{ 'over-limit': preview.description.length > descConfig.maxChars }">
            {{ preview.description.length }} / {{ descConfig.maxChars }}
          </span>
          <button class="btn-icon" @click="copy(preview.description, 'Description')" title="Copy description">📋</button>
        </label>
        <textarea v-model="preview.description" class="textarea preview-textarea" placeholder="Generated description will appear here" />
      </div>

      <div class="form-group mt-1">
        <label>
          Tags
          <span class="char-count">{{ preview.tags.length }} tags</span>
          <button class="btn-icon" @click="copy(tagsAsString, 'Tags')" title="Copy tags as comma-separated string">📋</button>
        </label>
        <textarea v-model="tagsAsString" class="textarea tags-textarea" placeholder="Comma-separated tags (e.g. sleep story, bedtime story, relaxation)" />
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Metadata Generator — Story Studio KH" })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { metaGenerating } = useGenerating()

const episodeId = ref('')
const model = ref('gpt-4o')

// Source-of-truth gating: every metadata generator (descriptions, titles,
// tags, "Generate All") reads narration context from the script docx, so
// we disable the buttons until episode.status.script flips true. Refetches
// when a script-only job lands so the page enables itself live without a
// reload.
const { selectedEpisode, scriptReady } = useEpisodeStatus(episodeId, slug, {
  refetchOnJobTypes: ['script-only'],
})
const noScriptTooltip = 'Generate the script first to unlock this generator.'

// Generating flags (independent per section)
const genTitles = ref(false)
const genDesc = ref(false)
const genTags = ref(false)
const genAll = ref(false)

// Section configs
const titleConfig = reactive({
  preset: 'Universal',
  maxLength: 100,
  count: 5,
  includeScriptContext: true,
})
const descConfig = reactive({ maxChars: 5000 })
const tagConfig = reactive({ count: 15 })

// Results / preview
const titleOptions = ref<string[]>([])
const preview = reactive({
  title: '',
  description: '',
  tags: [] as string[],
})
const versions = ref<Array<{ version: number; title: string; description: string; tags: string[]; savedAt: string | null }>>([])
const selectedVersion = ref<number>(1)

// Section builder
interface SectionConfig { [key: string]: any }
interface Section { id: string; label: string; type: 'builtin' | 'custom'; enabled: boolean; config: SectionConfig }

// New section schema (Apr 2026 refactor):
//   - hook       — characters + optional starting_format prefix
//                  (was: number-of-sentences; sentences was too coarse for
//                  YouTube's snippet truncation which is character-based)
//   - narrator   — name (split out from old monolithic 'metadata' section)
//   - music      — title + link + disclaimer (NEW dedicated section)
//   - channels   — array of channels with optional kind=own|recommended
//                  (was: single channel inside 'metadata'; user now wants
//                  to recommend other channels too — same UX as 'videos')
//   - videos     — unchanged
//   - playlists  — unchanged
//   - cta        — subscribe/like only (split out from old conflated 'cta')
//   - support    — array of platforms (Patreon, Ko-fi, BMC, YT Members, custom)
//                  (was: Patreon-only field on the old 'cta' section)
//   - affiliate / ai-disclosure / hashtags — unchanged
//
// Old sections ('metadata', old-shape 'cta') are auto-migrated by the
// `apply` function in usePresets so existing presets transparently upgrade.
const defaultSections: Section[] = [
  { id: 'hook', label: 'Hook / Intro Paragraph', type: 'builtin', enabled: true, config: { characters: 250, starting_format: '' } },
  { id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: true, config: { name: '' } },
  { id: 'music', label: 'Music Credit', type: 'builtin', enabled: true, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } },
  { id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: true, config: { channels: [{ name: '', url: '', kind: 'own' as 'own' | 'recommended' }] } },
  { id: 'videos', label: 'Video Recommendations', type: 'builtin', enabled: true, config: { videos: [{ name: '', url: '' }] } },
  { id: 'playlists', label: 'Playlists', type: 'builtin', enabled: false, config: { playlists: [{ name: '', url: '' }] } },
  { id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: true, config: { custom_lines: [] as string[] } },
  { id: 'support', label: 'Support / Membership', type: 'builtin', enabled: true, config: { platforms: [] as Array<{ kind: string; url: string; label?: string }> } },
  { id: 'affiliate', label: 'Affiliate Disclaimer', type: 'builtin', enabled: false, config: { text: 'As an Amazon Associate we earn from qualifying purchases.' } },
  { id: 'ai-disclosure', label: 'AI Disclosure', type: 'builtin', enabled: true, config: { text: 'This story was written with the assistance of AI tools and reviewed for quality and warmth.' } },
  { id: 'hashtags', label: 'Hashtags (inside description)', type: 'builtin', enabled: true, config: { count: 15 } },
]

/**
 * Migrate a sections[] array from the pre-Apr-2026 schema to the new
 * shape. Idempotent: running on already-new sections is a no-op.
 *
 * Mappings:
 *   hook { sentences } → hook { characters: sentences * 80, starting_format: '' }
 *     (~80 chars per sentence is a reasonable rule of thumb for prose;
 *      keeps the user's existing length intent even though the unit
 *      changed)
 *   metadata { narrator_*, music, channel_* } → split into narrator + music + channels
 *   cta { patreon_url, custom_text } → split into cta + support
 *
 * Returns { migrated, didMigrate } so the caller can show a one-time
 * toast when something actually changed.
 */
function migrateSections(input: Section[]): { migrated: Section[]; didMigrate: boolean } {
  let didMigrate = false
  const out: Section[] = []
  let injectedNarrator = false, injectedMusic = false, injectedChannels = false, injectedSupport = false

  for (const s of input) {
    // Old monolithic metadata section → split
    if (s.id === 'metadata') {
      didMigrate = true
      const cfg = s.config || {}
      out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: cfg.narrator_enabled !== false, config: { name: cfg.narrator_name || '' } })
      out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: !!cfg.music, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
      out.push({
        id: 'channels', label: 'Channel Mentions', type: 'builtin',
        enabled: cfg.channel_enabled !== false,
        config: {
          channels: cfg.channel_name
            ? [{ name: cfg.channel_name, url: '', kind: 'own' }]
            : [{ name: '', url: '', kind: 'own' }],
        },
      })
      injectedNarrator = injectedMusic = injectedChannels = true
      continue
    }

    // Old cta with patreon_url → split into cta + support
    if (s.id === 'cta' && s.config && ('patreon_url' in s.config || 'custom_text' in s.config)) {
      didMigrate = true
      const cfg = s.config || {}
      out.push({
        id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: s.enabled,
        config: { custom_lines: cfg.custom_text ? [cfg.custom_text] : [] },
      })
      out.push({
        id: 'support', label: 'Support / Membership', type: 'builtin', enabled: s.enabled,
        config: {
          platforms: cfg.patreon_url
            ? [{ kind: 'patreon', url: cfg.patreon_url }]
            : [],
        },
      })
      injectedSupport = true
      continue
    }

    // hook { sentences } → hook { characters }
    if (s.id === 'hook' && s.config && 'sentences' in s.config && !('characters' in s.config)) {
      didMigrate = true
      const sentences = Number(s.config.sentences) || 3
      out.push({
        ...s,
        config: { characters: Math.max(120, Math.min(500, sentences * 80)), starting_format: '' },
      })
      continue
    }

    out.push(s)
  }

  // If presets were saved before the new sections existed, inject defaults
  // for any new section the migration didn't already produce. Order is
  // best-effort — user can drag to reorder.
  const have = new Set(out.map(s => s.id))
  if (!have.has('narrator') && !injectedNarrator) {
    out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: false, config: { name: '' } })
    didMigrate = true
  }
  if (!have.has('music') && !injectedMusic) {
    out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: false, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
    didMigrate = true
  }
  if (!have.has('channels') && !injectedChannels) {
    out.push({ id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: false, config: { channels: [{ name: '', url: '', kind: 'own' }] } })
    didMigrate = true
  }
  if (!have.has('support') && !injectedSupport) {
    out.push({ id: 'support', label: 'Support / Membership', type: 'builtin', enabled: false, config: { platforms: [] } })
    didMigrate = true
  }

  return { migrated: out, didMigrate }
}

const sections = ref<Section[]>(JSON.parse(JSON.stringify(defaultSections)))

// ── Unified preset wiring ──────────────────────────────────────────────────
// Swapped off the custom youtube_templates schema onto the same usePresets
// composable every other generator page uses. One-time migration below
// converts pre-existing youtube_templates into the unified preset store
// so the user never loses their saved layouts.
const metadataPresets = usePresets<{ sections: Section[] }>({
  slug: slug.value,
  configKey: 'metadata',
  snapshot: () => ({ sections: JSON.parse(JSON.stringify(sections.value)) }),
  apply: (data) => {
    if (!data?.sections) return
    // Run the schema migration before assigning. This handles any preset
    // saved before the Apr 2026 section split (old `metadata` /
    // `cta`-with-patreon shape) so the user's existing presets stay
    // usable without manual re-creation. The flag below ensures the
    // info toast fires once per migrated preset (keyed in localStorage).
    const { migrated, didMigrate } = migrateSections(JSON.parse(JSON.stringify(data.sections)))
    sections.value = migrated
    if (didMigrate) {
      const presetId = metadataPresets.activeId.value || 'unknown'
      const flagKey = `metadata-migration-toast-shown:${slug.value}:${presetId}`
      if (typeof window !== 'undefined' && !window.localStorage.getItem(flagKey)) {
        // Defer the toast so it shows AFTER the page mounts (calling
        // success() during component setup can be swallowed by Toast's
        // mount guard).
        nextTick(() => success('Your metadata preset was upgraded — review the new sections.'))
        try { window.localStorage.setItem(flagKey, '1') } catch { /* localStorage disabled — fine */ }
      }
    }
  },
})

// ── Computed ───────────────────────────────────────────────────────────────

const tagsAsString = computed({
  get: () => preview.tags.join(', '),
  set: (val: string) => { preview.tags = val.split(',').map(t => t.trim()).filter(Boolean) },
})

const nextVersionNumber = computed(() => {
  if (!versions.value.length) return 1
  return Math.max(...versions.value.map(v => v.version)) + 1
})

// ── Preset handling ────────────────────────────────────────────────────────

const PRESET_LIMITS: Record<string, number> = {
  YouTube: 100,
  TikTok: 100,
  Facebook: 255,
  Universal: 100,
}
function onTitlePresetChange() {
  if (titleConfig.preset !== 'custom' && PRESET_LIMITS[titleConfig.preset]) {
    titleConfig.maxLength = PRESET_LIMITS[titleConfig.preset]!
  }
}

// ── Section reorder ────────────────────────────────────────────────────────

function moveSection(i: number, dir: number) {
  const j = i + dir
  if (j < 0 || j >= sections.value.length) return
  const a = sections.value[i]
  const b = sections.value[j]
  if (!a || !b) return
  sections.value[i] = b
  sections.value[j] = a
}
function addCustomBlock() {
  sections.value.push({ id: `custom-${Date.now()}`, label: 'Custom Section', type: 'custom', enabled: true, config: { instructions: '' } })
}

// ── HTML5 Drag & Drop ──────────────────────────────────────────────────────

const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onDragStart(i: number, ev: DragEvent) {
  dragIndex.value = i
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(i))
  }
}
function onDragOver(i: number) {
  if (dragIndex.value === null || dragIndex.value === i) return
  dragOverIndex.value = i
}
function onDragLeave() { dragOverIndex.value = null }
function onDrop(i: number) {
  const from = dragIndex.value
  if (from === null || from === i) { onDragEnd(); return }
  const moved = sections.value.splice(from, 1)[0]
  if (moved) sections.value.splice(i, 0, moved)
  onDragEnd()
}
function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

// ── Episode selection + preview load ──────────────────────────────────────

// Synchronous fast-path: drop the EpisodeSelector's payload straight into
// `selectedEpisode` so loadExistingMetadata (triggered by the episodeId
// watch) can read the title immediately. The useEpisodeStatus composable
// will subsequently refetch and overwrite with the API row that carries
// status.* — same data, just guaranteed-fresh.
function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
}

async function loadExistingMetadata() {
  if (!episodeId.value) return
  try {
    const title = selectedEpisode.value?.title || ''
    const data = await get<{ versions: typeof versions.value }>(
      `/projects/${slug.value}/episodes/${episodeId.value}/metadata?title=${encodeURIComponent(title)}`
    )
    versions.value = data.versions || []
    if (versions.value.length) {
      const latest = versions.value[versions.value.length - 1]!
      selectedVersion.value = latest.version
      applyVersion(latest)
    } else {
      selectedVersion.value = 1
      preview.title = ''
      preview.description = ''
      preview.tags = []
    }
  } catch {
    versions.value = []
  }
}

function applyVersion(v: { title: string; description: string; tags: string[] }) {
  preview.title = v.title || ''
  preview.description = v.description || ''
  preview.tags = Array.isArray(v.tags) ? [...v.tags] : []
}

function loadVersion() {
  const v = versions.value.find(x => x.version === selectedVersion.value)
  if (v) suppressAutoSaveDuring(() => applyVersion(v))
}

// ── Generation ─────────────────────────────────────────────────────────────

async function generateTitles() {
  if (!episodeId.value) return
  genTitles.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ titles: string[] }>(`/projects/${slug.value}/generate/metadata/seo-titles`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: model.value,
      count: titleConfig.count,
      max_length: titleConfig.maxLength,
      platform_preset: titleConfig.preset,
      include_script_context: titleConfig.includeScriptContext,
    })
    titleOptions.value = data.titles
    if (!preview.title && data.titles[0]) preview.title = data.titles[0]
    success(`Generated ${data.titles.length} title options`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to generate titles')
  } finally {
    genTitles.value = false
    metaGenerating.value = false
  }
}

async function generateDescription() {
  if (!episodeId.value) return
  genDesc.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ description: string }>(`/projects/${slug.value}/generate/metadata/description`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: model.value,
      sections: sections.value.filter(s => s.enabled),
      max_chars: descConfig.maxChars,
    })
    preview.description = data.description
    success('Description generated')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to generate description')
  } finally {
    genDesc.value = false
    metaGenerating.value = false
  }
}

async function generateTags() {
  if (!episodeId.value) return
  genTags.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ tags: string[] }>(`/projects/${slug.value}/generate/metadata/tags`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      description: preview.description,
      model: model.value,
      count: tagConfig.count,
    })
    preview.tags = data.tags
    success(`Generated ${data.tags.length} tags`)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to generate tags')
  } finally {
    genTags.value = false
    metaGenerating.value = false
  }
}

async function generateAll() {
  if (!episodeId.value) return
  genAll.value = true
  metaGenerating.value = true
  try {
    const data = await post<{ titles: string[]; description: string; tags: string[] }>(
      `/projects/${slug.value}/generate/metadata/all`,
      {
        episode_id: episodeId.value,
        title: selectedEpisode.value?.title || '',
        model: model.value,
        sections: sections.value.filter(s => s.enabled),
        max_chars: descConfig.maxChars,
        title_count: titleConfig.count,
        title_max_length: titleConfig.maxLength,
        title_platform_preset: titleConfig.preset,
        tag_count: tagConfig.count,
      }
    )
    titleOptions.value = data.titles
    // New content = new editing session, so the next autosave creates a new
    // version on disk instead of overwriting whichever one we last touched.
    sessionVersion.value = null
    preview.title = data.titles[0] || ''
    preview.description = data.description
    preview.tags = data.tags
    success('All metadata generated — autosaving as new version…')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to generate metadata')
  } finally {
    genAll.value = false
    metaGenerating.value = false
  }
}

// ── Save ───────────────────────────────────────────────────────────────────

// Manual escape hatch: snapshot current edits as a fresh version on disk
// even mid-session. After forking, the autosave session adopts that new
// version so further keystrokes accumulate into it.
async function forkToNewVersion() {
  sessionVersion.value = null
  await autoSave.flush()
}

// ── Copy helpers ───────────────────────────────────────────────────────────

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    success(`${label} copied`)
  } catch {
    showError('Copy failed')
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ── One-time migration + preset load ───────────────────────────────────────
// If this project still carries the legacy `youtube_templates` config key
// and has no `metadata_presets` yet, convert once and persist under the new
// keys so `usePresets` can take over. Old keys are left in place as a
// safety net — removed in a later release.
async function migrateLegacyMetadataTemplates() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    const alreadyMigrated = Array.isArray(config.metadata_presets) && config.metadata_presets.length
    const hasLegacy = Array.isArray(config.youtube_templates) && config.youtube_templates.length
    if (alreadyMigrated || !hasLegacy) return

    // Legacy shape: { id, name, sections? }. New shape: { id, name, data: { sections } }.
    const migrated = config.youtube_templates
      .filter((t: any) => t && t.id && t.name)
      .map((t: any) => ({
        id: t.id,
        name: t.name,
        data: { sections: Array.isArray(t.sections) ? t.sections : [] },
      }))

    await put(`/projects/${slug.value}/settings/config`, {
      metadata_presets: migrated,
      metadata_last_preset: config.youtube_last_template || (migrated[0]?.id ?? ''),
    })
  } catch {
    // Migration failures are non-fatal — user can still use the defaults and
    // save new presets from scratch.
  }
}

// ── Auto-save (debounced, true autosave with silent versioning) ────────────
//
// Behaviour: the FIRST debounced save in an editing "session" creates a new
// version on disk. All subsequent saves in the same session overwrite that
// version in place. A new session starts when the episode changes, a
// different version is loaded, or generation runs (any of which calls
// `resetAutoSaveSession`). This keeps version history meaningful — one
// version per editing session — instead of one version per keystroke.

const sessionVersion = ref<number | null>(null)

function resetAutoSaveSession() {
  sessionVersion.value = null
  autoSave.reset()
}

const autoSave = useAutoSave({
  debounceMs: 800,
  save: async () => {
    if (!episodeId.value) return
    // Skip if there's nothing meaningful to persist yet
    if (!preview.title && !preview.description && !preview.tags.length) return
    const writingTo = sessionVersion.value
    const data = await post<{ version: number }>(`/projects/${slug.value}/generate/metadata/save`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      metadata_title: preview.title,
      description: preview.description,
      tags: preview.tags,
      // First save in a session → new version. Re-saves in the same session
      // overwrite the version we just created so a paragraph of typing
      // doesn't fan out to v7..v12 silently.
      save_mode: writingTo == null ? 'new' : 'overwrite',
      version: writingTo ?? undefined,
    })
    sessionVersion.value = data.version
    // Refresh the version dropdown without re-triggering autosave.
    await suppressAutoSaveDuring(() => loadExistingMetadata())
    selectedVersion.value = data.version
  },
})

let suppressAutoSave = false

async function suppressAutoSaveDuring<T>(fn: () => Promise<T> | T): Promise<T> {
  suppressAutoSave = true
  try { return await fn() } finally {
    // Release on next tick so the watchers triggered by the operation don't fire saves
    await nextTick()
    suppressAutoSave = false
  }
}

watch([() => preview.title, () => preview.description, () => preview.tags], () => {
  if (suppressAutoSave) return
  autoSave.scheduleSave()
}, { deep: true })

// ── Watchers ───────────────────────────────────────────────────────────────

watch(episodeId, async () => {
  await suppressAutoSaveDuring(() => loadExistingMetadata())
  resetAutoSaveSession()
})

// Loading a different version explicitly should also start a new editing
// session, otherwise autosave would silently overwrite the version the
// user just opened with their next keystroke.
watch(selectedVersion, () => {
  sessionVersion.value = null
})

onMounted(async () => {
  await migrateLegacyMetadataTemplates()
  await metadataPresets.load()
})
</script>

<style scoped>
.combined-card {
  background: linear-gradient(135deg, rgba(96,165,250,0.08), rgba(167,139,250,0.08));
  border: 1px solid rgba(96,165,250,0.2);
}

.shared-settings { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 12px 16px; }
.shared-settings-label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; font-weight: 600; color: var(--text-secondary); min-width: 110px; }

.card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }

/* Title options */
.title-options { display: flex; flex-direction: column; gap: 6px; }
.title-option {
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.title-option:hover { border-color: var(--accent); background: var(--bg-hover); }
.title-option.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.1); }
.title-option-text { flex: 1; font-size: 14px; }
.title-option-count { font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; white-space: nowrap; }

/* Char count badge */
.char-count {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 8px;
  font-family: 'SF Mono', monospace;
}
.char-count.over-limit { color: var(--error); font-weight: 600; }

/* Section list with drag & drop */
.section-list { display: flex; flex-direction: column; gap: 8px; }

.section-item {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px;
  transition: opacity 0.2s, border-color 0.15s, transform 0.15s;
  cursor: grab;
}
.section-item:active { cursor: grabbing; }
.section-item.disabled { opacity: 0.4; }
.section-item.drag-over {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(240, 198, 116, 0.15);
}

.section-header { display: flex; justify-content: space-between; align-items: center; }
.section-head-left { display: flex; align-items: center; gap: 8px; }

.drag-handle {
  color: var(--text-muted);
  font-size: 18px;
  cursor: grab;
  user-select: none;
  padding: 0 2px;
  line-height: 1;
}
.drag-handle:hover { color: var(--text-primary); }

.section-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }

.reorder-btns { display: flex; flex-direction: column; gap: 2px; }
.reorder-btn {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  line-height: 1;
  min-height: 20px;
  min-width: 28px;
  transition: all 0.15s;
}
.reorder-btn:hover:not(:disabled) { background: var(--accent-dim); color: var(--accent); border-color: rgba(240, 198, 116, 0.3); }
.reorder-btn:disabled { opacity: 0.3; cursor: default; }
.reorder-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.config-textarea { width: 100%; min-height: 70px; font-size: 13px; line-height: 1.5; resize: vertical; }

/* Preview */
.preview-textarea {
  width: 100%;
  min-height: 350px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.tags-textarea {
  width: 100%;
  min-height: 80px;
  font-size: 13px;
  resize: vertical;
}

.link-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.meta-toggles { display: flex; gap: 20px; }
.toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }

.btn-icon {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px;
}
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--error); background: rgba(248,113,113,0.1); }

.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-muted); }

.select-sm { padding: 4px 8px; font-size: 12px; }

.ml-auto { margin-left: auto; }

/* Save-as modal */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 2000;
}
.modal-small {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 420px;
  max-width: calc(100vw - 48px);
}
.modal-small h3 { font-size: 16px; font-weight: 600; }
</style>
