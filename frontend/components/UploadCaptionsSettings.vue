<!--
  Upload closed captions (optional) — Item 17 of release 1.4.386.

  Closed captions (CC) are uploaded as an optional track viewers can toggle
  in YouTube player. OFF by default. Does not burn subtitles into video pixels.
  Honest states: failure preserves the exact remote video ID and never blocks
  normal video upload.
-->
<template>
  <section class="panel upload-captions-settings" data-setting="upload-captions">
    <div class="row">
      <div class="copy">
        <span class="eyebrow">Optional</span>
        <h4>Closed captions (CC) upload</h4>
        <p>
          Uploads the episode's subtitle track (.srt/.vtt) to YouTube's captions API as closed captions
          viewers can toggle in the video player. <strong>OFF by default.</strong> Does not burn subtitles
          into video pixels. If captions upload fails, the video upload still completes normally.
        </p>
      </div>
      <label class="toggle">
        <input
          v-model="draft.enabled"
          type="checkbox"
          :disabled="disabled"
          aria-label="Upload closed captions track"
        />
        <span>Upload CC track</span>
      </label>
    </div>

    <div v-if="draft.enabled" class="detail">
      <div class="grid">
        <label class="field">
          <span>Language</span>
          <select v-model="draft.language" :disabled="disabled" aria-label="Caption language">
            <option value="en">English (en)</option>
            <option value="km">Khmer (km)</option>
            <option value="es">Spanish (es)</option>
            <option value="ja">Japanese (ja)</option>
            <option value="fr">French (fr)</option>
            <option value="de">German (de)</option>
            <option value="other">Other (custom code)</option>
          </select>
        </label>

        <label v-if="draft.language === 'other'" class="field">
          <span>Custom language code</span>
          <input
            v-model="customLanguage"
            type="text"
            placeholder="e.g. pt-BR"
            maxlength="16"
            :disabled="disabled"
            aria-label="Custom language code"
          />
        </label>

        <label class="field">
          <span>Track title</span>
          <input
            v-model="draft.track_name"
            type="text"
            maxlength="60"
            :placeholder="defaultTrackName"
            :disabled="disabled"
            aria-label="Track title"
          />
        </label>

        <label class="field">
          <span>Subtitle source</span>
          <select v-model="draft.preferred_source" :disabled="disabled" aria-label="Subtitle source">
            <option value="auto">Auto (stitched or whisper .srt)</option>
            <option value="stitched">Stitched full-episode (.srt)</option>
            <option value="whisper">Whisper transcription (.srt)</option>
            <option value="custom">Custom file path</option>
          </select>
        </label>

        <label v-if="draft.preferred_source === 'custom'" class="field full-width">
          <span>Custom .srt file path</span>
          <input
            v-model="draft.custom_srt_path"
            type="text"
            placeholder="/path/to/episode.srt"
            :disabled="disabled"
            aria-label="Custom .srt file path"
          />
        </label>
      </div>

      <fieldset class="field dedupe-group">
        <legend class="field-label">If captions in this language already exist</legend>
        <div class="radio-row" role="radiogroup" aria-label="Deduplication behavior">
          <label :class="{ active: draft.dedupe_mode === 'skip_if_exists' }">
            <input
              v-model="draft.dedupe_mode"
              type="radio"
              value="skip_if_exists"
              :disabled="disabled"
            />
            <span>Skip upload (avoid duplicate)</span>
          </label>
          <label :class="{ active: draft.dedupe_mode === 'replace_existing' }">
            <input
              v-model="draft.dedupe_mode"
              type="radio"
              value="replace_existing"
              :disabled="disabled"
            />
            <span>Replace existing track</span>
          </label>
          <label :class="{ active: draft.dedupe_mode === 'upload_always' }">
            <input
              v-model="draft.dedupe_mode"
              type="radio"
              value="upload_always"
              :disabled="disabled"
            />
            <span>Upload as new track anyway</span>
          </label>
        </div>
      </fieldset>

      <div class="options-row">
        <label class="checkbox-label">
          <input
            v-model="draft.is_draft"
            type="checkbox"
            :disabled="disabled"
            aria-label="Mark closed captions as draft"
          />
          <span>Mark as draft (hidden from public viewers until reviewed)</span>
        </label>
      </div>

      <div class="status-box">
        <p class="status">
          <span :class="statusBadgeClass">{{ statusText }}</span>
          <span class="fine">· Uploaded via YouTube Captions API separately from the video file.</span>
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

export type CaptionDedupeMode = 'skip_if_exists' | 'replace_existing' | 'upload_always'
export type CaptionSourcePreference = 'auto' | 'stitched' | 'whisper' | 'custom'

export interface YouTubeCaptionSettings {
  enabled: boolean
  language: string
  track_name: string
  is_draft: boolean
  dedupe_mode: CaptionDedupeMode
  preferred_source: CaptionSourcePreference
  custom_srt_path?: string
}

