<template>
  <div class="fish-expr">
    <div class="fish-expr-head">
      <label class="fish-expr-toggle" :title="modelValue ? 'Audio will render the tagged script below' : 'Audio renders the plain narration'">
        <input
          type="checkbox"
          :checked="modelValue"
          @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
        />
        <span>Use expression markup</span>
        <span class="fish-expr-badge">Fish S2</span>
      </label>
      <span v-if="sections.length" class="text-muted text-xs">{{ taggedCount }}/{{ sections.length }} tagged</span>
    </div>
    <p class="text-muted text-xs fish-expr-hint">
      Fish S2 performs inline <code>[tags]</code> — e.g. <code>[whispering]</code>, <code>[excited]</code>,
      <code>[long&nbsp;pause]</code>, or free-form like <code>[dead&nbsp;tired]</code>. Draft them with AI, then
      review &amp; edit. When the toggle is on, the audio renders this tagged script instead of the plain narration —
      and any section you haven't tagged yet is <strong>auto-tagged at render time</strong> (including Pipeline runs), so it works hands-off.
    </p>

    <div v-if="!episodeId" class="text-muted text-xs fish-expr-empty">Pick an episode to mark up its script.</div>
    <div v-else-if="loadError" class="fish-expr-error">{{ loadError }}</div>
    <template v-else>
      <div class="fish-expr-row">
        <select v-model="markupModel" class="select fish-expr-model" title="Which LLM writes the tags">
          <template v-if="modelGroups.length">
            <optgroup v-for="g in modelGroups" :key="g.provider" :label="g.label">
              <option v-for="m in g.items" :key="m.id" :value="m.id" :disabled="!m.available">
                {{ m.label }}{{ m.available ? '' : ' · needs API key' }}
              </option>
            </optgroup>
          </template>
          <option v-else :value="markupModel">{{ markupModel }}</option>
        </select>
        <button type="button" class="btn btn-sm" :disabled="!!busy || jobActive || !sections.length" @click="generateAll">
          {{ jobActive ? `Tagging… (${taggedCount}/${sections.length})` : '✨ Tag all with AI' }}
        </button>
      </div>

      <p v-if="jobActive" class="text-muted text-xs fish-expr-bg">
        ⏳ Tagging all sections in the background — this keeps running even if you leave this page. Come back anytime to review.
      </p>

      <div v-if="sections.length" class="fish-expr-editor">
        <div class="fish-expr-row">
          <select v-model="activeSlug" class="select fish-expr-section">
            <option v-for="s in sections" :key="s.slug" :value="s.slug">
              {{ s.label }}{{ edits[s.slug] && edits[s.slug].trim() ? ' ✓' : '' }}
            </option>
          </select>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="!!busy || !activeSlug" title="Re-tag just this section with AI" @click="generateOne">
            {{ busy === activeSlug ? 'Tagging…' : '✨ This one' }}
          </button>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="!activeSlug || !draft" title="Clear tags for this section — falls back to the plain narration" @click="resetActive">
            Clear
          </button>
        </div>

        <div class="fish-expr-tags">
          <button v-for="t in TAGS" :key="t" type="button" class="tag-chip" :title="`Insert [${t}] at the cursor`" @click="insertTag(t)">{{ t }}</button>
        </div>

        <textarea
          ref="editorEl"
          v-model="draft"
          class="textarea fish-expr-text"
          rows="10"
          spellcheck="false"
          placeholder="No tags yet for this section. Click ✨ to draft them with AI, or type [tags] in yourself."
        />

        <div class="fish-expr-row">
          <button type="button" class="btn btn-sm" :disabled="!!busy || !dirty" @click="save">
            {{ busy === 'save' ? 'Saving…' : (dirty ? 'Save edits' : 'Saved') }}
          </button>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="!activeOriginal || draft === activeOriginal" title="Replace the editor with the untagged narration so you can re-tag from scratch" @click="draft = activeOriginal">
            Load plain text
          </button>
          <span v-if="dirty" class="text-muted text-xs">Unsaved edits</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useApi } from '~/composables/useApi'
import { PROVIDER_DISPLAY } from '~/composables/useModelGroups'

interface ExprSection { slug: string; label: string; original: string; expressive: string }
interface ModelRow { id: string; label: string; provider: string; available: boolean }

