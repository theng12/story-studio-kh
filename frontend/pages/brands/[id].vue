<template>
  <div class="brand-editor">
    <header class="page-header">
      <NuxtLink to="/brands" class="btn btn-secondary btn-sm">← All brands</NuxtLink>
      <h1 v-if="brand">{{ brand.name || brand.id }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary" :disabled="!dirty || saving" @click="reload">
          Discard changes
        </button>
        <button class="btn btn-primary" :disabled="!dirty || saving || !brand?.name" @click="save">
          {{ saving ? 'Saving…' : (dirty ? 'Save changes' : 'Saved') }}
        </button>
      </div>
    </header>

    <div v-if="loadError" class="error-card">
      <strong>Couldn't load brand.</strong>
      <p>{{ loadError }}</p>
      <NuxtLink to="/brands" class="btn btn-secondary">Back to list</NuxtLink>
    </div>

    <div v-else-if="!brand" class="empty-state">Loading…</div>

    <div v-else class="editor-grid">
      <!-- Channel section -->
      <section class="card">
        <h2>Channel</h2>
        <p class="text-muted">
          The name you publish under. Replaces literal channel-name references in metadata templates
          via the <code>{channel_name}</code> placeholder.
        </p>
        <div class="form-group">
          <label>Channel name</label>
          <input class="input" v-model="brand.channel!.name" type="text" placeholder="Sleep Studio Asia" />
        </div>
        <div class="form-group">
          <label>YouTube channel URL</label>
          <input class="input" v-model="brand.channel!.youtube_url" type="text" placeholder="https://youtube.com/@yourchannel" />
        </div>
        <div class="form-group">
          <label>Handle</label>
          <input class="input" v-model="brand.channel!.handle" type="text" placeholder="@yourchannel" />
        </div>
      </section>

      <!-- Visual section -->
      <section class="card">
        <h2>Visual</h2>
        <p class="text-muted">
          Logo + colors. The video assembly preset uses the logo path as a default
          when the project hasn't overridden it.
        </p>
        <div class="form-group">
          <label>Logo path</label>
          <FilePicker
            v-model="brand.visual!.logo_path"
            placeholder="/path/to/logo.png"
            :filters="[{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]"
            title="Choose a brand logo"
            clearable
          />
        </div>
        <div class="form-group">
          <label>Font family</label>
          <input class="input" v-model="brand.visual!.font_family" type="text" placeholder="Inter" />
        </div>
        <div class="palette-row">
          <div class="form-group">
            <label>Primary</label>
            <input class="input" v-model="brand.visual!.color_palette!.primary" type="text" placeholder="#3b82f6" />
          </div>
          <div class="form-group">
            <label>Accent</label>
            <input class="input" v-model="brand.visual!.color_palette!.accent" type="text" placeholder="#f59e0b" />
          </div>
          <div class="form-group">
            <label>Background</label>
            <input class="input" v-model="brand.visual!.color_palette!.background" type="text" placeholder="#0b1220" />
          </div>
        </div>
      </section>

      <!-- Narration section -->
      <section class="card">
        <h2>Narration</h2>
        <p class="text-muted">
          The persona is prepended to LLM system prompts for ideas, scripts, and metadata.
          Keep it tight — 1-3 sentences.
        </p>
        <div class="form-group">
          <label>Persona</label>
          <textarea class="input" v-model="brand.narration!.persona" rows="3"
            placeholder="A clear, evidence-based narrator for explainer videos. Confident but never preachy. Third person. Never breaks the fourth wall." />
        </div>
        <div class="form-group">
          <label>Default voice id</label>
          <input class="input" v-model="brand.narration!.default_voice_id" type="text" placeholder="ElevenLabs voice id" />
          <span class="text-muted">Falls back to format default if blank.</span>
        </div>
      </section>

      <!-- Image prompts section -->
      <section class="card">
        <h2>Image style</h2>
        <p class="text-muted">
          Keywords prepended to every image prompt (one per row). The style sheet is appended
          as a "Style reference:" block.
        </p>
        <div class="form-group">
          <label>Style keywords (one per line)</label>
          <textarea class="input" :value="styleKeywordsText" rows="3"
            placeholder="cinematic&#10;moody&#10;photorealistic"
            @input="onStyleKeywordsInput" />
        </div>
        <div class="form-group">
          <label>Style sheet</label>
          <textarea class="input" v-model="brand.imagePrompts!.style_sheet" rows="4"
            placeholder="Long-form description of look, mood, color, lighting…" />
        </div>
        <div class="form-group">
          <label>Negative prompts (one per line)</label>
          <textarea class="input" :value="negativePromptsText" rows="3"
            placeholder="text&#10;watermark&#10;low quality"
            @input="onNegativePromptsInput" />
        </div>
      </section>

      <!-- Pronunciation lexicon section -->
      <section class="card">
        <h2>Pronunciation lexicon</h2>
        <p class="text-muted">
          Pre-TTS substitution. Each entry rewrites a term in the narration text before
          it goes to the voice provider, so a single mispronunciation doesn't force a
          whole-episode re-render. ASCII terms match on word boundaries (so
          "<code>Sok</code>" won't match inside "<code>Sokhom</code>"). Khmer and other
          non-Latin terms match as substrings. Case-insensitive by default.
        </p>

        <div v-if="(brand.pronunciation_lexicon?.length ?? 0) === 0" class="lex-empty text-muted">
          No entries yet. Add proper nouns or character names that the TTS provider
          tends to mispronounce.
        </div>

        <ul v-else class="lex-list">
          <li v-for="(row, idx) in brand.pronunciation_lexicon" :key="idx" class="lex-row">
            <div class="lex-grid">
              <div class="form-group">
                <label>Term in script</label>
                <input class="input" v-model="row.term" type="text" placeholder="Sokhom" />
              </div>
              <div class="form-group">
                <label>Alt spelling (what TTS will say)</label>
                <input class="input" v-model="row.alt_spelling" type="text" placeholder="Soh-Khohm" />
              </div>
              <div class="lex-row-actions">
                <button class="btn btn-secondary btn-sm" type="button" @click="toggleAdvanced(idx)">
                  {{ advancedRows.has(idx) ? 'Hide advanced' : 'Advanced' }}
                </button>
                <button class="btn btn-danger btn-sm" type="button" @click="removeLexEntry(idx)">
                  Remove
                </button>
              </div>
            </div>
            <div v-if="advancedRows.has(idx)" class="lex-advanced">
              <p class="text-muted lex-advanced-note">
                IPA + SSML apply on direct ElevenLabs only. Other providers (Fal, GenAIPro)
                fall back to the alt spelling above. Leave blank if you don't need finer control.
              </p>
              <div class="form-group">
                <label>IPA</label>
                <input class="input" v-model="row.ipa" type="text" placeholder="/sɔːkˈhɔːm/" />
                <span class="text-muted">Wrapped in &lt;phoneme alphabet="ipa" ph="…"&gt; at TTS time when supported.</span>
              </div>
              <div class="form-group">
                <label>SSML override</label>
                <input class="input" v-model="row.ssml" type="text" placeholder='<phoneme alphabet="ipa" ph="…">…</phoneme>' />
                <span class="text-muted">Replaces the term verbatim when supported. Wins over IPA when both are set.</span>
              </div>
              <label class="lex-case-toggle">
                <input type="checkbox" v-model="row.case_sensitive" />
                <span>Case-sensitive match</span>
              </label>
            </div>
          </li>
        </ul>

        <button class="btn btn-secondary mt-2" type="button" @click="addLexEntry">+ Add term</button>
      </section>

      <!-- Metadata section -->
      <section class="card">
        <h2>Metadata defaults</h2>
        <p class="text-muted">
          Boilerplate that flows into YouTube descriptions + post-generation guards.
        </p>
        <div class="form-group">
          <label>Description outro template</label>
          <textarea class="input" v-model="brand.metadata!.description_outro_template" rows="3"
            placeholder="Subscribe to keep the videos coming. New episode every week." />
        </div>
        <div class="form-group">
          <label>Attribution template</label>
          <input class="input" v-model="brand.metadata!.attribution_template" type="text"
            placeholder="Music: {track_name} by {artist} — {license}" />
        </div>
        <div class="form-group">
          <label>Banned words (one per line — flagged as warnings, not blocked)</label>
          <textarea class="input" :value="bannedWordsText" rows="3"
            placeholder="word to flag"
            @input="onBannedWordsInput" />
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Brand } from '@shared/contracts'

const route = useRoute()
const id = computed(() => String(route.params.id || ''))

const { loadOne, update } = useBrands()

const brand = ref<Brand | null>(null)
const original = ref<string>('')
const dirty = computed(() => brand.value && JSON.stringify(brand.value) !== original.value)
const loadError = ref<string | null>(null)
const saving = ref(false)

// Reactive title — refreshes once the brand loads. Loaded state reads
// "Foo — Brand — Story Studio KH" (consistent with the rest of the app);
// loading/missing state falls back to "Brand — Story Studio KH".
useAppTitle(() => brand.value ? `${brand.value.name} — Brand` : 'Brand')

// Keyword lists are edited as textareas (one entry per line); split on
// input. Trailing/leading whitespace per line is stripped, blank lines
// dropped, but order is preserved.
function linesToList(text: string): string[] {
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}
function listToLines(list: string[] | undefined): string {
  return (list || []).join('\n')
}
const styleKeywordsText = computed(() => listToLines(brand.value?.imagePrompts?.style_keywords))
const negativePromptsText = computed(() => listToLines(brand.value?.imagePrompts?.negative_prompts))
const bannedWordsText = computed(() => listToLines(brand.value?.metadata?.banned_words))

function onStyleKeywordsInput(e: Event) {
  if (!brand.value) return
  if (!brand.value.imagePrompts) brand.value.imagePrompts = {}
  brand.value.imagePrompts.style_keywords = linesToList((e.target as HTMLTextAreaElement).value)
}
function onNegativePromptsInput(e: Event) {
  if (!brand.value) return
  if (!brand.value.imagePrompts) brand.value.imagePrompts = {}
  brand.value.imagePrompts.negative_prompts = linesToList((e.target as HTMLTextAreaElement).value)
}
function onBannedWordsInput(e: Event) {
  if (!brand.value) return
  if (!brand.value.metadata) brand.value.metadata = {}
  brand.value.metadata.banned_words = linesToList((e.target as HTMLTextAreaElement).value)
}

function ensureSubobjects(b: Brand): Brand {
  // The editor binds nested fields directly; ensure every section exists
  // so v-model has somewhere to write.
  return {
    ...b,
    channel: b.channel ?? {},
    visual: { ...(b.visual ?? {}), color_palette: b.visual?.color_palette ?? {} },
    narration: b.narration ?? {},
    imagePrompts: { ...(b.imagePrompts ?? {}), style_keywords: b.imagePrompts?.style_keywords ?? [] },
    metadata: { ...(b.metadata ?? {}), banned_words: b.metadata?.banned_words ?? [] },
    pronunciation_lexicon: b.pronunciation_lexicon ?? [],
  }
}

// Per-row "Advanced" disclosure state. Tracks indices of rows whose
// IPA / SSML / case-sensitive controls are expanded.
const advancedRows = ref(new Set<number>())
function toggleAdvanced(idx: number) {
  if (advancedRows.value.has(idx)) advancedRows.value.delete(idx)
  else advancedRows.value.add(idx)
  // Trigger reactivity — Set mutations don't auto-trigger Vue refs.
  advancedRows.value = new Set(advancedRows.value)
}

function addLexEntry() {
  if (!brand.value) return
  if (!brand.value.pronunciation_lexicon) brand.value.pronunciation_lexicon = []
  brand.value.pronunciation_lexicon.push({ term: '', alt_spelling: '' })
}

function removeLexEntry(idx: number) {
  if (!brand.value?.pronunciation_lexicon) return
  brand.value.pronunciation_lexicon.splice(idx, 1)
  // Reindex the advanced-disclosure set: any open row at idx+ shifts down by 1.
  const next = new Set<number>()
  for (const i of advancedRows.value) {
    if (i < idx) next.add(i)
    else if (i > idx) next.add(i - 1)
  }
  advancedRows.value = next
}

async function reload() {
  loadError.value = null
  try {
    const b = await loadOne(id.value)
    if (!b) {
      loadError.value = `Brand "${id.value}" not found.`
      return
    }
    brand.value = ensureSubobjects(b)
    original.value = JSON.stringify(brand.value)
  } catch (e: any) {
    loadError.value = e?.data?.detail || e?.message || 'Failed to load brand'
  }
}

async function save() {
  if (!brand.value) return
  saving.value = true
  try {
    // Strip empty objects/arrays before save so the on-disk JSON stays tidy.
    const cleaned = pruneEmpty(brand.value) as Brand
    await update(cleaned)
    original.value = JSON.stringify(cleaned)
    brand.value = ensureSubobjects(cleaned)
  } catch (e: any) {
    loadError.value = e?.data?.detail || e?.message || 'Failed to save brand'
  } finally {
    saving.value = false
  }
}

function pruneEmpty(b: Brand): Brand {
  const out: any = { id: b.id, name: b.name, schemaVersion: 1 }
  if (b.format_default_id) out.format_default_id = b.format_default_id
  if (b.format_overrides) out.format_overrides = b.format_overrides

  const channel = trimObj(b.channel)
  if (channel) out.channel = channel

  const visual: any = {}
  if (b.visual?.logo_path) visual.logo_path = b.visual.logo_path
  if (b.visual?.font_family) visual.font_family = b.visual.font_family
  const palette = trimObj(b.visual?.color_palette)
  if (palette) visual.color_palette = palette
  if (Object.keys(visual).length) out.visual = visual

  const narr: any = {}
  if (b.narration?.persona) narr.persona = b.narration.persona
  if (b.narration?.default_voice_id) narr.default_voice_id = b.narration.default_voice_id
  if (b.narration?.default_voice_settings) narr.default_voice_settings = b.narration.default_voice_settings
  if (Object.keys(narr).length) out.narration = narr

  const ip: any = {}
  if (b.imagePrompts?.style_keywords?.length) ip.style_keywords = b.imagePrompts.style_keywords
  if (b.imagePrompts?.style_sheet) ip.style_sheet = b.imagePrompts.style_sheet
  if (b.imagePrompts?.negative_prompts?.length) ip.negative_prompts = b.imagePrompts.negative_prompts
  if (Object.keys(ip).length) out.imagePrompts = ip

  const md: any = {}
  if (b.metadata?.description_outro_template) md.description_outro_template = b.metadata.description_outro_template
  if (b.metadata?.attribution_template) md.attribution_template = b.metadata.attribution_template
  if (b.metadata?.banned_words?.length) md.banned_words = b.metadata.banned_words
  if (Object.keys(md).length) out.metadata = md

  // Pronunciation lexicon — drop blank-term rows, strip empty optional fields.
  const lexicon = (b.pronunciation_lexicon || [])
    .map(row => {
      const term = (row.term || '').trim()
      if (!term) return null
      const entry: any = { term }
      if (row.alt_spelling?.trim()) entry.alt_spelling = row.alt_spelling.trim()
      if (row.ipa?.trim()) entry.ipa = row.ipa.trim()
      if (row.ssml?.trim()) entry.ssml = row.ssml.trim()
      if (row.case_sensitive) entry.case_sensitive = true
      return entry
    })
    .filter(Boolean)
  if (lexicon.length) out.pronunciation_lexicon = lexicon

  return out
}

function trimObj(o: any): any | null {
  if (!o) return null
  const out: any = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v !== '' && v !== null && v !== undefined) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

await reload()
watch(id, reload)
</script>

<style scoped>
.brand-editor {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px;
  color: var(--text-primary);
}
.page-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.page-header h1 {
  margin: 0;
  color: var(--accent);
}
.header-actions {
  display: flex;
  gap: 8px;
}
.editor-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Editor sections — match the global .card aesthetic but locally scoped
 * here because <section class="card"> with no .card global match would
 * still render plain, and we want consistent typography inside. */
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  color: var(--text-primary);
}
.card h2 {
  margin: 0 0 8px;
  font-size: 18px;
  color: var(--text-primary);
}
.card p.text-muted {
  margin-top: 0;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-muted);
}
.card p code {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.form-group {
  margin-bottom: 12px;
}
.form-group label {
  display: block;
  margin-bottom: 4px;
  font-weight: 500;
  font-size: 13px;
  color: var(--text-secondary);
}
.form-group label .text-muted {
  font-weight: 400;
  font-size: 12px;
}
.form-group > .text-muted {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.palette-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
}

.error-card {
  background: var(--bg-secondary);
  border: 1px solid #d97757;
  color: var(--text-primary);
  padding: 16px;
  border-radius: 8px;
}
.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--text-secondary);
}

/* Pronunciation lexicon — dark-aware row styling. */
.lex-empty {
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
.lex-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lex-row {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
}
.lex-grid {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 10px;
  align-items: end;
}
.lex-grid .form-group {
  margin-bottom: 0;
}
.lex-row-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.lex-advanced {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  display: grid;
  gap: 10px;
}
.lex-advanced-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.lex-case-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
.lex-case-toggle input[type="checkbox"] {
  accent-color: var(--accent);
}
.mt-2 {
  margin-top: 12px;
}
</style>
