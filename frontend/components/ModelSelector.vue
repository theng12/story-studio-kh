<template>
  <div class="form-group">
    <label>
      {{ label || 'LLM model' }}
      <span v-if="loading" class="loading">Loading GenStudio catalog…</span>
    </label>
    <ModelMenu
      :model-value="modelValue"
      :options="menuOptions"
      :loading="loading"
      media-type="llm"
      title="Choose LLM model"
      placeholder="Pick an LLM model…"
      search-placeholder="Search LLM models…"
      aria-label="LLM model options"
      @update:model-value="selectModel"
    />
    <p v-if="loadError" class="catalog-message">{{ loadError }}</p>
    <!-- Rendered in full, always, while a model carrying it is selected. Not a
         tooltip, not collapsed, not truncated: choosing the model IS the
         consent act, so the words have to be readable at the moment of
         choosing. It disappears for a model without a notice, so it never
         becomes furniture people learn to scroll past. -->
    <p v-if="selectedDataDisclosure" class="data-disclosure">{{ selectedDataDisclosure }}</p>
    <!-- Shown for as long as a retiring model stays selected. The date alone
         would make the reader work out how much time is left, so the sentence
         carries both. Same treatment as the notice above: body text, in the
         flow, never a tooltip and never truncated — a warning nobody can read
         at a glance is the warning that was already there. -->
    <p v-if="selectedRetirementNotice" class="retirement-notice">{{ selectedRetirementNotice }}</p>
  </div>
</template>

<script setup lang="ts">
import {
  isUsableLiveGenStudioModel,
  selectLiveGenStudioModel,
  genStudioModelLockReason,
} from '../utils/live-genstudio-model-selection.js'
import { invalidateModelCatalogCache } from '../composables/useApi.js'
import type { GenStudioCostTier } from '../utils/genstudio-cost-tier.js'
import { describeChatRate } from '../utils/genstudio-credit-cost.js'
import {
  describeRelaxedQueueHint,
  queueClassGroupLabel,
  isRelaxedQueue,
  type RelaxedQueueHint,
} from '../utils/genstudio-relaxed-queue.js'
import { describeModelRetirement, isRetiring } from '../utils/genstudio-model-retirement.js'

interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  provider_name?: string | null
  available: boolean
  disabled_reason?: string | null
  hint?: string | null
  supports_vision?: boolean
  /** Total prompt-plus-output budget, published live by GenStudio. */
  context_window_tokens?: number
  /** @deprecated Backwards-compatibility alias for older GenStudio releases.
   *  Read only when `context_window_tokens` is absent. */
  context_limit_tokens?: number
  /** Maximum selectable output allowance, published live by GenStudio. */
  max_output_tokens?: number
  structured_output_mode?: 'json_object' | 'request_json_schema'
  legacy_ids?: string[]
  cost_tier?: GenStudioCostTier
  locked?: boolean
  lock_reason?: string | null
  input_credits_per_million_tokens?: number | null
  output_credits_per_million_tokens?: number | null
  /** The undiscounted rates, sent only while GenStudio is applying a sale to
   *  this account. The pair above is what the account pays today; these are the
   *  prices shown struck through beside them. */
  standard_input_credits_per_million_tokens?: number | null
  standard_output_credits_per_million_tokens?: number | null
  minimum_credits?: number | null
  price_version?: string | null
  /**
   * Which shelf GenStudio sells this product on. The ONLY thing this picker
   * groups by — the words "(Relaxed Queue)" that appear inside some display
   * names are copy the owner edits, and a menu that grouped by searching for
   * the phrase would regroup itself the next time he reworded a product.
   *
   * Absent means `direct`, which is the truth for every product that predates
   * the field: one undivided list, exactly as this menu looked before.
   */
  queue_class?: 'direct' | 'relaxed' | null
  /** GenStudio's own note about the relaxed shelf — the discount it is running,
   *  the top-up total that makes it permanent, and the sentence explaining it.
   *  Rendered once under the section heading, and never authored here. */
  relaxed_queue_hint?: RelaxedQueueHint | null
  /**
   * GenStudio offers some products at a reduced price in exchange for a data
   * arrangement. NOT `sale_disclaimer`, which is a price promotion and means
   * something else. The sentence is published per model and rendered verbatim;
   * Story Studio never writes its own copy of it, because softening a word
   * would change what the customer was told they agreed to.
   */
  discount?: boolean
  discount_disclaimer?: string | null
  /**
   * GenStudio's published retirement schedule. `deprecation_warning` is its own
   * flag for "the warning window is open" — this app reads it rather than
   * deciding for itself how much notice a customer gets — and `retires_at` is
   * the moment the product stops being available to them.
   */
  deprecation_warning?: boolean
  deprecation_warning_at?: string | null
  scheduled_retirement_at?: string | null
  retires_at?: string | null
  /**
   * Carried through the client and the /api/models whitelist, and deliberately
   * unused here. The picker promises it "will not switch products
   * automatically"; naming one successor would quietly steer the choice it
   * promises to leave alone. Plumbing it anyway means a change of mind is a UI
   * change, not a transport change.
   */
  replacement_model_id?: string | null
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
  label?: string
  requireVision?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'model-meta': [value: LlmModelRow | null]
}>()

