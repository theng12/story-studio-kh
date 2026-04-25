<template>
  <div class="library-page">
    <header class="page-header">
      <div>
        <h1>Character Library</h1>
        <p class="text-muted">
          App-level character library shared across every project on this machine. Save a project's
          character here to reuse it elsewhere; import into a fresh project as a snapshot copy.
          Library entries don't auto-sync — re-import to refresh a project's copy from the library.
        </p>
      </div>
    </header>

    <div v-if="loading" class="muted">Loading…</div>

    <div v-else-if="!characters.length" class="empty">
      No characters in the library yet. Open a project's Characters page, edit any character, and
      use <strong>Save to library</strong> to add them here.
    </div>

    <div v-else class="char-list">
      <CharacterCard
        v-for="c in characters"
        :key="c.id"
        :character="c"
      >
        <template #actions>
          <button class="btn btn-secondary btn-sm" @click="openImport(c)">
            Import to project →
          </button>
          <button class="btn btn-ghost btn-sm danger" @click="confirmDelete(c)">Delete</button>
        </template>
      </CharacterCard>
    </div>

    <!-- Import-to-project picker modal -->
    <div v-if="importingChar" class="import-backdrop" @click.self="importingChar = null">
      <div class="import-card">
        <header class="import-header">
          <h3>Import "{{ importingChar.name }}" to a project</h3>
          <button class="btn btn-ghost btn-sm" @click="importingChar = null">✕</button>
        </header>

        <div class="import-body">
          <div class="form-group">
            <label>Target project <span class="req">*</span></label>
            <select v-model="importTargetSlug" class="select">
              <option v-if="!projects.length" value="">— no projects found —</option>
              <option v-for="p in projects" :key="p.slug" :value="p.slug">{{ p.name }} ({{ p.slug }})</option>
            </select>
          </div>

          <div class="form-group">
            <label>Scope on import</label>
            <span class="hint">Project = available to every episode. Episode-only = only for the listed episode codes.</span>
            <div class="scope-toggle">
              <label><input type="radio" :value="'project'" v-model="importScope" /> Project-wide</label>
              <label><input type="radio" :value="'episode'" v-model="importScope" /> Episode-only</label>
            </div>
          </div>

          <div v-if="importScope === 'episode'" class="form-group">
            <label>Episode codes <span class="req">*</span></label>
            <span class="hint">Comma-separated (e.g. <code>EP001, EP002</code>).</span>
            <input v-model="importEpisodeCodes" class="input" placeholder="EP001" />
          </div>

          <div class="form-group">
            <label>Rename on import (optional)</label>
            <span class="hint">Defaults to the library id (<code>{{ importingChar.id }}</code>). Pick a different kebab-case slug if the project already has a character with that id.</span>
            <input v-model="importTargetId" class="input" :placeholder="importingChar.id" />
          </div>
        </div>

        <div class="import-footer">
          <button class="btn btn-ghost" @click="importingChar = null">Cancel</button>
          <button class="btn btn-primary" :disabled="!canImport || importing" @click="doImport(false)">
            {{ importing ? 'Importing…' : 'Import' }}
          </button>
        </div>
        <div v-if="importError" class="import-error">
          {{ importError }}
          <button v-if="importCanOverwrite" class="btn btn-secondary btn-sm" @click="doImport(true)">
            Overwrite existing
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../composables/useCharacters.js'

definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Character Library — Story Studio KH' })

const cl = useCharacterLibrary()
const { get } = useApi()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const characters = ref<Character[]>([])
const projects = ref<Array<{ slug: string; name: string }>>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const [chars, projs] = await Promise.all([
      cl.list(),
      get<Array<{ slug: string; name: string }>>('/projects'),
    ])
    characters.value = chars
    projects.value = projs
  } catch (e: any) {
    showError(`Failed to load library: ${e?.data?.detail || e?.message || e}`)
  } finally {
    loading.value = false
  }
}

watch(() => null, load, { immediate: true })

// ── Import modal state ────────────────────────────────────────────────────
const importingChar = ref<Character | null>(null)
const importTargetSlug = ref('')
const importScope = ref<'project' | 'episode'>('project')
const importEpisodeCodes = ref('')
const importTargetId = ref('')
const importing = ref(false)
const importError = ref('')
const importCanOverwrite = ref(false)

const canImport = computed(() => {
  if (!importTargetSlug.value) return false
  if (importScope.value === 'episode' && !importEpisodeCodes.value.trim()) return false
  return true
})

function openImport(c: Character) {
  importingChar.value = c
  importTargetSlug.value = projects.value[0]?.slug || ''
  importScope.value = 'project'
  importEpisodeCodes.value = ''
  importTargetId.value = ''
  importError.value = ''
  importCanOverwrite.value = false
}

async function doImport(overwrite: boolean) {
  if (!importingChar.value) return
  importing.value = true
  importError.value = ''
  importCanOverwrite.value = false
  try {
    const r = await cl.importToProject(importingChar.value.id, importTargetSlug.value, {
      targetId: importTargetId.value.trim() || undefined,
      scope: importScope.value,
      episode_codes: importScope.value === 'episode'
        ? importEpisodeCodes.value.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      overwrite,
    })
    success(`Imported "${r.name}" into ${importTargetSlug.value}`)
    importingChar.value = null
  } catch (e: any) {
    const detail = e?.data?.detail || e?.message || 'Import failed'
    importError.value = detail
    if (e?.status === 409 || e?.statusCode === 409 || /already exists/i.test(detail)) {
      importCanOverwrite.value = true
    }
  } finally {
    importing.value = false
  }
}

async function confirmDelete(c: Character) {
  const ok = await ask({
    title: `Delete "${c.name}" from the library?`,
    body: 'Removes the library entry only. Projects that previously imported this character keep their copies (each import is a snapshot, not a live link).',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await cl.remove(c.id)
    characters.value = characters.value.filter(x => x.id !== c.id)
    success(`Deleted "${c.name}" from library`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}
</script>

<style scoped>
.library-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.page-header h1 { margin: 0 0 4px; font-size: 20px; }
.page-header .text-muted { font-size: 12px; line-height: 1.5; max-width: 720px; }

.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  background: var(--bg-secondary);
  border-radius: 6px;
}

.char-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.btn-ghost.danger { color: var(--error, #e25c5c); }
.btn-ghost.danger:hover { background: rgba(226, 92, 92, 0.08); }

/* ── Import modal ─────────────────────────────────────────────── */
.import-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 24px;
}

.import-card {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: min(540px, 100%);
  display: flex;
  flex-direction: column;
}

.import-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.import-header h3 { margin: 0; font-size: 14px; }

.import-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--text-primary); }
.form-group .hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; margin-bottom: 4px; }
.req { color: var(--error, #e25c5c); font-weight: bold; }
.scope-toggle { display: flex; gap: 16px; font-size: 12px; }

.import-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}

.import-error {
  margin: 0 18px 14px;
  padding: 8px 12px;
  background: rgba(226, 92, 92, 0.10);
  color: var(--error, #e25c5c);
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
</style>
