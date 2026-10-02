<template>
  <div class="ttp-root" :class="{ 'ttp-compact': compact }">
    <div v-if="loading" class="ttp-loading">Loading templates…</div>
    <div v-else-if="loadError" class="ttp-empty ttp-error" role="alert">
      Could not load thumbnail templates: {{ loadError }}
      <button type="button" class="btn btn-sm btn-ghost" @click="load">Retry</button>
    </div>
    <div v-else-if="!templates.length" class="ttp-empty">
      No thumbnail templates yet. Templates you create or install will appear here.
    </div>
    <div v-else class="ttp-grid" :class="{ 'ttp-grid-strip': compact }">
      <button
        v-for="t in sortedTemplates"
        :key="t.id"
        type="button"
        :class="['ttp-card', { 'is-active': t.id === modelValue, 'is-recommended': isRecommended(t) }]"
        :title="cardTooltip(t)"
        @click="select(t.id)"
      >
        <div class="ttp-preview-wrap">
          <img
            :src="t.previewImages?.[0] || previewUrl(t.id)"
            :alt="`${t.name} preview`"
            class="ttp-preview"
            loading="lazy"
          />
          <span v-if="isRecommended(t)" class="ttp-rec-badge" aria-label="Recommended for this niche">★</span>
          <span v-if="t.id === modelValue" class="ttp-active-badge" aria-label="Selected">✓</span>
        </div>
        <div class="ttp-meta">
          <div class="ttp-name">{{ t.name }}</div>
          <div v-if="t.tagline" class="ttp-tagline">{{ t.tagline }}</div>
          <div v-if="showEditButtons" class="ttp-actions">
            <button
              type="button"
              class="link-btn ttp-edit"
              :title="t.builtin
                ? 'Open the visual editor. Saving makes your own copy; the built-in template stays as it is.'
                : 'Open the visual editor. Changes save to your own template.'"
              @click.stop="emit('edit', t.id)"
            >
              {{ t.builtin ? 'Edit a copy' : 'Edit' }}
            </button>
          </div>
        </div>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Thumbnail-template gallery picker (v1.0.105+).
 *
 * Fetches /api/thumbnail-templates on mount; renders a clickable card
 * grid with the live preview render of each layout. Each preview comes
 * from /api/thumbnail-templates/:id/preview.png — the backend composites
 * the template's SVG overlay over a synthetic placeholder portrait so
 * the user sees the actual text layout, not just a name.
 *
 * Two modes:
 *   - Full grid (default) — used on the Settings → Thumbnail Templates
 *     page. Three-up grid, generous spacing.
 *   - Compact strip (`compact` prop) — horizontally-scrolling strip,
 *     embedded inside the Compose dialog. Same data, smaller cards.
 *
 * `recommendedNicheId` prop is advisory only: templates whose
 * `recommendedNicheIds` includes that id show a ★ badge and sort to
 * the top. Every template stays clickable regardless — the user is in
 * charge.
 */
import { ref, computed, onMounted } from 'vue'
import { useApi } from '~/composables/useApi'

interface ThumbnailTemplateLite {
  id: string
  name: string
  description: string
  tagline?: string
  builtin: boolean
  recommendedNicheIds?: string[]
  previewImages?: string[]
  category?: string
  tags?: string[]
  recipe?: { titleMode?: 'ai' }
}

const props = defineProps<{
  /** Currently-selected template id. Two-way bound via update:modelValue. */
  modelValue: string
  /** The project's niche id. Templates whose recommendedNicheIds
   *  includes this float to the top of the gallery with a ★ badge. */
  recommendedNicheId?: string
  /** Compact horizontal-strip layout for embedding in a dialog. */
  compact?: boolean
  /** v1.0.108+ — show per-card "Edit" buttons that open the visual
   *  editor. Hidden by default so the compact dialog strip stays
   *  uncluttered; turned on by the Thumbnail Templates management
   *  page. */
  showEditButtons?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** Fired with the full template object whenever selection changes —
   *  saves the parent a second roundtrip when it needs the template's
   *  textZones / logoSlot for hint UI. */
  'change': [template: ThumbnailTemplateLite]
  /** v1.0.108+ — Edit button clicked. Parent opens the visual editor. */
  'edit': [id: string]
}>()

