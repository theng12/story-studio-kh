<template>
  <div class="niches-page">
    <header class="page-header">
      <div>
        <h1>Niches</h1>
        <p class="text-muted">
          Niches are the subject-domain layer — orthogonal to Format. Format
          decides <em>what shape</em> the video takes (sleep-story, listicle,
          bound-explainer); niche decides <em>what subject</em> it covers
          (plants, animals, fungi, your own). Generators read both at runtime
          and layer the niche's vocabulary, visual style, and YouTube tag hints
          on top of the format's defaults.
        </p>
      </div>
      <button class="btn btn-primary" :disabled="creating" @click="openCreator">
        + Create custom niche
      </button>
    </header>

    <div v-if="isLoading" class="loading">Loading niches…</div>
    <div v-else-if="error" class="error-box">
      Failed to load niches: {{ formatErr(error) }}
    </div>
    <div v-else-if="!niches.length" class="empty-box">
      No niches found. Create your first custom niche or restore the built-ins
      by reinstalling the app.
    </div>
    <div v-else class="niche-grid">
      <article
        v-for="n in niches"
        :key="n.id"
        class="niche-tile"
        :class="{ 'tile-builtin': n.builtin, 'tile-custom': !n.builtin }"
      >
        <div class="tile-header">
          <h2>{{ n.name }}</h2>
          <span v-if="!n.builtin" class="badge badge-custom">custom</span>
          <span v-else class="badge badge-builtin">built-in</span>
        </div>
        <p v-if="n.tagline" class="tile-tagline">{{ n.tagline }}</p>
        <p class="tile-description">{{ n.description }}</p>

        <div class="tile-stats">
          <span>
            <strong>{{ n.exampleTopics.length }}</strong>
            example {{ n.exampleTopics.length === 1 ? 'topic' : 'topics' }}
          </span>
          <span v-if="n.vocabulary?.keyword">
            <strong>{{ n.vocabulary.keyword.length }}</strong> keywords
          </span>
          <span v-if="n.referenceImages?.length">
            <strong>{{ n.referenceImages.length }}</strong> refs
          </span>
          <span v-if="n.project_count">
            in <strong>{{ n.project_count }}</strong>
            {{ n.project_count === 1 ? 'project' : 'projects' }}
          </span>
        </div>

        <details class="tile-details">
          <summary>Example topics</summary>
          <ul class="topic-list">
            <li v-for="t in n.exampleTopics.slice(0, 10)" :key="t">{{ t }}</li>
            <li v-if="n.exampleTopics.length > 10" class="topic-more">
              +{{ n.exampleTopics.length - 10 }} more
            </li>
          </ul>
        </details>

        <details v-if="n.visualStyleSheet || n.scriptContext" class="tile-details">
          <summary>Generator context</summary>
          <div v-if="n.scriptContext" class="detail-row">
            <strong>Script:</strong> {{ n.scriptContext }}
          </div>
          <div v-if="n.visualStyleSheet" class="detail-row">
            <strong>Visual:</strong> {{ n.visualStyleSheet }}
          </div>
          <div v-if="n.negativePromptAddendum" class="detail-row">
            <strong>Negative:</strong> {{ n.negativePromptAddendum }}
          </div>
        </details>

        <div class="tile-actions" v-if="!n.builtin">
          <button class="btn btn-ghost btn-sm" @click="confirmDelete(n)">
            Delete
          </button>
        </div>
      </article>
    </div>

    <!-- Create-niche modal. Two modes: blank form OR AI-assisted from a
         one-sentence niche description (LLM proposes a full niche JSON
         that the user reviews / edits before saving). -->
    <div v-if="showCreate" class="modal-backdrop" @click.self="closeCreator">
      <div class="modal">
        <header class="modal-header">
          <h2>Create custom niche</h2>
          <button class="btn btn-ghost btn-sm" @click="closeCreator">✕</button>
        </header>

        <div class="modal-body">
          <div class="form-group">
            <label>
              <strong>id</strong>
              <span class="hint">lowercase slug — letters, digits, dashes, underscores</span>
            </label>
            <input v-model="draft.id" class="input" placeholder="e.g. gemstones" :disabled="creating" />
          </div>

          <div class="form-group">
            <label>
              <strong>name</strong>
              <span class="hint">human-readable label shown in the picker</span>
            </label>
            <input v-model="draft.name" class="input" placeholder="e.g. Gemstones & Minerals" :disabled="creating" />
          </div>

          <div class="form-group">
            <label>
              <strong>tagline</strong>
              <span class="hint">optional one-liner shown on the niche card</span>
            </label>
            <input v-model="draft.tagline" class="input" placeholder="e.g. Crystalline, ancient, weirdly violent to form." :disabled="creating" />
          </div>

          <div class="form-group">
            <label>
              <strong>description</strong>
              <span class="hint">2-3 sentences describing what this niche covers</span>
            </label>
            <textarea v-model="draft.description" class="input" rows="3" :disabled="creating" />
          </div>

          <div class="form-group">
            <label>
              <strong>example topics</strong>
              <span class="hint">one per line — feeds the idea generator</span>
            </label>
            <textarea v-model="exampleTopicsText" class="input" rows="6" :disabled="creating" placeholder="Diamond&#10;Ruby&#10;Sapphire&#10;…" />
          </div>

          <div class="form-group">
            <label>
              <strong>script context</strong>
              <span class="hint">one-line context injected into the narration system prompt</span>
            </label>
            <textarea v-model="draft.scriptContext" class="input" rows="2" :disabled="creating" />
          </div>

          <div class="form-group">
            <label>
              <strong>visual style sheet</strong>
              <span class="hint">long-form style instructions appended to every image prompt</span>
            </label>
            <textarea v-model="draft.visualStyleSheet" class="input" rows="3" :disabled="creating" />
          </div>

          <div v-if="createError" class="error-box">{{ createError }}</div>
        </div>

        <footer class="modal-footer">
          <button class="btn btn-secondary" :disabled="creating" @click="closeCreator">Cancel</button>
          <button class="btn btn-primary" :disabled="creating || !canCreate" @click="submitCreate">
            {{ creating ? 'Creating…' : 'Create niche' }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import type { Niche } from '../composables/useNiches.js'

definePageMeta({ layout: 'dashboard' })

const { niches, isLoading, error, createNiche, deleteNiche } = useNiches()

function formatErr(e: any): string {
  return e?.data?.detail || e?.message || String(e)
}

// ── Create flow ────────────────────────────────────────────────────────────

const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')

const draft = reactive<{
  id: string
  name: string
  tagline: string
  description: string
  scriptContext: string
  visualStyleSheet: string
}>({
  id: '',
  name: '',
  tagline: '',
  description: '',
  scriptContext: '',
  visualStyleSheet: '',
})

const exampleTopicsText = ref('')

const canCreate = computed(() => {
  if (!draft.id.trim()) return false
  if (!draft.name.trim()) return false
  if (!draft.description.trim()) return false
  if (!exampleTopicsText.value.trim()) return false
  return /^[a-z0-9][a-z0-9_-]*$/.test(draft.id.trim())
})

function openCreator() {
  draft.id = ''
  draft.name = ''
  draft.tagline = ''
  draft.description = ''
  draft.scriptContext = ''
  draft.visualStyleSheet = ''
  exampleTopicsText.value = ''
  createError.value = ''
  showCreate.value = true
}

function closeCreator() {
  if (creating.value) return
  showCreate.value = false
}

async function submitCreate() {
  if (!canCreate.value) return
  creating.value = true
  createError.value = ''
  try {
    const topics = exampleTopicsText.value
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
    const body: Niche = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      builtin: false,
      schemaVersion: 1,
      tagline: draft.tagline.trim() || undefined,
      exampleTopics: topics,
      scriptContext: draft.scriptContext.trim() || undefined,
      visualStyleSheet: draft.visualStyleSheet.trim() || undefined,
    }
    await createNiche(body)
    showCreate.value = false
  } catch (e: any) {
    createError.value = e?.data?.detail || e?.message || 'Failed to create niche'
  } finally {
    creating.value = false
  }
}

