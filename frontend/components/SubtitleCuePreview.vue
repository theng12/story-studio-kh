<!--
  v1.0.495 — Presentational inline preview of a subtitle file's parsed cues.
  Used by the Subtitles tab for both per-chapter SRTs and the stitched timeline
  SRT. Fetch + state live in the parent (subtitles.vue); this only renders.
-->
<template>
  <div class="sub-preview">
    <div class="sub-preview-head">
      <strong>{{ filename }}</strong>
      <span v-if="meta && !loading" class="text-muted text-xs">
        {{ meta.cue_count }} cue{{ meta.cue_count === 1 ? '' : 's' }} · {{ fmtDur(meta.total_duration_sec) }}
      </span>
      <span class="sub-preview-spacer" />
      <button class="btn-icon" title="Close preview" @click="$emit('close')">✕</button>
    </div>

    <div v-if="loading" class="text-muted text-sm mt-2">
      <LoadingSpinner size="sm" /> Loading subtitle text…
    </div>
    <template v-else-if="meta?.is_ass">
      <pre class="sub-preview-raw mt-2">{{ raw }}</pre>
    </template>
    <template v-else-if="cues.length">
      <div class="sub-cue-list mt-2">
        <div v-for="c in cues" :key="c.index" class="sub-cue">
          <span class="sub-cue-time">{{ fmtTime(c.start_sec) }} → {{ fmtTime(c.end_sec) }}</span>
          <span class="sub-cue-text">{{ c.text }}</span>
        </div>
      </div>
      <p v-if="meta?.truncated" class="text-muted text-xs mt-1">
        Showing the first {{ cues.length }} cues (file has more).
      </p>
    </template>
    <p v-else class="text-muted text-sm mt-2">No cues found in this file.</p>
  </div>
</template>

<script setup lang="ts">
interface SrtCuePreview { index: number; start_sec: number; end_sec: number; text: string }
interface SubtitleContent {
  filename: string; is_ass: boolean; cue_count: number; truncated: boolean;
  total_duration_sec: number; cues: SrtCuePreview[]; raw?: string
}

defineProps<{
  filename: string
  loading: boolean
  meta: SubtitleContent | null
  cues: SrtCuePreview[]
  raw: string
}>()
defineEmits<{ (e: 'close'): void }>()

/** SRT-style `MM:SS.mmm` (or `H:MM:SS.mmm` past an hour) for the cue list. */
function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}` : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}
/** Coarse duration for the header, e.g. "3m 12s". */
function fmtDur(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
</script>

<style scoped>
.sub-preview { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px 12px; background: var(--bg-secondary); }
.sub-preview-head { display: flex; align-items: center; gap: 10px; }
.sub-preview-head strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.sub-preview-spacer { flex: 1; }
.sub-cue-list { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.sub-cue { display: flex; gap: 12px; padding: 4px 6px; border-radius: 4px; font-size: 13px; line-height: 1.4; }
.sub-cue:nth-child(odd) { background: var(--bg-tertiary); }
.sub-cue-time { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-xs); color: var(--text-muted); white-space: nowrap; padding-top: 1px; }
.sub-cue-text { flex: 1; color: var(--text-primary); white-space: pre-wrap; }
.sub-preview-raw { max-height: 360px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-xs); white-space: pre-wrap; margin: 0; color: var(--text-secondary); }
</style>
