<template>
  <div class="workspace-page presets-workspace">
    <WorkspaceHero
      eyebrow="Library · Reusable setup"
      title="Presets"
      :description="`Every preset saved for ${projectName || 'this channel'}, grouped by where it is used. All presets are local, with one clear source of truth.`"
    >
      <template #aside>
        <button class="btn btn-sm btn-secondary" :disabled="loading || hasSavingGroups" @click="loadAll">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </template>
    </WorkspaceHero>

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
                :disabled="isGroupSaving(group.key)"
                @keydown.enter="confirmRename"
                @keydown.escape="cancelRename"
                @blur="confirmRename"
              />
              <button v-else class="label-btn" :disabled="isGroupSaving(group.key)" @click="startRename(group.key, p)">{{ p.name }}</button>
            </td>
            <td>
              <span v-if="p.type" class="type-chip">{{ p.type }}</span>
            </td>
            <td class="col-actions">
              <button class="btn btn-sm btn-ghost" :disabled="isGroupSaving(group.key)" @click="duplicate(group.key, p)" title="Create a copy of this preset">Duplicate</button>
              <button class="btn btn-sm btn-ghost" @click="exportJson(group.key, p)" title="Download this preset as JSON">Export</button>
              <button class="btn btn-sm btn-danger" :disabled="isGroupSaving(group.key)" @click="remove(group.key, p)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!loading && totalCount" class="hint mt-2">
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

function normalizePreset(value: PresetRecord): PresetRecord {
  const normalized = { ...value } as PresetRecord & { machine_label?: unknown }
  delete normalized.machine_label
  return normalized
}

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
    hint: 'Opening recipe: host name, beats, length, model.',
    configKey: 'introduction',
    typeFilter: 'introduction',
    editLink: '/introduction',
  },
  {
    key: 'ideas_generator',
    label: 'Ideas',
    icon: '💡',
    hint: 'Idea count, model, and direction for new episode ideas.',
    configKey: 'ideas_generator',
    editLink: '/ideas',
  },
  {
    key: 'research',
    label: 'Research',
    icon: '🔎',
    hint: 'Research mode, model, and source limits.',
    configKey: 'research',
    editLink: '/research',
  },
  {
    key: 'scene_plan',
    label: 'Scene Plan',
    icon: '🗺',
    hint: 'Reusable Scene Plan setup and guidance.',
    configKey: 'scene_plan',
    editLink: '/scene-plan',
  },
  {
    key: 'continuity_page',
    label: 'Character Sheet',
    icon: '🧑',
    hint: 'Character sheet look, cast, and scene rhythm.',
    configKey: 'continuity_page',
    editLink: '/character-sheet',
  },
  {
    key: 'scene_prompts',
    label: 'Scene Prompts',
    icon: '🖌',
    hint: 'Scene prompt style and direction.',
    configKey: 'scene_prompts',
    editLink: '/image-prompts?tab=scenes',
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
    label: 'Audio Assembly',
    icon: '🎛',
    hint: 'Intro clip, background music, gap duration, volumes.',
    configKey: 'audio_merge',
    editLink: '/audio-merge',
  },
  {
    key: 'subtitles_generator',
    label: 'Subtitles',
    icon: '🔤',
    hint: 'Subtitle generation settings.',
    configKey: 'subtitles_generator',
    editLink: '/subtitles',
  },
  {
    key: 'sound_design',
    label: 'Sound Design',
    icon: '🔊',
    hint: 'Ambience and sound-effect settings.',
    configKey: 'sound_design',
    editLink: '/sound-design',
  },
  {
    key: 'broll',
    label: 'B-Roll',
    icon: '🎬',
    hint: 'B-roll search and selection settings.',
    configKey: 'broll',
    editLink: '/broll',
  },
  {
    key: 'scene_review_genstudio',
    label: 'Scene Review',
    icon: '🧐',
    hint: 'Scene review model and checks.',
    configKey: 'scene_review_genstudio',
    editLink: '/scene-review',
  },
  {
    key: 'motion_review',
    label: 'Motion Review',
    icon: '🎥',
    hint: 'Motion review model and checks.',
    configKey: 'motion_review',
    editLink: '/motion-review',
  },
  {
    key: 'contextual_cues',
    label: 'Contextual Cues',
    icon: '🏷',
    hint: 'Cue model, density, placement, and auto-approve.',
    configKey: 'contextual_cues',
    editLink: '/contextual-cues',
  },
  {
    key: 'metadata',
    label: 'YouTube Finalizer',
    icon: '📄',
    hint: 'Formula publishing profile, final title/description/tags, measured chapters, and research sources.',
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
  {
    key: 'transition',
    label: 'Video Assembly · Transitions',
    icon: '🔀',
    hint: 'Transition type and duration.',
    configKey: 'transition',
    editLink: '/video-assembly',
  },
  {
    key: 'animation',
    label: 'Video Assembly · Motion',
    icon: '🌀',
    hint: 'Zoom and parallax motion on still scenes.',
    configKey: 'animation',
    editLink: '/video-assembly',
  },
]

