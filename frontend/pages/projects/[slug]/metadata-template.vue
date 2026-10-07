<!--
  Project publishing profile editor. Formula owns episode-specific metadata;
  this page owns the recurring channel copy that should appear consistently
  across YouTube uploads.
-->
<template>
  <div class="workspace-page metadata-template-workspace">
    <WorkspaceHero
      eyebrow="Channel identity · Publishing"
      title="YouTube Publishing Profile"
      description="Set reusable channel copy once. Your Series Formula still writes each episode’s title, summary, sources, and tags."
    />

    <section class="publishing-relationship mt-3">
      <span class="relationship-kicker">Clear ownership</span>
      <div class="relationship-grid">
        <div><strong>Series Formula</strong><span>Episode-specific title, summary, voice, sources, and tags.</span></div>
        <div><strong>Publishing profile</strong><span>Recurring title wrapper, links, credits, CTA, disclosures, and channel copy.</span></div>
      </div>
    </section>

    <section class="card mt-3">
      <h3>Dynamic episode details</h3>
      <table class="ph-table">
        <tbody>
          <tr><td><code>{topic}</code></td><td>Short title-case phrase describing the episode (3-8 words).</td></tr>
          <tr><td><code>{topic_tag}</code></td><td>Lowercase 1-3 word tag version of the topic.</td></tr>
          <tr><td><code>{summary}</code></td><td>2-3 sentence plain-prose summary.</td></tr>
          <tr><td><code>{keywords}</code></td><td>Comma-separated 5-8 episode-specific keywords.</td></tr>
          <tr><td><code>{episode_code}</code></td><td>Literal episode code (no LLM call needed).</td></tr>
          <tr><td><code>{date}</code></td><td>Today's date (<code>YYYY-MM-DD</code>).</td></tr>
          <tr><td><code>{date_long}</code></td><td>Today's date (e.g. <code>May 15, 2026</code>).</td></tr>
        </tbody>
      </table>
      <p class="text-muted text-xs mt-2">
        Use these only where episode-specific wording belongs. Any other placeholder in braces is filled in by the writing model, so a typo gets invented text — double-check spelling before saving.
      </p>
    </section>

    <section class="card mt-3">
      <h3>Description formula</h3>
      <span class="hint">Choose the section architecture every episode's YouTube description follows by default. An episode can still override this for a single run on the YouTube Finalizer page.</span>
      <select v-model="selectedFormulaId" class="select mt-1" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError">
        <option value="">None — build sections manually (current behaviour)</option>
        <option v-for="f in formulas" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <div v-if="selectedFormula" class="formula-card mt-1">
        <div class="formula-card-header">
          <strong>{{ selectedFormula.name }}</strong>
          <span :class="['formula-source-badge', selectedFormula.source === 'built-in' ? 'is-builtin' : 'is-pack']">
            {{ selectedFormula.source === 'built-in' ? 'Built in' : 'From a pack' }}
          </span>
        </div>
        <p class="formula-architecture">{{ selectedFormula.architecture }}</p>
      </div>
      <p v-if="formulasError" class="text-muted text-xs mt-1">Could not load description formulas: {{ formulasError }}</p>
    </section>

    <section class="card mt-3">
      <h3>Optional title wrapper</h3>
      <span class="hint">Leave empty to keep the approved episode title exactly as the Formula created it. Use only for a durable channel prefix or suffix.</span>
      <input v-model="tpl.title" class="input mt-1" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError" placeholder="e.g. The Economics of {topic}" />
    </section>

    <section class="card mt-3">
      <h3>Recurring description blocks</h3>
      <span class="hint">Put <code>{summary}</code> near the top, then add stable links, credits, CTA, disclosure, or channel information below it.</span>
      <textarea v-model="tpl.description" rows="10" class="input mt-1" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError" placeholder="e.g.&#10;{summary}&#10;&#10;Subscribe for more clear business explainers.&#10;Business enquiries: hello@example.com&#10;&#10;#Business #Economics" />
    </section>

    <section class="card mt-3">
      <h3>Recurring YouTube tags</h3>
      <span class="hint">One tag per line. Formula-specific episode tags are added alongside these. Empty results are dropped.</span>
      <textarea v-model="tagsText" rows="8" class="input mt-1" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError" placeholder="{topic_tag}&#10;{keywords}&#10;business economics&#10;business explained" />
    </section>

    <div class="actions mt-3">
      <button class="btn btn-primary" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError" @click="save">
        <LoadingSpinner v-if="saving" size="sm" />
        Save publishing profile
      </button>
      <button class="btn btn-ghost" :disabled="saving || metadataTemplateLoading || !!metadataTemplateLoadError" @click="clearTpl">Clear Profile (Use Formula Defaults)</button>
      <NuxtLink :to="`/projects/${slug}/metadata`" class="text-sm ml-auto">← Back to YouTube Finalizer</NuxtLink>
    </div>

    <div v-if="unknownPlaceholders.length" class="save-msg is-err">
      Not recognised: {{ unknownPlaceholders.map(name => '{' + name + '}').join(', ') }}. The writing model fills these in for every episode — if one is a typo, fix it against the list above.
    </div>
    <div v-if="saveMessage" :class="['save-msg', saveMessage.ok ? 'is-ok' : 'is-err']">{{ saveMessage.text }}</div>
    <WorkspaceNotice v-if="metadataTemplateLoadError" tone="warning" title="Publishing profile unavailable" class="mt-3">
      {{ metadataTemplateLoadError }}
      <template #actions><button type="button" class="btn btn-secondary btn-sm" @click="reload">Retry</button></template>
    </WorkspaceNotice>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Channel Metadata Template')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()

