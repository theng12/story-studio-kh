<template>
  <Modal :visible="visible" size="lg" @close="emit('close')">
    <div class="dialog-head">
      <h2 id="mad-title" class="dialog-title">
        <span aria-hidden="true">&#9888;</span>
        Missing assets
      </h2>
      <p class="dialog-sub text-muted">
        {{ summary }}
      </p>
      <p class="dialog-sub text-muted" style="margin-top: 6px;">
        Nothing has been regenerated. This is a read-only report — fix by
        opening the matching <strong>Repair</strong> button on each page,
        or <NuxtLink :to="`/projects/${slug}/board?repair=1`" @click="emit('close')">Repair</NuxtLink> on the Production Board.
      </p>
    </div>

    <div v-if="!report" class="dialog-empty">
      <LoadingSpinner size="sm" /> Scanning…
    </div>

    <div v-else-if="!report.total_missing" class="dialog-empty">
      <span aria-hidden="true">&#9989;</span> All assets match the project manifest.
    </div>

    <div v-else class="dialog-body">
      <div
        v-for="ep in episodesWithGaps"
        :key="ep.episode_code"
        class="ep-block"
      >
        <div class="ep-head">
          <strong>{{ ep.episode_code }}</strong>
          <span class="text-muted ep-title">{{ ep.title }}</span>
        </div>
        <ul class="stage-list">
          <li
            v-for="s in startedStagesWithMissing(ep)"
            :key="s.stage"
            class="stage-row"
          >
            <div class="stage-head">
              <span class="stage-label">{{ stageLabel(s.stage) }}</span>
              <span class="stage-count">
                {{ s.present }}/{{ s.expected }}
                <span class="miss-chip">&minus;{{ s.missing.length }}</span>
              </span>
              <NuxtLink
                class="stage-jump"
                :to="jumpTo(ep.episode_code, s.stage)"
                @click="emit('close')"
              >Open &rarr;</NuxtLink>
            </div>
            <ul class="miss-files">
              <li v-for="(name, i) in s.missing.slice(0, 6)" :key="name + i">
                <code>{{ name }}</code>
              </li>
              <li v-if="s.missing.length > 6" class="text-muted" style="font-size: var(--font-xs);">
                + {{ s.missing.length - 6 }} more
              </li>
            </ul>
            <div v-if="s.extra.length" class="extras text-muted">
              {{ s.extra.length }} file(s) in this folder aren't tracked by the manifest
              — possibly a rename or a stray copy:
              <code v-for="n in s.extra.slice(0, 3)" :key="n">{{ n }}</code>
              <span v-if="s.extra.length > 3">&nbsp;+ {{ s.extra.length - 3 }} more</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="dialog-actions">
      <button class="btn btn-secondary" @click="emit('close')">Close</button>
      <NuxtLink
        class="btn btn-primary"
        :to="`/projects/${slug}/board?repair=1`"
        @click="emit('close')"
      >Open Repair</NuxtLink>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Read-only summary dialog for the dashboard's "N assets missing" banner.
 *
 * By design this dialog never kicks off a repair — per the portability-audit
 * P7 fix: "Don't auto-repair. Don't auto-regenerate. Just inform." The user
 * navigates to Repair (on the Production Board) or the matching generator page
 * to act on the report. Silent auto-repair would mask the root cause
 * (incomplete sync / rsync interruption) which is the whole reason this audit
 * exists.
 */
import type { AuditStage, ProjectAudit, EpisodeAudit, StageAudit } from '~/types/audit'

const props = defineProps<{
  visible: boolean
  slug: string
  report: ProjectAudit | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const episodesWithGaps = computed<EpisodeAudit[]>(() =>
  (props.report?.episodes || []).filter(ep =>
    ep.stages.some(s => s.started && s.missing.length > 0),
  ),
)

function startedStagesWithMissing(ep: EpisodeAudit): StageAudit[] {
  return ep.stages.filter(s => s.started && s.missing.length > 0)
}

const summary = computed(() => {
  if (!props.report) return ''
  const { total_missing, episodes_with_missing } = props.report
  if (total_missing === 0) return 'Everything on disk matches what the project manifest expects.'
  return `${total_missing} asset${total_missing === 1 ? '' : 's'} missing across `
    + `${episodes_with_missing} episode${episodes_with_missing === 1 ? '' : 's'}.`
})

const STAGE_LABELS: Record<AuditStage, string> = {
  audio: 'Audio chunks',
  scenes: 'Scene images',
  thumbnails: 'Thumbnail images',
  video: 'AI video clips',
  merged_audio: 'Merged audio',
}

function stageLabel(s: AuditStage): string { return STAGE_LABELS[s] || s }

function jumpTo(code: string, stage: AuditStage): string {
  switch (stage) {
    case 'audio': return `/projects/${props.slug}/audio?episode=${code}`
    case 'scenes': return `/projects/${props.slug}/images?episode=${code}`
    case 'thumbnails': return `/projects/${props.slug}/images?episode=${code}`
    case 'video': return `/projects/${props.slug}/motion-review?episode=${code}`
    case 'merged_audio': return `/projects/${props.slug}/audio-merge?episode=${code}`
    default: return `/projects/${props.slug}/board?repair=1`
  }
}
</script>

<style scoped>
.dialog-head { margin-bottom: 12px; }
.dialog-title {
  margin: 0;
  display: flex; align-items: center; gap: 8px;
  font-size: 18px;
}
.dialog-sub { font-size: 13px; margin: 6px 0 0; }

.dialog-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}

.dialog-body {
  max-height: 55vh;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 16px;
  padding: 4px 0;
}

.ep-block {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  background: var(--bg-tertiary);
}
.ep-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ep-title { font-size: 12px; }

.stage-list {
  list-style: none;
  padding: 0; margin: 8px 0 0;
  display: flex; flex-direction: column; gap: 10px;
}
.stage-row {
  padding: 8px 10px;
  border-left: 2px solid rgba(245, 158, 11, 0.7);
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
}
.stage-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 13px;
}
.stage-label { font-weight: 600; }
.stage-count { font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.miss-chip {
  margin-left: 4px;
  color: rgb(180, 83, 9);
  font-weight: 600;
}
.stage-jump {
  margin-left: auto;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.stage-jump:hover { text-decoration: underline; }

.miss-files {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
}
.miss-files li { margin-top: 2px; }
.miss-files code { font-size: var(--font-xs); }

.extras {
  margin-top: 6px;
  font-size: var(--font-xs);
  display: flex; flex-wrap: wrap; gap: 4px;
  align-items: center;
}
.extras code {
  font-size: var(--font-xs);
  background: var(--bg-tertiary);
  padding: 1px 5px; border-radius: 3px;
}

.dialog-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 16px;
}
</style>
