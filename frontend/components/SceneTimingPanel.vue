<template>
  <section v-if="timing" class="timing-panel">
    <div class="timing-head">
      <div>
        <h4>Scene Plan timing</h4>
        <p>
          {{ timing.scenes.length }} exact windows across {{ formatTime(timing.audio_duration_sec) }}.
          Applied automatically during local or Render Studio assembly.
        </p>
      </div>
      <span class="timing-state" :class="timing.complete ? 'ready' : 'blocked'">
        {{ timing.complete ? 'Ready to render' : 'Needs repair' }}
      </span>
    </div>

    <div class="timing-metrics">
      <span>{{ timing.approved }}/{{ timing.scenes.length }} approved</span>
      <span>{{ timing.stills_ready }}/{{ timing.scenes.length }} images</span>
      <span>{{ timing.motion_ready }} motion clips</span>
      <span :class="{ issue: timing.uncovered_sec > 0.25 }">{{ timing.uncovered_sec.toFixed(1) }}s uncovered</span>
      <span :class="{ issue: timing.overlap_count > 0 }">{{ timing.overlap_count }} overlaps</span>
    </div>

    <div class="timing-ruler" aria-label="Scene timing ruler">
      <div
        v-if="timing.opening_reserved_sec > 0"
        class="timing-segment opening"
        :style="segmentStyle(timing.opening_reserved_sec)"
        :title="`Branded opening · ${formatTime(timing.opening_reserved_sec)}`"
      />
      <div
        v-for="scene in timing.scenes"
        :key="scene.id"
        class="timing-segment"
        :class="{
          motion: scene.media_type === 'motion',
          invalid: !scene.approved || !scene.image_ready || scene.stale,
        }"
        :style="segmentStyle(scene.duration_sec)"
        :title="`Scene ${scene.scene_index} · ${formatTime(scene.start_sec)}–${formatTime(scene.end_sec)} · ${scene.media_type}`"
      />
    </div>
    <div class="timing-legend">
      <span><i class="still" /> Still</span>
      <span><i class="motion" /> Motion</span>
      <span v-if="timing.opening_reserved_sec > 0"><i class="opening" /> Branded opening</span>
      <span><i class="invalid" /> Needs repair</span>
    </div>

    <details class="timing-details">
      <summary>View exact scene timestamps</summary>
      <div class="timing-table-wrap">
        <table class="timing-table">
          <thead>
            <tr><th>Scene</th><th>Start</th><th>End</th><th>Duration</th><th>Visual</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr v-for="scene in visibleScenes" :key="scene.id">
              <td>#{{ scene.scene_index }}</td>
              <td>{{ formatTime(scene.start_sec) }}</td>
              <td>{{ formatTime(scene.end_sec) }}</td>
              <td>{{ scene.duration_sec.toFixed(1) }}s</td>
              <td>{{ scene.media_type === 'motion' ? 'Motion clip' : 'Still image' }}</td>
              <td :class="sceneReady(scene) ? 'ok' : 'bad'">{{ sceneStatus(scene) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="timing.scenes.length > 60" type="button" class="btn btn-sm btn-secondary mt-1" @click="showAll = !showAll">
        {{ showAll ? 'Show first 60' : `Show all ${timing.scenes.length}` }}
      </button>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface TimingScene {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  duration_sec: number
  approved: boolean
  image_ready: boolean
  stale: boolean
  media_type: 'still' | 'motion'
}

interface SceneTiming {
  opening_reserved_sec: number
  audio_duration_sec: number
  approved: number
  stills_ready: number
  motion_ready: number
  uncovered_sec: number
  overlap_count: number
  complete: boolean
  scenes: TimingScene[]
}

const props = defineProps<{ timing?: SceneTiming | null }>()
const showAll = ref(false)
const visibleScenes = computed(() => showAll.value ? props.timing?.scenes || [] : (props.timing?.scenes || []).slice(0, 60))

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const remainder = safe - minutes * 60
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

function segmentStyle(duration: number): Record<string, string> {
  const total = Math.max(0.1, props.timing?.audio_duration_sec || 0.1)
  return { width: `${Math.max(0.08, (Math.max(0, duration) / total) * 100)}%` }
}

function sceneReady(scene: TimingScene): boolean {
  return scene.approved && scene.image_ready && !scene.stale
}

function sceneStatus(scene: TimingScene): string {
  if (!scene.image_ready) return 'Missing image'
  if (scene.stale) return 'Image is stale'
  if (!scene.approved) return 'Not approved'
  return 'Ready'
}
</script>

<style scoped>
.timing-panel { margin-top: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--bg-card) 88%, var(--accent) 12%); }
.timing-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.timing-head h4 { margin: 0 0 4px; }
.timing-head p { margin: 0; color: var(--text-muted); font-size: 12px; }
.timing-state { flex: none; padding: 5px 9px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.timing-state.ready { color: #65e39a; background: rgba(29, 140, 77, .18); }
.timing-state.blocked { color: #ff897f; background: rgba(184, 54, 48, .18); }
.timing-metrics { display: flex; flex-wrap: wrap; gap: 7px; margin: 12px 0 9px; }
.timing-metrics span { padding: 4px 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-muted); font-size: var(--font-xs); }
.timing-metrics .issue { color: #ff897f; border-color: rgba(255, 92, 82, .42); }
.timing-ruler { display: flex; width: 100%; height: 28px; overflow: hidden; gap: 1px; border-radius: 7px; background: var(--bg-input); }
.timing-segment { min-width: 1px; background: #c8a15a; }
.timing-segment.motion { background: #55a8b4; }
.timing-segment.opening { background: #8a7aab; }
.timing-segment.invalid { background: #d4554d; }
.timing-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 7px; color: var(--text-muted); font-size: var(--font-xs); }
.timing-legend span { display: inline-flex; align-items: center; gap: 5px; }
.timing-legend i { width: 8px; height: 8px; border-radius: 2px; background: #c8a15a; }
.timing-legend i.motion { background: #55a8b4; }
.timing-legend i.opening { background: #8a7aab; }
.timing-legend i.invalid { background: #d4554d; }
.timing-details { margin-top: 12px; }
.timing-details summary { cursor: pointer; color: var(--text); font-size: 12px; font-weight: 650; }
.timing-table-wrap { max-height: 360px; overflow: auto; margin-top: 9px; border: 1px solid var(--border); border-radius: 8px; }
.timing-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.timing-table th, .timing-table td { padding: 7px 9px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.timing-table th { position: sticky; top: 0; background: var(--bg-card); color: var(--text-muted); }
.timing-table td.ok { color: #65e39a; }
.timing-table td.bad { color: #ff897f; }
@media (max-width: 720px) { .timing-head { display: block; } .timing-state { display: inline-block; margin-top: 9px; } }
</style>
