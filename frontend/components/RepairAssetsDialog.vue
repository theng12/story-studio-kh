<template>
  <Modal :visible="visible" size="xl" labelledby="repair-title" @close="emit('close')">
    <div class="dialog-head">
      <h2 id="repair-title" class="dialog-title">
        <span aria-hidden="true">&#8635;</span>
        {{ isScoped ? `Recover ${scopeLabel} — generated but not received` : 'Repair — generated but not received' }}
      </h2>
      <p v-if="isScoped" class="dialog-sub text-muted">
        Checks <strong>{{ scopeLabel }}</strong> only for gaps the provider might already have finished, then
        re-downloads {{ scopedCodes.length === 1 ? 'its' : 'their' }} audio and images from provider history.
        <strong>No credits consumed.</strong>
        Nothing else in the library is scanned or touched.
        Files without a stored recovery record come back as "needs fresh generation" in the job log.
      </p>
      <p v-else class="dialog-sub text-muted">
        Scans every accepted episode for gaps the provider might already have finished, then
        re-downloads audio and images from provider history. <strong>No credits consumed.</strong> Use this
        after an app crash, network blip, or timeout left provider-completed output unsaved locally.
        Files without a stored recovery record come back as "needs fresh generation" in the job log.
      </p>
    </div>

    <div class="repair-toolbar">
      <span v-if="lastRunAt" class="text-muted" style="font-size: 12px;">Last scan: {{ lastRunAt }}</span>
      <span v-if="repairableCounts.total > 0" class="repair-summary">
        <span class="repair-chip">Audio: {{ repairableCounts.audio }}</span>
        <span class="repair-chip">Images: {{ repairableCounts.images }}</span>
      </span>
      <div class="repair-toolbar-actions">
        <button class="btn btn-sm btn-secondary" :disabled="loading" @click="runAudit">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? 'Scanning…' : (rows.length ? 'Rescan' : 'Scan now') }}
        </button>
        <button
          class="btn btn-sm btn-primary"
          :disabled="repairing || repairableCounts.total === 0"
          :title="repairableCounts.total === 0
            ? 'No gaps detected — nothing to repair. Rescan after a generation attempt if you think something is missing.'
            : isScoped
              ? `Recovers only ${scopeLabel}'s missing audio and images from provider history. No credits consumed, nothing else is scanned.`
              : 'Queues repair jobs for every episode with missing audio or images. Reads provider history; no credits consumed.'"
          @click="repairAll"
        >
          <LoadingSpinner v-if="repairing" size="sm" />
          {{ repairing
            ? 'Queuing…'
            : isScoped ? `Recover ${scopeLabel}` : `Repair all (${repairableCounts.total})` }}
        </button>
      </div>
    </div>

    <div v-if="error" class="text-danger mt-2" style="font-size: 13px;">{{ error }}</div>

    <div v-if="loading && !rows.length" class="repair-empty">
      <LoadingSpinner size="sm" />
      {{ isScoped
        ? `Checking ${scopeLabel}…`
        : 'Scanning every episode — this may take a few seconds for large projects…' }}
    </div>
    <div v-else-if="!loading && !rows.length && !error" class="repair-empty">
      {{ isScoped
        ? `${scopeLabel} ${scopedCodes.length === 1 ? 'is not an accepted episode' : 'are not accepted episodes'}, so there is nothing to recover.`
        : 'No accepted ideas yet. Accept some in the Ideas Generator first.' }}
    </div>
    <div v-else-if="repairableCounts.total === 0" class="repair-empty">
      <span aria-hidden="true">&#9989;</span>
      {{ isScoped
        ? `Everything ${scopeLabel} generated is already on disk — nothing to recover.`
        : 'Everything generated is on disk — nothing to repair.' }}
    </div>

    <div v-else class="repair-list mt-2">
      <div class="repair-row repair-header">
        <span class="repair-ep">Episode</span>
        <span class="repair-gap">Audio gap</span>
        <span class="repair-gap">Images gap</span>
        <span class="repair-actions"></span>
      </div>
      <div v-for="row in repairableRows" :key="row.episode_id" class="repair-row">
        <div class="repair-ep">
          <strong>{{ row.episode_id }}</strong>
          <div class="text-muted" style="font-size: var(--font-xs);">{{ row.title }}</div>
        </div>
        <span class="repair-gap" :class="row.audio.missing > 0 ? 'gap-missing' : 'gap-ok'">
          {{ row.audio.missing > 0 ? `${row.audio.missing} missing` : '✓' }}
        </span>
        <span class="repair-gap" :class="(row.scenes.missing + row.thumbnails.missing) > 0 ? 'gap-missing' : 'gap-ok'">
          <template v-if="row.scenes.missing > 0">{{ row.scenes.missing }} scenes</template>
          <template v-if="row.scenes.missing > 0 && row.thumbnails.missing > 0"> · </template>
          <template v-if="row.thumbnails.missing > 0">{{ row.thumbnails.missing }} thumbs</template>
          <template v-if="row.scenes.missing === 0 && row.thumbnails.missing === 0">✓</template>
        </span>
        <span class="repair-actions">
          <button
            v-if="row.audio.missing > 0"
            class="btn btn-sm btn-ghost repair-btn-row"
            :disabled="repairingRow === row.episode_id"
            title="Repair audio for this episode only. Reads provider task history, no credits consumed."
            @click="repairSingleAudio(row.episode_id)"
          >↻ Audio</button>
          <button
            v-if="(row.scenes.missing + row.thumbnails.missing) > 0"
            class="btn btn-sm btn-ghost repair-btn-row"
            :disabled="repairingRow === row.episode_id"
            title="Repair scene + thumbnail images for this episode. Reads provider task history, no credits consumed."
            @click="repairSingleImages(row.episode_id)"
          >↻ Images</button>
        </span>
      </div>
    </div>

    <div class="dialog-actions">
      <button class="btn btn-secondary" @click="emit('close')">Close</button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Repair dialog — re-pulls provider-completed jobs (images / video / audio)
 * that finished on the provider's side but never persisted locally (app crash,
 * network blip, timeout). Relocated from the retired per-project Assets tab
 * (v1.0.481): the audit *matrix* that page also carried is now redundant with
 * the Production Board, but Repair is the unique, valuable capability — it
 * lives here, reachable from the board, and is the only place that calls
 * /assets/repair-all + the per-episode images/video/audio repair endpoints.
 *
 * Still uses GET /assets-audit to compute what's missing (that endpoint feeds
 * the gap counts below); only the on-page audit *visualisation* was dropped.
 *
 * v1.4.43 — the scope is a LIST, not a single code. Every entry point that
 * arrives here already knows which episodes are broken: a failed job knows its
 * own, and the batch-finished banner knows all of them. Sending one and
 * discarding the rest meant the banner's Repair button re-scanned the whole
 * library to reach episodes it could already name. The owner's words:
 * *"we just need what we need to get repaired. not a witch hunt. if i want a
 * witch hunt i will intentionally come here and do it myself."* The unscoped
 * library-wide scan survives untouched — it is the board's own Repair button,
 * which is the intentional way in.
 *
 * v1.2.8 — `episodeCode` turns this same dialog into a targeted recovery.
 * Library-wide Repair is a SEARCH tool: it scans everything because the usual
 * question is "which episode is broken?". When the user already knows — he is
 * looking straight at the job that failed — scanning seventy episodes to fix
 * one is slow and the wrong shape. The owner's words: *"it's never something i
 * will want to do intentionally at all… our case, we know exactly which one."*
 * Only the scope and the entry point change; the recovery machinery, the
 * endpoints and the no-credits guarantee are identical, which is exactly why
 * this is a prop and not a second dialog.
 */