const tpl = reactive({
  title: '',
  description: '',
})
const tagsText = ref('')
const saving = ref(false)
const saveMessage = ref<{ ok: boolean; text: string } | null>(null)
const metadataTemplateLoadError = ref('')
const metadataTemplateConfigLoading = ref(false)
const metadataFormulasLoading = ref(false)
const metadataTemplateLoading = computed(() => metadataTemplateConfigLoading.value || metadataFormulasLoading.value)

function resetMetadataTemplate() {
  tpl.title = ''
  tpl.description = ''
  tagsText.value = ''
  savedProfile.value = profileShape()
  formulas.value = []
  selectedFormulaId.value = ''
  savedFormulaId.value = ''
  formulasError.value = ''
  metadataTemplateLoadError.value = ''
  saveMessage.value = null
  saving.value = false
}

// ── Description formula (2026-08-27) ────────────────────────────────────────
// A metadata formula owns the description's section architecture, title
// shaping, tag guidance, and tone. This picker sets the CHANNEL default,
// persisted as `metadata_formula_id` on project config. An empty string
// means "no formula" — every existing channel keeps that as its default;
// nothing here auto-picks a formula for anyone.
interface MetadataFormula {
  id: string
  name: string
  description: string
  architecture: string
  source: 'built-in' | 'pack'
  pack_id: string | null
  section_count: number
  description_max_chars: number
  title_count: number
  tag_count: number
  outline: Array<{ id: string; header: string }>
}
const formulas = ref<MetadataFormula[]>([])
const selectedFormulaId = ref('')
const formulasError = ref('')
const selectedFormula = computed(() => formulas.value.find(f => f.id === selectedFormulaId.value) || null)

/** What is on disk, so "unsaved" is a comparison and never a guess. */
const savedProfile = ref('')
const savedFormulaId = ref('')
const profileShape = () => JSON.stringify([tpl.title, tpl.description, tagsText.value])
const dirty = computed(() => !metadataTemplateLoading.value && !metadataTemplateLoadError.value
  && (profileShape() !== savedProfile.value || selectedFormulaId.value !== savedFormulaId.value))
useUnsavedGuard(dirty, 'publishing profile edits')
// A "Saved." line must not stay up once the page no longer matches it.
watch(dirty, isDirty => { if (isDirty) saveMessage.value = null })

/** The placeholders the generator fills (see lib/metadata-template.ts). */
const KNOWN_PLACEHOLDERS = new Set(['topic', 'topic_tag', 'summary', 'keywords', 'episode_code', 'date', 'date_long'])
const unknownPlaceholders = computed(() => [...new Set(
  [...`${tpl.title}\n${tpl.description}\n${tagsText.value}`.matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)]
    .map(match => match[1]!.toLowerCase())
    .filter(name => !KNOWN_PLACEHOLDERS.has(name)),
)])
let metadataTemplateScope = 0
let metadataTemplateConfigRequest = 0
let metadataFormulaRequest = 0

async function loadFormulas(): Promise<void> {
  const projectSlug = slug.value
  const scope = metadataTemplateScope
  const request = ++metadataFormulaRequest
  const current = () => projectSlug === slug.value && scope === metadataTemplateScope && request === metadataFormulaRequest
  metadataFormulasLoading.value = true
  formulasError.value = ''
  try {
    const data = await get<{ channel_default_id: string; formulas: MetadataFormula[] }>(
      `/projects/${projectSlug}/metadata/formulas`,
    )
    if (!current()) return
    formulas.value = Array.isArray(data?.formulas) ? data.formulas : []
    selectedFormulaId.value = data?.channel_default_id || ''
    savedFormulaId.value = selectedFormulaId.value
  } catch (e: any) {
    if (!current()) return
    formulasError.value = e?.data?.detail || e?.message || 'unknown'
    metadataTemplateLoadError.value = `Could not load description formulas: ${formulasError.value}`
  } finally {
    if (current()) {
      metadataFormulasLoading.value = false
    }
  }
}

