<template>
  <div>
    <div class="rcy-header">
      <h1>🔁 Recency Log</h1>
      <NuxtLink :to="`/projects/${slug}/scripts`" class="btn btn-sm btn-secondary">
        ← Back to Scripts
      </NuxtLink>
    </div>

    <p class="text-muted rcy-intro">
      Things this channel's recent episodes already used — for example a Bible verse a prayer
      episode quoted. When the next script is written, the writer is asked to pick something
      different from these. Remove an entry to let it be used again, or clear several at once.
    </p>

    <!-- Active rule summary -->
    <div v-if="state" class="card rcy-summary">
      <div class="rcy-summary-row">
        <div>
          <div class="rcy-summary-label">What is being tracked</div>
          <div class="rcy-summary-value">
            <template v-if="state.enabled">
              <strong>{{ capitalise(state.label || '') }}</strong>
              from the last <strong>{{ state.lookback }}</strong> episodes
              <span class="text-muted">({{ lookbackSourceText }})</span>
            </template>
            <template v-else>
              <span class="text-muted">
                Nothing is being tracked for this channel — its kind of story has nothing that
                needs to be kept from repeating, so no new entries are added. Any entries below
                are kept from earlier and still work as before.
              </span>
            </template>
          </div>
        </div>
        <div class="rcy-summary-stat">
          <div class="rcy-summary-stat-num">{{ state.log_size }}</div>
          <div class="rcy-summary-stat-label">total entries</div>
        </div>
      </div>
    </div>

    <!-- Filters + bulk actions -->
    <div v-if="state && state.log_size > 0" class="card rcy-controls">
      <div class="rcy-controls-row">
        <label class="rcy-filter">
          <span class="rcy-filter-label">Filter by kind</span>
          <select v-model="filterKind" class="select select-sm">
            <option value="">All kinds ({{ state.log_size }})</option>
            <option v-for="(count, k) in state.kind_counts" :key="k" :value="k">
              {{ kindLabel(String(k)) }} ({{ count }})
            </option>
          </select>
        </label>
        <label class="rcy-filter">
          <span class="rcy-filter-label">Search</span>
          <input
            v-model="filterText"
            type="text"
            class="input input-sm"
            placeholder="match item or episode"
          />
        </label>
        <span class="rcy-spacer"></span>
        <button
          v-if="filterKind"
          type="button"
          class="btn btn-sm btn-ghost rcy-danger"
          @click="clearByKind"
        >
          Clear all "{{ kindLabel(filterKind) }}" entries
        </button>
        <button
          type="button"
          class="btn btn-sm btn-ghost rcy-danger"
          @click="clearAll"
        >
          Clear entire log
        </button>
      </div>
    </div>

    <!-- Log table -->
    <div v-if="loading" class="text-muted rcy-loading">Loading log…</div>
    <div v-else-if="!state || state.log_size === 0" class="card rcy-empty">
      <p>
        <strong>Nothing recorded yet.</strong>
        Entries are added by themselves each time a script is written, for channels whose kind
        of story tracks something — prayer channels, for example, track the Bible verses used.
      </p>
    </div>
    <div v-else-if="filteredLog.length === 0" class="card rcy-empty">
      <p>No entries match the current filter. Try clearing the search or picking a different kind.</p>
    </div>
    <table v-else class="rcy-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Kind</th>
          <th>Episode</th>
          <th>Used</th>
          <th class="rcy-col-actions"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(entry, i) in filteredLog" :key="`${entry.episode_code}|${entry.kind}|${entry.item}|${i}`">
          <td class="rcy-cell-item">{{ entry.item }}</td>
          <td>
            <span class="rcy-kind-pill">{{ kindLabel(entry.kind) }}</span>
          </td>
          <td class="rcy-cell-episode"><code>{{ entry.episode_code }}</code></td>
          <td class="rcy-cell-used" :title="entry.used_at">{{ formatRelative(entry.used_at) }}</td>
          <td class="rcy-col-actions">
            <button
              type="button"
              class="btn-icon danger"
              :title="`Remove this entry — '${entry.item}' becomes available again for the next generation`"
              @click="removeEntry(entry)"
            >&#10005;</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
