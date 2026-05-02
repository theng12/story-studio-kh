<template>
  <div class="brands-page">
    <header class="brands-header">
      <NuxtLink to="/" class="btn btn-secondary btn-sm">← Back to projects</NuxtLink>
      <div>
        <h1>Brands</h1>
        <p class="text-muted">
          Channel-level identity. One brand per channel — name, narrator persona,
          default voice, logo, brand-style image keywords. Multiple projects can share a brand.
        </p>
      </div>
      <button class="btn btn-primary" @click="openCreate">+ New brand</button>
    </header>

    <div v-if="loading && brands.length === 0" class="empty-state">Loading…</div>

    <div v-else-if="error" class="error-card">
      <strong>Couldn't load brands.</strong>
      <p>{{ error }}</p>
      <button class="btn btn-secondary" @click="loadAll">Retry</button>
    </div>

    <div v-else-if="brands.length === 0" class="empty-state">
      <h2>No brands yet</h2>
      <p>
        Create one to share channel-level identity across projects. Without a brand,
        each project uses literal defaults from its format profile.
      </p>
      <button class="btn btn-primary" @click="openCreate">+ New brand</button>
    </div>

    <ul v-else class="brand-list">
      <li v-for="b in brands" :key="b.id" class="brand-row">
        <div class="brand-row-head">
          <div>
            <h3 class="brand-name">{{ b.name }}</h3>
            <span class="brand-id text-muted">{{ b.id }}</span>
          </div>
          <div class="brand-meta">
            <span class="pill">{{ b.project_count }} project{{ b.project_count === 1 ? '' : 's' }}</span>
            <NuxtLink :to="`/brands/${b.id}`" class="btn btn-secondary btn-sm">Edit</NuxtLink>
            <button class="btn btn-danger btn-sm" @click="confirmDelete(b)">Delete</button>
          </div>
        </div>
        <p v-if="b.channel?.name" class="brand-subline">
          Channel: <strong>{{ b.channel.name }}</strong>
        </p>
        <p v-if="b.narration?.persona" class="brand-subline text-muted">
          Persona: {{ b.narration.persona.length > 140 ? b.narration.persona.slice(0, 140) + '…' : b.narration.persona }}
        </p>
      </li>
    </ul>

    <!-- Create dialog (id + name only — full editor opens after create) -->
    <Teleport to="body">
      <div v-if="creating" class="modal-backdrop" @click.self="creating = false">
        <div class="modal">
          <h2>New brand</h2>
          <p class="text-muted">
            The id is the file name on disk (lowercase letters, digits, dashes).
            You can edit everything else after creating.
          </p>
          <div class="form-group">
            <label>Brand name</label>
            <input v-model="newName" class="input" type="text" placeholder="Sleep Studio Asia" @input="syncId" />
          </div>
          <div class="form-group">
            <label>Brand id (slug)</label>
            <input v-model="newId" class="input" type="text" placeholder="sleep-studio-asia" />
          </div>
          <div v-if="createError" class="error-inline">{{ createError }}</div>
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="creating = false">Cancel</button>
            <button class="btn btn-primary" :disabled="!newId || !newName || saving" @click="doCreate">
              {{ saving ? 'Creating…' : 'Create + edit' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal">
          <h2>Delete "{{ deleteTarget.name }}"?</h2>
          <p v-if="!deleteRefs.length">This will remove the brand JSON file from disk. Cannot be undone.</p>
          <div v-else>
            <p>This brand is currently used by {{ deleteRefs.length }} project(s):</p>
            <ul class="ref-list">
              <li v-for="slug in deleteRefs" :key="slug"><code>{{ slug }}</code></li>
            </ul>
            <p>Reassign or clear those projects first, then try again.</p>
          </div>
          <div v-if="deleteError" class="error-inline">{{ deleteError }}</div>
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="deleteTarget = null">Close</button>
            <button v-if="!deleteRefs.length" class="btn btn-danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting…' : 'Delete' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import type { Brand } from '@shared/contracts'

useAppTitle('Brands')

const router = useRouter()
const { brands, loading, error, loadAll, create, remove } = useBrands()

const creating = ref(false)
const newName = ref('')
const newId = ref('')
const createError = ref<string | null>(null)
const saving = ref(false)

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

// Auto-suggest id from name as the user types — but only if they haven't
// hand-edited the id field. Track that via a watcher flag.
const idTouched = ref(false)
function syncId() {
  if (idTouched.value) return
  newId.value = slugify(newName.value)
}
watch(newId, () => { if (newId.value && newId.value !== slugify(newName.value)) idTouched.value = true })

function openCreate() {
  newName.value = ''
  newId.value = ''
  idTouched.value = false
  createError.value = null
  creating.value = true
}

async function doCreate() {
  createError.value = null
  saving.value = true
  try {
    const brand: Brand = {
      id: newId.value,
      name: newName.value,
      schemaVersion: 1,
      channel: { name: newName.value },
    }
    await create(brand)
    creating.value = false
    router.push(`/brands/${encodeURIComponent(brand.id)}`)
  } catch (e: any) {
    createError.value = e?.data?.detail || e?.message || 'Failed to create brand'
  } finally {
    saving.value = false
  }
}

const deleteTarget = ref<Brand | null>(null)
const deleteRefs = ref<string[]>([])
const deleteError = ref<string | null>(null)
const deleting = ref(false)

function confirmDelete(b: Brand & { project_count?: number }) {
  deleteTarget.value = b
  deleteRefs.value = []
  deleteError.value = null
  // Optimistic — if the list already shows project_count > 0, prefill so
  // the dialog explains the blocker before the user clicks Delete.
  if ((b as any).project_count > 0) {
    deleteRefs.value = ['(loading…)']
  }
  // Actual list comes from the 409 response when the user clicks Delete.
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  deleteError.value = null
  try {
    const result = await remove(deleteTarget.value.id)
    if ('conflict' in result) {
      deleteRefs.value = result.referencing_projects
      return
    }
    await loadAll()
    deleteTarget.value = null
  } catch (e: any) {
    deleteError.value = e?.data?.detail || e?.message || 'Failed to delete brand'
  } finally {
    deleting.value = false
  }
}

await loadAll()
</script>

<style scoped>
.brands-page {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px;
  color: var(--text-primary);
}
.brands-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: start;
  margin-bottom: 24px;
}
.brands-header h1 { margin: 0; color: var(--accent); }
.brands-header p { margin: 4px 0 0; color: var(--text-secondary); }

.brand-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.brand-row {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.brand-row-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.brand-name { margin: 0; color: var(--text-primary); }
.brand-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text-muted);
}
.brand-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}
.pill {
  background: var(--accent-dim);
  color: var(--accent);
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.brand-subline {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--text-secondary);
}
.empty-state {
  text-align: center;
  padding: 48px 16px;
  background: var(--bg-secondary);
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-secondary);
}
.empty-state h2 { margin: 0 0 8px; color: var(--text-primary); }
.error-card {
  background: var(--bg-secondary);
  border: 1px solid #d97757;
  color: var(--text-primary);
  padding: 16px;
  border-radius: 8px;
}
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 24px;
  border-radius: 8px;
  width: min(420px, 90vw);
}
.modal h2 { margin: 0 0 8px; color: var(--text-primary); }
.modal p { color: var(--text-secondary); }
.modal-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 16px;
}
.error-inline {
  color: #d97757;
  margin-top: 8px;
  font-size: 13px;
}
.ref-list {
  margin: 8px 0;
  padding-left: 20px;
  color: var(--text-secondary);
}
.ref-list code {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
}
</style>