const props = defineProps<{
  projectSlug: string
  episodeId: string | null
  /** Bound to form.use_expression. */
  modelValue: boolean
}>()
defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const { get, post, put } = useApi()

// Text models for the tagging pass — pulled live from /models so every
// configured provider (DeepSeek, OpenAI/ChatGPT, OpenRouter, kie Claude/GPT/
// Gemini, LM Studio) is offered, grouped + labelled. Models without a key show
// disabled. Defaults to the cheap DeepSeek Flash when it's available.
const markupModel = ref('deepseek-v4-flash')
const modelGroups = ref<Array<{ provider: string; label: string; items: ModelRow[] }>>([])
const PROV_ORDER = ['deepseek', 'openrouter', 'openai', 'kie', 'lmstudio']

async function loadModels() {
  try {
    const rows = await get<ModelRow[]>(`/models?project=${props.projectSlug}`)
    const byProv = new Map<string, ModelRow[]>()
    for (const m of rows) {
      if (!byProv.has(m.provider)) byProv.set(m.provider, [])
      byProv.get(m.provider)!.push(m)
    }
    const provs = [...byProv.keys()].sort((a, b) => {
      const ai = PROV_ORDER.indexOf(a), bi = PROV_ORDER.indexOf(b)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.localeCompare(b)
    })
    modelGroups.value = provs.map(p => ({ provider: p, label: PROVIDER_DISPLAY[p] || p, items: byProv.get(p)! }))
    // Keep the current choice if still usable; else fall back to the first
    // available (preferring the cheap DeepSeek default when present).
    if (!rows.some(m => m.id === markupModel.value && m.available)) {
      const pref = rows.find(m => m.id === 'deepseek-v4-flash' && m.available)
      const firstAvail = pref || rows.find(m => m.available)
      if (firstAvail) markupModel.value = firstAvail.id
    }
  } catch { /* leave the default single option */ }
}

// Quick-insert palette (covers the blog's tag categories; the AI + free typing
// handle everything else, since Fish tags are open-domain).
const TAGS = [
  'whispering', 'soft voice', 'warmly', 'excited', 'emphasis', 'sad', 'angry', 'shouting',
  'sigh', 'exhale', 'gasp', 'laughing', 'chuckling', 'short pause', 'long pause',
]

const sections = ref<ExprSection[]>([])
const edits = reactive<Record<string, string>>({})   // working expressive text per slug
const saved = reactive<Record<string, string>>({})   // last server-confirmed text per slug
const activeSlug = ref('')
const busy = ref<string>('')                          // '' | 'all' | 'save' | '<slug>'
const jobActive = ref(false)                          // a background "Tag all" is running
const loadError = ref('')
const editorEl = ref<HTMLTextAreaElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

const activeOriginal = computed(() => sections.value.find(s => s.slug === activeSlug.value)?.original || '')
const taggedCount = computed(() => sections.value.filter(s => (edits[s.slug] || '').trim()).length)
const dirty = computed(() => sections.value.some(s => (edits[s.slug] || '') !== (saved[s.slug] || '')))

const draft = computed<string>({
  get: () => edits[activeSlug.value] || '',
  set: (v) => { if (activeSlug.value) edits[activeSlug.value] = v },
})