/**
 * Recency log management page (v1.0.108+).
 *
 * Reads:
 *   - GET /api/projects/:slug/recency?full=1
 *
 * Writes:
 *   - DELETE /api/projects/:slug/recency/entry  (single entry)
 *   - DELETE /api/projects/:slug/recency?kind=X (by kind)
 *   - DELETE /api/projects/:slug/recency        (clear all)
 *
 * The Script Generator's recency strip only shows the active avoid-list
 * (filtered by lookback). This page shows EVERY entry on disk so you can
 * audit / surgical-delete / clear bulk without leaving Story Studio.
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, del } = useApi()
const { success: toastSuccess, error: toastError } = useToast()

interface LogEntry {
  episode_code: string
  used_at: string
  kind: string
  item: string
}
interface RecencyView {
  enabled: boolean
  kind: string | null
  label: string | null
  lookback: number
  lookback_source: 'project' | 'niche' | 'default' | null
  recent_items: string[]
  log_size: number
  niche_id: string | null
  full_log?: LogEntry[]
  kind_counts?: Record<string, number>
}

const loading = ref(false)
const state = ref<RecencyView | null>(null)
const filterKind = ref('')
const filterText = ref('')

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}
/** A plain name for a kind: the rule's own label when it is this one, else the key in words. */
function kindLabel(kind: string): string {
  if (kind && kind === state.value?.kind && state.value.label) return capitalise(state.value.label)
  return capitalise(kind.replace(/[_-]+/g, ' ').trim())
}
const lookbackSourceText = computed(() => ({
  project: 'set for this channel',
  niche: 'the usual number for this kind of story',
  default: 'the app\u2019s usual number',
} as Record<string, string>)[state.value?.lookback_source || ''] || '')

const filteredLog = computed(() => {
  const log = state.value?.full_log || []
  const q = filterText.value.trim().toLowerCase()
  return log.filter(e => {
    if (filterKind.value && e.kind !== filterKind.value) return false
    if (q && !e.item.toLowerCase().includes(q) && !e.episode_code.toLowerCase().includes(q)) return false
    return true
  })
})

async function load() {
  loading.value = true
  try {
    state.value = await get<RecencyView>(`/projects/${slug.value}/recency?full=1`)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not load recency log')
  } finally {
    loading.value = false
  }
}

async function removeEntry(entry: LogEntry) {
  if (!confirm(`Remove "${entry.item}" (used in ${entry.episode_code})? It becomes available again for the next generation.`)) return
  try {
    await del(`/projects/${slug.value}/recency/entry`, {
      body: { episode_code: entry.episode_code, kind: entry.kind, item: entry.item },
    })
    toastSuccess(`Removed "${entry.item}"`)
    await load()
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not remove entry')
  }
}

async function clearByKind() {
  if (!filterKind.value) return
  const count = state.value?.kind_counts?.[filterKind.value] || 0
  if (!confirm(`Clear all ${count} "${kindLabel(filterKind.value)}" entries? They can all be used again.`)) return
  try {
    await del(`/projects/${slug.value}/recency?kind=${encodeURIComponent(filterKind.value)}`)
    toastSuccess(`Cleared ${count} "${kindLabel(filterKind.value)}" entries`)
    filterKind.value = ''
    await load()
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not clear by kind')
  }
}

async function clearAll() {
  if (!state.value?.log_size) return
  if (!confirm(`Clear all ${state.value.log_size} recency entries? Every tracked item becomes available again. This can't be undone.`)) return
  try {
    await del(`/projects/${slug.value}/recency`)
    toastSuccess(`Cleared ${state.value.log_size} entries`)
    await load()
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not clear log')
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

onMounted(load)
</script>

<style scoped>
.rcy-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.rcy-header h1 {
  margin: 0;
}
.rcy-intro {
  font-size: 13px;
  max-width: 780px;
  margin: 6px 0 16px;
  line-height: 1.5;
}
.rcy-intro code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
}

.rcy-summary {
  padding: 14px 16px;
  margin-top: 12px;
}
.rcy-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.rcy-summary-label {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.rcy-summary-value {
  font-size: 14px;
}
.rcy-summary-value code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.rcy-summary-stat {
  text-align: right;
}
.rcy-summary-stat-num {
  font-size: 28px;
  font-weight: 600;
  color: var(--accent, #6ea8fe);
}
.rcy-summary-stat-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.rcy-controls {
  padding: 12px 16px;
  margin-top: 12px;
}
.rcy-controls-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.rcy-filter {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rcy-filter-label {
  font-size: var(--font-xs);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rcy-spacer {
  flex: 1;
}
.rcy-danger {
  color: #ff8a8a;
}

.rcy-loading {
  padding: 24px;
  text-align: center;
  font-size: 13px;
}
.rcy-empty {
  padding: 24px;
  text-align: center;
}
.rcy-empty p {
  margin: 0 0 8px;
}
.rcy-empty code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
}

.rcy-table {
  width: 100%;
  margin-top: 12px;
  font-size: 13px;
  border-collapse: collapse;
}
.rcy-table th,
.rcy-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.rcy-table th {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}
.rcy-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.02);
}
.rcy-cell-item {
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 12px;
}
.rcy-cell-episode code {
  font-size: var(--font-xs);
}
.rcy-cell-used {
  font-size: 12px;
  color: var(--text-muted);
}
.rcy-col-actions {
  width: 40px;
  text-align: right;
}
.rcy-kind-pill {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(80, 200, 160, 0.12);
  border: 1px solid rgba(80, 200, 160, 0.30);
  border-radius: 10px;
  font-size: var(--font-xs);
  color: var(--text-primary);
}
</style>
