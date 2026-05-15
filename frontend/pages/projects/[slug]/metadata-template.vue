<!--
  Channel-locked metadata template editor.
  Per-project page where you write a TITLE / DESCRIPTION / TAGS template
  with `{placeholders}`. The metadata generator then fills only the
  placeholders from the episode's story context, keeping the surrounding
  copy consistent across every upload. v1.0.89+.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Channel Metadata Template</h1>
    </div>

    <p class="text-muted mt-2">
      When this template is set, the Metadata Generator stops writing each title / description / tag pool from scratch.
      Instead, ONE small LLM call extracts the <strong>{placeholder}</strong> values from the episode's story context,
      and your template stays intact around them. Reads like the same editorial voice every episode.
    </p>

    <section class="card mt-3">
      <h3>Placeholders you can use</h3>
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
        Unknown placeholders pass through as empty strings (so a typo silently elides rather than leaving literal <code>{badname}</code> in the title).
      </p>
    </section>

    <section class="card mt-3">
      <h3>Title</h3>
      <span class="hint">One line. Keep within ~70 chars when rendered.</span>
      <input v-model="tpl.title" class="input mt-1" placeholder="e.g. Morning Prayer for {topic}" />
    </section>

    <section class="card mt-3">
      <h3>Description</h3>
      <span class="hint">Multi-line. Mention <code>{summary}</code> early. Hashtags / CTAs etc. stay verbatim.</span>
      <textarea v-model="tpl.description" rows="10" class="input mt-1" placeholder="e.g.&#10;{summary}&#10;&#10;Subscribe for daily prayer ({date_long} · {episode_code}).&#10;&#10;#Prayer #Devotional" />
    </section>

    <section class="card mt-3">
      <h3>Tags</h3>
      <span class="hint">One tag per line. Each line can contain placeholders. Empty results dropped.</span>
      <textarea v-model="tagsText" rows="8" class="input mt-1" placeholder="{topic_tag}&#10;{keywords}&#10;prayer&#10;daily prayer&#10;morning prayer" />
    </section>

    <div class="actions mt-3">
      <button class="btn btn-primary" :disabled="saving" @click="save">
        <LoadingSpinner v-if="saving" size="sm" />
        💾 Save template
      </button>
      <button class="btn btn-ghost" :disabled="saving" @click="clearTpl">Clear template (revert to LLM-from-scratch)</button>
      <NuxtLink :to="`/projects/${slug}/metadata`" class="text-sm ml-auto">← Back to Metadata Generator</NuxtLink>
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
    saveMessage.value = { ok: true, text: 'Saved. Next metadata generation for this project will use the template.' }
    success('Template saved')
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
.card { padding: 14px 18px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md, 6px); }
.card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.hint { font-size: 11px; color: var(--text-muted); }
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
</style>
