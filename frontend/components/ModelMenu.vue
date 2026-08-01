<template>
  <div class="model-menu" :class="`model-menu-${mediaType}`">
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

    <PickerDialog
      :visible="expanded"
      :kind="kindLabel"
      :title="title"
      :count="`${selectableOptionCount} available`"
      :close-label="`Close ${ariaLabel.toLowerCase()}`"
      size="lg"
      @close="close"
    >
      <div class="model-menu-search-wrap">
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          class="input model-menu-search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          @keydown="onListKeydown"
        />
      </div>

      <div v-if="catalogNotice" class="model-menu-catalog-notice">
        <span>{{ catalogNotice }}</span>
        <NuxtLink v-if="catalogNoticeHref" :to="catalogNoticeHref">Plan status →</NuxtLink>
      </div>

      <div
        ref="listEl"
        class="model-menu-list"
        :class="`model-menu-list-${mediaType}`"
        role="listbox"
        :aria-label="ariaLabel"
        @keydown="onListKeydown"
      >
        <section v-for="group in groupedOptions" :key="group.label" class="model-menu-group" role="group" :aria-label="group.label">
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
    </PickerDialog>
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
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

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
const selectableOptionCount = computed(() => filteredOptions.value.filter(option => !option.disabled).length)
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
  if (expanded.value) {
    close()
    return
  }
  query.value = ''
  expanded.value = true
  // Two ticks: the shared focus trap moves focus to the dialog's first control
  // on the first tick, so the search field claims it on the one after.
  await nextTick()
  await nextTick()
  searchEl.value?.focus({ preventScroll: true })
  listEl.value?.querySelector('.model-menu-option.selected')?.scrollIntoView({ block: 'center' })
}
/** Modal restores focus to the trigger, so closing never strands the keyboard. */
function close() {
  expanded.value = false
}
function select(option: ModelMenuOption) {
  if (option.disabled) return
  emit('update:modelValue', option.id)
  close()
}

/**
 * Arrow keys walk the selectable rows and Enter picks one — Enter needs no
 * handler because every row is a real <button>, so the browser activates the
 * focused one. Focus moves for real rather than through aria-activedescendant
 * so screen readers announce each row, and Arrow Up off the top hands the
 * keyboard back to the search field.
 */
function selectableButtons(): HTMLButtonElement[] {
  const nodes = listEl.value?.querySelectorAll<HTMLButtonElement>('.model-menu-option:not(.disabled)')
  return nodes ? Array.from(nodes) : []
}
function moveActive(delta: number) {
  const buttons = selectableButtons()
  if (!buttons.length) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) {
    buttons[delta > 0 ? 0 : buttons.length - 1]?.focus()
    return
  }
  const next = current + delta
  if (next < 0) {
    searchEl.value?.focus({ preventScroll: true })
    return
  }
  buttons[Math.min(next, buttons.length - 1)]?.focus()
}
function onListKeydown(event: KeyboardEvent) {
  // Home/End belong to the caret while the user is typing a query.
  const typing = event.target === searchEl.value
  if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1) }
  else if (event.key === 'Home' && !typing) { event.preventDefault(); selectableButtons()[0]?.focus() }
  else if (event.key === 'End' && !typing) { event.preventDefault(); selectableButtons().at(-1)?.focus() }
}
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

.model-menu-search-wrap { flex: 0 0 auto; padding: 12px 14px 9px; }
.model-menu-search { width: 100%; min-height: 38px; }
.model-menu-catalog-notice {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin: 0 14px 9px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-secondary));
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.4;
}
.model-menu-catalog-notice a { flex: 0 0 auto; color: var(--accent); font-weight: 700; white-space: nowrap; }
/* The only scroller in the dialog — the header and search stay put while a
   long catalogue moves under them. min-height:0 lets it shrink inside the
   flex column instead of pushing the dialog past its max-height. */
.model-menu-list { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 12px; scrollbar-width: thin; }
.model-menu-group { margin-top: 5px; }
.model-menu-group h4 { margin: 0; padding: 7px 8px 5px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.model-menu-option { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.model-menu-option:hover:not(.disabled) { border-color: var(--border); background: var(--bg-tertiary); }
.model-menu-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
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
  .model-menu-search-wrap { padding-inline: 12px; }
  .model-menu-catalog-notice { margin-inline: 12px; }
}
</style>
