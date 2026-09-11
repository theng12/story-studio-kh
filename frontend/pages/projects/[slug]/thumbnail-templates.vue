<template>
  <div class="workspace-page thumbnail-template-workspace">
    <WorkspaceHero
      eyebrow="Library · Thumbnail composition"
      title="Thumbnail Recipe Catalog"
      description="Browse reusable thumbnail formats. Recipe cards can show real generated examples, direct the AI composition, and safely composite the final headline."
    >
      <template #aside><NuxtLink :to="`/projects/${slug}/images`" class="btn btn-sm btn-secondary">Back to Thumbnails</NuxtLink></template>
    </WorkspaceHero>

    <!-- Currently active row — shows what would be used for THIS project's -->
    <!-- next compose. Reads from the same resolution chain the compose -->
    <!-- endpoint uses (project override → niche default → legacy inline). -->
    <div class="card tt-active">
      <div class="tt-active-row">
        <div class="tt-active-info">
          <div class="tt-active-label">Active for {{ projectName || 'this project' }}</div>
          <div class="tt-active-name">
            <template v-if="effectiveLoading">Resolving…</template>
            <template v-else-if="effectiveTemplate">
              <strong>{{ effectiveTemplate.name }}</strong>
              <span v-if="effectiveSource" class="tt-active-source">
                — picked via {{ effectiveSource }}
              </span>
            </template>
            <template v-else>
              <span class="text-muted">No template set. Pick one below — it'll become the default for this project.</span>
            </template>
          </div>
        </div>
        <button
          v-if="effectiveTemplate && hasProjectOverride"
          type="button"
          class="btn btn-sm btn-ghost"
          :disabled="templateMutationBusy"
          @click="clearProjectOverride"
        >
          Clear project override
        </button>
      </div>
    </div>

    <div class="tt-section-headrow">
      <h2 class="tt-section-head">All thumbnail formats</h2>
      <button
        v-if="!editingId"
        :disabled="templateMutationBusy"
        type="button"
        class="btn btn-sm btn-primary"
        @click="onCreateTemplate"
      >
        + New template
      </button>
    </div>
    <p class="text-muted tt-section-hint">
      ★ marks templates recommended for this project's niche
      <template v-if="nicheId"> (<strong>{{ nicheId }}</strong>)</template>.
      Click any card to set it as the project default — the next thumbnail prompt and render use it automatically.
      Recipe cards keep the generated image text-free and composite a crisp headline afterward. Or hit <strong>Edit</strong> on any card to open the
      visual editor. Use <strong>+ New template</strong> to build one from scratch in your library
      (built-ins fork to your user library on first save).
    </p>

    <ThumbnailTemplatePicker
      v-if="!editingId"
      v-model="selectedId"
      :recommended-niche-id="nicheId"
      @change="onTemplateChange"
      :show-edit-buttons="true"
      @edit="onEditTemplate"
    />

    <!-- v1.0.108+ — inline visual editor. Mounts in place of the -->
    <!-- gallery while editing. Save forks built-ins; cancel reverts. -->
    <ThumbnailTemplateEditor
      v-else
      :template-id="editingId"
      @saved="onEditorSaved"
      @cancelled="onEditorCancelled"
    />

    <div class="card tt-howto mt-3">
      <h3 style="margin: 0 0 8px;">Add your own template</h3>
      <p class="text-muted tt-howto-p">
        Drop a JSON file into <code>{{ userTemplatesDirHint }}</code> following the shape of the
        built-in templates (see <code>electron/server/thumbnail-templates/portrait-block-right.json</code>
        in the app bundle). The new file appears in this gallery on next page load with its own
        live preview. No code changes; restart not required.
      </p>
      <p class="text-muted tt-howto-p" style="margin-top: 6px;">
        Each template declares: <code>aspectRatio</code>, <code>canvas</code>,
        <code>backgroundDimGradient</code>, <code>textZones</code> (title / subtitle positioning + font),
        <code>accentStrokes</code> (horizontal rules), and an optional <code>logoSlot</code>.
        See the schema in <code>electron/server/models/types.ts</code> for the full field list.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Standalone gallery + management page for the v1.0.105+ thumbnail-
 * template library.
 *
 * Reads:
 *   - GET /api/thumbnail-templates                          (via picker)
 *   - GET /api/projects/:slug/effective-thumbnail-template  (active state)
 *   - GET /api/projects/:slug/effective-niche               (★ filtering)
 *   - GET /api/projects/:slug/settings/config               (override check)
 *
 * Writes:
 *   - PUT /api/projects/:slug/settings/config
 *       { thumbnail_template_id }   — set a project override
 *       { thumbnail_template_id: '' }  — clear the override (re-resolves to niche default)
 *
 * No new endpoints needed. The compose endpoint already reads this
 * resolution chain at compose time.
 */
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, put } = useApi()
const { success: toastSuccess, error: toastError } = useToast()

