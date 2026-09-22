<template>
  <div v-if="picker.isOpen" class="fbm-overlay" @click.self="onCancel">
    <div class="fbm-card" role="dialog" aria-modal="true" :aria-label="title">
      <header class="fbm-header">
        <h2>{{ title }}</h2>
        <button class="fbm-close" @click="onCancel" aria-label="Close">×</button>
      </header>

      <div class="fbm-body">
        <aside class="fbm-sidebar" v-if="quickLocations.length">
          <h3>Quick locations</h3>
          <ul>
            <li v-for="loc in quickLocations" :key="loc.path">
              <button class="fbm-quick" @click="loadDir(loc.path)" :title="loc.path">
                {{ loc.label }}
              </button>
            </li>
          </ul>
        </aside>

        <section class="fbm-main">
          <div class="fbm-toolbar">
            <input
              v-model="manualPath"
              class="input fbm-path-input"
              placeholder="Type or paste a path…"
              @keydown.enter="loadDir(manualPath)"
            >
            <button class="btn btn-secondary btn-sm" @click="loadDir(manualPath)" :disabled="loading">
              Go
            </button>
            <label class="fbm-hidden-toggle">
              <input type="checkbox" v-model="showHidden" @change="reload">
              Show hidden
            </label>
          </div>

          <nav v-if="breadcrumbs.length" class="fbm-breadcrumb" aria-label="Breadcrumb">
            <button
              v-for="(crumb, i) in breadcrumbs"
              :key="i"
              class="fbm-crumb"
              @click="loadDir(crumb.path)"
            >{{ crumb.label }}</button>
          </nav>

          <div v-if="error" class="fbm-error">{{ error }}</div>

          <ul v-if="!loading && entries.length" class="fbm-list" tabindex="0">
            <li
              v-for="entry in entries"
              :key="entry.name"
              class="fbm-entry"
              :class="{ 'is-dir': entry.type === 'dir', 'is-selected': isSelected(entry) }"
              @click="onClickEntry(entry, $event)"
              @dblclick="onDoubleClickEntry(entry)"
            >
              <span class="fbm-icon">{{ entry.type === 'dir' ? '📁' : '📄' }}</span>
              <span class="fbm-name">{{ entry.name }}</span>
              <span v-if="entry.type === 'file' && typeof entry.size === 'number'" class="fbm-size">
                {{ formatSize(entry.size) }}
              </span>
            </li>
          </ul>

          <div v-else-if="loading" class="fbm-empty">Loading…</div>
          <div v-else class="fbm-empty">No items in this folder.</div>
        </section>
      </div>

      <footer class="fbm-footer">
        <span class="fbm-status">
          <template v-if="picker.mode === 'dir'">
            <span v-if="currentPath">Selected: <code>{{ currentPath }}</code></span>
          </template>
          <template v-else-if="picker.mode === 'file'">
            <span v-if="selected.length === 1">Selected: <code>{{ selected[0] }}</code></span>
          </template>
          <template v-else>
            <span>{{ selected.length }} file{{ selected.length === 1 ? '' : 's' }} selected</span>
          </template>
        </span>
        <div class="fbm-buttons">
          <button class="btn btn-secondary" @click="onCancel">Cancel</button>
          <button class="btn btn-primary" :disabled="!canConfirm" @click="onConfirm">
            {{ confirmLabel }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { usePickerState, resolvePicker } from '~/composables/usePathPicker'

interface BrowseEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
  mtime?: string
  hidden: boolean
}

interface QuickLocation { label: string; path: string }

const picker = usePickerState()

const currentPath = ref<string>('')
const entries = ref<BrowseEntry[]>([])
const breadcrumbs = ref<Array<{ label: string; path: string }>>([])
const manualPath = ref('')
const showHidden = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const quickLocations = ref<QuickLocation[]>([])
const selected = ref<string[]>([])

const title = computed(() => {
  if (picker.options.title) return picker.options.title
  switch (picker.mode) {
    case 'dir': return 'Select Folder'
    case 'file': return 'Select File'
    case 'files': return 'Select Files'
  }
  return 'Browse'
})

const confirmLabel = computed(() => {
  if (picker.options.button_label) return picker.options.button_label
  switch (picker.mode) {
    case 'dir': return 'Select Folder'
    case 'file': return 'Open'
    case 'files': return selected.value.length
      ? `Add ${selected.value.length} File${selected.value.length === 1 ? '' : 's'}`
      : 'Add Files'
  }
  return 'Select'
})

const canConfirm = computed(() => {
  if (picker.mode === 'dir') return !!currentPath.value
  if (picker.mode === 'file') return selected.value.length === 1
  if (picker.mode === 'files') return selected.value.length > 0
  return false
})

// Load quick locations once on first mount.
onMounted(async () => {
  try {
    const r = await $fetch('/api/system/quick-locations') as { locations: QuickLocation[] }
    quickLocations.value = r.locations || []
  } catch { /* non-fatal — sidebar just shows empty */ }
})

