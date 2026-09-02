<template>
  <div class="model-menu" :class="`model-menu-${mediaType}`">
    <button
      type="button"
      class="model-menu-trigger"
      :class="{ open: expanded, empty: !selectedOption }"
      :disabled="disabled || (loading && !options.length)"
      :aria-expanded="expanded"
      aria-haspopup="listbox"
      :title="triggerLabel"
      @click="toggle"
    >
      <span class="model-menu-kind" aria-hidden="true">{{ kindLabel }}</span>
      <span class="model-menu-current" :class="{ missing: showingMissingSelection }">
        <strong>{{ triggerLabel }}</strong>
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

      <div
        v-if="tierMode"
        ref="tierTabsEl"
        class="model-menu-tier-tabs"
        role="tablist"
        aria-label="Browse models by cost tier"
      >
        <button
          v-for="tier in GENSTUDIO_COST_TIERS"
          :id="tierTabId(tier.id)"
          :key="tier.id"
          type="button"
          class="model-menu-tier-tab"
          :class="{ active: tier.id === activeTier }"
          role="tab"
          :aria-selected="tier.id === activeTier"
          :aria-controls="tierPanelId"
          :tabindex="tier.id === activeTier ? 0 : -1"
          :title="tier.description"
          @click="setTier(tier.id)"
          @keydown="onTierKeydown"
        >{{ tier.label }}</button>
      </div>

      <div v-if="catalogNotice" class="model-menu-catalog-notice">
        <span>{{ catalogNotice }}</span>
        <NuxtLink v-if="catalogNoticeHref" :to="catalogNoticeHref">Plan status →</NuxtLink>
      </div>

      <div
        class="model-menu-results"
        :id="tierMode ? tierPanelId : undefined"
        :role="tierMode ? 'tabpanel' : undefined"
        :aria-labelledby="tierMode ? activeTierTabId : undefined"
      >
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
            <!-- Said ONCE for the whole section, never per row. The relaxed
                 shelf's offer is the only thing in this dialog a customer
                 genuinely has to read, and repeating it under every model is
                 how it would become furniture they scroll past. Body-weight
                 rather than muted micro-copy, and never truncated: it wraps. -->
            <p v-if="group.note" class="model-menu-group-note">{{ group.note }}</p>
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
                <small v-if="option.provider" class="model-menu-option-provider">{{ option.provider }}</small>
                <small
                  v-if="option.price"
                  class="model-menu-option-price"
                  :title="option.priceTitle || option.price"
                >Published rate · {{ option.price }}</small>
                <small v-if="option.priceNote" class="model-menu-option-price-note">{{ option.priceNote }}</small>
                <span v-if="option.description" class="model-menu-option-description">{{ option.description }}</span>
                <span v-if="option.meta" class="model-menu-option-meta">{{ option.meta }}</span>
                <small v-if="option.disabledReason">{{ option.disabledReason }}</small>
              </span>
              <span class="model-menu-option-side">
                <span
                  v-if="searching && option.costTier"
                  class="model-menu-tier-badge"
                >{{ tierLabel(option.costTier) }}</span>
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
            {{ emptyResultLabel }}
          </div>
        </div>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import {
  GENSTUDIO_COST_TIERS,
  costTierLabel,
  isCompleteTierCatalog,
  tierForKeyboard,
  tierForOpening,
  visibleTierOptions,
  type GenStudioCostTier,
} from '../utils/genstudio-cost-tier'
import { groupMenuOptions } from '../utils/genstudio-relaxed-queue'
import { pickerTriggerLabel } from '../utils/picker-trigger-label'

interface ModelMenuBadge {
  label: string
  tone?: 'neutral' | 'local' | 'free' | 'paid' | 'warning' | 'info'
  title?: string
}

