<template>
  <div class="add-custom-model">
    <div class="form-header">
      <h4>Add Custom Model</h4>
      <p class="form-help">
        Register a new model id that isn't in the default catalog. The provider must already be
        supported by the app — custom models appear in the relevant picker (Scripts, Images, Video,
        or Audio) alongside the built-ins. Fields change based on the type you pick.
      </p>
    </div>

    <div class="form-grid">
      <!-- Row 1: common fields -->
      <div class="form-group">
        <label>
          Type
          <span class="hint">What this model produces. Drives which param fields appear below.</span>
        </label>
        <select v-model="form.type" class="select">
          <option value="image">Image</option>
          <option value="audio">Audio (TTS)</option>
          <option value="video">Video</option>
          <option value="text">Text (LLM)</option>
        </select>
      </div>
      <div class="form-group">
        <label>
          Provider
          <span class="hint">Which API serves this model. Only providers the app knows how to dispatch to are listed.</span>
        </label>
        <select v-model="form.provider" class="select">
          <option v-for="p in providersForType" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>
          Model id
          <span class="hint">The identifier you'll pick from model dropdowns. Warn-only on duplicates.</span>
        </label>
        <input
          v-model="form.id"
          class="input"
          :placeholder="idPlaceholder"
          :class="{ 'input-warn': idCollision }"
        />
        <span v-if="idCollision" class="warn-hint">
          ⚠ <code>{{ form.id }}</code> is already in the catalog. Save anyway to override.
        </span>
      </div>
      <div class="form-group">
        <label>
          Label
          <span class="hint">Human-readable name shown in dropdowns.</span>
        </label>
        <input v-model="form.label" class="input" :placeholder="labelPlaceholder" />
      </div>

      <!-- Type-specific: IMAGE -->
      <template v-if="form.type === 'image'">
        <div class="form-group">
          <label>
            Credits / image
            <span class="hint">Shown in cost-preview dialogs before generation.</span>
          </label>
          <input v-model.number="form.image.credits_per_image" type="number" step="0.5" min="0" class="input" />
        </div>
        <div class="form-group">
          <label>
            Endpoint type
            <span class="hint">Which kie.ai endpoint shape this model lives behind.</span>
          </label>
          <select v-model="form.image.type" class="select">
            <option value="jobs">jobs (generic createTask/recordInfo)</option>
            <option value="flux">flux (dedicated Flux endpoint)</option>
            <option value="4o">4o (dedicated GPT-4o image endpoint)</option>
            <option value="gpt-image">gpt-image (dedicated GPT-Image endpoint)</option>
          </select>
        </div>
        <div class="form-group">
          <label>
            api_model
            <span class="hint">Exact model slug the provider expects in the request body.</span>
          </label>
          <input v-model="form.image.api_model" class="input" placeholder="e.g. google/nano-banana" />
        </div>
        <div class="form-group">
          <label>
            Submit endpoint
            <span class="hint">Path appended to the provider's base URL. Most image models use <code>/jobs/createTask</code>.</span>
          </label>
          <input v-model="form.image.endpoint" class="input" :placeholder="imageEndpointHint.endpoint" />
        </div>
        <div class="form-group">
          <label>
            Poll endpoint
            <span class="hint">Path polled for task status. Paired with the submit endpoint — usually <code>/jobs/recordInfo</code>.</span>
          </label>
          <input v-model="form.image.poll" class="input" :placeholder="imageEndpointHint.poll" />
        </div>
      </template>

      <!-- Type-specific: AUDIO -->
      <template v-if="form.type === 'audio'">
        <div class="form-group">
          <label>
            Cost / 1K chars (USD)
            <span class="hint">Used for session usage estimates on the dashboard.</span>
          </label>
          <input v-model.number="form.audio.cost_per_1k_chars" type="number" step="0.01" min="0" class="input" />
        </div>
      </template>

      <!-- Type-specific: VIDEO -->
      <template v-if="form.type === 'video'">
        <div class="form-group">
          <label>
            Credits / video
            <span class="hint">Shown in cost-preview dialogs before generation.</span>
          </label>
          <input v-model.number="form.video.credits_per_video" type="number" step="1" min="0" class="input" />
        </div>
        <div class="form-group">
          <label>
            Max duration (s)
            <span class="hint">Upper bound the model accepts. Leave blank if unknown.</span>
          </label>
          <input v-model.number="form.video.max_duration" type="number" step="1" min="1" class="input" placeholder="e.g. 8" />
        </div>
        <div class="form-group form-group-wide">
          <label>
            Supported modes
            <span class="hint">Text-to-video, image-to-video (frames), or reference-image composition (ingredients).</span>
          </label>
          <div class="mode-chips">
            <label v-for="mode in VIDEO_MODES" :key="mode" class="mode-chip">
              <input
                type="checkbox"
                :checked="form.video.modes.includes(mode)"
                @change="toggleMode(mode)"
              />
              {{ mode }}
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>
            Provider slug
            <span class="hint">Queue id the provider expects (e.g. <code>fal-ai/veo3.1</code> or a kie <code>api_model</code> string).</span>
          </label>
          <input v-model="form.video.provider_slug" class="input" :placeholder="videoSlugHint" />
        </div>
        <div class="form-group">
          <label>
            Default duration (s)
            <span class="hint">Sent on submit when the generator doesn't specify a duration. Leave blank for provider default.</span>
          </label>
          <input v-model.number="form.video.default_duration" type="number" step="1" min="1" class="input" />
        </div>
      </template>

      <!-- Type-specific: TEXT — no extra fields beyond id/provider/label -->
      <template v-if="form.type === 'text'">
        <div class="form-group form-group-wide text-info">
          Text (LLM) models need no extra params — the provider's client already knows how to call
          them by id. Make sure the provider's <code>supportsModel()</code> implementation accepts
          this id, or Script Generator will reject it.
        </div>
      </template>
    </div>

    <div class="form-actions">
      <button class="btn btn-primary" :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? 'Adding…' : 'Add Custom Model' }}
      </button>
      <span v-if="missingReason" class="text-muted" style="font-size: 12px;">
        {{ missingReason }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
type ModelType = 'image' | 'audio' | 'video' | 'text'

interface UnifiedModel {
  id: string
  provider: string
  type: ModelType
  label: string
  is_custom?: boolean
  params: Record<string, any>
}

const props = defineProps<{
  /** All models currently in the catalog — used to warn on id collisions. */
  existing: UnifiedModel[]
}>()

const emit = defineEmits<{ add: [model: UnifiedModel] }>()

const VIDEO_MODES = ['text', 'frames', 'ingredients'] as const

const PROVIDERS_BY_TYPE: Record<ModelType, Array<{ id: string; label: string }>> = {
  image: [
    { id: 'kie', label: 'kie.ai' },
  ],
  audio: [
    { id: 'fal', label: 'fal.ai (ElevenLabs)' },
    { id: 'genaipro', label: 'GenAIPro (ElevenLabs)' },
    { id: 'elevenlabs', label: 'ElevenLabs (direct)' },
  ],
  video: [
    { id: 'fal-video', label: 'fal.ai Video' },
    { id: 'kie-video', label: 'kie.ai Video' },
  ],
  text: [
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'kie', label: 'kie.ai (DeepSeek)' },
  ],
}