// Open the modal: reset state, load the initial directory.
watch(() => picker.isOpen, async (open) => {
  if (!open) return
  selected.value = []
  error.value = null
  manualPath.value = ''
  // Determine initial path: caller-provided, else first quick location, else home.
  const initial = picker.options.initial_path
    || quickLocations.value[0]?.path
    || ''
  if (initial) await loadDir(initial)
}, { immediate: false })

async function loadDir(p: string) {
  if (!p) return
  loading.value = true
  error.value = null
  try {
    const r = await $fetch(
      '/api/system/browse-dir',
      { method: 'POST', body: { path: p, show_hidden: showHidden.value } },
    ) as { path: string; parent: string | null; entries: BrowseEntry[] }
    currentPath.value = r.path
    manualPath.value = r.path
    entries.value = filterEntriesByExtension(r.entries)
    selected.value = []
    breadcrumbs.value = computeCrumbs(r.path)
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not open folder'
    entries.value = []
  } finally {
    loading.value = false
  }
}

function reload() {
  if (currentPath.value) loadDir(currentPath.value)
}

function filterEntriesByExtension(list: BrowseEntry[]): BrowseEntry[] {
  const exts = picker.options.extensions
  if (!exts?.length || picker.mode === 'dir') return list
  const norm = exts.map(e => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
  return list.filter(e => {
    if (e.type === 'dir') return true  // always show directories so user can navigate
    return norm.some(ext => e.name.toLowerCase().endsWith(ext))
  })
}

function computeCrumbs(p: string) {
  const parts = p.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += '/' + part
    out.push({ label: part, path: acc })
  }
  return out
}

function isSelected(entry: BrowseEntry): boolean {
  const full = joinPath(currentPath.value, entry.name)
  return selected.value.includes(full)
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/')) return dir + name
  return dir + '/' + name
}

function onClickEntry(entry: BrowseEntry, evt: MouseEvent) {
  const full = joinPath(currentPath.value, entry.name)
  if (entry.type === 'dir') {
    // dir mode: single-click selects (sets currentPath via reload). file modes: ignore.
    if (picker.mode === 'dir') {
      // already shown as selected via currentPath. nothing more needed.
    }
    return
  }
  // File click — depends on mode.
  if (picker.mode === 'file') {
    selected.value = [full]
  } else if (picker.mode === 'files') {
    if (evt.metaKey || evt.ctrlKey) {
      const i = selected.value.indexOf(full)
      if (i >= 0) selected.value.splice(i, 1)
      else selected.value.push(full)
    } else {
      selected.value = [full]
    }
  }
}

function onDoubleClickEntry(entry: BrowseEntry) {
  if (entry.type === 'dir') {
    loadDir(joinPath(currentPath.value, entry.name))
  } else {
    // Double-click on a file = pick + confirm in one move (single/multi-file modes).
    if (picker.mode !== 'dir') {
      selected.value = [joinPath(currentPath.value, entry.name)]
      onConfirm()
    }
  }
}

function onCancel() {
  if (picker.mode === 'files') resolvePicker([])
  else resolvePicker(null)
}

function onConfirm() {
  if (picker.mode === 'dir') {
    resolvePicker(currentPath.value || null)
    return
  }
  if (picker.mode === 'file') {
    resolvePicker(selected.value[0] || null)
    return
  }
  resolvePicker(selected.value.slice())
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
</script>

<style scoped>
.fbm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.fbm-card {
  width: 100%;
  max-width: 800px;
  height: 600px;
  max-height: calc(100vh - 64px);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}
.fbm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.fbm-header h2 {
  margin: 0;
  font-size: 15px;
  color: var(--text-primary);
}
.fbm-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
}
.fbm-close:hover { color: var(--text-primary); }
.fbm-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.fbm-sidebar {
  width: 180px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 12px 8px;
  overflow-y: auto;
}
.fbm-sidebar h3 {
  font-size: var(--font-xs);
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 0 8px 8px;
  letter-spacing: 0.05em;
}
.fbm-sidebar ul { list-style: none; padding: 0; margin: 0; }
.fbm-quick {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.fbm-quick:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.fbm-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.fbm-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.fbm-path-input { flex: 1; }
.fbm-hidden-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.fbm-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.fbm-crumb {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}
.fbm-crumb::after { content: '/'; margin-left: 6px; color: var(--text-muted); }
.fbm-crumb:last-child::after { content: ''; }
.fbm-crumb:hover { background: var(--bg-hover); }
.fbm-error {
  padding: 10px 14px;
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}
.fbm-list {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  padding: 4px 0;
  margin: 0;
}
.fbm-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
.fbm-entry:hover { background: var(--bg-hover); }
.fbm-entry.is-selected {
  background: var(--accent-dim);
  color: var(--text-primary);
}
.fbm-icon { width: 18px; flex-shrink: 0; }
.fbm-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fbm-size { color: var(--text-muted); font-size: var(--font-xs); flex-shrink: 0; }
.fbm-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}
.fbm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-primary);
}
.fbm-status {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fbm-status code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg-tertiary);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
}
.fbm-buttons { display: flex; gap: 8px; flex-shrink: 0; }
</style>
