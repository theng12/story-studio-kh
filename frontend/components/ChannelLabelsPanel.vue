<template>
  <section class="card settings-panel channel-labels" aria-labelledby="channel-labels-heading">
    <header class="channel-labels-head">
      <h3 id="channel-labels-heading">Labels</h3>
      <p>
        Your own words for what this channel is — “Khmer”, “Sleep”, “History”.
        They show on the channel's card on the start page, which can then be
        searched, filtered and sorted by them.
      </p>
    </header>

    <div v-if="loading" class="channel-labels-state" aria-live="polite">Loading labels…</div>
    <div v-else-if="loadError" class="channel-labels-error" role="alert">
      <span>{{ loadError }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="load">Try again</button>
    </div>

    <template v-else>
      <div class="form-group">
        <label>Labels</label>
        <ChipInput
          v-model="draft"
          :suggestions="suggestions"
          placeholder="Add a label"
          allow-custom
          :max="MAX_PROJECT_LABELS"
        />
        <small class="channel-labels-hint">
          Up to {{ MAX_PROJECT_LABELS }} labels, each up to {{ MAX_PROJECT_LABEL_LENGTH }} characters.
          Spelling is not case-sensitive: “Sleep” and “sleep” are the same label, and the spelling
          already used is the one kept.
        </small>
      </div>

      <p v-if="saveError" class="channel-labels-error" role="alert">{{ saveError }}</p>

      <div class="channel-labels-actions">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="saving || !dirty"
          @click="save"
        >{{ saving ? 'Saving…' : 'Save labels' }}</button>
        <span v-if="savedAt && !dirty" class="channel-labels-saved" role="status">Saved</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * The channel's labels, in the identity tab beside its name and profile.
 *
 * Labels live on `ProjectMeta` in project.json — next to the name, not in a
 * store of their own — so they travel with the channel folder and the start
 * page gets them with the channel list it already reads. This panel writes them
 * through the ordinary project save path (`PUT /projects/:slug`), which is also
 * what normalises them: trimmed, case-insensitively de-duplicated with the first
 * spelling kept, and bounded by the ceilings in `contracts/project-labels.ts`.
 *
 * The suggestions are every label already used anywhere in this Library, so the
 * same label is not spelled two ways; a failed suggestion read leaves a plain
 * free-text field rather than an error, because the suggestion list is a
 * convenience and the label itself is the customer's.
 *
 * A project change replaces everything here (AGENTS.md §4): a stale answer from
 * the previous channel must never land on the new one, so every request carries
 * a generation and the draft is re-seeded from that channel's own metadata.
 */

import {
  MAX_PROJECT_LABELS,
  MAX_PROJECT_LABEL_LENGTH,
  labelCounts,
  labelSuggestions,
  normalizeProjectLabels,
} from '~/utils/channel-view'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ (e: 'saved', labels: string[]): void }>()

const { get, put } = useApi()

const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const savedAt = ref(0)
const draft = ref<string[]>([])
const stored = ref<string[]>([])
/** Every label in use in this Library. Best effort — never an error on screen. */
const libraryLabels = ref<string[]>([])

let loadSeq = 0

const suggestions = computed(() => labelSuggestions(libraryLabels.value, draft.value))
const dirty = computed(() => (
  JSON.stringify(normalizeProjectLabels(draft.value)) !== JSON.stringify(stored.value)
))

async function load(): Promise<void> {
  const request = ++loadSeq
  const target = props.slug
  draft.value = []
  stored.value = []
  loadError.value = ''
  saveError.value = ''
  savedAt.value = 0
  if (!target) { loading.value = false; return }
  loading.value = true
  try {
    const project = await get<{ labels?: unknown }>(`/projects/${target}`)
    if (request !== loadSeq) return
    stored.value = normalizeProjectLabels(project?.labels)
    draft.value = [...stored.value]
  } catch (e: any) {
    if (request !== loadSeq) return
    loadError.value = e?.data?.detail || 'Could not load this channel’s labels.'
    return
  } finally {
    if (request === loadSeq) loading.value = false
  }
  await loadSuggestions(request)
}

/**
 * The suggestions, read AFTER the labels: the panel is usable without them and a
 * failure here is silent by design (see the header comment).
 */
async function loadSuggestions(request: number): Promise<void> {
  try {
    const rows = await get<any[]>('/projects', { cache: 'no-store' })
    if (request !== loadSeq) return
    libraryLabels.value = labelCounts(rows).map(entry => entry.label)
  } catch {
    if (request === loadSeq) libraryLabels.value = []
  }
}

async function save(): Promise<void> {
  const target = props.slug
  if (!target || saving.value || !dirty.value) return
  saving.value = true
  saveError.value = ''
  try {
    const sent = normalizeProjectLabels(draft.value)
    const saved = await put<{ labels?: unknown }>(`/projects/${target}`, { labels: sent })
    if (target !== props.slug) return
    // The server's own answer is what is stored: its normalising rules are the
    // authority, and a label it refused is reported rather than assumed stored.
    // A reply carrying no list is not "no labels" — the just-sent list stands.
    stored.value = Array.isArray(saved?.labels) ? normalizeProjectLabels(saved.labels) : sent
    draft.value = [...stored.value]
    savedAt.value = Date.now()
    emit('saved', stored.value)
  } catch (e: any) {
    saveError.value = e?.data?.detail || 'Could not save the labels.'
  } finally {
    saving.value = false
  }
}

watch(() => props.slug, () => { void load() }, { immediate: true })
</script>

<style scoped>
/* The head sizes match ChannelProfilePanel above it, so the two cards read as
   one identity section rather than two different pages. */
.channel-labels-head { margin-bottom: 12px; }
.channel-labels-head h3 { margin: 0 0 4px; font-size: 18px; letter-spacing: -.015em; }
.channel-labels-head p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.channel-labels-state,
.channel-labels-error { color: var(--text-secondary); font-size: var(--font-sm); }
.channel-labels-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--error) 11%, transparent);
  color: var(--error);
}
.channel-labels-hint { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.channel-labels-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.channel-labels-saved { color: var(--success); font-size: var(--font-xs); font-weight: 650; }
</style>