const { get } = useApi()
const allModels = ref<LlmModelRow[]>([])
const loading = ref(false)
const loadError = ref('')

function isDisabled(model: LlmModelRow): boolean {
  return !isUsableLiveGenStudioModel(model, props.requireVision === true)
}

const menuOptions = computed(() => {
  // A reference-guided request has an image input. Do not leave text-only
  // models in the menu as disabled dead ends: they cannot run this request at
  // all, and showing them invites a confusing failure after the user uploads
  // a reference. The server remains authoritative at execution time.
  const eligibleModels = props.requireVision
    ? allModels.value.filter(model => isUsableLiveGenStudioModel(model, true))
    : allModels.value
  // The gateway is named once by the group heading. A creator/provider is a
  // separate published fact and appears on the row only when GenStudio sends
  // `provider_name`; it is never reconstructed from an id or display name.
  const rows = eligibleModels.map((model) => {
    const rate = describeChatRate({ ...model, display_name: model.label })
    return {
      id: model.id,
      label: model.label,
      // Two shelves, and `queue_class` decides which. A catalogue with no
      // relaxed products yields one group with the heading it has always had.
      group: queueClassGroupLabel(model, 'Language models'),
      // Sent on every relaxed row, rendered once for the section — see
      // `ModelMenu`'s `groupNote`. Empty for a direct row, and empty for a
      // relaxed row on a GenStudio that publishes no hint, which shows the
      // section with no note rather than a note this app made up.
      groupNote: isRelaxedQueue(model) ? describeRelaxedQueueHint(model.relaxed_queue_hint) : '',
      provider: model.provider_name || '',
      price: rate.text,
      priceTitle: rate.title,
      description: model.disabled_reason || model.hint || '',
      disabled: isDisabled(model),
      disabledReason: genStudioModelLockReason(model) || model.disabled_reason || (props.requireVision && !model.supports_vision ? 'This GenStudio model does not publish image-input support.' : ''),
      // Scannable in the list, before anything is opened. The sentence itself
      // is rendered in full beneath the selector once the model is chosen — a
      // badge is a signpost, never the disclosure.
      badges: [
        ...(model.discount === true
          ? [{ label: 'Data notice', tone: 'warning' as const, title: model.discount_disclaimer || 'This model carries a data notice from GenStudio.' }]
          : []),
        // Visible while scanning the list, before any row is opened. The date
        // and the countdown ride along as the title; the full sentence is
        // rendered beneath the selector once the model is chosen.
        ...(isRetiring(model)
          ? [{ label: 'Retiring', tone: 'warning' as const, title: describeModelRetirement(model) }]
          : []),
      ],
      costTier: model.cost_tier,
    }
  })
  return rows
})

/**
 * What GenStudio has published about the selected model's retirement, or ''.
 *
 * Every value in the sentence comes off the catalogue row; the only thing
 * computed here is the distance between GenStudio's date and today, which is
 * the arithmetic this exists to spare the reader.
 */
