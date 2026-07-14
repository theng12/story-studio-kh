<template>
  <div>
    <div class="presets-header">
      <h1>🗂 Presets</h1>
      <button class="btn btn-sm btn-ghost" :disabled="loading" @click="loadAll">
        <LoadingSpinner v-if="loading" size="sm" />
        {{ loading ? 'Loading…' : '↻ Refresh' }}
      </button>
    </div>

    <p class="text-muted mt-1 mb-2" style="font-size: 13px; max-width: 860px;">
      All presets saved for <strong>{{ projectName || 'this project' }}</strong>, grouped by where they're used.
      Heavy editing lives on each feature page — this view is for cross-cutting management (rename, delete, export).
      Presets are project-scoped: they don't follow you to other projects.
    </p>

    <div v-if="error" class="text-danger mt-2" style="font-size: 13px;">{{ error }}</div>

    <!-- Empty state -->
    <EmptyState
      v-if="!loading && !totalCount"
      icon="&#9881;"
      title="No presets saved yet"
      message="On any generator page, set up the options you like and hit Save preset — it'll show up here, ready to reuse on the next episode."
    />

    <!-- Preset groups -->
    <div v-for="group in groups" :key="group.key" class="preset-group card mt-2" v-show="group.items.length">
      <div class="group-head">
        <div>
          <h3 style="margin: 0">{{ group.icon }} {{ group.label }}</h3>
          <p class="text-muted" style="font-size: 12px; margin: 2px 0 0;">{{ group.hint }}</p>
        </div>
        <div class="group-actions">
          <NuxtLink v-if="group.editLink" :to="`/projects/${slug}${group.editLink}`" class="btn btn-sm btn-secondary">
            Edit on {{ group.label }} →
          </NuxtLink>
        </div>
      </div>

      <table class="preset-table mt-2">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in group.items" :key="`${group.key}-${p.id}`">
            <td>
              <input
                v-if="editing && editing.groupKey === group.key && editing.id === p.id"
                v-model="editing.name"
                class="input input-sm"
                @keydown.enter="confirmRename"
                @keydown.escape="cancelRename"
                @blur="confirmRename"
              />
              <button v-else class="label-btn" @click="startRename(group.key, p)">{{ p.name }}</button>
            </td>
            <td>
              <span class="type-chip">{{ p.type || 'legacy' }}</span>
            </td>
            <td class="col-actions">
              <button class="btn btn-sm btn-ghost" @click="duplicate(group.key, p)" title="Create a copy of this preset">Duplicate</button>
              <button class="btn btn-sm btn-ghost" @click="exportJson(group.key, p)" title="Download this preset as JSON">Export</button>
              <button class="btn btn-sm btn-danger" @click="remove(group.key, p)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!loading && totalCount" class="text-muted mt-2" style="font-size: 11px;">
      {{ totalCount }} preset{{ totalCount === 1 ? '' : 's' }} across {{ groupsWithItems }} group{{ groupsWithItems === 1 ? '' : 's' }}.
    </p>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put } = useApi()
const { project } = useProject()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const projectName = computed(() => project.value?.name || '')

interface PresetRecord { id: string; name: string; data?: any; type?: string }
interface PresetGroup {
  key: string
  label: string
  icon: string
  hint: string
  configKey: string      // e.g. 'script' → config.script_presets
  editLink?: string
  activeKey?: string     // e.g. 'script_last_preset'
  typeFilter?: string    // only keep items where preset.type matches
  items: PresetRecord[]
}

