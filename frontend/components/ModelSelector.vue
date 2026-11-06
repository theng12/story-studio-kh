<template>
  <div class="form-group">
    <label>
      {{ label || 'LLM model' }}
      <span v-if="loading" class="loading">Loading Gateway catalog…</span>
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
      :catalog-notice="selectionGap"
      :empty-catalog-label="emptyCatalogLabel"
      :catalogue-error="loadError"
      :missing-selection-label="selectionGap ? 'No longer offered' : ''"
      :unverified-selection-label="unverifiedSelectionLabel"
      @update:model-value="selectModel"
    />
    <p v-if="loadError" class="catalog-message">{{ loadError }}</p>
    <p v-if="emptyCatalogNeedsSetup" class="catalog-message">
      No Gateway API Key is configured, so LLM models cannot load.
      <button type="button" class="catalog-action" @click="appSettingsModal.open('connections')">Open Connection Settings</button>
    </p>
    <!-- The saved product is gone from the catalogue. Body text in the flow,
         like the disclosure and retirement notices below it: this is the only
         thing telling the user why the field no longer names a model, and it
         asks them to do something about it. -->
    <p v-if="selectionGap" class="selection-gap">{{ selectionGap }}</p>
    <p v-else-if="appDefaultWritingGone" class="selection-gap" role="status">{{ appDefaultWritingGone }}</p>
    <p v-else-if="!modelValue.trim() && allModels.length && !loading" class="selection-gap">
      Choose a writing model. Story Studio does not pick one for you.
    </p>
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
  describeGenStudioSelectionGap,
  genStudioSelectionGapMessage,
} from '../utils/live-genstudio-model-selection.js'
import { invalidateModelCatalogCache } from '../composables/useApi.js'
import { emptyDefaultModels, normalizeDefaultModels, resolveEffectiveModel } from '../utils/live-genstudio-model-selection.js'
import type { GenStudioLlmCostTier } from '../utils/genstudio-cost-tier.js'
import { describeChatRate } from '../utils/genstudio-credit-cost.js'
import {
  describeRelaxedQueueHint,
  queueClassGroupLabel,
  isRelaxedQueue,
  type RelaxedQueueHint,
} from '../utils/genstudio-relaxed-queue.js'
import { describeModelRetirement, isRetiring } from '../utils/genstudio-model-retirement.js'
import { describeGenStudioAvailability } from '../utils/genstudio-availability.js'
import { unverifiedSelectionLabel as unverifiedLabel } from '../utils/picker-trigger-label.js'
import { isGatewayPoolId, poolsFirst, POOL_GROUP_LABEL, POOL_HINT, POOL_PAID_LAST_RESORT_LABEL } from '../utils/gateway-pool.js'

interface LlmModelRow {
  id: string
  label: string
  provider: 'genstudio'
  provider_name?: string | null
  available: boolean
  availability_reason?: 'daily_quota_depleted' | 'temporary_backpressure' | null
  available_again_at?: string | null
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
  /** Whose maximum that is. Carried through the picker so a surface that shows the
   *  allowance can say whether the model stated it or a worker defaulted it. */
  max_output_tokens_source?: 'provider' | 'model' | 'curated' | 'gateway' | 'worker_default' | 'unknown' | null
  /** Input-side request ceiling, published live by the Gateway when it has one. */
  max_request_tokens?: number
  max_request_tokens_source?: 'provider' | 'model' | 'curated' | 'gateway' | 'worker_default' | 'unknown' | null
  structured_output_mode?: 'json_object' | 'request_json_schema'
  legacy_ids?: string[]
  cost_tier?: GenStudioLlmCostTier
  /** Gateway-published: this model may cost money. */
  chargeable?: boolean
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
  /**
   * A page's own writing model. When it has none and this project moved off the
   * retired LLM lineup, the model kept for it then is filled in (owner, 2026-10-03).
   */
  writingStep?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'model-meta': [value: LlmModelRow | null]
  'user-selected': [value: string]
}>()