const selectedRetirementNotice = computed(() => describeModelRetirement(
  allModels.value.find(model => model.id === props.modelValue),
))

/** GenStudio's own sentence for the selected model, or '' when it publishes none. */
const selectedDataDisclosure = computed(() => {
  const selected = allModels.value.find(model => model.id === props.modelValue)
  return selected?.discount === true ? (selected.discount_disclaimer || '') : ''
})

function selectModel(value: string): void {
  const model = allModels.value.find(entry => entry.id === value)
  if (!model || isDisabled(model)) return
  emit('update:modelValue', value)
  emit('model-meta', model)
}

function syncModelSelection(): void {
  const selected = selectLiveGenStudioModel(
    props.modelValue,
    allModels.value,
    props.requireVision === true,
  )
  if (!selected) {
    const saved = props.modelValue.trim()
    const unavailable = allModels.value.find(model => model.id === saved)
    if (saved && unavailable) {
      loadError.value = unavailable.disabled_reason
        || `${unavailable.label} is retired or unavailable. Choose a replacement; Story Studio will not switch products automatically.`
    }
    emit('model-meta', null)
    return
  }
  loadError.value = ''
  // Persist the healed value through the owning form. This replaces stale
  // direct-provider defaults (notably GPT-4o) and means they cannot reappear
  // after the next visit.
  if (props.modelValue !== selected.id) emit('update:modelValue', selected.id)
  emit('model-meta', selected)
}

/**
 * Load the catalogue through the shared `/models?` read cache.
 *
 * `force` drops that shared entry first, so the next read goes to the network.
 * It is used when GenStudio itself has told us our view of the published limits
 * is wrong — see `reloadCatalog` below.
 */
async function loadModels(force = false): Promise<void> {
  if (force) invalidateModelCatalogCache()
  loading.value = true
  loadError.value = ''
  try {
    const models = await get<LlmModelRow[]>(`/models?project=${props.projectSlug}`)
    allModels.value = models
    syncModelSelection()
  } catch (error: any) {
    allModels.value = []
    loadError.value = error?.data?.detail || error?.message || 'GenStudio catalog unavailable.'
  } finally {
    loading.value = false
  }
}

watch(() => props.projectSlug, () => { void loadModels() }, { immediate: true })
watch(() => props.modelValue, syncModelSelection)
watch(() => props.requireVision, syncModelSelection)

/**
 * Re-read the published catalogue from the network and re-emit the selected
 * model's live limits. Owning pages call this after GenStudio — the final
 * validator — rejects a request for exceeding a context or output limit, so the
 * UI clamps to what the model publishes NOW instead of to a stale snapshot.
 */
async function reloadCatalog(): Promise<void> {
  await loadModels(true)
}

defineExpose({ reloadCatalog })
</script>

<style scoped>
.loading { margin-left: 8px; color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; }
.catalog-message { margin: 6px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }

/*
 * Body text, deliberately. This is the only place a customer is told what
 * happens to data they send to a reduced-price model, so it is set at the same
 * size as the rest of the form rather than as muted micro-copy — the usual
 * treatment for a notice nobody is expected to read. It wraps freely and is
 * never truncated: four sentences must fit at any selector width.
 */
.data-disclosure {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--warning, #d97706);
  border-radius: var(--radius-sm, 4px);
  background: color-mix(in srgb, var(--warning, #d97706) 8%, transparent);
  color: var(--text-primary);
  font-size: var(--font-md);
  line-height: 1.5;
  overflow-wrap: break-word;
}

/*
 * Body text, for the same reason the notice above is. This is the only warning
 * a customer gets before a model they chose months ago stops answering, and the
 * usual treatment for such a thing — muted micro-copy under a form control — is
 * indistinguishable from a hint nobody needs to read. It wraps and is never
 * clamped, so the date and the countdown both survive a narrow selector.
 */
.retirement-notice {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--warning, #d97706);
  border-radius: var(--radius-sm, 4px);
  background: color-mix(in srgb, var(--warning, #d97706) 8%, transparent);
  color: var(--text-primary);
  font-size: var(--font-md);
  line-height: 1.5;
  overflow-wrap: break-word;
}
</style>