const form = reactive({
  type: 'image' as ModelType,
  id: '',
  label: '',
  provider: 'kie',
  image: {
    credits_per_image: 1,
    endpoint: '/jobs/createTask',
    poll: '/jobs/recordInfo',
    type: 'jobs',
    api_model: '',
  },
  audio: {
    cost_per_1k_chars: 0.1,
  },
  video: {
    credits_per_video: 5,
    max_duration: undefined as number | undefined,
    modes: ['text'] as string[],
    provider_slug: '',
    default_duration: undefined as number | undefined,
  },
})

const submitting = ref(false)

// When the user changes Type, reset Provider to the first one valid for that type.
watch(() => form.type, (t) => {
  const first = PROVIDERS_BY_TYPE[t]?.[0]?.id
  if (first && !PROVIDERS_BY_TYPE[t].some(p => p.id === form.provider)) {
    form.provider = first
  }
}, { immediate: true })

const providersForType = computed(() => PROVIDERS_BY_TYPE[form.type])

const idCollision = computed(() => {
  if (!form.id.trim()) return false
  return props.existing.some(m => m.id === form.id.trim())
})

const idPlaceholder = computed(() => {
  switch (form.type) {
    case 'image': return 'e.g. my-image-v1'
    case 'audio': return 'e.g. my-tts-v1'
    case 'video': return 'e.g. my-veo-fast'
    case 'text':  return 'e.g. gpt-4.1-mini'
  }
  return ''
})