const projectName = ref('')
const nicheId = ref('')
const selectedId = ref('')
const effectiveTemplate = ref<any | null>(null)
const effectiveSource = ref('') // 'project override' | 'niche default' | 'legacy inline'
const hasProjectOverride = ref(false)
const effectiveLoading = ref(true)
const editingId = ref('')
let thumbnailTemplateScope = 0
let thumbnailTemplateLoadRequest = 0
let editingScope = 0
let thumbnailTemplateMutation = 0
const templateMutationBusy = ref(false)

// Static hint string — the actual path is OS-specific (lives under
// PROJECTS_ROOT/.thumbnail-templates), but the user knows what
// PROJECTS_ROOT is from earlier setup. Avoids a server roundtrip just
// to display a directory hint.
const userTemplatesDirHint = '~/Documents/Story Studio KH/.thumbnail-templates/'

function resetThumbnailTemplateState() {
  projectName.value = ''
  nicheId.value = ''
  selectedId.value = ''
  effectiveTemplate.value = null
  effectiveSource.value = ''
  hasProjectOverride.value = false
  effectiveLoading.value = true
  editingId.value = ''
  editingScope = 0
  thumbnailTemplateMutation++
  templateMutationBusy.value = false
}

async function loadAll() {
  const projectSlug = slug.value
  const scope = thumbnailTemplateScope
  const request = ++thumbnailTemplateLoadRequest
  const current = () => projectSlug === slug.value
    && scope === thumbnailTemplateScope && request === thumbnailTemplateLoadRequest
  effectiveLoading.value = true
  try {
    const [project, niche, eff, cfg] = await Promise.all([
      get<{ name?: string }>(`/projects/${projectSlug}`),
      get<{ niche: any | null }>(`/projects/${projectSlug}/effective-niche`),
      get<{ template: any | null }>(`/projects/${projectSlug}/effective-thumbnail-template`),
      get<Record<string, any>>(`/projects/${projectSlug}/settings/config`),
    ])
    if (!current()) return
    projectName.value = project?.name || ''
    nicheId.value = niche?.niche?.id || ''
    effectiveTemplate.value = eff?.template || null
    selectedId.value = eff?.template?.id || ''

    const override = typeof cfg?.thumbnail_template_id === 'string' ? cfg.thumbnail_template_id : ''
    hasProjectOverride.value = !!override
    if (override && eff?.template?.id === override) {
      effectiveSource.value = 'project override'
    } else if (eff?.template && niche?.niche?.defaultThumbnailTemplateId === eff.template.id) {
      effectiveSource.value = `niche default (${niche.niche.id})`
    } else if (eff?.template) {
      effectiveSource.value = 'library default'
    } else {
      effectiveSource.value = ''
    }
  } catch (e: any) {
    if (!current()) return
    toastError(e?.data?.detail || 'Could not load thumbnail templates page')
  } finally {
    if (current()) effectiveLoading.value = false
  }
}

