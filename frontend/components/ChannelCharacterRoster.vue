<!--
  Channel roster — this channel's own Channel Characters, shown on the
  Character Sheet ABOVE the episode-specific cast and usable with no episode
  selected.

  Contract (2026-11-06 owner correction):
  - a character belongs to exactly one channel; this roster reads and edits
    only GET/POST/PUT /projects/:slug/characters and its reference-image routes
  - no global character-library read for edit, no channel assignment labels,
    and no multi-channel voice profiles — the record carries this channel's
    voice only
  - the episode cast stays on listForEpisode in the page's own ref with its
    own race fence; this component has its own sequence fence and never feeds
    dropUnknownAnchors or the continuity save
  - edits go through CharacterRecordEditor: staged until Save, Cancel never saves
-->
<template>
  <section class="card mt-3 cs-roster">
    <header class="cs-section-head">
      <div>
        <span class="cs-kicker">Channel roster</span>
        <h3>Channel characters</h3>
        <p class="text-muted text-sm">Characters stored on this channel only — identity, reference images and voice. No episode needed.</p>
      </div>
      <div class="cs-roster-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading" @click="load">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
        <button class="btn btn-primary btn-sm" @click="openCreate">+ New Character</button>
      </div>
    </header>

    <WorkspaceNotice v-if="loadError" class="mt-3" tone="error" title="Channel characters could not be loaded">
      {{ loadError }}
      <button class="btn btn-ghost btn-sm" @click="load">Retry</button>
    </WorkspaceNotice>

    <template v-else>
      <div v-if="loading && !records.length" class="text-muted text-sm mt-3">Loading characters…</div>

      <EmptyState
        v-else-if="!records.length"
        class="mt-3"
        icon="&#127917;"
        title="No characters on this channel yet"
        message="Create a character here to reuse its look and voice across this channel's episodes."
      >
        <template #action>
          <button class="btn btn-primary mt-2" @click="openCreate">+ New Character</button>
        </template>
      </EmptyState>

      <div v-else>
        <WorkspaceNotice v-if="legacyCount" class="mt-3" tone="info" title="Legacy characters are read-only here">
          {{ legacyCount }} {{ legacyCount === 1 ? 'record predates' : 'records predate' }} this channel's copies. They stay visible but cannot be edited until this channel's character library is migrated.
        </WorkspaceNotice>

        <div class="cs-roster-grid">
          <article v-for="record in records" :key="record.id" class="cs-roster-tile">
            <button
              class="cs-roster-portrait"
              type="button"
              :disabled="isLegacy(record)"
              :aria-label="isLegacy(record) ? `${record.name} is read-only until migration` : `Edit ${record.name}`"
              @click="openEdit(record)"
            >
              <img
                v-if="firstImage(record) && !previewFailed(record)"
                :src="portraitUrl(record)"
                :alt="`${record.name} reference image`"
                @error="markPreviewFailed(record)"
              />
              <span v-else class="cs-roster-initials" aria-hidden="true">{{ initials(record.name) }}</span>
            </button>
            <div class="cs-roster-copy">
              <div class="cs-roster-heading">
                <div class="cs-roster-title">
                  <span class="cs-roster-archetype">{{ record.archetype || 'Recurring character' }}</span>
                  <h4>{{ record.name }}</h4>
                </div>
                <button
                  class="btn btn-sm btn-secondary"
                  :disabled="isLegacy(record)"
                  :title="isLegacy(record) ? 'Read-only until this channel’s character library is migrated' : ''"
                  @click="openEdit(record)"
                >Edit</button>
              </div>
              <p class="cs-roster-desc">{{ record.description }}</p>
              <div class="cs-roster-chips">
                <span v-if="isLegacy(record)" class="cs-roster-chip legacy">legacy · read-only</span>
                <span v-else-if="hasVoice(record)" class="cs-roster-chip current">voice saved</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </template>

    <CharacterRecordEditor
      :visible="editorVisible"
      :character="editing"
      :slug="slug"
      @close="editorVisible = false"
      @saved="onSaved"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Character } from '../composables/useCharacters.js'

const props = defineProps<{ slug: string }>()

const cm = useCharacters(() => props.slug)
const { error: showError } = useToast()

const records = ref<Character[]>([])
const loading = ref(false)
const loadError = ref('')

const editorVisible = ref(false)
const editing = ref<Character | null>(null)
const legacyCount = computed(() => records.value.filter(isLegacy).length)

