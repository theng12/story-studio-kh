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
        Use these only where episode-specific wording belongs. Unknown placeholders are left empty, so double-check spelling before saving.
      </p>
    </section>

    <section class="card mt-3">
      <h3>Optional title wrapper</h3>
      <span class="hint">Leave empty to keep the approved episode title exactly as the Formula created it. Use only for a durable channel prefix or suffix.</span>
      <input v-model="tpl.title" class="input mt-1" placeholder="e.g. The Economics of {topic}" />
    </section>

    <section class="card mt-3">
      <h3>Recurring description blocks</h3>
      <span class="hint">Put <code>{summary}</code> near the top, then add stable links, credits, CTA, disclosure, or channel information below it.</span>
      <textarea v-model="tpl.description" rows="10" class="input mt-1" placeholder="e.g.&#10;{summary}&#10;&#10;Subscribe for more clear business explainers.&#10;Business enquiries: hello@example.com&#10;&#10;#Business #Economics" />
    </section>

    <section class="card mt-3">
      <h3>Recurring YouTube tags</h3>
      <span class="hint">One tag per line. Formula-specific episode tags are added alongside these. Empty results are dropped.</span>
      <textarea v-model="tagsText" rows="8" class="input mt-1" placeholder="{topic_tag}&#10;{keywords}&#10;business economics&#10;business explained" />
    </section>

    <div class="actions mt-3">
      <button class="btn btn-primary" :disabled="saving" @click="save">
        <LoadingSpinner v-if="saving" size="sm" />
        Save publishing profile
      </button>
      <button class="btn btn-ghost" :disabled="saving" @click="clearTpl">Clear profile (use Formula defaults)</button>
      <NuxtLink :to="`/projects/${slug}/metadata`" class="text-sm ml-auto">← Back to YouTube Finalizer</NuxtLink>
    </div>

    <div v-if="saveMessage" :class="['save-msg', saveMessage.ok ? 'is-ok' : 'is-err']">{{ saveMessage.text }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Channel Metadata Template')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put } = useApi()
const { success, error: showError } = useToast()

const tpl = reactive({
  title: '',
  description: '',
})
const tagsText = ref('')
const saving = ref(false)
const saveMessage = ref<{ ok: boolean; text: string } | null>(null)

async function load(): Promise<void> {
  try {
    const cfg = await get<any>(`/projects/${slug.value}/settings/config`)
    const t = cfg?.metadata_template || {}
    tpl.title = t.title || ''
    tpl.description = t.description || ''
    tagsText.value = Array.isArray(t.tags) ? t.tags.join('\n') : ''
  } catch { /* tolerate */ }
}

onMounted(load)

async function save(): Promise<void> {
  saving.value = true
  saveMessage.value = null
  try {
    const tags = tagsText.value.split('\n').map(t => t.trim()).filter(Boolean)
    const template: any = {}
    if (tpl.title.trim()) template.title = tpl.title.trim()
    if (tpl.description.trim()) template.description = tpl.description.trim()
    if (tags.length) template.tags = tags
    await put(`/projects/${slug.value}/settings/config`, {
      metadata_template: Object.keys(template).length ? template : undefined,
    })
    saveMessage.value = { ok: true, text: 'Saved. The next YouTube package will use this recurring channel copy.' }
    success('Publishing profile saved')
  } catch (e: any) {
    saveMessage.value = { ok: false, text: e?.data?.detail || e?.message || 'Save failed' }
    showError(saveMessage.value.text)
  } finally {
    saving.value = false
  }
}

async function clearTpl(): Promise<void> {
  tpl.title = ''
  tpl.description = ''
  tagsText.value = ''
  await save()
}
</script>

<style scoped>
.publishing-relationship { padding: 16px 18px; border: 1px solid rgba(240, 198, 116, .35); border-radius: var(--radius-md, 6px); background: linear-gradient(120deg, rgba(240, 198, 116, .10), rgba(95, 179, 124, .06)); }
.relationship-kicker { display: block; margin-bottom: 10px; color: var(--accent); text-transform: uppercase; letter-spacing: .09em; font-weight: 700; font-size: var(--font-xs); }
.relationship-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.relationship-grid div { display: grid; gap: 3px; padding: 10px 12px; border-radius: 6px; background: rgba(11, 15, 25, .28); }
.relationship-grid span { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.card { padding: 14px 18px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md, 6px); }
.card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.hint { font-size: var(--font-xs); color: var(--text-muted); }
.input { width: 100%; }
textarea.input { font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical; }
.ph-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ph-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
.ph-table td:first-child { width: 140px; font-family: var(--font-mono, monospace); }
.actions { display: flex; gap: 8px; align-items: center; }
.ml-auto { margin-left: auto; }
.save-msg { padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-top: 12px; }
.save-msg.is-ok { background: rgba(34,197,94,0.10); color: rgb(21,128,61); }
.save-msg.is-err { background: rgba(220,38,38,0.10); color: rgb(185,28,28); }
@media (max-width: 640px) { .relationship-grid { grid-template-columns: 1fr; } .actions { align-items: stretch; flex-direction: column; } .ml-auto { margin-left: 0; } }
</style>
