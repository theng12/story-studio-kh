<template>
  <div ref="rootEl" class="model-menu" :class="`model-menu-${mediaType}`">
    <button
      type="button"
      class="model-menu-trigger"
      :class="{ open: expanded, empty: !selectedOption }"
      :disabled="disabled || (loading && !options.length)"
      :aria-expanded="expanded"
      aria-haspopup="listbox"
      :title="selectedOption?.label || modelValue || placeholder"
      @click="toggle"
    >
      <span class="model-menu-kind" aria-hidden="true">{{ kindLabel }}</span>
      <span class="model-menu-current">
        <strong>{{ selectedOption?.label || modelValue || (loading ? loadingLabel : placeholder) }}</strong>
        <span v-if="selectedSummary">{{ selectedSummary }}</span>
      </span>
      <span
        v-for="badge in selectedAccessBadges"
        :key="`selected-${badge.label}`"
        class="model-menu-badge model-menu-trigger-badge"
        :data-tone="badge.tone || 'neutral'"
        :title="badge.title || badge.label"
      >{{ badge.label }}</span>
      <span class="model-menu-chevron" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
      <div
        v-if="expanded"
        ref="panelEl"
        class="model-menu-panel"
        :class="`model-menu-panel-${mediaType}`"
        :style="panelStyle"
        role="listbox"
        tabindex="-1"
        :aria-label="ariaLabel"
        @click.stop
      >
        <div class="model-menu-panel-head">
          <div>
            <span>{{ kindLabel }}</span>
            <strong>{{ title }}</strong>
          </div>
          <span class="model-menu-count">{{ filteredOptions.length }} available</span>
        </div>

        <div class="model-menu-search-wrap">
          <input
            ref="searchEl"
            v-model="query"
            type="search"
            class="input model-menu-search"
            :placeholder="searchPlaceholder"
            :aria-label="searchPlaceholder"
          />
        </div>

        <div v-if="catalogNotice" class="model-menu-catalog-notice">
          <span>{{ catalogNotice }}</span>
          <NuxtLink v-if="catalogNoticeHref" :to="catalogNoticeHref">Plan status →</NuxtLink>
        </div>

        <div class="model-menu-list">
          <section v-for="group in groupedOptions" :key="group.label" class="model-menu-group">
            <h4>{{ group.label }}</h4>
            <button
              v-for="option in group.items"
              :key="option.id"
              type="button"
              class="model-menu-option"
              :class="{ selected: option.id === modelValue, disabled: option.disabled }"
              role="option"
              :aria-selected="option.id === modelValue"
              :aria-disabled="option.disabled || undefined"
              :title="option.disabledReason || option.description || option.label"
              @click="select(option)"
            >
              <span class="model-menu-option-copy">
                <strong>{{ option.label }}</strong>
                <span v-if="option.meta || option.description">{{ option.meta || option.description }}</span>
                <small v-if="option.disabledReason">{{ option.disabledReason }}</small>
              </span>
              <span class="model-menu-option-side">
                <span
                  v-for="badge in option.badges || []"
                  :key="`${option.id}-${badge.label}`"
                  class="model-menu-badge"
                  :data-tone="badge.tone || 'neutral'"
                  :title="badge.title || badge.label"
                >{{ badge.label }}</span>
                <span v-if="option.id === modelValue" class="model-menu-check" aria-label="Selected">✓</span>
              </span>
            </button>
          </section>

          <div v-if="!groupedOptions.length" class="model-menu-empty">
            No models match “{{ query.trim() }}”.
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
interface ModelMenuBadge {
  label: string
  tone?: 'neutral' | 'local' | 'free' | 'paid' | 'warning' | 'info'
  title?: string
}

