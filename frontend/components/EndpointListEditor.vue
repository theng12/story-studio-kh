<!--
  v1.0.257 — Modular endpoint list editor for local modal pools (Image Studio /
  Voice Studio). Add/remove one row per Mac, test each (●online / ○offline),
  and Save. Self-contained: reads/writes {routePrefix}/base-url (stored as a
  comma-joined list) and probes {routePrefix}/test. The render/TTS pool
  (lib/endpoint-pool.ts) health-checks + distributes least-busy across whatever
  is online, so stale/offline rows are harmless.
-->
<template>
  <div class="ep-editor mt-2">
    <div v-for="(row, i) in rows" :key="i" class="ep-row">
      <span class="ep-dot" :class="row.status" :title="row.detail || row.status">
        <template v-if="row.status === 'testing'">⋯</template>
        <template v-else-if="row.status === 'online'">●</template>
        <template v-else-if="row.status === 'offline'">○</template>
        <template v-else>○</template>
      </span>
      <input
        v-model="row.url"
        type="text"
        class="input input-sm ep-input"
        :placeholder="placeholder || 'http://your-mac.local:port'"
        spellcheck="false"
        @input="row.status = 'idle'; row.detail = ''"
      />
      <button class="btn btn-sm btn-secondary ep-test" :disabled="!row.url.trim() || row.status === 'testing'" @click="testRow(i)">
        {{ row.status === 'testing' ? '…' : 'Test' }}
      </button>
      <button class="ep-remove" :disabled="rows.length === 1" title="Remove endpoint" @click="removeRow(i)">✕</button>
    </div>

    <p v-if="lastDetail" class="ep-detail">{{ lastDetail }}</p>

    <div class="ep-actions">
      <button class="btn btn-sm btn-ghost" @click="addRow">＋ Add endpoint</button>
      <button class="btn btn-sm btn-secondary" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : 'Save endpoints' }}
      </button>
      <button class="btn btn-sm btn-ghost" :disabled="testingAll || !anyUrl" @click="testAll">
        {{ testingAll ? 'Testing…' : 'Test all' }}
      </button>
      <span v-if="savedMsg" class="ep-saved">✓ {{ savedMsg }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Row { url: string; status: 'idle' | 'testing' | 'online' | 'offline'; detail: string }

const props = defineProps<{ routePrefix: string; placeholder?: string }>()
const emit = defineEmits<{ (e: 'saved', urls: string[]): void }>()

const { get, put, post } = useApi()
const { success, error: showError } = useToast()

const rows = ref<Row[]>([{ url: '', status: 'idle', detail: '' }])
const saving = ref(false)
const testingAll = ref(false)
const savedMsg = ref('')
const lastDetail = ref('')

const anyUrl = computed(() => rows.value.some(r => r.url.trim()))

onMounted(load)
async function load(): Promise<void> {
  try {
    const r = await get<{ baseUrl: string }>(`${props.routePrefix}/base-url`)
    const urls = (r.baseUrl || '').split(/[\s,]+/).map(u => u.trim()).filter(Boolean)
    rows.value = urls.length
      ? urls.map(u => ({ url: u, status: 'idle' as const, detail: '' }))
      : [{ url: '', status: 'idle', detail: '' }]
  } catch { /* keep the single empty row */ }
}

function addRow(): void { rows.value.push({ url: '', status: 'idle', detail: '' }) }
function removeRow(i: number): void {
  rows.value.splice(i, 1)
  if (!rows.value.length) addRow()
}

/** Build a short capability summary from the provider's /test response. */
function describe(res: any): string {
  const bits: string[] = []
  if (res.appVersion) bits.push(`v${res.appVersion}`)
  if (typeof res.modelCount === 'number') bits.push(`${res.modelCount} model${res.modelCount === 1 ? '' : 's'}`)
  if (typeof res.voiceLibraryCount === 'number') bits.push(`${res.voiceLibraryCount} voice${res.voiceLibraryCount === 1 ? '' : 's'}`)
  if (res.device) bits.push(String(res.device))
  if (Array.isArray(res.loadedFamilies) && res.loadedFamilies.length) bits.push(`loaded: ${res.loadedFamilies.join(', ')}`)
  return bits.join(' · ')
}

async function testRow(i: number): Promise<void> {
  const row = rows.value[i]
  const url = row.url.trim()
  if (!url) return
  row.status = 'testing'; row.detail = ''
  try {
    const res: any = await post(`${props.routePrefix}/test`, { baseUrl: url })
    if (res.ok) {
      row.status = 'online'; row.detail = describe(res)
      lastDetail.value = `${url} — online${row.detail ? ' · ' + row.detail : ''}`
    } else {
      row.status = 'offline'; row.detail = res.error || 'unreachable'
      lastDetail.value = `${url} — ${row.detail}`
    }
  } catch (e: any) {
    row.status = 'offline'; row.detail = e?.data?.detail || e?.message || 'test failed'
    lastDetail.value = `${url} — ${row.detail}`
  }
}

async function testAll(): Promise<void> {
  testingAll.value = true
  try {
    for (let i = 0; i < rows.value.length; i++) {
      if (rows.value[i].url.trim()) await testRow(i)
    }
  } finally { testingAll.value = false }
}

async function save(): Promise<void> {
  const urls = rows.value.map(r => r.url.trim()).filter(Boolean)
  if (!urls.length) { showError('Add at least one endpoint URL.'); return }
  saving.value = true
  try {
    const r = await put<{ baseUrl: string }>(`${props.routePrefix}/base-url`, { baseUrl: urls.join(', ') })
    // The server cleans/validates + returns the stored list — reflect it.
    const cleaned = (r?.baseUrl || urls.join(', ')).split(/[\s,]+/).map(u => u.trim()).filter(Boolean)
    rows.value = cleaned.map(u => {
      const prev = rows.value.find(x => x.url.trim() === u)
      return { url: u, status: prev?.status ?? 'idle', detail: prev?.detail ?? '' }
    })
    savedMsg.value = `${cleaned.length} endpoint${cleaned.length === 1 ? '' : 's'}`
    success('Endpoints saved.')
    emit('saved', cleaned)
    setTimeout(() => { savedMsg.value = '' }, 3000)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save endpoints')
  } finally { saving.value = false }
}
</script>

<style scoped>
.ep-editor { display: flex; flex-direction: column; gap: 6px; }
.ep-row { display: flex; align-items: center; gap: 8px; }
.ep-input { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ep-dot { width: 14px; text-align: center; flex: 0 0 auto; font-size: 12px; }
.ep-dot.online { color: #5bb37c; }
.ep-dot.offline { color: #c97a4a; }
.ep-dot.testing { color: var(--accent, #f0c674); }
.ep-dot.idle { color: var(--text-muted); }
.ep-test { flex: 0 0 auto; }
.ep-remove {
  flex: 0 0 auto;
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-muted); cursor: pointer; padding: 4px 9px; font-size: 12px;
}
.ep-remove:hover:not(:disabled) { color: #c97a4a; border-color: #c97a4a; }
.ep-remove:disabled { opacity: 0.4; cursor: not-allowed; }
.ep-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.ep-saved { color: #5bb37c; font-size: 12px; }
.ep-detail { font-size: 11px; color: var(--text-muted); margin: 2px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
