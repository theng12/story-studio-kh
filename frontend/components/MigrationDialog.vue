<template>
  <Modal
    :visible="show"
    size="md"
    :z-index="2500"
    labelledby="migration-dialog-title"
    :close-on-backdrop="!migrating"
    :close-on-escape="!migrating"
    @close="skip"
  >
    <h2 id="migration-dialog-title">Move your project to a visible folder</h2>
    <p class="text-muted mt-1">
      We've updated Story Studio to save project files somewhere you can find them in Finder.
      <strong>{{ pending.length }} project{{ pending.length === 1 ? '' : 's' }}</strong> still live in a hidden system folder.
    </p>

    <div v-if="current" class="project-box mt-2">
      <div class="label">Project</div>
      <div class="name">{{ current.name }}</div>
      <div class="label mt-1">Currently at</div>
      <code class="path">{{ current.current_path }}</code>
    </div>

    <div v-if="destination" class="project-box mt-2 dest">
      <div class="label">Will move to</div>
      <code class="path">{{ destination }}/{{ current?.name }}</code>
    </div>

    <div v-if="migrating" class="status mt-2">
      <LoadingSpinner size="sm" :label="`Moving files…`" show-label />
    </div>
    <div v-if="errorMsg" class="error-box mt-2">{{ errorMsg }}</div>

    <div class="flex gap-2 mt-3" style="flex-wrap:wrap">
      <button class="btn btn-secondary" :disabled="migrating" @click="skip">Skip for now</button>
      <button v-if="!destination" class="btn btn-primary" :disabled="picking || migrating" @click="chooseFolder">
        {{ picking ? 'Opening…' : 'Choose Folder…' }}
      </button>
      <button v-else class="btn btn-primary" :disabled="migrating" @click="confirmMigrate">
        {{ migrating ? 'Moving…' : `Move '${current?.name}' here` }}
      </button>
      <button v-if="destination" class="btn btn-secondary" :disabled="migrating" @click="destination = ''">
        Change folder
      </button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * One-time migration prompt: surfaces on app launch for any project whose
 * output_root is still relative (i.e., stored in the hidden userData folder).
 *
 * Uses /api/system/migrations/pending + /api/system/migrations/migrate.
 * Skipping keeps the project in place; the prompt reappears next launch.
 */
interface Pending { slug: string; name: string; current_path: string }

const { get, post } = useApi()
const { success, error: showError } = useToast()

const pending = ref<Pending[]>([])
const current = computed<Pending | null>(() => pending.value[0] || null)
const show = ref(false)
const destination = ref('')
const picking = ref(false)
const migrating = ref(false)
const errorMsg = ref('')

async function loadPending() {
  try {
    const r = await get<{ projects: Pending[] }>('/system/migrations/pending')
    pending.value = r.projects || []
    show.value = pending.value.length > 0
  } catch {
    // Non-fatal — if the endpoint errors we just skip the prompt this launch.
  }
}

function skip() {
  show.value = false
  destination.value = ''
  errorMsg.value = ''
}

async function chooseFolder() {
  picking.value = true
  errorMsg.value = ''
  try {
    const r = await post<{ path: string | null }>('/system/pick-folder', {})
    if (r.path) destination.value = r.path
  } catch (e: any) {
    errorMsg.value = e.data?.detail || 'Folder picker failed'
  } finally {
    picking.value = false
  }
}

async function confirmMigrate() {
  if (!current.value || !destination.value) return
  migrating.value = true
  errorMsg.value = ''
  try {
    const r = await post<{ new_path: string; files_moved: number }>('/system/migrations/migrate', {
      slug: current.value.slug,
      new_root: destination.value,
    })
    success(`Moved ${r.files_moved} file(s) to visible folder`)
    // Pop current off the queue; if more pending, reset to next.
    pending.value = pending.value.slice(1)
    destination.value = ''
    if (pending.value.length === 0) show.value = false
  } catch (e: any) {
    errorMsg.value = e.data?.detail || 'Migration failed'
    showError(errorMsg.value)
  } finally {
    migrating.value = false
  }
}

onMounted(() => {
  // Small delay so it doesn't flash before the dashboard loads
  setTimeout(loadPending, 600)
})
</script>

<style scoped>
/* Overlay / container are owned by the shared Modal primitive. Only the
   in-flow decorations (the project-box callouts, the error box) need
   component-local styles. */
h2 { font-size: 18px; font-weight: 600; }

.project-box {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
}
.project-box.dest {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.project-box .label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.project-box .name { font-size: 15px; font-weight: 500; margin-top: 2px; }
.project-box .path {
  display: block;
  margin-top: 4px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
  color: var(--accent);
  word-break: break-all;
}

.status { display: flex; align-items: center; gap: 8px; }

.error-box {
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 13px;
  color: var(--error);
}
</style>
