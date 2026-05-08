<!--
  Per-prompt Regenerate panel for /projects/:slug/image-prompts.

  Read-only listing of every scene + thumbnail prompt currently on disk
  for the selected episode, with a 🔁 Regenerate button per row that
  re-runs THAT ONE prompt through the LLM. Mirrors the per-chapter
  Regenerate UX on the Script Generator's OutlineReviewPanel.

  v1 — no in-place editing or reordering. The user picked "Regenerate
  only" via AskUserQuestion. Edit / reorder can land in v2 if needed.
-->
<template>
  <div v-if="show" class="card mt-2 prp">
    <div class="prp-head">
      <h3 class="prp-title">🔁 Prompt Review</h3>
      <span class="text-muted text-xs">
        Click 🔁 on any row to regenerate just that prompt — keeps the others on disk untouched.
      </span>
    </div>

    <div v-if="loading" class="text-muted text-md prp-status">
      <LoadingSpinner size="sm" /> Loading prompts…
    </div>
    <div v-else-if="error" class="text-muted text-md prp-status">
      {{ error }}
    </div>
    <template v-else>
      <ul v-if="scenes.length" class="prp-list" role="list">
        <li class="prp-section">Scenes</li>
        <li v-for="row in scenes" :key="`s-${row.number}`" class="prp-row">
          <PromptRow
            :row="row" :prefix="'Scene'"
            :busy="busy.has(`scene-${row.number}`)"
            :error="errors[`scene-${row.number}`] || null"
            @regenerate="regenerateOne('scene', row)"
          />
        </li>
      </ul>
      <ul v-if="thumbnails.length" class="prp-list" role="list">
        <li class="prp-section">Thumbnails</li>
        <li v-for="row in thumbnails" :key="`t-${row.number}`" class="prp-row">
          <PromptRow
            :row="row" :prefix="'Thumbnail'"
            :busy="busy.has(`thumbnail-${row.number}`)"
            :error="errors[`thumbnail-${row.number}`] || null"
            @regenerate="regenerateOne('thumbnail', row)"
          />
        </li>
      </ul>
      <div v-if="!scenes.length && !thumbnails.length" class="text-muted text-md prp-status">
        No prompts found yet. Click Generate above first.
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import PromptRow from './PromptReviewPanelRow.vue'

interface PromptRowData { number: number; title: string; prompt: string }

const props = defineProps<{
  projectSlug: string
  episodeId: string
  /** Episode title — required by resolveEpisodePaths backend-side to find
   *  the right folder. Without it, the GET 404s. */
  title?: string
  /** LLM model to use for regeneration. Falls back to gpt-4o backend-side
   *  when omitted; pass the same model used for the bulk batch so style
   *  + voice stay consistent. */
  model?: string
  /** Bumped by the parent (e.g. when the bulk image-prompts job
   *  completes) to force a re-read of the docx. */
  refreshKey?: number
}>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

const scenes = ref<PromptRowData[]>([])
const thumbnails = ref<PromptRowData[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const busy = ref<Set<string>>(new Set())
const errors = ref<Record<string, string>>({})

// Card visibility: only when we have an episode_id selected. Empty list
// renders the "click Generate" hint; full lists render the rows.
const show = computed(() => !!props.episodeId)

async function loadPrompts(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  loading.value = true
  error.value = null
  scenes.value = []
  thumbnails.value = []
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ scenes: PromptRowData[]; thumbnails: PromptRowData[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts${titleParam}`,
    )
    scenes.value = Array.isArray(data?.scenes) ? data.scenes : []
    thumbnails.value = Array.isArray(data?.thumbnails) ? data.thumbnails : []
  } catch (e: any) {
    if (e?.status === 404) {
      // 404 = prompts not generated yet → empty card with the "click
      // Generate" hint. Not an error condition for the user.
      scenes.value = []
      thumbnails.value = []
      error.value = null
    } else {
      error.value = e?.data?.detail || e?.message || 'Failed to load prompts'
    }
  } finally {
    loading.value = false
  }
}

async function regenerateOne(kind: 'scene' | 'thumbnail', row: PromptRowData): Promise<void> {
  const key = `${kind}-${row.number}`
  if (busy.value.has(key)) return
  busy.value = new Set([...busy.value, key])
  errors.value = { ...errors.value, [key]: '' }
  try {
    const data = await post<{ number: number; title: string; prompt: string }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts/regenerate`,
      {
        kind, number: row.number,
        title: props.title,
        model: props.model,
      },
    )
    // Patch the in-memory list so the card reflects the new prompt
    // without a full reload.
    const list = kind === 'scene' ? scenes : thumbnails
    const idx = list.value.findIndex(p => p.number === row.number)
    if (idx >= 0) {
      list.value = [
        ...list.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...list.value.slice(idx + 1),
      ]
    }
    success(`${kind === 'scene' ? 'Scene' : 'Thumbnail'} ${row.number} regenerated`)
  } catch (e: any) {
    const msg = e?.data?.detail || e?.message || 'Regeneration failed'
    errors.value = { ...errors.value, [key]: msg }
    showError(msg)
  } finally {
    const next = new Set(busy.value)
    next.delete(key)
    busy.value = next
  }
}

watch(() => [props.episodeId, props.title, props.refreshKey], () => {
  if (props.episodeId) void loadPrompts()
}, { immediate: true })
</script>

<style scoped>
.prp { padding: 12px 14px; }
.prp-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.prp-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: var(--text-primary);
}
.prp-status { padding: 8px 0; }
.prp-list { list-style: none; margin: 8px 0 0 0; padding: 0; }
.prp-section {
  margin-top: 12px;
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-muted);
}
.prp-section:first-of-type { margin-top: 0; }
.prp-row { padding: 0; }
</style>