const props = withDefaults(
  defineProps<{
    modelValue?: Partial<YouTubeCaptionSettings>
    disabled?: boolean
    hasSubtitles?: boolean
  }>(),
  {
    modelValue: () => ({}),
    disabled: false,
    hasSubtitles: undefined,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: YouTubeCaptionSettings): void
}>()

const KNOWN_LANGUAGES = ['en', 'km', 'es', 'ja', 'fr', 'de']

const initialLang = props.modelValue.language?.toLowerCase() || 'en'
const isKnown = KNOWN_LANGUAGES.includes(initialLang)

const customLanguage = ref(!isKnown ? initialLang : '')

const draft = reactive<YouTubeCaptionSettings>({
  enabled: props.modelValue.enabled === true,
  language: isKnown ? initialLang : 'other',
  track_name: props.modelValue.track_name || 'English',
  is_draft: props.modelValue.is_draft === true,
  dedupe_mode: props.modelValue.dedupe_mode || 'skip_if_exists',
  preferred_source: props.modelValue.preferred_source || 'auto',
  custom_srt_path: props.modelValue.custom_srt_path || '',
})

const defaultTrackName = computed(() => {
  const lang = effectiveLanguage.value
  if (lang === 'km') return 'Khmer'
  if (lang === 'es') return 'Spanish'
  if (lang === 'ja') return 'Japanese'
  if (lang === 'fr') return 'French'
  if (lang === 'de') return 'German'
  return 'English'
})

const effectiveLanguage = computed(() => {
  if (draft.language === 'other') {
    return customLanguage.value.trim().toLowerCase() || 'en'
  }
  return draft.language
})

const statusText = computed(() => {
  if (props.hasSubtitles === true) return 'Subtitle file available (.srt)'
  if (props.hasSubtitles === false) return 'No subtitle file found for this episode'
  return 'Subtitle status will be verified at upload time'
})

const statusBadgeClass = computed(() => {
  if (props.hasSubtitles === true) return 'badge-ok'
  if (props.hasSubtitles === false) return 'badge-warn'
  return 'badge-muted'
})

// Auto-fill track_name if empty when language changes
watch(
  () => draft.language,
  (newLang) => {
    if (!draft.track_name || draft.track_name === 'English' || draft.track_name === 'Khmer') {
      if (newLang === 'km') draft.track_name = 'Khmer'
      else if (newLang === 'en') draft.track_name = 'English'
      else if (newLang === 'es') draft.track_name = 'Spanish'
      else if (newLang === 'ja') draft.track_name = 'Japanese'
      else if (newLang === 'fr') draft.track_name = 'French'
      else if (newLang === 'de') draft.track_name = 'German'
    }
  },
)

watch(
  [draft, effectiveLanguage],
  () => {
    emit('update:modelValue', {
      enabled: draft.enabled,
      language: effectiveLanguage.value,
      track_name: draft.track_name.trim() || defaultTrackName.value,
      is_draft: draft.is_draft,
      dedupe_mode: draft.dedupe_mode,
      preferred_source: draft.preferred_source,
      ...(draft.custom_srt_path ? { custom_srt_path: draft.custom_srt_path } : {}),
    })
  },
  { deep: true },
)
</script>

<style scoped>
.upload-captions-settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 8px;
  background: var(--bg-surface, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
}

.copy {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.eyebrow {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #888);
}

h4 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-normal, #f0f0f0);
}

p {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--text-muted, #a0a0a0);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  white-space: nowrap;
  font-size: 0.9rem;
  font-weight: 500;
  user-select: none;
}

.toggle input[type="checkbox"] {
  cursor: pointer;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field.full-width {
  grid-column: 1 / -1;
}

.field span,
.field-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted, #a0a0a0);
}

input[type="text"],
select {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  border-radius: 4px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  background: var(--bg-input, rgba(0, 0, 0, 0.2));
  color: var(--text-normal, #f0f0f0);
}

input[type="text"]:focus,
select:focus {
  outline: none;
  border-color: var(--primary, #3b82f6);
}

.dedupe-group {
  border: none;
  padding: 0;
  margin: 0;
}

.radio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.35rem;
}

.radio-row label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  background: var(--bg-chip, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  color: var(--text-normal, #ddd);
}

.radio-row label.active {
  background: var(--bg-chip-active, rgba(59, 130, 246, 0.15));
  border-color: var(--primary, #3b82f6);
}

.options-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--text-normal, #ddd);
}

.status-box {
  padding: 0.6rem 0.75rem;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.15);
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  margin: 0;
}

.fine {
  font-size: 0.75rem;
  opacity: 0.75;
}

.badge-ok {
  color: var(--ok, #4ade80);
  font-weight: 600;
}

.badge-warn {
  color: var(--warn, #facc15);
  font-weight: 600;
}

.badge-muted {
  color: var(--text-muted, #888);
}
</style>