const groups = ref<PresetGroup[]>(groupsMeta.map(g => ({ ...g, items: [] })))
const loading = ref(false)
const error = ref('')
const savingGroups = ref(new Set<string>())

const totalCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const groupsWithItems = computed(() => groups.value.filter(g => g.items.length).length)
const hasSavingGroups = computed(() => savingGroups.value.size > 0)

function isGroupSaving(groupKey: string): boolean { return savingGroups.value.has(groupKey) }
function setGroupSaving(groupKey: string, saving: boolean) {
  const next = new Set(savingGroups.value)
  if (saving) next.add(groupKey)
  else next.delete(groupKey)
  savingGroups.value = next
}

async function loadAll() {
  if (loading.value || hasSavingGroups.value) return
  const requestedSlug = slug.value
  loading.value = true
  error.value = ''
  try {
    const config = await get<any>(`/projects/${requestedSlug}/settings/config`)
    if (slug.value !== requestedSlug) return
    for (const g of groups.value) {
      const list: PresetRecord[] = Array.isArray(config[`${g.configKey}_presets`])
        ? config[`${g.configKey}_presets`].map(normalizePreset)
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
  const targetSlug = slug.value
  // Merge: the stored list is potentially wider than the filtered `items`
  // (typeFilter only shows this group's type). Re-read, overlay, write.
  try {
    const config = await get<any>(`/projects/${targetSlug}/settings/config`)
    const storedKey = `${g.configKey}_presets`
    const stored: PresetRecord[] = Array.isArray(config[storedKey])
      ? config[storedKey].map(normalizePreset)
      : []
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
    await put(`/projects/${targetSlug}/settings/config`, {
      [storedKey]: merged.map(normalizePreset),
    })
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to persist preset changes')
    throw e
  }
}

async function saveGroup(groupKey: string, nextList: PresetRecord[]) {
  if (isGroupSaving(groupKey)) return false
  setGroupSaving(groupKey, true)
  try {
    await persist(groupKey, nextList)
    return true
  } finally {
    setGroupSaving(groupKey, false)
  }
}

// ── Rename ──
const editing = ref<{ groupKey: string; id: string; name: string } | null>(null)
function startRename(groupKey: string, p: PresetRecord) {
  if (isGroupSaving(groupKey)) return
  editing.value = { groupKey, id: p.id, name: p.name }
}
function cancelRename() { editing.value = null }
async function confirmRename() {
  const e = editing.value
  if (!e) return
  if (isGroupSaving(e.groupKey)) return
  const name = e.name.trim()
  editing.value = null
  if (!name) return
  const g = groups.value.find(x => x.key === e.groupKey)
  if (!g) return
  const target = g.items.find(p => p.id === e.id)
  if (!target || target.name === name) return
  const priorName = target.name
  target.name = name
  try {
    if (!await saveGroup(e.groupKey, [...g.items])) {
      target.name = priorName
      return
    }
    success(`Renamed to "${name}"`)
  } catch { target.name = priorName }
}

// ── Duplicate ──
async function duplicate(groupKey: string, p: PresetRecord) {
  if (isGroupSaving(groupKey)) return
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  const copy: PresetRecord = {
    ...p,
    id: `preset-${Date.now()}`,
    name: `${p.name} (copy)`,
  }
  g.items = [...g.items, copy]
  try {
    if (!await saveGroup(groupKey, g.items)) {
      g.items = g.items.filter(x => x.id !== copy.id)
      return
    }
    success(`Duplicated as "${copy.name}"`)
  } catch { /* rollback */
    g.items = g.items.filter(x => x.id !== copy.id)
  }
}

// ── Delete ──
async function remove(groupKey: string, p: PresetRecord) {
  if (isGroupSaving(groupKey)) return
  const ok = await ask({
    title: `Delete preset "${p.name}"?`,
    message: `This removes the preset from the project. Any content you generated using it stays on disk.`,
    confirmLabel: 'Delete Preset',
    danger: true,
  })
  if (!ok) return
  const g = groups.value.find(x => x.key === groupKey)
  if (!g) return
  const prior = g.items
  g.items = g.items.filter(x => x.id !== p.id)
  try {
    if (!await saveGroup(groupKey, g.items)) {
      g.items = prior
      return
    }
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
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  font-weight: 500;
  text-transform: lowercase;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 999px;
  letter-spacing: 0.03em;
}
</style>