/** Unmigrated legacy rows are visible but read-only; every write returns 409. */
function isLegacy(record: Character): boolean {
  return record.source === 'library'
}

// Own race fence — deliberately separate from the page's characterScopeSequence
// that guards the episode cast (listForEpisode).
let rosterScopeSequence = 0

async function load(): Promise<void> {
  const project = props.slug
  const scope = rosterScopeSequence
  const current = () => scope === rosterScopeSequence && project === props.slug
  loading.value = true
  try {
    const all = await cm.list()
    if (!current()) return
    // The no-episode endpoint also returns legacy episode-scope records; the
    // roster is project-scope only. Episode cast stays listForEpisode below.
    records.value = all.filter(character => character.scope === 'project')
    loadError.value = ''
  } catch (e: any) {
    if (current() && !e?.__slugRace) loadError.value = e?.data?.detail || e?.message || 'Unknown loading error'
  } finally {
    if (current()) loading.value = false
  }
}

/** Read the record through this channel's own route before editing. */
async function openEdit(record: Character): Promise<void> {
  // Legacy rows are read-only until this channel's library is migrated; never
  // read the global store to fake an editable copy.
  if (isLegacy(record)) return
  const project = props.slug
  const scope = rosterScopeSequence
  try {
    const canonical = await cm.getOne(record.id)
    if (scope !== rosterScopeSequence || project !== props.slug) return
    if (!canonical) throw new Error('Character not found')
    editing.value = canonical
    editorVisible.value = true
  } catch (e: any) {
    if (scope === rosterScopeSequence && !e?.__slugRace) {
      showError(e?.data?.detail || e?.message || 'Character could not be opened')
    }
  }
}

function openCreate(): void {
  editing.value = null
  editorVisible.value = true
}

/** Reload so the list reflects server truth after a save. */
function onSaved(): void {
  void load()
}

function hasVoice(record: Character): boolean {
  return !!record.speech?.voiceId
}

function firstImage(record: Character): string | undefined {
  return record.references?.images?.[0]
}

function portraitUrl(record: Character): string {
  const id = encodeURIComponent(record.id)
  const file = encodeURIComponent(firstImage(record) || '')
  return `/api/projects/${encodeURIComponent(props.slug)}/characters/${id}/reference-image/${file}`
}

const failedPreviews = ref<Record<string, true>>({})
function previewFailed(record: Character): boolean {
  return !!failedPreviews.value[record.id]
}
function markPreviewFailed(record: Character): void {
  failedPreviews.value = { ...failedPreviews.value, [record.id]: true }
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}

// AGENTS §4: a channel change blanks the roster synchronously before the new
// read lands, and closes any editor bound to the previous channel.
watch(() => props.slug, () => {
  rosterScopeSequence++
  records.value = []
  loadError.value = ''
  editing.value = null
  editorVisible.value = false
  void load()
}, { immediate: true, flush: 'sync' })
</script>

<style scoped>
.cs-roster-actions { display: flex; align-items: center; gap: 8px; }
.cs-roster-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 12px; margin-top: 14px; }
.cs-roster-tile { display: grid; grid-template-columns: 96px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.cs-roster-portrait { border: 0; border-right: 1px solid var(--border); background: var(--bg-tertiary); color: var(--accent); cursor: pointer; overflow: hidden; padding: 0; }
.cs-roster-portrait img { width: 100%; height: 100%; min-height: 132px; object-fit: cover; display: block; }
.cs-roster-portrait:hover:not(:disabled) .cs-roster-initials { color: var(--accent); }
.cs-roster-portrait:disabled { cursor: not-allowed; opacity: .7; }
.cs-roster-initials { display: grid; width: 100%; min-height: 132px; place-items: center; font-size: 26px; font-weight: 700; }
.cs-roster-copy { padding: 14px 16px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.cs-roster-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.cs-roster-title h4 { margin: 2px 0 0; font-size: 16px; }
.cs-roster-archetype { color: var(--accent); font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .1em; }
.cs-roster-desc {
  margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.cs-roster-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
.cs-roster-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px;
  padding: 3px 9px; font-size: var(--font-xs); color: var(--text-muted);
}
.cs-roster-chip.current { border-color: rgba(245, 193, 88, .45); color: var(--text); background: rgba(245, 193, 88, .07); }
.cs-roster-chip.legacy { border-color: rgba(231, 103, 103, .4); color: #f08f8f; }
@media (max-width: 620px) {
  .cs-roster-actions { width: 100%; }
  .cs-roster-tile { grid-template-columns: 80px minmax(0, 1fr); }
}
</style>