const props = defineProps<{ visible: boolean; slug: string; episodeCodes?: string[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

interface AssetCount { total: number; present: number; missing: number }
interface AuditRow {
  episode_id: string
  title: string
  audio: AssetCount
  scenes: AssetCount
  thumbnails: AssetCount
  video: AssetCount
  merged_audio: { present: boolean }
  errors?: Record<string, string>
}

// The episodes this run is confined to. Empty = the deliberate library-wide
// scan. Deduplicated and trimmed here so no caller has to remember to.
const scopedCodes = computed(() => Array.from(new Set(
  (props.episodeCodes || [])
    .filter((code): code is string => typeof code === 'string' && !!code.trim())
    .map(code => code.trim()),
)))
const isScoped = computed(() => scopedCodes.value.length > 0)
const scopeLabel = computed(() => scopedCodes.value.length === 1
  ? scopedCodes.value[0]!
  : `${scopedCodes.value.length} episodes`)

const rows = ref<AuditRow[]>([])
const loading = ref(false)
const error = ref('')
const lastRunAt = ref('')
const repairing = ref(false)
const repairingRow = ref<string | null>(null)

const repairableRows = computed(() => rows.value.filter(r =>
  r.audio.missing > 0 || r.scenes.missing > 0 || r.thumbnails.missing > 0,
))

const repairableCounts = computed(() => {
  const counts = { audio: 0, images: 0, total: 0 }
  for (const r of rows.value) {
    if (r.audio.missing > 0) counts.audio++
    if (r.scenes.missing > 0 || r.thumbnails.missing > 0) counts.images++
  }
  counts.total = counts.audio + counts.images
  return counts
})

async function runAudit() {
  loading.value = true
  error.value = ''
  try {
    // `episode` is repeatable on the audit route, so a scoped scan never walks
    // an episode folder it was not asked about.
    const scope = isScoped.value
      ? `?${scopedCodes.value.map(code => `episode=${encodeURIComponent(code)}`).join('&')}`
      : ''
    const r = await get<{ episodes: AuditRow[] }>(`/projects/${props.slug}/assets-audit${scope}`)
    rows.value = r.episodes || []
    lastRunAt.value = new Date().toLocaleString()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Scan failed'
  } finally {
    loading.value = false
  }
}

async function repairSingleImages(code: string) {
  repairingRow.value = code
  try {
    await post<{ job_id: string }>(`/projects/${props.slug}/generate/images-repair`, { episode_id: code })
    success(`Image repair queued for ${code} — watch progress in Jobs.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Image repair failed to queue')
  } finally {
    repairingRow.value = null
  }
}

async function repairSingleAudio(code: string) {
  repairingRow.value = code
  try {
    // Audio repair runs synchronously (provider history lookup). The route
    // takes no provider — recovery is GenStudio-only and the server decides.
    const r = await post<{ recovered: number; still_missing: number }>(
      `/projects/${props.slug}/episodes/${code}/audio-repair`,
      {},
    )
    success(`Audio repair for ${code}: recovered ${r.recovered}, ${r.still_missing} still missing`)
    // Re-run audit to update the row.
    await runAudit()
  } catch (e: any) {
    showError(e?.data?.detail || 'Audio repair failed')
  } finally {
    repairingRow.value = null
  }
}

async function repairAll() {
  repairing.value = true
  try {
    const r = await post<{
      enqueued: Array<{ episode_id: string; type: string }>
      audio_repair_candidates: string[]
      total_repair_jobs: number
    // v1.2.8 — narrowing the request as well as the scan. The endpoint has
    // always accepted `episode_codes`; until now nothing sent them.
    }>(`/projects/${props.slug}/assets/repair-all`, isScoped.value ? { episode_codes: scopedCodes.value } : {})

    // Kick off audio repairs one by one (they run inline server-side;
    // serializing avoids blasting the history API with parallel lookups for
    // every episode at once).
    for (const code of r.audio_repair_candidates) {
      try {
        await post(`/projects/${props.slug}/episodes/${code}/audio-repair`, {})
      } catch { /* surfaced in audit after rescan; don't stop the loop */ }
    }

    const msg = [
      r.total_repair_jobs > 0 ? `${r.total_repair_jobs} image repair job(s) queued` : '',
      r.audio_repair_candidates.length > 0 ? `${r.audio_repair_candidates.length} audio repair(s) run` : '',
    ].filter(Boolean).join(' · ')
    success(msg || 'No repairs were needed')

    // Re-run audit so the list reflects what's still missing.
    await runAudit()
  } catch (e: any) {
    showError(e?.data?.detail || 'Repair-all failed')
  } finally {
    repairing.value = false
  }
}

// Scan on open (and rescan if reopened for a different project). The audit
// walks every episode folder, so we only fire it when the dialog is actually
// shown — never on board mount.
watch(() => props.visible, (open) => {
  if (open && !loading.value) void runAudit()
})

// Re-scope without closing: arriving from a second failed job while the dialog
// is already open must re-scan for THAT episode, not keep showing the first.
watch(() => scopedCodes.value.join('|'), () => {
  if (props.visible && !loading.value) void runAudit()
})
</script>

<style scoped>
.dialog-head { margin-bottom: 12px; }
.dialog-title {
  margin: 0;
  display: flex; align-items: center; gap: 8px;
  font-size: 18px;
}
.dialog-sub { font-size: 13px; margin: 6px 0 0; line-height: 1.5; max-width: 760px; }

.repair-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.repair-toolbar-actions { display: flex; gap: 8px; margin-left: auto; }
.repair-summary { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.repair-chip {
  display: inline-flex; align-items: center;
  padding: 2px 10px;
  font-size: var(--font-xs); font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 999px;
}

.repair-empty {
  padding: 24px 12px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.repair-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden auto;
  max-height: 50vh;
}
.repair-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.2fr) minmax(100px, 1fr) minmax(140px, 1fr) minmax(220px, auto);
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.repair-row:last-child { border-bottom: none; }
.repair-header {
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
}
.repair-ep { min-width: 110px; }
.repair-gap { font-variant-numeric: tabular-nums; }
.gap-ok { color: rgb(22, 163, 74); }
.gap-missing { color: rgb(180, 83, 9); font-weight: 500; }
.repair-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.repair-btn-row { font-size: var(--font-xs); padding: 2px 8px; }

.dialog-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 16px;
}
</style>
