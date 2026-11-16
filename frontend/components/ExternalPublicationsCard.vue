<script setup lang="ts">
/**
 * Published outside Story — imported releases, reviewed by a human, and what they cover.
 *
 * The file is chosen with the app's ONE picker and posted as a path; a refused row comes back with
 * its row number and reason and NOTHING is written. Verifying is the human review action, and it is
 * refused when the row would be a second coverage mark for a day or episode this channel already
 * covers. Dismissing is always allowed and never counts.
 *
 * Every control is an in-app control (no confirm/alert/prompt), and every action reports its result.
 */
import { pickFile } from '~/composables/usePathPicker'

interface Entry {
  id: string
  title: string
  published_at: string
  state: 'unlinked' | 'verified' | 'dismissed'
  video_url?: string
  video_id?: string
  episode_code?: string
  verified_at?: string | null
  verified_by?: string | null
}
interface Payload {
  status: 'absent' | 'ok' | 'unreadable'
  error?: string
  entries: Entry[]
  coverage: { verified: number; days: string[]; overlapping_local: string[] }
}

const props = defineProps<{ slug: string }>()
const { get, post, patch } = useApi()
const { ask } = useConfirm()

const data = ref<Payload | null>(null)
const loading = ref(true)
const busy = ref('')
const error = ref('')
const notice = ref('')
const refusals = ref<Array<{ row: number; reason: string }>>([])

const stateLabel: Record<Entry['state'], string> = {
  unlinked: 'Needs review',
  verified: 'Verified',
  dismissed: 'Dismissed',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await get<Payload>(`/projects/${props.slug}/external-publications`)
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not read this channel’s outside publications.'
  } finally { loading.value = false }
}

async function importFile() {
  if (busy.value) return
  refusals.value = []
  notice.value = ''
  error.value = ''
  const picked = await pickFile({ title: 'Choose a CSV or JSON file of releases', extensions: ['csv', 'json'] })
  if (!picked) return // a cancel writes nothing
  busy.value = 'import'
  try {
    const result = await post<{ imported: number; refusals: Array<{ row: number; reason: string }>; entries: Entry[]; detail?: string }>(
      `/projects/${props.slug}/external-publications/import`, { path: picked },
    )
    refusals.value = result.refusals || []
    if (refusals.value.length) {
      error.value = result.detail || 'Nothing was imported — fix the rows below and import again.'
    } else {
      notice.value = `Imported ${result.imported} release${result.imported === 1 ? '' : 's'}. Each one still needs your review before it counts.`
    }
    await load()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'That file could not be imported. Nothing was changed.'
  } finally { busy.value = '' }
}

async function review(entry: Entry, state: 'verified' | 'dismissed') {
  if (busy.value) return
  if (state === 'dismissed') {
    const confirmed = await ask({
      title: 'Dismiss this release?',
      message: `“${entry.title}” stays in the list as dismissed, and never counts as coverage.`,
      confirmLabel: 'Dismiss',
    })
    if (!confirmed) return
  }
  busy.value = entry.id
  error.value = ''
  notice.value = ''
  try {
    await patch(`/projects/${props.slug}/external-publications/${encodeURIComponent(entry.id)}`, { state, reviewer: 'owner' })
    notice.value = state === 'verified'
      ? `“${entry.title}” is verified and now counts on ${entry.published_at.slice(0, 10)}.`
      : `“${entry.title}” dismissed — it does not count.`
    await load()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'That review could not be saved. Nothing was changed.'
  } finally { busy.value = '' }
}

watch(() => props.slug, () => void load(), { immediate: true })
</script>

<template>
  <section class="panel external-card" aria-labelledby="external-publications-title">
    <div class="external-head">
      <div>
        <h2 id="external-publications-title">Published outside Story</h2>
        <p>
          Releases this channel made elsewhere. Import a CSV or JSON file, then verify each one — only
          a verified release counts toward the schedule's coverage. Nothing here talks to YouTube.
        </p>
      </div>
      <button type="button" class="btn btn-sm" :disabled="busy !== ''" @click="importFile">
        {{ busy === 'import' ? 'Importing…' : 'Import a file…' }}
      </button>
    </div>

    <p v-if="loading" class="hint">Loading outside publications…</p>
    <p v-else-if="error" class="result err" role="status">{{ error }}</p>
    <ul v-if="refusals.length" class="external-refusals">
      <li v-for="refusal in refusals" :key="refusal.row">Row {{ refusal.row }}: {{ refusal.reason }}</li>
    </ul>
    <p v-if="notice" class="result ok" role="status">{{ notice }}</p>

    <p v-if="!loading && data?.status === 'unreadable'" class="result err" role="status">
      The list file could not be read, so coverage is unknown — not zero. {{ data.error }}
    </p>

    <template v-if="!loading && data">
      <p v-if="data.coverage.verified" class="hint">
        {{ data.coverage.verified }} verified release{{ data.coverage.verified === 1 ? '' : 's' }} count toward coverage:
        {{ data.coverage.days.join(', ') }}.
      </p>
      <p v-if="data.coverage.overlapping_local.length" class="hint">
        These days are also covered by this channel's own schedule, so they are counted once:
        {{ data.coverage.overlapping_local.join(', ') }}.
      </p>
      <p v-if="!data.entries.length" class="hint">No outside releases imported yet.</p>
      <ul v-else class="external-list">
        <li v-for="entry in data.entries" :key="entry.id" class="external-entry">
          <div class="external-entry-body">
            <strong>{{ entry.title }}</strong>
            <span class="hint">{{ entry.published_at.slice(0, 10) }}<template v-if="entry.episode_code"> · {{ entry.episode_code }}</template></span>
          </div>
          <span class="external-state" :class="entry.state">{{ stateLabel[entry.state] }}</span>
          <div class="external-actions">
            <button
              v-if="entry.state !== 'verified'"
              type="button" class="btn btn-sm btn-primary" :disabled="busy !== ''"
              @click="review(entry, 'verified')"
            >Verify</button>
            <button
              v-if="entry.state !== 'dismissed'"
              type="button" class="btn btn-sm" :disabled="busy !== ''"
              @click="review(entry, 'dismissed')"
            >Dismiss</button>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.external-card { display: grid; gap: 12px; }
.external-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: start; justify-content: space-between; }
.external-head h2 { margin: 0 0 4px; font-size: 18px; }
.external-head p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.external-list, .external-refusals { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.external-refusals { color: var(--danger); font-size: var(--font-xs); }
.external-entry { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.external-entry-body { display: grid; gap: 2px; min-width: 0; flex: 1 1 220px; }
.external-entry-body strong { font-size: var(--font-xs); overflow-wrap: anywhere; }
.external-state { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: var(--font-xs); }
.external-state.verified { color: var(--success); border-color: currentColor; }
.external-state.dismissed { color: var(--text-muted); }
.external-actions { display: flex; gap: 6px; }
.hint { color: var(--text-muted); font-size: var(--font-xs); margin: 0; }
.result { margin: 0; font-size: var(--font-xs); }
.result.err { color: var(--danger); }
.result.ok { color: var(--success); }
</style>
