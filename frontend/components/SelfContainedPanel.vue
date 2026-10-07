<template>
  <section class="self-contained" :aria-labelledby="headingId">
    <div class="sc-heading">
      <div>
        <h3 :id="headingId">{{ slug ? 'Make this channel self-contained' : 'Make all channels self-contained' }}</h3>
        <p>
          Copies every shared file {{ slug ? 'this channel uses' : 'each channel uses' }} — logos, intros, music beds, overlays, backgrounds —
          into the channel's own <code>assets</code> folder and moves its finished videos into the channel's <code>Exports</code> folder,
          so copying the channel folder to another Mac takes everything along. <code>_Project Assets</code> and every original file are left where they are.
        </p>
      </div>
      <button class="btn btn-secondary" :disabled="busy" @click="loadPlan">{{ loading ? 'Checking…' : plan ? 'Check Again' : 'Preview' }}</button>
    </div>
    <p v-if="error" class="sc-error" role="alert">{{ error }}</p>

    <div v-if="plan" class="sc-plan" role="status" aria-live="polite">
      <p v-if="plan.done && !totals.missing"><strong>Already self-contained.</strong> Nothing to copy or move.</p>
      <ul v-else class="sc-totals">
        <li><strong>{{ totals.files_to_copy }}</strong> {{ totals.files_to_copy === 1 ? 'file' : 'files' }} to copy · {{ formatBytes(totals.bytes_to_copy) }}</li>
        <li><strong>{{ totals.refs_to_rewrite }}</strong> saved {{ totals.refs_to_rewrite === 1 ? 'setting' : 'settings' }} pointed at the channel's copy</li>
        <li><strong>{{ totals.exports_to_move }}</strong> finished-video {{ totals.exports_to_move === 1 ? 'file' : 'files' }} to move · {{ formatBytes(totals.export_bytes) }}</li>
        <li v-if="totals.missing" class="sc-warn"><strong>{{ totals.missing }}</strong> {{ totals.missing === 1 ? 'file is' : 'files are' }} missing on this Mac and will be left as they are</li>
      </ul>
      <details v-for="ch in channels" :key="ch.slug" class="disclosure sc-channel" :open="channels.length === 1">
        <summary>
          <strong>{{ ch.slug }}</strong>
          <small>{{ ch.done && !ch.totals.missing ? 'done' : `${ch.totals.files_to_copy} to copy · ${ch.totals.exports_to_move} videos to move${ch.totals.missing ? ` · ${ch.totals.missing} missing` : ''}` }}</small>
        </summary>
        <p v-if="ch.exports.blocked" class="sc-warn">{{ ch.exports.blocked }}</p>
        <p v-if="!ch.exports.channel_local" class="sc-hint">Finished videos stay in the folder chosen for them (a separate finished-videos folder or this channel's media drive).</p>
        <ul class="sc-rows">
          <li v-for="(r, i) in ch.refs" :key="i" :class="{ 'sc-warn': r.action === 'missing' }">
            <span class="sc-path">{{ r.from }}</span>
            <span>{{ r.action === 'missing' ? 'missing — left as is' : `→ ${r.to}` }}<template v-if="r.bytes"> · {{ formatBytes(r.bytes) }}</template></span>
          </li>
          <li v-if="ch.exports.moves.length"><span class="sc-path">{{ ch.exports.from }}</span><span>→ {{ ch.exports.to }} · {{ ch.exports.moves.length }} files</span></li>
          <li v-for="c in ch.exports.conflicts" :key="c.from" class="sc-warn"><span class="sc-path">{{ c.from }}</span><span>already at the destination — left where it is</span></li>
        </ul>
        <p v-if="ch.content_packs.length" class="sc-hint">
          Content packs this channel uses (install the same versions on the other Mac):
          <span v-for="p in ch.content_packs" :key="p.pack_id" class="sc-pack">{{ p.pack_id }} {{ p.version }}<template v-if="!p.installed"> (not installed here)</template></span>
        </p>
      </details>
      <div v-if="!plan.done" class="sc-actions">
        <button class="btn btn-primary" :disabled="busy" @click="apply">{{ applying ? 'Working…' : slug ? 'Make Channel Self-Contained' : 'Make All Channels Self-Contained' }}</button>
      </div>
    </div>

    <div v-if="result" class="sc-result" role="status">
      <p>{{ resultSummary }}</p>
      <ul v-if="resultErrors.length" class="sc-warn"><li v-for="e in resultErrors" :key="e">{{ e }}</li></ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

interface Totals { refs_to_rewrite: number; files_to_copy: number; bytes_to_copy: number; missing: number; exports_to_move: number; export_bytes: number }
interface ChannelPlan {
  slug: string
  refs: Array<{ from: string; to: string; action: 'copy' | 'rewrite' | 'missing'; bytes: number }>
  exports: { channel_local: boolean; from: string; to: string; moves: Array<{ from: string }>; conflicts: Array<{ from: string }>; blocked: string }
  content_packs: Array<{ pack_id: string; version: string; installed: boolean }>
  totals: Totals
  done: boolean
}
interface ApplyResult { slug: string; copied: unknown[]; rewritten: number; exports_moved: number; errors: string[]; plan_after: ChannelPlan }

/** With a slug: this channel. Without: every channel in the Library. */
const props = defineProps<{ slug?: string }>()
const { get, post } = useApi()
const { ask } = useConfirm()

const headingId = computed(() => props.slug ? 'self-contained-channel' : 'self-contained-library')
const plan = ref<{ channels?: ChannelPlan[]; totals: Totals; done: boolean } | null>(null)
const result = ref<ApplyResult[] | null>(null)
const loading = ref(false)
const applying = ref(false)
const error = ref('')
const busy = computed(() => loading.value || applying.value)
const channels = computed<ChannelPlan[]>(() => plan.value?.channels ?? (plan.value ? [plan.value as unknown as ChannelPlan] : []))
const totals = computed<Totals>(() => plan.value!.totals)
const endpoint = computed(() => props.slug ? `/projects/${encodeURIComponent(props.slug)}/self-contained` : '/library/self-contained')

async function loadPlan() {
  loading.value = true
  error.value = ''
  try {
    plan.value = await get(endpoint.value)
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not check this channel.'
  } finally {
    loading.value = false
  }
}

async function apply() {
  if (!plan.value) return
  const t = totals.value
  const ok = await ask({
    title: props.slug ? 'Make this channel self-contained?' : 'Make all channels self-contained?',
    message: `Copy ${t.files_to_copy} files (${formatBytes(t.bytes_to_copy)}) into ${props.slug ? "the channel's" : "each channel's"} assets folder, checking every copy, `
      + `point ${t.refs_to_rewrite} saved settings at those copies, and move ${t.exports_to_move} finished-video files (${formatBytes(t.export_bytes)}) into the channel. `
      + 'Shared files and originals are not removed. Running it again is safe.',
    confirmLabel: props.slug ? 'Make Channel Self-Contained' : 'Make All Self-Contained',
    danger: false,
  })
  if (!ok) return
  applying.value = true
  error.value = ''
  try {
    const r: any = await post(endpoint.value, {})
    result.value = r.channels ?? [r]
    await loadPlan()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not finish. Nothing already copied is lost; run it again.'
  } finally {
    applying.value = false
  }
}

const resultErrors = computed(() => (result.value ?? []).flatMap(r => r.errors.map(e => `${r.slug}: ${e}`)))
const resultSummary = computed(() => {
  const rs = result.value ?? []
  const copied = rs.reduce((n, r) => n + r.copied.length, 0)
  const rewritten = rs.reduce((n, r) => n + r.rewritten, 0)
  const moved = rs.reduce((n, r) => n + r.exports_moved, 0)
  return `Done: ${copied} files copied and verified, ${rewritten} settings updated, ${moved} finished-video files moved.`
})
</script>

<style scoped>
.self-contained { padding: 20px 0; scroll-margin-top: 24px; }
.sc-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
.sc-heading h3 { margin: 0 0 8px; }
.sc-heading > button { flex-shrink: 0; }
p { color: var(--text-secondary); line-height: 1.5; margin: 8px 0 12px; max-width: 72ch; }
.sc-totals { margin: 8px 0 12px; padding-left: 18px; line-height: 1.6; }
.sc-channel { border-top: 1px solid var(--border); padding: 10px 0; }
.sc-channel summary small { margin-left: 8px; color: var(--text-secondary); }
.sc-rows { list-style: none; padding: 0; margin: 8px 0; max-height: 320px; overflow: auto; }
.sc-rows li { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.sc-path { font-family: var(--font-mono, monospace); font-size: var(--font-sm); overflow-wrap: anywhere; }
.sc-rows li > span:last-child { overflow-wrap: anywhere; font-size: var(--font-sm); color: var(--text-secondary); }
.sc-hint { font-size: var(--font-sm); }
.sc-pack { display: inline-block; margin-right: 10px; font-family: var(--font-mono, monospace); }
.sc-warn { color: var(--warning, #b26a00); }
.sc-error { color: var(--danger, #c0392b); }
.sc-actions { margin-top: 12px; }
</style>