function applyServer(rows: ExprSection[]) {
  sections.value = rows
  for (const r of rows) { edits[r.slug] = r.expressive || ''; saved[r.slug] = r.expressive || '' }
  if (!activeSlug.value && rows.length) activeSlug.value = rows[0]!.slug
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
function startPolling() { if (!pollTimer) pollTimer = setInterval(() => { void load() }, 4000) }

async function load() {
  if (!props.episodeId) { sections.value = []; jobActive.value = false; stopPolling(); return }
  loadError.value = ''
  try {
    const r = await get<{ sections: ExprSection[]; job_active?: boolean }>(`/projects/${props.projectSlug}/episodes/${props.episodeId}/expression`)
    applyServer(r.sections || [])
    jobActive.value = !!r.job_active
    // While a background "Tag all" runs, poll for live progress (the job saves
    // each section as it finishes) and keep the button in its busy state.
    if (jobActive.value) { busy.value = 'all'; startPolling() }
    else { stopPolling(); if (busy.value === 'all') busy.value = '' }
  } catch (e: any) {
    sections.value = []
    loadError.value = e?.data?.detail || 'Could not load the script for this episode. Generate the narration first.'
  }
}

// "Tag all" runs as a BACKGROUND JOB — it keeps tagging even if you leave the
// Audio Generator page, saving each section as it goes. We just kick it off and
// poll for progress; returning to the page reattaches via the load() check.
async function generateAll() {
  if (busy.value || jobActive.value) return
  busy.value = 'all'
  loadError.value = ''
  try {
    await post(`/projects/${props.projectSlug}/episodes/${props.episodeId}/expression/generate-all`, { model: markupModel.value })
    jobActive.value = true
    startPolling()
  } catch (e: any) {
    const detail = e?.data?.detail || ''
    if (e?.status === 409 || /already (running|tagging)/i.test(detail)) {
      jobActive.value = true; startPolling()   // one is already going — just attach
    } else {
      busy.value = ''
      loadError.value = detail || 'Could not start tagging. Check your text-model API key in Settings.'
    }
  }
}

async function generateOne() {
  if (busy.value || !activeSlug.value) return
  const slug = activeSlug.value
  busy.value = slug
  try {
    const r = await post<{ sections: ExprSection[] }>(`/projects/${props.projectSlug}/episodes/${props.episodeId}/expression/generate`, { model: markupModel.value, slugs: [slug] })
    applyServer(r.sections || [])
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'AI tagging failed. Check your text-model API key in Settings.'
  } finally { busy.value = '' }
}

function resetActive() {
  if (activeSlug.value) edits[activeSlug.value] = ''
}

async function save() {
  if (busy.value || !dirty.value) return
  busy.value = 'save'
  try {
    const payload: Record<string, string> = {}
    for (const s of sections.value) payload[s.slug] = edits[s.slug] || ''
    const r = await put<{ sections: ExprSection[] }>(`/projects/${props.projectSlug}/episodes/${props.episodeId}/expression`, { sections: payload })
    applyServer(r.sections || [])
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'Could not save the expressive script.'
  } finally { busy.value = '' }
}

function insertTag(tag: string) {
  const insert = `[${tag}] `
  const slug = activeSlug.value
  if (!slug) return
  const el = editorEl.value
  const cur = edits[slug] || ''
  if (!el) { edits[slug] = cur + insert; return }
  const start = el.selectionStart ?? cur.length
  const end = el.selectionEnd ?? cur.length
  edits[slug] = cur.slice(0, start) + insert + cur.slice(end)
  nextTick(() => {
    el.focus()
    const pos = start + insert.length
    try { el.setSelectionRange(pos, pos) } catch { /* detached */ }
  })
}

onMounted(() => { void loadModels(); void load() })
watch(() => props.episodeId, () => { activeSlug.value = ''; void load() })
onUnmounted(stopPolling)
</script>

<style scoped>
.fish-expr {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fish-expr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fish-expr-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 500; }
.fish-expr-badge {
  font-size: 10px; font-weight: 600;
  padding: 1px 6px; border-radius: 999px;
  background: var(--accent-soft, var(--bg-hover)); color: var(--accent);
}
.fish-expr-hint { margin: 0; line-height: 1.4; }
.fish-expr-bg { margin: 0; line-height: 1.4; color: var(--accent); }
.fish-expr-hint code {
  background: var(--bg-tertiary); padding: 0 3px; border-radius: 3px; font-size: 0.9em;
}
.fish-expr-empty, .fish-expr-error { padding: 4px 0; }
.fish-expr-error { color: var(--danger, #e5534b); font-size: 12px; }
.fish-expr-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fish-expr-model { flex: 0 1 220px; }
.fish-expr-section { flex: 1; min-width: 0; }
.fish-expr-editor { display: flex; flex-direction: column; gap: 6px; }
.fish-expr-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag-chip {
  font-size: 10px; line-height: 1;
  padding: 4px 7px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-tertiary);
  color: var(--text-secondary); cursor: pointer;
  transition: color 0.12s, background 0.12s, border-color 0.12s;
}
.tag-chip:hover { color: var(--accent); border-color: var(--accent); background: var(--bg-hover); }
.fish-expr-text {
  width: 100%; font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px; line-height: 1.5; resize: vertical; min-height: 160px;
}
</style>