interface ModelMenuOption {
  id: string
  label: string
  group?: string
  provider?: string
  meta?: string
  description?: string
  disabled?: boolean
  disabledReason?: string
  badges?: ModelMenuBadge[]
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: ModelMenuOption[]
  mediaType?: 'llm' | 'image' | 'tts' | 'video' | 'transcription'
  title?: string
  placeholder?: string
  searchPlaceholder?: string
  ariaLabel?: string
  loading?: boolean
  loadingLabel?: string
  disabled?: boolean
  catalogNotice?: string
  catalogNoticeHref?: string
}>(), {
  mediaType: 'llm',
  title: 'Choose a model',
  placeholder: 'Pick a model…',
  searchPlaceholder: 'Search models…',
  ariaLabel: 'Model options',
  loading: false,
  loadingLabel: 'Loading models…',
  disabled: false,
  catalogNotice: '',
  catalogNoticeHref: '',
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const expanded = ref(false)
const query = ref('')
const rootEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const { panelStyle } = useAnchoredPanel(expanded, rootEl, panelEl, {
  minWidth: 420,
  maxWidth: 680,
  maxHeight: 620,
})

const kindLabel = computed(() => ({
  llm: 'AI',
  image: 'IMG',
  tts: 'TTS',
  video: 'I2V',
  transcription: 'STT',
})[props.mediaType])
const selectedOption = computed(() => props.options.find(option => option.id === props.modelValue) || null)
const selectedAccessBadges = computed(() => (
  selectedOption.value?.badges?.filter(badge => badge.label.startsWith('∞')) || []
))
const selectedSummary = computed(() => {
  const option = selectedOption.value
  if (!option) return ''
  return [option.provider || option.group, option.meta].filter(Boolean).join(' · ')
})
const filteredOptions = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return props.options
  return props.options.filter((option) => {
    const haystack = [option.label, option.id, option.group, option.provider, option.meta, option.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})
const groupedOptions = computed(() => {
  const groups = new Map<string, ModelMenuOption[]>()
  for (const option of filteredOptions.value) {
    const label = option.group || option.provider || 'Models'
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(option)
  }
  return Array.from(groups, ([label, items]) => ({ label, items }))
})

async function toggle() {
  if (props.disabled || (props.loading && !props.options.length)) return
  expanded.value = !expanded.value
  if (expanded.value) {
    query.value = ''
    await nextTick()
    searchEl.value?.focus({ preventScroll: true })
  }
}
function select(option: ModelMenuOption) {
  if (option.disabled) return
  emit('update:modelValue', option.id)
  expanded.value = false
}
function closeOnOutside(event: MouseEvent) {
  const target = event.target as Node
  if (expanded.value && !rootEl.value?.contains(target) && !panelEl.value?.contains(target)) expanded.value = false
}
function closeOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') expanded.value = false
}
onMounted(() => {
  document.addEventListener('click', closeOnOutside)
  window.addEventListener('keydown', closeOnEscape)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeOnOutside)
  window.removeEventListener('keydown', closeOnEscape)
})
</script>

<style scoped>
.model-menu { width: 100%; min-width: 0; }
.model-menu-trigger {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.model-menu-trigger:hover:not(:disabled), .model-menu-trigger.open { border-color: var(--accent); box-shadow: var(--focus-ring); }
.model-menu-trigger:disabled { cursor: not-allowed; opacity: .58; }
.model-menu-kind {
  flex: 0 0 auto;
  min-width: 34px;
  padding: 4px 6px;
  border-radius: 7px;
  background: var(--surface-accent);
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .08em;
  text-align: center;
}
.model-menu-current { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.model-menu-current strong {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.25;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.model-menu-current span { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.model-menu-chevron { flex: 0 0 auto; color: var(--text-muted); transition: transform .15s ease; }
.model-menu-trigger.open .model-menu-chevron { transform: rotate(180deg); }
.model-menu-trigger-badge { flex: 0 0 auto; }

.model-menu-panel {
  position: fixed;
  z-index: 1400;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  border-radius: 14px;
  background: var(--bg-primary);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .46);
  color: var(--text-primary);
}
.model-menu-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px 10px; border-bottom: 1px solid var(--border); background: var(--surface-raised); }
.model-menu-panel-head > div { display: flex; min-width: 0; align-items: center; gap: 9px; }
.model-menu-panel-head > div > span { padding: 3px 6px; border-radius: 6px; background: var(--surface-accent); color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .08em; }
.model-menu-panel-head strong { font-size: 13px; }
.model-menu-count { flex: 0 0 auto; color: var(--text-muted); font-size: var(--font-xs); }
.model-menu-search-wrap { padding: 10px 12px 8px; }
.model-menu-search { width: 100%; min-height: 38px; }
.model-menu-catalog-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin: 0 12px 8px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-secondary));
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.4;
}
.model-menu-catalog-notice a { flex: 0 0 auto; color: var(--accent); font-weight: 700; white-space: nowrap; }
.model-menu-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 10px; }
.model-menu-group { margin-top: 5px; }
.model-menu-group h4 { margin: 0; padding: 7px 8px 5px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.model-menu-option { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.model-menu-option:hover:not(.disabled) { border-color: var(--border); background: var(--bg-tertiary); }
.model-menu-option.selected { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); }
.model-menu-option.disabled { cursor: not-allowed; opacity: .48; }
.model-menu-option-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.model-menu-option-copy strong { font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.model-menu-option-copy span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; overflow-wrap: anywhere; }
.model-menu-option-copy small { color: var(--warning); font-size: var(--font-xs); line-height: 1.3; }
.model-menu-option-side { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 5px; }
.model-menu-badge { padding: 3px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; white-space: nowrap; }
.model-menu-badge[data-tone='local'], .model-menu-badge[data-tone='free'] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
.model-menu-badge[data-tone='paid'], .model-menu-badge[data-tone='warning'] { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); }
.model-menu-badge[data-tone='info'] { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.model-menu-check { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; background: var(--accent); color: var(--accent-on); font-size: var(--font-xs); font-weight: 800; }
.model-menu-empty { padding: 28px 14px; color: var(--text-muted); font-size: 12px; text-align: center; }

@media (max-width: 680px) {
  .model-menu-trigger-badge { display: none; }
  .model-menu-option-side .model-menu-badge:nth-child(n+2) { display: none; }
  .model-menu-panel-head { padding-inline: 12px; }
}
</style>
