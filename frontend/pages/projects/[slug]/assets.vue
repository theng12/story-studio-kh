<template>
  <div>
    <div class="assets-header">
      <h1>🗂 Assets</h1>
      <div class="header-actions">
        <span v-if="lastRunAt" class="text-muted" style="font-size: 12px;">
          Last run: {{ lastRunAt }}
        </span>
        <button class="btn btn-sm btn-secondary" :disabled="loading" @click="runAudit">
          <LoadingSpinner v-if="loading" size="sm" />
          {{ loading ? 'Scanning…' : (rows.length ? 'Rescan' : 'Run audit') }}
        </button>
      </div>
    </div>

    <p class="text-muted mt-1 mb-2" style="font-size: 13px; max-width: 860px;">
      <strong>Audit what's missing, then repair provider-completed jobs that didn't persist locally.</strong>
      Scans every accepted episode and reports how many assets are on disk vs expected. Green = all present,
      amber = gaps. The <strong>Repair</strong> section below finds episodes where the provider already
      produced the asset but we never saved it locally (app crash, network blip, timeout) and re-downloads
      it at no extra cost.
    </p>

    <!-- ── Audit matrix ───────────────────────────────────────────────── -->
    <div class="card mt-2">
      <div class="flex items-center justify-between">
        <h3 style="margin: 0">Per-episode audit</h3>
        <span class="text-muted" style="font-size: 11px;">Click any cell to jump to that generator for the episode.</span>
      </div>

      <div v-if="error" class="text-danger mt-2" style="font-size: 13px;">{{ error }}</div>

      <div v-if="loading && !rows.length" class="text-muted mt-2" style="font-size: 13px;">
        Running audit — this may take a few seconds for large projects…
      </div>

      <div v-else-if="!loading && !rows.length && !error" class="text-muted mt-2" style="font-size: 13px;">
        No accepted ideas yet. Accept some in <NuxtLink :to="`/projects/${slug}/ideas`">Ideas Generator</NuxtLink> first.
      </div>

      <div v-if="rows.length" class="assets-audit-wrap mt-2">
        <table class="assets-audit">
          <thead>
            <tr>
              <th class="sticky-left">Episode</th>
              <th>Audio</th>
              <th>Scenes</th>
              <th>Thumbs</th>
              <th>Video</th>
              <th>Merged</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.episode_id">
              <td class="sticky-left">
                <div class="ep-cell">
                  <strong>{{ row.episode_id }}</strong>
                  <span class="text-muted" style="font-size: 11px;">{{ row.title }}</span>
                </div>
              </td>
              <td :class="cellClass(row.audio)">
                <NuxtLink :to="`/projects/${slug}/audio?episode=${row.episode_id}`" class="audit-cell-link">
                  {{ row.audio.present }}/{{ row.audio.total }}
                </NuxtLink>
              </td>
              <td :class="cellClass(row.scenes)">
                <NuxtLink :to="`/projects/${slug}/images?episode=${row.episode_id}`" class="audit-cell-link">
                  {{ row.scenes.present }}/{{ row.scenes.total }}
                </NuxtLink>
              </td>
              <td :class="cellClass(row.thumbnails)">
                <NuxtLink :to="`/projects/${slug}/images?episode=${row.episode_id}`" class="audit-cell-link">
                  {{ row.thumbnails.present }}/{{ row.thumbnails.total }}
                </NuxtLink>
              </td>
              <td :class="cellClass(row.video)">
                <NuxtLink :to="`/projects/${slug}/video?episode=${row.episode_id}`" class="audit-cell-link">
                  {{ row.video.present }}/{{ row.video.total }}
                </NuxtLink>
              </td>
              <td :class="row.merged_audio.present ? 'cell-ok' : 'cell-missing'">
                <NuxtLink :to="`/projects/${slug}/audio-merge?episode=${row.episode_id}`" class="audit-cell-link">
                  {{ row.merged_audio.present ? '✓' : '—' }}
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="rows.length" class="audit-legend mt-2 text-muted" style="font-size: 11px;">
        <span class="legend-swatch ok"></span> all present
        <span class="legend-swatch warn"></span> gaps detected
        <span class="legend-swatch empty"></span> none expected
      </div>
    </div>

    <!-- ── Repair section ─────────────────────────────────────────────── -->
    <div class="card mt-2">
      <div class="flex items-center justify-between" style="flex-wrap: wrap; gap: 8px;">
        <div>
          <h3 style="margin: 0">↻ Generated but not received — Repair</h3>
          <p class="text-muted mt-1" style="font-size: 12px; max-width: 760px;">
            Episodes below have gaps the provider might already have finished. Click <strong>Repair</strong>
            to re-download from the provider's history. No credits consumed.
            Files without a stored task ID will come back as "needs fresh generation" in the job log.
          </p>
        </div>
        <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
          <span v-if="repairableCounts.total > 0" class="repair-summary">
            <span class="repair-chip">Audio: {{ repairableCounts.audio }}</span>
            <span class="repair-chip">Images: {{ repairableCounts.images }}</span>
            <span class="repair-chip">Video: {{ repairableCounts.video }}</span>
          </span>
          <button
            class="btn btn-sm btn-primary"
            :disabled="repairing || repairableCounts.total === 0"
            :title="repairableCounts.total === 0
              ? 'No gaps detected — nothing to repair. Re-run the audit after a generation attempt if you think something is missing.'
              : 'Queues repair jobs for every episode with missing audio/images/video. Reads provider history; no credits consumed.'"
            @click="repairAll"
          >
            <LoadingSpinner v-if="repairing" size="sm" />
            {{ repairing ? 'Queuing…' : `Repair all (${repairableCounts.total})` }}
          </button>
        </div>
      </div>

      <div v-if="!rows.length" class="text-muted mt-2" style="font-size: 13px;">
        Run the audit above first.
      </div>
      <div v-else-if="repairableCounts.total === 0" class="empty-repair mt-2">
        Everything generated is on disk. ✅
      </div>
      <div v-else class="repair-list mt-2">
        <div class="repair-row repair-header">
          <span style="min-width: 110px;">Episode</span>
          <span class="repair-gap">Audio gap</span>
          <span class="repair-gap">Images gap</span>
          <span class="repair-gap">Video gap</span>
          <span class="repair-actions"></span>
        </div>
        <div v-for="row in repairableRows" :key="row.episode_id" class="repair-row">
          <div style="min-width: 110px;">
            <strong>{{ row.episode_id }}</strong>
            <div class="text-muted" style="font-size: 11px;">{{ row.title }}</div>
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
          <span class="repair-gap" :class="row.video.missing > 0 ? 'gap-missing' : 'gap-ok'">
            {{ row.video.missing > 0 ? `${row.video.missing} clips` : '✓' }}
          </span>
          <span class="repair-actions">
            <button
              v-if="row.audio.missing > 0"
              class="btn btn-sm btn-ghost repair-btn-row"
              :disabled="repairingRow === row.episode_id"
              title="Repair audio for this episode only. Uses GenAIPro history, no credits consumed."
              @click="repairSingleAudio(row.episode_id)"
            >↻ Audio</button>
            <button
              v-if="(row.scenes.missing + row.thumbnails.missing) > 0"
              class="btn btn-sm btn-ghost repair-btn-row"
              :disabled="repairingRow === row.episode_id"
              title="Repair scene + thumbnail images for this episode. Reads provider task history, no credits consumed."
              @click="repairSingleImages(row.episode_id)"
            >↻ Images</button>
            <button
              v-if="row.video.missing > 0"
              class="btn btn-sm btn-ghost repair-btn-row"
              :disabled="repairingRow === row.episode_id"
              title="Repair video clips for this episode. Reads provider task history, no credits consumed."
              @click="repairSingleVideo(row.episode_id)"
            >↻ Video</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)

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

