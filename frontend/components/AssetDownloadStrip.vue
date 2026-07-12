<template>
  <Transition name="ads-fade">
    <div v-if="activeJob" class="asset-strip">
      <ProgressBar
        :indeterminate="!activeJob.bytes_total"
        :progress="activeJob.bytes_total ? activeJob.progress : undefined"
        :bytes-done="activeJob.bytes_done"
        :bytes-total="activeJob.bytes_total"
        :speed-bps="activeJob.speed_bps"
        :eta-seconds="activeJob.eta_seconds"
        :label="label"
        :label-title="labelTitle"
      />
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useJobs, type Job } from '~/composables/useJobs'
import ProgressBar from './ProgressBar.vue'

const props = withDefaults(defineProps<{
  /** Filter to which job types should activate this strip. Defaults to
   *  every download-capable phase. Use a narrower list (e.g. just
   *  ['images','scene_images','thumb_images']) when you want a page-
   *  specific strip that doesn't fight with other phases. */
  jobTypes?: string[]
}>(), {
  jobTypes: () => [
    'images', 'scene_images', 'thumb_images', 'images_repair',
    'audio', 'video', 'video_repair',
  ],
})

const { jobs } = useJobs()

const activeJob = computed(() => {
  return jobs.value.find((j: Job) =>
    j.status === 'running'
    && props.jobTypes.includes(j.type)
    && (j.bytes_done != null || j.speed_bps != null),
  )
})

const label = computed(() => {
  if (!activeJob.value) return ''
  const t = activeJob.value.type
  if (t === 'images' || t === 'scene_images' || t === 'thumb_images' || t === 'images_repair') {
    return 'Downloading scene assets'
  }
  if (t === 'audio') return 'Downloading audio (TTS)'
  if (t === 'video' || t === 'video_repair') return 'Downloading video clips'
  return 'Downloading assets'
})

const labelTitle = computed(() => {
  return 'Live download speed for the running asset job — updates every ~250 ms while bytes are flowing in.'
})
</script>

<style scoped>
.asset-strip {
  padding: 8px 12px;
  background: var(--bg-secondary, rgba(96, 165, 250, 0.06));
  border: 1px solid var(--border, rgba(96, 165, 250, 0.18));
  border-radius: 8px;
  margin-bottom: 12px;
}
.ads-fade-enter-active, .ads-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.ads-fade-enter-from, .ads-fade-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}
@media (prefers-reduced-motion: reduce) {
  .ads-fade-enter-active, .ads-fade-leave-active { transition: none; }
}
</style>