const { get } = useApi()
const allModels = ref<LlmModelRow[]>([])
const loading = ref(false)
const loadError = ref('')
type EmptyCatalogState = 'setup' | ''
const emptyCatalogState = ref<EmptyCatalogState>('')
const appSettingsModal = useAppSettingsModal()
const emptyCatalogNeedsSetup = computed(() => emptyCatalogState.value === 'setup')
const emptyCatalogLabel = computed(() => {
  // An empty list from a failed read is not "no models are published" — the
  // dialog must not claim the Gateway offers none when nobody managed to ask.
  if (loadError.value) return ''
  if (emptyCatalogState.value === 'setup') return 'Add a Gateway API Key in Settings to load LLM models.'
  return allModels.value.length === 0 && !loading.value ? 'No LLM models are currently available.' : ''
})
/**
 * The sentence for a saved product that has LEFT the live catalogue, or ''.
 *
 * Authored once in `genStudioSelectionGapMessage` and rendered verbatim on both
 * surfaces this picker owns — under the field, and inside the open menu — so a
 * user who never opens the menu still learns their pin is dead.
 */
const selectionGap = ref('')

/**
 * Names this browser has seen for GenStudio products, persisted across launches.
 *
 * Hydrated (no network) on mount so the very first paint after a cold start
 * already has a name for the saved model, and topped up from every successful
 * catalogue read below.
 *
 * Auto-imported, like `useApi` and every other composable this app uses from a
 * component. An explicit relative import would also work in the app and break
 * the in-process SFC compiler the picker tests run under, which resolves the
 * component's own `../utils/…` imports but has no Nuxt runtime to hand it a
 * composable.
 */
const rememberedNames = useGenStudioModelDisplay()
rememberedNames.hydrate()

/**
 * What the trigger says when the catalogue could not be read at all.
 *
 * This is the failure the picker had no answer for. `loadModels` empties
 * `allModels` on a rejected read and — because there is no catalogue to compare
 * against — deliberately does NOT run the "no longer offered" branch, which
 * would be a lie about a catalogue nobody has seen. That left `ModelMenu` with a
 * `modelValue` and no matching option, and its old last-resort was to render the
 * id itself.
 *
 * The name comes from what this browser remembers, and the parenthetical is not
 * decoration: the app genuinely cannot confirm this product is still published
 * or still priced the way it was, and the customer is entitled to know that
 * before they read the label as settled fact. The money-fence is untouched — a
 * submission against a catalogue we could not read is still refused by the
 * server; this only governs what the control is allowed to SAY.
 */