// Match the configKey + presetType combinations that each feature page
// uses with usePresets(). Kept in one place so the Presets page can
// enumerate every pool without each feature registering itself.
const groupsMeta: Omit<PresetGroup, 'items'>[] = [
  {
    key: 'script',
    label: 'Script',
    icon: '📝',
    hint: 'Chapter settings, model, style, word counts.',
    configKey: 'script',
    typeFilter: 'script',
    editLink: '/scripts',
  },
  {
    key: 'introduction',
    label: 'Introduction',
    icon: '🎙',
    hint: 'Intro host name, beats, word target.',
    configKey: 'script',
    typeFilter: 'introduction',
    editLink: '/scripts',
  },
  {
    key: 'thumbnail_prompts',
    label: 'Thumbnail Prompts',
    icon: '🎨',
    hint: 'Thumbnail count, text styling, aspect ratio, and cover-art direction.',
    configKey: 'thumbnail_prompts',
    editLink: '/image-prompts?tab=thumbnails',
  },
  {
    key: 'thumbnail_generator',
    label: 'Thumbnail Generator',
    icon: '📸',
    hint: 'Thumbnail model, aspect ratio, quality, and render settings.',
    configKey: 'thumbnail_generator',
    editLink: '/images?tab=thumbnails',
  },
  {
    key: 'audio_generator',
    label: 'Audio Generator',
    icon: '🎙',
    hint: 'Voice, provider, speed.',
    configKey: 'audio_generator',
    editLink: '/audio',
  },
  {
    key: 'audio_merge',
    label: 'Audio Merge',
    icon: '🎛',
    hint: 'Intro clip, background music, gap duration, volumes.',
    configKey: 'audio_merge',
    editLink: '/audio-merge',
  },
  {
    key: 'metadata',
    label: 'Metadata',
    icon: '📄',
    hint: 'Section templates, tag strategy.',
    configKey: 'metadata',
    editLink: '/metadata',
  },
  {
    key: 'video_bundle',
    label: 'Video Assembly Bundle',
    icon: '🎞',
    hint: 'One-click bundle applying intro/timeline/effects/subtitles/export at once.',
    configKey: 'video_bundle',
    editLink: '/video-assembly',
  },
  {
    key: 'intro',
    label: 'Video Assembly · Intro',
    icon: '▶️',
    hint: 'Intro clip settings inside video assembly.',
    configKey: 'intro',
    editLink: '/video-assembly',
  },
  {
    key: 'timeline',
    label: 'Video Assembly · Timeline',
    icon: '⏱',
    hint: 'Scene recycling, duration, transitions.',
    configKey: 'timeline',
    editLink: '/video-assembly',
  },
  {
    key: 'effects',
    label: 'Video Assembly · Effects',
    icon: '✨',
    hint: 'Color grading, vignette, film grain, chroma.',
    configKey: 'effects',
    editLink: '/video-assembly',
  },
  {
    key: 'subtitles',
    label: 'Video Assembly · Subtitles',
    icon: '💬',
    hint: 'Subtitle style presets.',
    configKey: 'subtitles',
    editLink: '/video-assembly',
  },
  {
    key: 'export',
    label: 'Video Assembly · Export',
    icon: '📤',
    hint: 'Resolution, codec, quality.',
    configKey: 'export',
    editLink: '/video-assembly',
  },
]

const groups = ref<PresetGroup[]>(groupsMeta.map(g => ({ ...g, items: [] })))
const loading = ref(false)
const error = ref('')

const totalCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const groupsWithItems = computed(() => groups.value.filter(g => g.items.length).length)

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    for (const g of groups.value) {
      const list: PresetRecord[] = Array.isArray(config[`${g.configKey}_presets`])
        ? config[`${g.configKey}_presets`]
        : []
      if (g.typeFilter) {
        // Only keep presets whose type matches — same filter usePresets applies.
        g.items = list.filter(p => (p.type || 'all') === g.typeFilter || (p.type || 'all') === 'all')
      } else {
        g.items = list
      }
    }
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Failed to load presets'
  } finally {
    loading.value = false
  }
}