const rows = ref<AuditRow[]>([])
const loading = ref(false)
const error = ref('')
const lastRunAt = ref('')
const repairing = ref(false)
const repairingRow = ref<string | null>(null)

const repairableRows = computed(() => rows.value.filter(r =>
  r.audio.missing > 0 || r.scenes.missing > 0 || r.thumbnails.missing > 0 || r.video.missing > 0,
))

const repairableCounts = computed(() => {
  const counts = { audio: 0, images: 0, video: 0, total: 0 }
  for (const r of rows.value) {
    if (r.audio.missing > 0) counts.audio++
    if (r.scenes.missing > 0 || r.thumbnails.missing > 0) counts.images++
    if (r.video.missing > 0) counts.video++
  }
  counts.total = counts.audio + counts.images + counts.video
  return counts
})

async function runAudit() {
  loading.value = true
  error.value = ''
  try {
    const r = await get<{ episodes: AuditRow[] }>(`/projects/${slug.value}/assets-audit`)
    rows.value = r.episodes || []
    lastRunAt.value = new Date().toLocaleString()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Audit failed'
  } finally {
    loading.value = false
  }
}

function cellClass(c: AssetCount): string {
  if (c.total === 0) return 'cell-empty'
  if (c.missing > 0) return 'cell-missing'
  return 'cell-ok'
}

