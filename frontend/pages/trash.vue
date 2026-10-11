<template>
  <div class="trash-page">
    <PlainBackLink />
    <header class="trash-header">
      <div>
        <span class="eyebrow">Story Studio</span>
        <h1>Trash</h1>
        <p>Everything Story Studio removes, from every channel, waits here. Nothing in it is used. Restore puts an item back where it was; the space comes back when you empty the Trash.</p>
      </div>
      <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load">{{ loading ? 'Measuring…' : 'Refresh' }}</button>
    </header>

    <p v-if="error" class="trash-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="trash-notice" role="status">{{ notice }}</p>
    <p v-if="loading && !listing" class="muted" role="status">Measuring the Trash…</p>

    <template v-if="listing">
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

      <section class="card danger-zone" aria-labelledby="empty-trash-title">
        <h2 id="empty-trash-title">Empty Trash</h2>
        <p>Deletes everything in the Trash for good ({{ formatBytes(listing.total_bytes) }}). Nothing can be restored afterwards. Only you can do this; Story Studio and its agents never empty the Trash.</p>
        <button v-if="!confirming" class="btn btn-danger btn-sm" :disabled="busy || !listing.total_bytes" @click="confirming = true; typed = ''">Empty Trash…</button>
        <div v-else class="confirm-row">
          <label for="empty-trash-confirm">Type <strong>{{ PHRASE }}</strong> to delete {{ formatBytes(listing.total_bytes) }} permanently</label>
          <input id="empty-trash-confirm" v-model="typed" class="input" autocomplete="off" :disabled="busy" @keydown.enter="emptyTrash" />
          <button class="btn btn-danger btn-sm" :disabled="busy || typed.trim() !== PHRASE" @click="emptyTrash">{{ emptying ? 'Emptying…' : 'Delete Permanently' }}</button>
          <button class="btn btn-secondary btn-sm" :disabled="emptying" @click="confirming = false">Cancel</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useApi } from '~/composables/useApi'

interface TrashItem { id: string; slug: string; kind: string; path: string; from: string | null; at: string | null; bytes: number; restorable: boolean; restore_note?: string }
interface Listing { roots: string[]; total_bytes: number; channels: { slug: string; bytes: number; items: number }[]; kinds: { kind: string; bytes: number; items: number }[]; items: TrashItem[]; items_total: number }

const PHRASE = 'EMPTY TRASH'
const KINDS: Record<string, string> = {
  final_video: 'Final videos', images: 'Scene images', chapter_audio: 'Chapter narration', narration_parts: 'Narration parts',
  merged_audio: 'Merged narration', master_audio: 'Full-quality audio', motion_clips: 'Motion clips', audio: 'Older narration takes',
  'preview-cache': 'Preview cache', script: 'Scripts', subtitles: 'Subtitles', research: 'Research', 'covered-topics': 'Covered-topics map',
  music: 'Music', leftovers: 'Leftover files', episode: 'Removed ideas and episodes', 'moved-source': 'Originals of moved folders',
  'unverified-copy': 'Copies that did not verify', 'character-picture': 'Character pictures', outline: 'Living Picture outlines', 'launch-agent': 'Open at Login setting',
  legacy: 'From the old channel trash', other: 'Other',
}
const { get, post } = useApi()
const listing = ref<Listing | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const channel = ref('')
const kind = ref('')
const restoring = ref('')
const confirming = ref(false)
const emptying = ref(false)
const typed = ref('')
const busy = computed(() => loading.value || emptying.value || !!restoring.value)
const shown = computed(() => (listing.value?.items || []).filter(item => (!channel.value || item.slug === channel.value) && (!kind.value || item.kind === kind.value)))

function message(e: any, fallback: string) { return e?.data?.detail || e?.message || fallback }
function formatBytes(n: number) { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB` }
function formatDate(iso: string) { return new Date(iso).toLocaleString() }
function baseName(p: string) { return p.split('/').filter(Boolean).pop() || p }
function kindLabel(k: string) { return KINDS[k] || k.replaceAll('_', ' ').replaceAll('-', ' ') }
function channelLabel(slug: string) { return slug === '_story-studio' ? 'Story Studio (the app)' : slug === '_character-library' ? 'Character Library' : slug.replaceAll('-', ' ') }

async function load() {
  loading.value = true; error.value = ''
  try { listing.value = await get<Listing>('/trash') } catch (e) { error.value = message(e, 'Could not read the Trash.') }
  finally { loading.value = false }
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
async function emptyTrash() {
  if (typed.value.trim() !== PHRASE || emptying.value) return
  emptying.value = true; error.value = ''; notice.value = ''
  try {
    const result = await post<{ bytes_freed: number; removed: number; errors: string[] }>('/trash/empty', { confirm: PHRASE })
    notice.value = `Trash emptied: ${formatBytes(result.bytes_freed)} freed.${result.errors.length ? ` ${result.errors.length} could not be deleted: ${result.errors.join('; ')}` : ''}`
    confirming.value = false; typed.value = ''
    await load()
  } catch (e) { error.value = message(e, 'Could not empty the Trash.') }
  finally { emptying.value = false }
}
onMounted(load)
</script>

<style scoped>
.trash-page { max-width: 1120px; margin: 0 auto; padding: 24px; color: var(--text-primary); }
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
.item-main { display: grid; gap: 2px; min-width: 0; }
.item-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-main .muted { text-transform: capitalize; }
.path { color: var(--text-muted); word-break: break-all; }
.item-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.muted { color: var(--text-muted); font-size: 13px; }
.trash-error { color: var(--error, #dc2626); }
.trash-notice { color: var(--success); }
.danger-zone { border-color: color-mix(in srgb, var(--error, #dc2626) 40%, var(--border)); }
.danger-zone p { margin: 0 0 10px; color: var(--text-secondary); line-height: 1.5; }
.confirm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.confirm-row label { flex-basis: 100%; }
.confirm-row .input { max-width: 220px; }
@media (max-width: 760px) { .trash-header { flex-direction: column; } .totals, .columns { grid-template-columns: 1fr; } .items li { align-items: flex-start; flex-direction: column; } }
</style>