interface ModelMenuOption {
  id: string
  label: string
  group?: string
  /**
   * A note about the SECTION this row sits in, carried on the row because that
   * is how the catalogue publishes it — a bare list, with each row carrying the
   * facts a client needs beside it. The first non-empty one in a section is
   * rendered once under that section's heading; the rest are ignored.
   */
  groupNote?: string
  provider?: string
  meta?: string
  description?: string
  price?: string
  priceTitle?: string
  priceNote?: string
  disabled?: boolean
  disabledReason?: string
  badges?: ModelMenuBadge[]
  costTier?: GenStudioCostTier
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
  /**
   * What to show on the trigger when `modelValue` names a product this menu's
   * options no longer contain.
   *
   * Empty by default. An owner that KNOWS the id is dead (it has the catalogue
   * and the id is not in it) sets this, and the trigger stops presenting a dead
   * id as though it were a chosen model.
   *
   * Which product went away is told to the user in full sentences beside the
   * control (`selection-gap` in ModelSelector). It is deliberately NOT echoed
   * here as a raw id: an internal product handle is not a name, and a customer
   * reading `gemini-3.1-flash-lite-discount` on the trigger — or in its tooltip
   * — learns nothing except that the app is showing them plumbing.
   */
  missingSelectionLabel?: string
  /**
   * What to show on the trigger when the catalogue could not be read at all.
   *
   * The owner (ModelSelector / any picker host) supplies a complete sentence
   * built from the name this browser remembers for the saved id — e.g.
   * `Claude Fable 5 (unverified — catalog unavailable)`. It wins over the
   * loading label so a returning user sees the model they chose rather than a
   * spinner-word, and it is the ONLY thing standing in for a selection whose
   * catalogue row is missing for a reason other than retirement.
   */
  unverifiedSelectionLabel?: string
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
  missingSelectionLabel: '',
  unverifiedSelectionLabel: '',
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const expanded = ref(false)
const query = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const tierTabsEl = ref<HTMLElement | null>(null)
const activeTier = ref<GenStudioCostTier>('economy')

const kindLabel = computed(() => ({
  llm: 'AI',
  image: 'IMG',
  tts: 'TTS',
  video: 'I2V',
  transcription: 'STT',
})[props.mediaType])
const selectedOption = computed(() => props.options.find(option => option.id === props.modelValue) || null)
/**
 * True only when the owner has told us the saved id is genuinely gone.
 *
 * Deliberately NOT inferred from "no matching option": that is also true while
 * the catalogue is still loading, and a menu that called its own saved value
 * dead every time it opened before the network answered would be crying wolf.
 */
const showingMissingSelection = computed(() => (
  !selectedOption.value && !!props.modelValue && !!props.missingSelectionLabel
))
/**
 * The trigger's headline.
 *
 * A raw product id can never come out of here. It used to: the last term of the
 * old expression was `props.modelValue`, so any state where the options did not
 * contain the saved id — a catalogue read that FAILED being the common one, and
 * the one nothing else covered — put an internal handle like
 * `gemini-3.1-flash-lite-discount` on screen as though it were the name of the
 * customer's model. Every fallback below is a sentence a person can read; the
 * host supplies `unverifiedSelectionLabel` from the name this browser
 * remembers, and where even that is unknown the honest answer is the loading
 * word or the placeholder, never the handle.
 */
const triggerLabel = computed(() => pickerTriggerLabel({
  selectedLabel: selectedOption.value?.label,
  missingLabel: showingMissingSelection.value ? props.missingSelectionLabel : '',
  unverifiedLabel: props.unverifiedSelectionLabel,
  loading: props.loading,
  loadingLabel: props.loadingLabel,
  placeholder: props.placeholder,
}))
const selectedAccessBadges = computed(() => (
  selectedOption.value?.badges?.filter(badge => badge.label.startsWith('∞')) || []
))
const tierMode = computed(() => isCompleteTierCatalog(props.options))
const searching = computed(() => query.value.trim().length > 0)
const tierPanelId = 'model-menu-tier-results'
const activeTierTabId = computed(() => tierTabId(activeTier.value))
const emptyResultLabel = computed(() => {
  if (tierMode.value && !searching.value) {
    return `No ${tierLabel(activeTier.value)} models are currently available.`
  }
  return `No models match “${query.value.trim()}”.`
})
/**
 * The line under the selected model on the closed trigger.
 *
 * `provider` ONLY — never `group`. `group` is this dialog's section heading and
 * is where the gateway is named, once; echoing it here restated the same fact
 * on a second surface while adding nothing. `provider` is different: it is the
 * provider or model creator GenStudio publishes for a product. It is genuinely
 * informative, so it also appears as a compact line on each open-menu row.
 * Where the catalogue publishes no provider this stays empty; nothing is
 * reconstructed from a model id or display name.
 */
const selectedSummary = computed(() => {
  const option = selectedOption.value
  if (!option) return ''
  return [option.provider, option.meta].filter(Boolean).join(' · ')
})
function tierLabel(costTier: GenStudioCostTier): string {
  return costTierLabel(costTier)
}
function tierTabId(costTier: GenStudioCostTier): string {
  return `model-menu-tier-${costTier}`
}
const filteredOptions = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matching = !terms.length ? props.options : props.options.filter((option) => {
    const haystack = [option.label, option.id, option.group, option.provider, option.price, option.meta, option.description, option.costTier && tierLabel(option.costTier)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
  return visibleTierOptions(matching, activeTier.value, searching.value)
})
const selectableOptionCount = computed(() => filteredOptions.value.filter(option => !option.disabled).length)
// Sectioning — including the rule that the relaxed shelf always comes last and
// that its note is said once — lives in a pure function so it can be tested
// against a catalogue rather than only inspected in a template.
const groupedOptions = computed(() => groupMenuOptions(filteredOptions.value))

async function toggle() {
  if (props.disabled || (props.loading && !props.options.length)) return
  if (expanded.value) {
    close()
    return
  }
  query.value = ''
  activeTier.value = tierForOpening(props.modelValue, props.options)
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
function setTier(tier: GenStudioCostTier) {
  activeTier.value = tier
}
function moveTier(key: string) {
  const tier = tierForKeyboard(activeTier.value, key)
  if (!tier) return
  setTier(tier)
  tierTabsEl.value?.querySelector<HTMLButtonElement>(`#${tierTabId(tier)}`)?.focus()
}
function onTierKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowRight') { event.preventDefault(); moveTier('ArrowRight') }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); moveTier('ArrowLeft') }
  else if (event.key === 'Home') { event.preventDefault(); moveTier('Home') }
  else if (event.key === 'End') { event.preventDefault(); moveTier('End') }
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
/* A dead pin must not read as a settled choice. Same warning colour the rest of
   this app uses for "you need to do something about this". */
.model-menu-current.missing strong { color: var(--warning, #d97706); }
.model-menu-chevron { flex: 0 0 auto; color: var(--text-muted); transition: transform .15s ease; }
.model-menu-trigger.open .model-menu-chevron { transform: rotate(180deg); }
.model-menu-trigger-badge { flex: 0 0 auto; }

.model-menu-search-wrap { flex: 0 0 auto; padding: 12px 14px 9px; }
.model-menu-search { width: 100%; min-height: 38px; }
.model-menu-tier-tabs { display: flex; flex: 0 0 auto; gap: 5px; margin: 0 14px 10px; padding: 4px; border-radius: 9px; background: var(--bg-tertiary); }
.model-menu-tier-tab { flex: 1; min-width: 0; min-height: 44px; padding: 7px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: var(--font-xs); font-weight: 700; cursor: pointer; }
.model-menu-tier-tab:hover { color: var(--text-primary); }
.model-menu-tier-tab.active { background: var(--bg-secondary); box-shadow: 0 1px 3px color-mix(in srgb, var(--text-primary) 16%, transparent); color: var(--text-primary); }
.model-menu-tier-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
.model-menu-results { display: flex; min-height: 0; flex: 1; flex-direction: column; }
/* The only scroller in the dialog — the header and search stay put while a
   long catalogue moves under them. min-height:0 lets it shrink inside the
   flex column instead of pushing the dialog past its max-height. */
.model-menu-list { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 12px; scrollbar-width: thin; }
.model-menu-group { margin-top: 5px; }
.model-menu-group h4 { margin: 0; padding: 7px 8px 5px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
/*
 * Set at the list's own reading size rather than as muted micro-copy. This is
 * where a customer is told a cheaper price exists and what earns it
 * permanently, and the usual treatment for such a thing — small grey text
 * under a heading — is indistinguishable from a hint nobody needs to read. It
 * wraps freely and is never clamped, so several sentences survive a narrow
 * dialog.
 */
.model-menu-group-note {
  margin: 0 8px 6px;
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--surface-accent);
  color: var(--text-primary);
  font-size: var(--font-sm);
  line-height: 1.5;
  overflow-wrap: break-word;
}
.model-menu-option { display: flex; width: 100%; min-height: 48px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.model-menu-option:hover:not(.disabled) { border-color: var(--border); background: var(--bg-tertiary); }
.model-menu-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.model-menu-option.selected { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); }
.model-menu-option.disabled { cursor: not-allowed; opacity: .48; }
.model-menu-option-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.model-menu-option-copy strong { font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.model-menu-option-copy .model-menu-option-provider { color: var(--accent); font-size: var(--font-xs); font-weight: 750; letter-spacing: .08em; line-height: 1.2; text-transform: uppercase; }
.model-menu-option-copy .model-menu-option-price { color: var(--warning); font-size: var(--font-xs); font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.model-menu-option-copy .model-menu-option-price-note { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; overflow-wrap: anywhere; }
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
  .model-menu-tier-tabs { margin-inline: 12px; }
  .model-menu-catalog-notice { margin-inline: 12px; }
}
</style>