const labelPlaceholder = computed(() => {
  switch (form.type) {
    case 'image': return 'e.g. My Image Model v1 [kie.ai]'
    case 'audio': return 'e.g. ElevenLabs Custom [fal]'
    case 'video': return 'e.g. Custom Veo Fast'
    case 'text':  return 'e.g. GPT-4.1 Mini'
  }
  return ''
})

const imageEndpointHint = computed(() => {
  switch (form.image.type) {
    case 'flux':      return { endpoint: '/flux/kontext/generate', poll: '/flux/kontext/record-info' }
    case '4o':        return { endpoint: '/gpt4o-image/generate',  poll: '/gpt4o-image/record-info' }
    case 'gpt-image': return { endpoint: '/jobs/createTask',       poll: '/jobs/recordInfo' }
    default:          return { endpoint: '/jobs/createTask',       poll: '/jobs/recordInfo' }
  }
})

const videoSlugHint = computed(() => {
  if (form.provider === 'fal-video') return 'fal-ai/veo3.1'
  if (form.provider === 'kie-video') return 'sora-2-text-to-video'
  return ''
})

const missingReason = computed(() => {
  if (!form.id.trim()) return 'Enter a model id to continue.'
  if (!form.label.trim()) return 'Enter a label to continue.'
  if (form.type === 'image' && !form.image.api_model.trim()) return 'Enter api_model — the slug the provider expects.'
  if (form.type === 'video' && !form.video.provider_slug.trim()) return 'Enter the provider slug (queue id).'
  if (form.type === 'video' && form.video.modes.length === 0) return 'Pick at least one supported mode.'
  return ''
})

const canSubmit = computed(() => !missingReason.value)

function toggleMode(mode: string) {
  const i = form.video.modes.indexOf(mode)
  if (i >= 0) form.video.modes.splice(i, 1)
  else form.video.modes.push(mode)
}

function buildParams(): Record<string, any> {
  switch (form.type) {
    case 'image': {
      return {
        credits_per_image: form.image.credits_per_image,
        endpoint: form.image.endpoint,
        poll: form.image.poll,
        type: form.image.type,
        api_model: form.image.api_model.trim(),
      }
    }
    case 'audio': {
      return { cost_per_1k_chars: form.audio.cost_per_1k_chars }
    }
    case 'video': {
      const params: Record<string, any> = {
        credits_per_video: form.video.credits_per_video,
        modes: [...form.video.modes],
      }
      if (form.video.max_duration !== undefined) params.max_duration = form.video.max_duration
      const providerParams: Record<string, any> = {}
      if (form.provider === 'fal-video') {
        providerParams.slug = form.video.provider_slug.trim()
      } else if (form.provider === 'kie-video') {
        providerParams.api_model = form.video.provider_slug.trim()
      }
      if (form.video.default_duration !== undefined) providerParams.default_duration = form.video.default_duration
      if (Object.keys(providerParams).length) params.provider_params = providerParams
      return params
    }
    case 'text':
      return {}
  }
  return {}
}

function resetForm() {
  form.id = ''
  form.label = ''
  form.image.api_model = ''
  form.video.provider_slug = ''
  form.video.max_duration = undefined
  form.video.default_duration = undefined
  form.video.modes = ['text']
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const model: UnifiedModel = {
      id: form.id.trim(),
      provider: form.provider,
      type: form.type,
      label: form.label.trim(),
      is_custom: true,
      params: buildParams(),
    }
    emit('add', model)
    resetForm()
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.add-custom-model {
  padding: 16px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary, transparent);
}

.form-header h4 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.form-help {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.form-group-wide {
  grid-column: span 2;
}

.form-group label {
  font-size: 12px;
  font-weight: 500;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.form-group .hint {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-secondary);
}

.input-warn {
  border-color: rgba(234, 179, 8, 0.6) !important;
}

.warn-hint {
  font-size: 11px;
  color: #eab308;
}

.mode-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 4px;
}
.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
}
.mode-chip input { margin: 0; }

.text-info {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}

@media (max-width: 720px) {
  .form-grid { grid-template-columns: 1fr; }
  .form-group-wide { grid-column: span 1; }
}
</style>