const { get } = useApi()
const loading = ref(true)
const templates = ref<ThumbnailTemplateLite[]>([])

const sortedTemplates = computed(() => {
  const rec = props.recommendedNicheId
  return [...templates.value].sort((a, b) => {
    if (rec) {
      const aRec = (a.recommendedNicheIds || []).includes(rec) ? 1 : 0
      const bRec = (b.recommendedNicheIds || []).includes(rec) ? 1 : 0
      if (aRec !== bRec) return bRec - aRec
    }
    return a.name.localeCompare(b.name)
  })
})

function isRecommended(t: ThumbnailTemplateLite): boolean {
  if (!props.recommendedNicheId) return false
  return (t.recommendedNicheIds || []).includes(props.recommendedNicheId)
}

function cardTooltip(t: ThumbnailTemplateLite): string {
  const base = t.description || t.name
  if (isRecommended(t)) {
    return `${base}\n\n★ Recommended for this project's niche.`
  }
  return base
}

function previewUrl(id: string): string {
  // Cache-bust per session so dev edits to template JSONs show up
  // without a hard reload. In production the JSONs are immutable in
  // the bundle so the URL is effectively stable.
  return `/api/thumbnail-templates/${encodeURIComponent(id)}/preview.png?k=${_cacheKey.value}`
}

// One cache-key per mount — fresh values on every dialog open.
const _cacheKey = ref(Date.now())

function select(id: string) {
  if (id === props.modelValue) return
  emit('update:modelValue', id)
  const t = templates.value.find(x => x.id === id)
  if (t) emit('change', t)
}

// A failed read is not "no templates": it is shown with a Retry.
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const r = await get<{ templates: ThumbnailTemplateLite[] }>('/thumbnail-templates')
    templates.value = r.templates || []
  } catch (e: any) {
    templates.value = []
    loadError.value = e?.data?.detail || e?.message || 'unknown error'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ttp-root {
  width: 100%;
}
.ttp-loading,
.ttp-empty {
  font-size: 12px;
  color: var(--text-muted, #b3b3bb);
  padding: 16px 0;
  text-align: center;
}
.ttp-error { color: var(--danger, #dc2626); }
.ttp-empty code {
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: var(--font-xs);
}

/* Full grid (Settings page) */
.ttp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

/* Compact strip (Compose dialog) */
.ttp-grid-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 8px; /* room for scrollbar */
  scrollbar-width: thin;
}
.ttp-grid-strip .ttp-card {
  flex: 0 0 200px;
}

.ttp-card {
  border: 2px solid var(--border, rgba(255, 255, 255, 0.08));
  background: var(--surface-elevated, #25252b);
  border-radius: 8px;
  padding: 0;
  cursor: pointer;
  text-align: left;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.1s;
  color: var(--text, #e8e8ea);
}
.ttp-card:hover {
  border-color: var(--border-accent, rgba(120, 160, 220, 0.4));
  transform: translateY(-1px);
}
.ttp-card.is-active {
  border-color: var(--accent, #6ea8fe);
  box-shadow: 0 0 0 1px var(--accent, #6ea8fe) inset;
}
.ttp-preview-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
}
.ttp-preview {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.ttp-rec-badge,
.ttp-active-badge {
  position: absolute;
  top: 6px;
  font-size: 12px;
  font-weight: 700;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ttp-rec-badge {
  left: 6px;
  background: #f5bc42;
  color: #1a1a20;
}
.ttp-active-badge {
  right: 6px;
  background: var(--accent, #6ea8fe);
  color: #1a1a20;
}
.ttp-meta {
  padding: 8px 10px 10px;
}
.ttp-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}
.ttp-tagline {
  font-size: var(--font-xs);
  color: var(--text-muted, #b3b3bb);
  margin-top: 3px;
  line-height: 1.3;
}
.ttp-actions {
  margin-top: 8px;
}
.ttp-edit {
  font-size: var(--font-xs);
}

/* Compact-mode card metadata gets tighter */
.ttp-compact .ttp-name {
  font-size: 12px;
}
.ttp-compact .ttp-tagline {
  font-size: var(--font-xs);
}
.ttp-compact .ttp-meta {
  padding: 6px 8px 8px;
}
</style>