async function onTemplateChange(t: { id: string; name: string }) {
  if (templateMutationBusy.value) {
    selectedId.value = effectiveTemplate.value?.id || ''
    return
  }
  const projectSlug = slug.value
  const scope = thumbnailTemplateScope
  const mutation = ++thumbnailTemplateMutation
  const current = () => projectSlug === slug.value && scope === thumbnailTemplateScope && mutation === thumbnailTemplateMutation
  templateMutationBusy.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      thumbnail_template_id: t.id,
    })
    if (!current()) return
    toastSuccess(`Set "${t.name}" as the default for this project`)
    // Re-resolve so the "Active" card updates without a hard reload.
    await loadAll()
  } catch (e: any) {
    if (!current()) return
    toastError(e?.data?.detail || 'Could not save template choice')
  }
  finally {
    if (current()) templateMutationBusy.value = false
  }
}

// v1.0.108+ — inline visual editor state. When non-empty, the
// gallery is replaced by the editor for that template id.
function onEditTemplate(id: string) {
  if (templateMutationBusy.value) return
  editingScope = thumbnailTemplateScope
  editingId.value = id
}

// v1.0.417 — open the editor on a blank template. The editor recognises the
// sentinel 'new', starts from defaults, and POSTs a new user-library template
// on save (onEditorSaved then sets it as the project default).
function onCreateTemplate() {
  if (templateMutationBusy.value) return
  editingScope = thumbnailTemplateScope
  editingId.value = 'new'
}

async function onEditorSaved(savedId: string) {
  if (templateMutationBusy.value) return
  const projectSlug = slug.value
  const scope = editingScope
  const mutation = ++thumbnailTemplateMutation
  const current = () => projectSlug === slug.value && scope === thumbnailTemplateScope && mutation === thumbnailTemplateMutation
  if (!current()) return
  editingId.value = ''
  templateMutationBusy.value = true
  // The save may have forked a built-in to a new id. Switch the
  // project default to the saved id so the next compose uses the
  // edited copy. Also refreshes the gallery so the new card appears.
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      thumbnail_template_id: savedId,
    })
    if (!current()) return
    selectedId.value = savedId
  } catch (e: any) {
    if (!current()) return
    toastError(e?.data?.detail || e?.message || 'Could not set the edited template as this project’s default')
  } finally {
    if (!current()) return
    await loadAll()
    if (current()) templateMutationBusy.value = false
  }
}

function onEditorCancelled() {
  editingId.value = ''
}

async function clearProjectOverride() {
  if (templateMutationBusy.value) return
  const projectSlug = slug.value
  const scope = thumbnailTemplateScope
  const mutation = ++thumbnailTemplateMutation
  const current = () => projectSlug === slug.value && scope === thumbnailTemplateScope && mutation === thumbnailTemplateMutation
  templateMutationBusy.value = true
  try {
    await put(`/projects/${projectSlug}/settings/config`, {
      thumbnail_template_id: '',
    })
    if (!current()) return
    toastSuccess('Project override cleared — falling back to the niche default')
    await loadAll()
  } catch (e: any) {
    if (!current()) return
    toastError(e?.data?.detail || 'Could not clear override')
  } finally {
    if (current()) templateMutationBusy.value = false
  }
}

watch(slug, () => {
  thumbnailTemplateScope++
  thumbnailTemplateLoadRequest++
  resetThumbnailTemplateState()
  void loadAll()
}, { immediate: true })
</script>

<style scoped>
.tt-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.tt-header h1 {
  margin: 0;
}
.tt-intro {
  font-size: 13px;
  max-width: 780px;
  margin: 6px 0 16px;
  line-height: 1.5;
}
.tt-active {
  padding: 14px 16px;
}
.tt-active-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.tt-active-info {
  flex: 1;
  min-width: 0;
}
.tt-active-label {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted, #b3b3bb);
  margin-bottom: 2px;
}
.tt-active-name {
  font-size: 15px;
}
.tt-active-source {
  font-size: 12px;
  color: var(--text-muted, #b3b3bb);
}
.tt-section-headrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 24px;
}
.tt-section-headrow .tt-section-head {
  margin: 0;
}
.tt-section-head {
  margin: 24px 0 4px;
  font-size: 16px;
}
.tt-section-hint {
  font-size: 12px;
  max-width: 780px;
  margin: 0 0 14px;
}
.tt-howto-p code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
}
.tt-howto-p {
  font-size: 12px;
  margin: 0;
  line-height: 1.5;
}
</style>
