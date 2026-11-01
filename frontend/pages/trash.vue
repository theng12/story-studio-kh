<template>
  <div class="trash-page page-frame">
    <PlainBackLink />
    <PageTitle
      eyebrow="Story Studio"
      title="Trash"
      description="Everything Story Studio removes, from every channel, waits here. Nothing in it is used. Restore puts an item back where it was; the space comes back when you delete items permanently. Only you can do that; Story Studio and its agents never do."
    >
      <template #actions>
        <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load">{{ loading ? 'Measuring…' : 'Refresh' }}</button>
      </template>
    </PageTitle>

    <p v-if="error" class="trash-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="trash-notice" role="status">{{ notice }}</p>
    <p v-if="loading && !listing" class="muted" role="status">Measuring the Trash…</p>

    <template v-if="listing">
      <section class="card free-space" aria-labelledby="free-space-title">
        <h2 id="free-space-title">Free up space</h2>
        <p class="summary">
          <strong>{{ formatBytes(listing.total_bytes) }}</strong> in {{ listing.items_total }} {{ listing.items_total === 1 ? 'item' : 'items' }}<template v-if="listing.oldest">
            · oldest: {{ baseName(listing.oldest.path) }} ({{ channelLabel(listing.oldest.slug) }}), {{ formatDate(listing.oldest.at) }}</template>
        </p>
        <p class="muted">Delete permanently gives the space back now and cannot be undone. Move to macOS Trash keeps items recoverable in the Mac's own Trash, but the space only comes back once that Trash is emptied.</p>
        <div class="space-actions">
          <button class="btn btn-secondary btn-sm" :disabled="busy || !selectedFor('macos').length" @click="ask('macos', 'selected')">Move selected to macOS Trash</button>
          <button class="btn btn-secondary btn-sm" :disabled="busy || !listing.movable.items" @click="ask('macos', 'all')">Move all to macOS Trash</button>
          <button class="btn btn-danger btn-sm" :disabled="busy || !selectedFor('delete').length" @click="ask('delete', 'selected')">Delete selected permanently</button>
          <button class="btn btn-danger btn-sm" :disabled="busy || !listing.deletable.items" @click="ask('delete', 'all')">Delete all permanently</button>
        </div>
        <div v-if="pending" class="confirm-row" role="alertdialog" aria-labelledby="pending-text">
          <span id="pending-text">{{ pending.action === 'delete'
            ? `Delete ${countLabel(pending.count)} (${formatBytes(pending.bytes)}) permanently? This cannot be undone.`
            : `Move ${countLabel(pending.count)} (${formatBytes(pending.bytes)}) to the Mac's Trash? They can be put back from there, not from here.` }}</span>
          <button :class="['btn', 'btn-sm', pending.action === 'delete' ? 'btn-danger' : 'btn-secondary']" :disabled="acting" @click="runPending">{{ acting ? 'Working…' : pending.action === 'delete' ? 'Delete Permanently' : 'Move to macOS Trash' }}</button>
          <button class="btn btn-secondary btn-sm" :disabled="acting" @click="pending = null">Cancel</button>
        </div>
      </section>

      <section class="card retention" aria-labelledby="retention-title">
        <h2 id="retention-title">Automatic retention</h2>
        <p class="muted">Generated files age out by themselves: anything in this Trash waits the number of days below, then moves to the Mac's own Trash (recoverable there; macOS empties it after its own 30 days). If the whole Trash passes the size below, the oldest items are handed over early until it is back under it. The same daily check runs the Free up space → Clean Up All Channels rule — verified uploads older than 7 days of production, plus unused leftovers — with no change to that rule. The buttons above still work; this only adds what happens when nobody clicks.</p>
        <div class="retention-controls">
          <label>Send Trash to the Mac's Trash after
            <input v-model.number="retentionDays" type="number" min="1" max="365" :disabled="retentionSaving" /> days
          </label>
          <label>or
            <input v-model.number="retentionGb" type="number" min="1" max="10000" :disabled="retentionSaving" /> GB
          </label>
          <label class="retention-toggle"><input v-model="autoCleanup" type="checkbox" :disabled="retentionSaving" /> Automatic cleanup</label>
          <button class="btn btn-secondary btn-sm" :disabled="retentionSaving || !retentionDirty" @click="saveRetention">{{ retentionSaving ? 'Saving…' : 'Save' }}</button>
        </div>
        <p v-if="retention && !retention.mac_trash_available" class="muted" role="status">The Mac's Trash is only reachable while Story Studio runs as the app on the Mac, so the automatic handoff is skipped here.</p>
        <p v-if="retention?.last_handoff" class="muted">Last Trash handoff: {{ formatRetentionRun(retention.last_handoff) }}</p>
        <p v-if="retention?.last_auto_cleanup" class="muted">Last automatic cleanup: {{ formatRetentionRun(retention.last_auto_cleanup) }}</p>
      </section>

      <div class="totals">
        <article><span>In the Trash</span><strong>{{ formatBytes(listing.total_bytes) }}</strong><small>{{ listing.items_total }} {{ listing.items_total === 1 ? 'item' : 'items' }}</small></article>
        <article><span>Channels</span><strong>{{ listing.channels.length }}</strong><small>with something in the Trash</small></article>
        <article class="where"><span>Where it is</span><small v-for="root in listing.roots" :key="root"><code>{{ root }}</code></small></article>
      </div>

      <div class="columns">
        <section class="card">
          <h2>By channel</h2>
          <p v-if="!listing.channels.length" class="muted">The Trash is empty.</p>
          <table v-else>
            <thead><tr><th>Channel</th><th class="num">Items</th><th class="num">Size</th></tr></thead>
            <tbody>
              <tr v-for="row in listing.channels" :key="row.slug" :class="{ picked: channel === row.slug }">
                <td><button class="link" @click="channel = channel === row.slug ? '' : row.slug">{{ channelLabel(row.slug) }}</button></td>
                <td class="num">{{ row.items }}</td><td class="num">{{ formatBytes(row.bytes) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="card">
          <h2>By kind</h2>
          <p v-if="!listing.kinds.length" class="muted">Nothing yet.</p>
          <table v-else>
            <thead><tr><th>Kind</th><th class="num">Items</th><th class="num">Size</th></tr></thead>
            <tbody>
              <tr v-for="row in listing.kinds" :key="row.kind" :class="{ picked: kind === row.kind }">
                <td><button class="link" @click="kind = kind === row.kind ? '' : row.kind">{{ kindLabel(row.kind) }}</button></td>
                <td class="num">{{ row.items }}</td><td class="num">{{ formatBytes(row.bytes) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <section class="card">
        <div class="items-head">
          <h2>Items <small v-if="channel || kind">· {{ [channel && channelLabel(channel), kind && kindLabel(kind)].filter(Boolean).join(' · ') }} <button class="link" @click="channel = ''; kind = ''">Show all</button></small></h2>
          <small v-if="listing.items_total > listing.items.length" class="muted">Newest {{ listing.items.length }} of {{ listing.items_total }} shown; the totals above count everything.</small>
        </div>
        <p v-if="!shown.length" class="muted">Nothing here.</p>
        <ul v-else class="items">
          <li v-for="item in shown" :key="item.id">
            <input v-if="item.movable" v-model="selected" type="checkbox" class="pick" :value="item.id" :disabled="busy" :aria-label="`Select ${baseName(item.path)}`" />
            <span v-else class="pick" />
            <div class="item-main">
              <strong>{{ item.path ? baseName(item.path) : 'Older items' }}</strong>
              <span class="muted">{{ channelLabel(item.slug) }} · {{ kindLabel(item.kind) }} · {{ formatBytes(item.bytes) }}<template v-if="item.at"> · {{ formatDate(item.at) }}</template></span>
              <small v-if="item.from" class="path">From <code>{{ item.from }}</code></small>
              <small v-else-if="item.restore_note" class="path">{{ item.restore_note }}</small>
            </div>
            <div class="item-actions">
              <button v-if="item.restorable" class="btn btn-secondary btn-sm" :disabled="busy" @click="restore(item)">{{ restoring === item.id ? 'Restoring…' : 'Restore' }}</button>
              <button v-if="item.path" class="btn btn-ghost btn-sm" :disabled="busy" @click="reveal(item.path)">Show in Finder</button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useApi } from '~/composables/useApi'

interface TrashItem { id: string; slug: string; kind: string; path: string; from: string | null; at: string | null; bytes: number; restorable: boolean; restore_note?: string; movable: boolean; deletable: boolean }
interface Totals { items: number; bytes: number }
interface Listing {
  roots: string[]; total_bytes: number; channels: { slug: string; bytes: number; items: number }[]; kinds: { kind: string; bytes: number; items: number }[]
  items: TrashItem[]; items_total: number; oldest: { at: string; path: string; slug: string } | null; movable: Totals; deletable: Totals
}
interface RetentionRun { at: string; status: 'completed' | 'failed' | 'skipped'; detail: string; moved?: number; bytes?: number }
interface Retention {
  trash_handoff_days: number; trash_handoff_gb: number; auto_cleanup_enabled: boolean; mac_trash_available: boolean
  last_handoff: RetentionRun | null; last_auto_cleanup: RetentionRun | null
}
type Action = 'macos' | 'delete'

const KINDS: Record<string, string> = {
  final_video: 'Final videos', images: 'Scene images', chapter_audio: 'Chapter narration', narration_parts: 'Narration parts',
  merged_audio: 'Merged narration', master_audio: 'Full-quality audio', motion_clips: 'Motion clips', audio: 'Older narration takes',
  'preview-cache': 'Preview cache', script: 'Scripts', subtitles: 'Subtitles', research: 'Research', 'covered-topics': 'Covered-topics map',
  music: 'Music', leftovers: 'Leftover files', episode: 'Removed ideas and episodes', 'moved-source': 'Originals of moved folders',
  'unverified-copy': 'Copies that did not verify', 'character-picture': 'Character pictures', outline: 'Living Picture outlines', 'launch-agent': 'Open at Login setting',
  app: 'Older app versions', 'app-update': 'Update downloads', 'trash-folder': 'From the old app Trash Folder',
  legacy: 'From the old channel trash', other: 'Other',
}
const { get, post, put } = useApi()
const listing = ref<Listing | null>(null)
const retention = ref<Retention | null>(null)
const retentionDays = ref(7)
const retentionGb = ref(20)
const autoCleanup = ref(true)
const retentionSaving = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const channel = ref('')
const kind = ref('')
const restoring = ref('')
const selected = ref<string[]>([])
const pending = ref<{ action: Action; ids: string[] | 'all'; count: number; bytes: number } | null>(null)
const acting = ref(false)
const busy = computed(() => loading.value || acting.value || !!restoring.value)
const shown = computed(() => (listing.value?.items || []).filter(item => (!channel.value || item.slug === channel.value) && (!kind.value || item.kind === kind.value)))
const retentionDirty = computed(() => {
  const saved = retention.value
  if (!saved) return false
  return retentionDays.value !== saved.trash_handoff_days || retentionGb.value !== saved.trash_handoff_gb || autoCleanup.value !== saved.auto_cleanup_enabled
})

function message(e: any, fallback: string) { return e?.data?.detail || e?.message || fallback }
function formatBytes(n: number) { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB` }
function formatDate(iso: string) { return new Date(iso).toLocaleString() }
function formatRetentionRun(run: RetentionRun) { return `${formatDate(run.at)} — ${run.status}: ${run.detail}` }
function baseName(p: string) { return p.split('/').filter(Boolean).pop() || p }
function kindLabel(k: string) { return KINDS[k] || k.replaceAll('_', ' ').replaceAll('-', ' ') }
function channelLabel(slug: string) { return slug === '_story-studio' ? 'Story Studio (the app)' : slug === '_character-library' ? 'Character Library' : slug.replaceAll('-', ' ') }

function countLabel(n: number) { return `${n} ${n === 1 ? 'item' : 'items'}` }

async function load() {
  loading.value = true; error.value = ''
  void loadRetention()
  try {
    listing.value = await get<Listing>('/trash')
    const ids = new Set(listing.value.items.map(item => item.id))
    selected.value = selected.value.filter(id => ids.has(id))
  } catch (e) { error.value = message(e, 'Could not read the Trash.') }
  finally { loading.value = false }
}
async function loadRetention() {
  try {
    const saved = await get<Retention>('/trash/retention')
    retention.value = saved
    retentionDays.value = saved.trash_handoff_days
    retentionGb.value = saved.trash_handoff_gb
    autoCleanup.value = saved.auto_cleanup_enabled
  } catch (e) { error.value = message(e, 'Could not read the retention settings.') }
}
async function saveRetention() {
  if (retentionSaving.value) return
  retentionSaving.value = true; error.value = ''; notice.value = ''
  try {
    const saved = await put<Retention>('/trash/retention', { trash_handoff_days: retentionDays.value, trash_handoff_gb: retentionGb.value, auto_cleanup_enabled: autoCleanup.value })
    retention.value = saved
    retentionDays.value = saved.trash_handoff_days
    retentionGb.value = saved.trash_handoff_gb
    autoCleanup.value = saved.auto_cleanup_enabled
    notice.value = 'Retention saved.'
  } catch (e) { error.value = message(e, 'Could not save the retention settings.') }
  finally { retentionSaving.value = false }
}
function selectedFor(action: Action) {
  return (listing.value?.items || []).filter(item => selected.value.includes(item.id) && (action === 'delete' ? item.deletable : item.movable))
}
/** What the confirmation shows is exactly what the server must still measure before it acts. */
function ask(action: Action, scope: 'selected' | 'all') {
  if (!listing.value) return
  if (scope === 'all') {
    const totals = action === 'delete' ? listing.value.deletable : listing.value.movable
    pending.value = { action, ids: 'all', count: totals.items, bytes: totals.bytes }
    return
  }
  const items = selectedFor(action)
  pending.value = { action, ids: items.map(item => item.id), count: items.length, bytes: items.reduce((n, item) => n + item.bytes, 0) }
}
async function runPending() {
  const p = pending.value
  if (!p || acting.value) return
  acting.value = true; error.value = ''; notice.value = ''
  try {
    if (p.action === 'macos') {
      const result = await post<{ moved: number; bytes: number; errors: string[] }>('/trash/macos-trash', { ids: p.ids, expected_count: p.count, expected_bytes: p.bytes })
      notice.value = `Moved ${countLabel(result.moved)} (${formatBytes(result.bytes)}) to the Mac's Trash; that space comes back once the Mac's Trash is emptied.${result.errors.length ? ` ${result.errors.length} could not be moved and stayed here: ${result.errors.join('; ')}` : ''}`
    } else {
      const result = await post<{ deleted: number; bytes_freed: number; errors: string[] }>('/trash/delete-permanently', { ids: p.ids, confirm: true, expected_count: p.count, expected_bytes: p.bytes })
      notice.value = `Deleted ${countLabel(result.deleted)} permanently: ${formatBytes(result.bytes_freed)} freed.${result.errors.length ? ` ${result.errors.length} could not be deleted: ${result.errors.join('; ')}` : ''}`
    }
    selected.value = []
  } catch (e) { error.value = message(e, p.action === 'delete' ? 'Could not delete the items.' : 'Could not move the items to the Mac\'s Trash.') }
  finally { pending.value = null; acting.value = false; await load() }
}
async function restore(item: TrashItem) {
  restoring.value = item.id; error.value = ''; notice.value = ''
  try {
    const result = await post<{ restored_to: string }>('/trash/restore', { id: item.id })
    notice.value = `Restored to ${result.restored_to}.`
    await load()
  } catch (e) { error.value = message(e, 'Could not restore it.') }
  finally { restoring.value = '' }
}
async function reveal(p: string) {
  try { await post('/system/reveal-folder', { path: p }) } catch (e) { error.value = message(e, 'Could not show it in Finder.') }
}
onMounted(load)
</script>

<style scoped>
/* Width, margin and padding belong to .page-frame (was: pinned at 1120px). */
.trash-page { color: var(--text-primary); }
.trash-header { display: flex; margin-top: 4px; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.trash-header h1 { margin: 2px 0; color: var(--accent); }
.trash-header p { margin: 0; max-width: 760px; color: var(--text-muted); line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.totals { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 12px; margin: 16px 0; }
.totals article, .card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-secondary); padding: 16px; }
.totals span, .totals small { display: block; color: var(--text-muted); font-size: var(--font-xs); }
.totals strong { display: block; margin: 4px 0; font-size: 24px; }
.where code { word-break: break-all; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.card { margin-top: 12px; }
.card h2 { margin: 0 0 10px; font-size: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--border); text-align: left; }
th { color: var(--text-muted); font-size: var(--font-xs); text-transform: uppercase; }
tr.picked td { background: var(--accent-dim); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.link { padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; text-align: left; text-transform: capitalize; }
.items-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.items { list-style: none; margin: 0; padding: 0; }
.items li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.pick { flex: 0 0 16px; }
.item-main { display: grid; flex: 1 1 auto; gap: 2px; min-width: 0; }
.free-space { margin-top: 0; }
.retention-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-bottom: 8px; }
.retention-controls input[type='number'] { width: 5em; margin: 0 4px; }
.retention-toggle { display: inline-flex; align-items: center; gap: 6px; }
.free-space .summary { margin: 0 0 6px; }
.free-space .summary strong { font-size: 20px; }
.free-space .muted { margin: 0 0 10px; line-height: 1.5; }
.space-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.item-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-main .muted { text-transform: capitalize; }
.path { color: var(--text-muted); word-break: break-all; }
.item-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.muted { color: var(--text-muted); font-size: 13px; }
.trash-error { color: var(--error, #dc2626); }
.trash-notice { color: var(--success); }
.confirm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
@media (max-width: 760px) { .trash-header { flex-direction: column; } .totals, .columns { grid-template-columns: 1fr; } .items li { align-items: flex-start; flex-direction: column; } }
</style>