const unverifiedSelectionLabel = computed(() => unverifiedLabel({
  savedId: props.modelValue,
  catalogueSize: allModels.value.length,
  loading: loading.value,
  rememberedName: rememberedNames.knownName(props.modelValue),
  unknownNoun: 'Saved model',
}))

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
  // Pools first: one choice that already falls back across several models.
  const rows = poolsFirst(eligibleModels).map((model) => {
    const rate = describeChatRate({ ...model, display_name: model.label })
    const pool = isGatewayPoolId(model.id)
    return {
      id: model.id,
      label: model.label,
      // Two shelves, and `queue_class` decides which. A catalogue with no
      // relaxed products yields one group with the heading it has always had.
      // Pools get their own section, listed first.
      group: pool ? POOL_GROUP_LABEL : queueClassGroupLabel(model, 'Language models'),
      // Sent on every relaxed row, rendered once for the section — see
      // `ModelMenu`'s `groupNote`. Empty for a direct row, and empty for a
      // relaxed row on a GenStudio that publishes no hint, which shows the
      // section with no note rather than a note this app made up.
      groupNote: pool ? POOL_HINT : isRelaxedQueue(model) ? describeRelaxedQueueHint(model.relaxed_queue_hint) : '',
      provider: model.provider_name || '',
      price: rate.text,
      priceTitle: rate.title,
      description: model.disabled_reason || model.hint || '',
      disabled: isDisabled(model),
      disabledReason: genStudioModelLockReason(model)
        || describeGenStudioAvailability(model)
        || model.disabled_reason
        || (props.requireVision && !model.supports_vision ? 'This Gateway model does not publish image-input support.' : ''),
      // Scannable in the list, before anything is opened. The sentence itself
      // is rendered in full beneath the selector once the model is chosen — a
      // badge is a signpost, never the disclosure.
      badges: [
        // A chargeable POOL runs on its free members; the Gateway's pool rule uses a paid
        // member only when every free one is out for the day (Dreamlands E2E: the free
        // writing pool read "Paid" although its paid member never fired).
        ...(model.chargeable === true
          ? [pool
              ? { label: POOL_PAID_LAST_RESORT_LABEL, tone: 'info' as const, title: 'Runs on the free models first. A paid model in this pool is used only when every free one is out for the day.' }
              : { label: 'Paid', tone: 'warning' as const, title: 'This writing model may cost money (the gateway marks it paid).' }]
          : []),
        ...(model.discount === true
          ? [{ label: 'Data notice', tone: 'warning' as const, title: model.discount_disclaimer || 'This model carries a data notice from the Gateway.' }]
          : []),
        // Visible while scanning the list, before any row is opened. The date
        // and the countdown ride along as the title; the full sentence is
        // rendered beneath the selector once the model is chosen.
        ...(isRetiring(model)
          ? [{ label: 'Retiring', tone: 'warning' as const, title: describeModelRetirement(model) }]
          : []),
      ],
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
  applyModel(value, true)
}

function applyModel(value: string, userSelected = false): void {
  const model = allModels.value.find(entry => entry.id === value)
  if (!model || isDisabled(model)) return
  emit('update:modelValue', value)
  emit('model-meta', model)
  if (userSelected) emit('user-selected', value)
}

function syncModelSelection(): void {
  const selected = selectLiveGenStudioModel(
    props.modelValue,
    allModels.value,
    props.requireVision === true,
    'llm',
  )
  if (!selected) {
    const saved = props.modelValue.trim()
    const unavailable = allModels.value.find(model => model.id === saved)
    if (saved && unavailable) {
      loadError.value = unavailable.disabled_reason
        || `${unavailable.label} is retired or unavailable. Choose a replacement; Story Studio will not switch products automatically.`
    }
    // The saved product left the catalogue entirely. Until now this fell
    // through in silence — no row to read a `disabled_reason` off, so the
    // branch above said nothing and the menu showed the dead id as though it
    // were still a choice. A pinned id that GenStudio no longer publishes is
    // exactly the case a catalogue dedupe produces, and it must be told to the
    // user rather than discovered when a generation fails.
    //
    // Guarded on a loaded catalogue: an empty `allModels` means the read is
    // still in flight or failed outright, and "no longer offered" would be a
    // lie about a catalogue nobody has seen yet. That failure has its own
    // message in `loadError`.
    //
    // `vanished` ONLY. A product that is still listed but disabled is the
    // branch above, which keeps its own wording — reporting the gap message
    // too would say the same thing twice in two different sentences.
    const gap = allModels.value.length
      ? describeGenStudioSelectionGap(saved, allModels.value, props.requireVision === true)
      : null
    selectionGap.value = gap?.kind === 'vanished' ? genStudioSelectionGapMessage(gap) || '' : ''
    emit('model-meta', null)
    return
  }
  loadError.value = ''
  selectionGap.value = ''
  // Persist the healed value through the owning form. This replaces stale
  // direct-provider defaults (notably GPT-4o) and means they cannot reappear
  // after the next visit.
  if (props.modelValue !== selected.id) emit('update:modelValue', selected.id)
  emit('model-meta', selected)
}

/**
 * A writing page with no model of its own gets the one kept when this project's
 * LLM lineup was retired — the owner's own earlier choice, never one Story picks.
 */
async function fillRetiredLineupChoice(): Promise<void> {
  if (!props.writingStep || props.modelValue.trim()) return
  try {
    const config = await get<{ llm_lineup_migration?: { model?: string } }>(`/projects/${props.projectSlug}/settings/config`)
    const kept = config?.llm_lineup_migration?.model
    if (kept && !props.modelValue.trim()) applyModel(kept)
  } catch { /* nothing kept; the page asks for a choice as usual */ }
}

/**
 * Last of all, the app-wide default from Settings → Default models.
 *
 * Order is the one the setting promises: the page's own saved model (restored by
 * `useRememberedForm` before this runs, or the preset's) wins, then the project's
 * kept lineup choice above, then this. It is READ only — the default is never
 * written into the page's remembered form, so changing it later still reaches
 * every page. A default that has left the catalogue fills nothing and says so.
 */
/**
 * Settings → Default models, read once per mount.
 *
 * Deliberately NOT through the composable: every picker test compiles this SFC in isolation, and a
 * module the harness does not inline fails to resolve. The decision itself is a pure function in
 * `utils/live-genstudio-model-selection.ts` — the same one every other page calls — so this picker
 * and the pages agree by construction.
 */
const appDefaults = ref(emptyDefaultModels())
const appDefaultModel = computed(() => resolveEffectiveModel(
  'writing',
  props.modelValue,
  allModels.value.map(model => model.id),
  appDefaults.value,
))
const appDefaultWritingGone = computed(() => appDefaultModel.value.goneNotice)

async function fillAppDefault(): Promise<void> {
  if (!props.writingStep || props.modelValue.trim()) return
  try {
    appDefaults.value = normalizeDefaultModels(await get('/app-settings/default-models', { cache: 'no-store' }))
  } catch {
    // An unreadable setting is "no default"; the page asks for a choice as usual.
    appDefaults.value = emptyDefaultModels()
  }
  const fallback = appDefaultModel.value.model
  if (!fallback || props.modelValue.trim()) return
  const row = allModels.value.find(model => model.id === fallback)
  if (!row || isDisabled(row)) return
  emit('update:modelValue', fallback)
  emit('model-meta', row)
}

async function identifyEmptyCatalog(): Promise<void> {
  emptyCatalogState.value = ''
  try {
    const keys = await get<{ providers: Array<{ providerId: string; hasKey: boolean }> }>('/app-settings/api-keys', { cache: 'no-store' })
    if (!keys.providers.some(row => row.providerId === 'genstudio' && row.hasKey)) emptyCatalogState.value = 'setup'
  } catch {
    // An unavailable local settings read says nothing about the account. Keep the
    // neutral empty-catalog state instead of sending a person to credentials.
  }
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
  emptyCatalogState.value = ''
  try {
    const models = await get<LlmModelRow[]>(`/models?project=${props.projectSlug}`)
    allModels.value = models
    if (models.length === 0) await identifyEmptyCatalog()
    // Every successful read is a chance to learn a name. The one that matters is
    // the CURRENTLY selected model's: it is what this picker will have to fall
    // back on the next time this read fails.
    rememberedNames.remember(models)
    syncModelSelection()
    await fillRetiredLineupChoice()
    await fillAppDefault()
  } catch (error: any) {
    allModels.value = []
    loadError.value = error?.data?.detail || error?.message || 'Gateway catalog unavailable.'
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
.catalog-action { margin-left: 6px; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.catalog-action:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

/*
 * Same treatment as the two notices below, and for the same reason: a dead pin
 * is not a hint, it is a thing the user must act on before this form can run.
 * Muted micro-copy under a control is how it stayed invisible before.
 */
.selection-gap {
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