// Persist a group's full list back to config. All mutations go through
// this so rename/duplicate/delete share the same write path and can't
// diverge.
async function persist(groupKey: string, nextList: PresetRecord[]) {
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  // Merge: the stored list is potentially wider than the filtered `items`
  // (typeFilter only shows this group's type). Re-read, overlay, write.
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    const storedKey = `${g.configKey}_presets`
    const stored: PresetRecord[] = Array.isArray(config[storedKey]) ? config[storedKey] : []
    let merged: PresetRecord[]
    if (g.typeFilter) {
      // Drop any stored item whose id appears in `items` (we're replacing
      // them) plus any other items that DON'T match this group's filter
      // stay untouched.
      const keptIds = new Set(nextList.map(p => p.id))
      const notThisGroup = stored.filter(p => {
        const t = p.type || 'all'
        return !(t === g.typeFilter || t === 'all')
      })
      const thisGroupKept = stored.filter(p => {
        const t = p.type || 'all'
        return (t === g.typeFilter || t === 'all') && keptIds.has(p.id)
      })
      // Rewrite kept items with any field changes; append any new items
      // (e.g. duplicates).
      const rewritten = thisGroupKept.map(p => {
        const edit = nextList.find(x => x.id === p.id)
        return edit ? { ...p, ...edit } : p
      })
      const newEntries = nextList.filter(p => !stored.some(s => s.id === p.id))
      merged = [...notThisGroup, ...rewritten, ...newEntries]
    } else {
      merged = nextList
    }
    await put(`/projects/${slug.value}/settings/config`, { [storedKey]: merged })
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to persist preset changes')
    throw e
  }
}

// ── Rename ──
const editing = ref<{ groupKey: string; id: string; name: string } | null>(null)
function startRename(groupKey: string, p: PresetRecord) {
  editing.value = { groupKey, id: p.id, name: p.name }
}
function cancelRename() { editing.value = null }
async function confirmRename() {
  const e = editing.value
  if (!e) return
  const name = e.name.trim()
  editing.value = null
  if (!name) return
  const g = groups.value.find(x => x.key === e.groupKey)
  if (!g) return
  const target = g.items.find(p => p.id === e.id)
  if (!target || target.name === name) return
  target.name = name
  try {
    await persist(e.groupKey, [...g.items])
    success(`Renamed to "${name}"`)
  } catch { /* persist already toasted */ }
}

// ── Duplicate ──
async function duplicate(groupKey: string, p: PresetRecord) {
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  const copy: PresetRecord = {
    ...p,
    id: `preset-${Date.now()}`,
    name: `${p.name} (copy)`,
  }
  g.items = [...g.items, copy]
  try {
    await persist(groupKey, g.items)
    success(`Duplicated as "${copy.name}"`)
  } catch { /* rollback */
    g.items = g.items.filter(x => x.id !== copy.id)
  }
}

// ── Delete ──
async function remove(groupKey: string, p: PresetRecord) {
  const ok = await ask({
    title: `Delete preset "${p.name}"?`,
    message: `This removes the preset from the project. Any content you generated using it stays on disk.`,
    confirmLabel: 'Delete preset',
    danger: true,
  })
  if (!ok) return
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  const prior = g.items
  g.items = g.items.filter(x => x.id !== p.id)
  try {
    await persist(groupKey, g.items)
    success(`Deleted "${p.name}"`)
  } catch {
    g.items = prior
  }
}

// ── Export JSON ──
function exportJson(groupKey: string, p: PresetRecord) {
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  const payload = { group: g.label, configKey: g.configKey, preset: p }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug.value}-${g.key}-${p.name.replace(/[^a-z0-9]+/gi, '_')}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

onMounted(loadAll)
</script>

<style scoped>
.presets-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-top: 16px;
}
.presets-header h1 { margin: 0; font-size: 22px; }

.group-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.preset-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.preset-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.preset-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, var(--border));
  vertical-align: middle;
}
.col-actions { width: 1%; white-space: nowrap; text-align: right; }
.col-actions > * + * { margin-left: 6px; }

.label-btn {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: var(--radius-sm);
  text-align: left;
}
.label-btn:hover { background: var(--bg-hover); }

.type-chip {
  display: inline-block;
  padding: 1px 8px;
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 999px;
  letter-spacing: 0.03em;
}
</style>
