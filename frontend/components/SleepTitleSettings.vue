<template>
  <!-- Sleep Video Title Placement (v1.4.386).
       Owner requirement: "Sleep videos: show the video title once, after the intro."
       Deduplicates title presentations so exactly one appears, placed after the intro. -->
  <div v-if="isSleep" class="sleep-title-settings settings-section mt-2">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="sleep-badge">Sleep Video</span>
        <h4 class="m-0 font-medium">Title Placement</h4>
      </div>
      <span class="text-xs text-muted">Shows once, after intro</span>
    </div>

    <!-- Timeline preview indicator -->
    <div class="sleep-timeline-track mt-2">
      <div v-if="introSec > 0" class="track-block track-intro" :title="`Intro (${formatSec(introSec)})`">
        <span class="track-label">Intro</span>
        <span class="track-time">{{ formatSec(introSec) }}</span>
      </div>
      <div v-if="titleMode !== 'none'" class="track-block track-title" :title="`Title (${formatSec(titleDuration)})`">
        <span class="track-label">{{ titleMode === 'title_card' ? 'Title Card' : 'Title Cover' }}</span>
        <span class="track-time">{{ formatSec(titleDuration) }}</span>
      </div>
      <div class="track-block track-story" title="Story narration begins">
        <span class="track-label">Story Narrative</span>
        <span class="track-time">Bedtime tale</span>
      </div>
    </div>

    <!-- Mode picker -->
    <div class="mode-picker-row mt-2">
      <label class="text-xs font-semibold text-muted block mb-1">Title Presentation</label>
      <div class="mode-pills">
        <button
          type="button"
          :class="['mode-pill', { active: titleMode === 'title_card' }]"
          :disabled="disabled"
          @click="selectMode('title_card')"
        >
          Text Title Card
        </button>
        <button
          type="button"
          :class="['mode-pill', { active: titleMode === 'title_image' }]"
          :disabled="disabled"
          @click="selectMode('title_image')"
        >
          Cover Image Frame
        </button>
        <button
          type="button"
          :class="['mode-pill', { active: titleMode === 'none' }]"
          :disabled="disabled"
          @click="selectMode('none')"
        >
          Off
        </button>
      </div>
    </div>

    <!-- Duration slider when title is on -->
    <div v-if="titleMode !== 'none'" class="grid-2 mt-2">
      <div class="form-group">
        <label>Title duration ({{ titleDuration }}s)</label>
        <SliderWithNumber
          v-model="titleDuration"
          :min="2"
          :max="10"
          :step="1"
          suffix="s"
          :disabled="disabled"
        />
      </div>
      <div class="form-group">
        <label class="text-xs text-muted">Placement timing</label>
        <p class="text-xs text-muted placement-note">
          <template v-if="introSec > 0">
            Plays at {{ formatSec(introSec) }} after the intro, then transitions into the story.
          </template>
          <template v-else>
            Plays at 0:00 at video start before narration begins.
          </template>
        </p>
      </div>
    </div>

    <p v-if="titleMode === 'none'" class="text-xs text-muted italic mt-1">
      Title card and cover frame are disabled for this episode. Scenes begin immediately.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    isSleep: boolean
    titleCard?: { enabled?: boolean; duration?: number; text?: string; [key: string]: any }
    titleImage?: { enabled?: boolean; duration?: number; image_path?: string; [key: string]: any }
    intro?: { enabled?: boolean; video_path?: string; duration?: number }
    introHold?: { intro_video_sec?: number; story_start_sec?: number; has_intro_chapter?: boolean } | null
    disabled?: boolean
  }>(),
  {
    isSleep: false,
    titleCard: () => ({ enabled: true, duration: 5 }),
    titleImage: () => ({ enabled: false, duration: 5 }),
    intro: () => ({ enabled: false }),
    introHold: null,
    disabled: false,
  },
)

const emit = defineEmits<{
  (e: 'update:titleCard', value: any): void
  (e: 'update:titleImage', value: any): void
}>()

const titleMode = computed<'title_card' | 'title_image' | 'none'>({
  get() {
    if (props.titleCard?.enabled) return 'title_card'
    if (props.titleImage?.enabled) return 'title_image'
    return 'none'
  },
  set(mode) {
    if (mode === 'title_card') {
      emit('update:titleCard', { ...(props.titleCard || {}), enabled: true })
      emit('update:titleImage', { ...(props.titleImage || {}), enabled: false })
    } else if (mode === 'title_image') {
      emit('update:titleCard', { ...(props.titleCard || {}), enabled: false })
      emit('update:titleImage', { ...(props.titleImage || {}), enabled: true })
    } else {
      emit('update:titleCard', { ...(props.titleCard || {}), enabled: false })
      emit('update:titleImage', { ...(props.titleImage || {}), enabled: false })
    }
  },
})

function selectMode(mode: 'title_card' | 'title_image' | 'none') {
  if (props.disabled) return
  titleMode.value = mode
}

const titleDuration = computed<number>({
  get() {
    if (titleMode.value === 'title_card') {
      return Number(props.titleCard?.duration) || 5
    }
    return Number(props.titleImage?.duration) || 5
  },
  set(val) {
    const dur = Math.max(2, Math.min(10, Math.round(Number(val) || 5)))
    if (titleMode.value === 'title_card') {
      emit('update:titleCard', { ...(props.titleCard || {}), duration: dur })
    } else if (titleMode.value === 'title_image') {
      emit('update:titleImage', { ...(props.titleImage || {}), duration: dur })
    }
  },
})

const introSec = computed(() => {
  const introVideoSec = props.intro?.enabled && props.intro.video_path
    ? (Number(props.intro.duration) || props.introHold?.intro_video_sec || 5)
    : 0
  const introAudioSec = props.introHold?.has_intro_chapter
    ? (props.introHold.story_start_sec || 0)
    : 0
  return Math.max(introVideoSec, introAudioSec)
})

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s'
  return `${Math.round(sec * 10) / 10}s`
}
</script>

<style scoped>
.sleep-title-settings {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-card, rgba(255, 255, 255, 0.02));
}

.sleep-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: rgba(147, 112, 219, 0.18);
  color: #b892ff;
  border: 1px solid rgba(147, 112, 219, 0.35);
  border-radius: 9999px;
}

.sleep-timeline-track {
  display: flex;
  gap: 4px;
  align-items: stretch;
  background: rgba(0, 0, 0, 0.25);
  padding: 4px;
  border-radius: 6px;
  min-height: 40px;
}

.track-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.track-intro {
  background: rgba(70, 130, 180, 0.22);
  border: 1px solid rgba(70, 130, 180, 0.35);
  color: #8ec5fc;
}

.track-title {
  background: rgba(147, 112, 219, 0.24);
  border: 1px solid rgba(147, 112, 219, 0.45);
  color: #d1b3ff;
  font-weight: 500;
}

.track-story {
  flex: 2;
  background: rgba(46, 139, 87, 0.18);
  border: 1px solid rgba(46, 139, 87, 0.3);
  color: #98fb98;
}

.track-label {
  font-weight: 600;
  line-height: 1.2;
}

.track-time {
  font-size: 10px;
  opacity: 0.8;
  line-height: 1.2;
}

.mode-pills {
  display: flex;
  gap: 6px;
}

.mode-pill {
  padding: 5px 12px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  color: var(--text-color, #e0e0e0);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-pill:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
}

.mode-pill.active {
  background: #6366f1;
  color: #ffffff;
  border-color: #818cf8;
}

.mode-pill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.placement-note {
  margin: 4px 0 0 0;
  line-height: 1.4;
}
</style>