async function load(): Promise<void> {
  const projectSlug = slug.value
  const scope = metadataTemplateScope
  const request = ++metadataTemplateConfigRequest
  const current = () => projectSlug === slug.value && scope === metadataTemplateScope && request === metadataTemplateConfigRequest
  metadataTemplateConfigLoading.value = true
  try {
    const cfg = await get<any>(`/projects/${projectSlug}/settings/config`)
    if (!current()) return
    const t = cfg?.metadata_template || {}
    tpl.title = t.title || ''
    tpl.description = t.description || ''
    tagsText.value = Array.isArray(t.tags) ? t.tags.join('\n') : ''
    savedProfile.value = profileShape()
  } catch (e: any) {
    if (!current()) return
    metadataTemplateLoadError.value = e?.data?.detail || e?.message || 'Could not load this publishing profile.'
  } finally {
    if (current()) metadataTemplateConfigLoading.value = false
  }
}

function reload() {
  resetMetadataTemplate()
  void load()
  void loadFormulas()
}

watch(slug, () => {
  metadataTemplateScope++
  metadataTemplateConfigRequest++
  metadataFormulaRequest++
  resetMetadataTemplate()
  void load()
  void loadFormulas()
}, { immediate: true })

async function save(): Promise<void> {
  if (saving.value || metadataTemplateLoading.value || metadataTemplateLoadError.value) return
  const projectSlug = slug.value
  const scope = metadataTemplateScope
  const current = () => projectSlug === slug.value && scope === metadataTemplateScope
  saving.value = true
  saveMessage.value = null
  try {
    const tags = tagsText.value.split('\n').map(t => t.trim()).filter(Boolean)
    const template: any = {}
    if (tpl.title.trim()) template.title = tpl.title.trim()
    if (tpl.description.trim()) template.description = tpl.description.trim()
    if (tags.length) template.tags = tags
    const sentProfile = profileShape()
    const sentFormulaId = selectedFormulaId.value
    // An empty object, never `undefined`: JSON drops an undefined key, so
    // "Clear profile" used to leave the old profile on disk. An empty
    // template is what the generator treats as "no profile".
    await put(`/projects/${projectSlug}/settings/config`, {
      metadata_template: template,
      metadata_formula_id: selectedFormulaId.value,
    })
    if (!current()) return
    savedProfile.value = sentProfile
    savedFormulaId.value = sentFormulaId
    saveMessage.value = { ok: true, text: 'Saved. The next YouTube package will use this recurring channel copy.' }
    success('Publishing profile saved')
  } catch (e: any) {
    if (!current()) return
    saveMessage.value = { ok: false, text: e?.data?.detail || e?.message || 'Save failed' }
    showError(saveMessage.value.text)
  } finally {
    if (current()) saving.value = false
  }
}

async function clearTpl(): Promise<void> {
  const confirmed = await ask({
    title: 'Clear the publishing profile?',
    message: 'This removes the title wrapper, recurring description blocks and recurring tags for this channel. '
      + 'Episodes then use what the Series Formula writes. It cannot be undone.',
    confirmLabel: 'Clear Profile',
    danger: true,
  })
  if (!confirmed) return
  tpl.title = ''
  tpl.description = ''
  tagsText.value = ''
  await save()
}
</script>

<style scoped>
.publishing-relationship { padding: 16px 18px; border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: var(--radius-md, 6px); background: linear-gradient(120deg, color-mix(in srgb, var(--accent) 10%, transparent), rgba(95, 179, 124, .06)); }
.relationship-kicker { display: block; margin-bottom: 10px; color: var(--accent); text-transform: uppercase; letter-spacing: .09em; font-weight: 700; font-size: var(--font-xs); }
.relationship-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.relationship-grid div { display: grid; gap: 3px; padding: 10px 12px; border-radius: 6px; background: var(--bg-tertiary); }
.relationship-grid span { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.card { padding: 14px 18px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md, 6px); }
.card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.hint { font-size: var(--font-xs); color: var(--text-muted); }
.input { width: 100%; }
textarea.input { font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical; }
.ph-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ph-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
.ph-table td:first-child { width: 140px; font-family: var(--font-mono, monospace); }
.formula-card { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.formula-card-header { display: flex; align-items: center; gap: 8px; }
.formula-source-badge { font-size: var(--font-xs); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); }
.formula-source-badge.is-builtin { color: var(--accent); border-color: var(--accent); }
.formula-source-badge.is-pack { color: var(--success, #5fb37a); border-color: var(--success, #5fb37a); }
.formula-architecture { margin: 6px 0 0; font-size: 12px; color: var(--text-muted); line-height: 1.45; }
.actions { display: flex; gap: 8px; align-items: center; }
.ml-auto { margin-left: auto; }
.save-msg { padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-top: 12px; }
.save-msg.is-ok { background: rgba(34,197,94,0.10); color: rgb(21,128,61); }
.save-msg.is-err { background: rgba(220,38,38,0.10); color: rgb(185,28,28); }
@media (max-width: 640px) { .relationship-grid { grid-template-columns: 1fr; } .actions { align-items: stretch; flex-direction: column; } .ml-auto { margin-left: 0; } }
</style>