async function repairSingleImages(code: string) {
  repairingRow.value = code
  try {
    await post(`/projects/${slug.value}/generate/images-repair`, { episode_id: code })
    success(`Image repair queued for ${code}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Image repair failed to queue')
  } finally {
    repairingRow.value = null
  }
}

async function repairSingleVideo(code: string) {
  repairingRow.value = code
  try {
    await post(`/projects/${slug.value}/generate/video-repair`, { episode_id: code })
    success(`Video repair queued for ${code}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Video repair failed to queue')
  } finally {
    repairingRow.value = null
  }
}

async function repairSingleAudio(code: string) {
  repairingRow.value = code
  try {
    // Audio repair runs synchronously (GenAIPro history lookup).
    const r = await post<{ recovered: number; still_missing: number }>(
      `/projects/${slug.value}/episodes/${code}/audio-repair`,
      { provider: 'genaipro' },
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
    }>(`/projects/${slug.value}/assets/repair-all`, {})

    // Kick off audio repairs one by one (they run inline server-side;
    // serializing avoids blasting the GenAIPro history API with parallel
    // lookups for every episode at once).
    for (const code of r.audio_repair_candidates) {
      try {
        await post(`/projects/${slug.value}/episodes/${code}/audio-repair`, { provider: 'genaipro' })
      } catch { /* surfaced in audit after rescan; don't stop the loop */ }
    }

    const msg = [
      r.total_repair_jobs > 0 ? `${r.total_repair_jobs} image/video repair job(s) queued` : '',
      r.audio_repair_candidates.length > 0 ? `${r.audio_repair_candidates.length} audio repair(s) run` : '',
    ].filter(Boolean).join(' · ')
    success(msg || 'No repairs were needed')

    // Re-run audit so the Repair section reflects what's still missing.
    await runAudit()
  } catch (e: any) {
    showError(e?.data?.detail || 'Repair-all failed')
  } finally {
    repairing.value = false
  }
}

onMounted(() => { runAudit() })
</script>

<style scoped>
.assets-header {
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 12px;
  padding-top: 16px;
}
.assets-header h1 { margin: 0; font-size: 22px; }
.header-actions { display: flex; align-items: center; gap: 10px; }

.assets-audit-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 60vh;
}
.assets-audit {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
.assets-audit th,
.assets-audit td {
  padding: 8px 10px;
  text-align: center;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.assets-audit th {
  background: var(--bg-tertiary);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  position: sticky;
  top: 0;
  z-index: 2;
}
.assets-audit th.sticky-left,
.assets-audit td.sticky-left {
  position: sticky;
  left: 0;
  background: var(--bg-primary);
  text-align: left;
  z-index: 1;
  border-right: 1px solid var(--border);
}
.assets-audit th.sticky-left { z-index: 3; background: var(--bg-tertiary); }
.assets-audit .ep-cell { display: flex; flex-direction: column; gap: 2px; }

.audit-cell-link {
  display: block;
  padding: 6px 10px;
  margin: -8px -10px;
  text-decoration: none;
  color: inherit;
}
.audit-cell-link:hover { background: var(--bg-hover, rgba(0,0,0,0.06)); }

.cell-ok { background: rgba(34, 197, 94, 0.10); color: rgb(22, 163, 74); font-weight: 600; }
.cell-missing { background: rgba(245, 158, 11, 0.14); color: rgb(180, 83, 9); font-weight: 600; }
.cell-empty { color: var(--text-muted); }

.audit-legend { display: flex; align-items: center; gap: 12px; }
.legend-swatch {
  display: inline-block; width: 12px; height: 12px;
  border-radius: 3px; vertical-align: middle; margin-right: 4px; margin-left: 8px;
}
.legend-swatch.ok { background: rgba(34, 197, 94, 0.35); }
.legend-swatch.warn { background: rgba(245, 158, 11, 0.5); }
.legend-swatch.empty { background: var(--border); }

/* ── Repair section ─────────────────────────────────────────────── */
.repair-summary { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.repair-chip {
  display: inline-flex; align-items: center;
  padding: 2px 10px;
  font-size: 11px; font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 999px;
}
.empty-repair {
  padding: 14px 10px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}
.repair-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.repair-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.2fr) minmax(100px, 1fr) minmax(140px, 1fr) minmax(100px, 1fr) minmax(220px, auto);
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.repair-row:last-child { border-bottom: none; }
.repair-header {
  background: var(--bg-tertiary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.repair-gap { font-variant-numeric: tabular-nums; }
.gap-ok { color: rgb(22, 163, 74); }
.gap-missing { color: rgb(180, 83, 9); font-weight: 500; }
.repair-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.repair-btn-row { font-size: 11px; padding: 2px 8px; }
</style>