// ── Delete flow ────────────────────────────────────────────────────────────

async function confirmDelete(n: Niche) {
  if (!confirm(`Delete niche "${n.name}"? This will fail if any project still references it.`)) return
  try {
    await deleteNiche(n.id)
  } catch (e: any) {
    alert('Failed to delete: ' + (e?.data?.detail || e?.message || 'unknown error'))
  }
}
</script>

<style scoped>
.niches-page {
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.page-header h1 {
  margin: 0 0 8px;
  font-size: 24px;
}

.page-header p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  max-width: 720px;
}

.loading, .empty-box, .error-box {
  padding: 24px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  text-align: center;
  color: var(--text-muted);
}

.error-box {
  color: var(--error, #e25c5c);
  background: rgba(226, 92, 92, 0.08);
  border-color: rgba(226, 92, 92, 0.3);
}

.niche-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}

.niche-tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.tile-builtin {
  border-left: 3px solid var(--accent, #6c8fff);
}

.tile-custom {
  border-left: 3px solid var(--warning, #d8a04a);
}

.tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tile-header h2 {
  margin: 0;
  font-size: 16px;
  flex: 1;
}

.badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 3px;
}

.badge-builtin {
  background: var(--accent-dim, #2a3148);
  color: var(--accent, #6c8fff);
}

.badge-custom {
  background: rgba(216, 160, 74, 0.16);
  color: var(--warning, #d8a04a);
}

.tile-tagline {
  margin: 0;
  font-size: 12px;
  font-style: italic;
  color: var(--text-muted);
}

.tile-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.tile-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
}

.tile-details summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--accent, #6c8fff);
  user-select: none;
}

.topic-list {
  list-style: none;
  padding: 8px 0 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.topic-list li {
  font-size: 11px;
  padding: 3px 8px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  color: var(--text-primary);
}

.topic-more {
  background: transparent !important;
  color: var(--text-muted) !important;
  font-style: italic;
}

.detail-row {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.tile-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  width: min(640px, 90vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-header h2 {
  margin: 0;
  font-size: 16px;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.form-group .hint {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
}
</style>
