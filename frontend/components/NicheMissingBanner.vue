<template>
  <section v-if="show" class="niche-missing-banner" role="region" aria-labelledby="formula-prompt-title">
    <span class="nmb-icon" aria-hidden="true">🎙️</span>
    <div class="nmb-body">
      <strong id="formula-prompt-title">Choose this channel's Series Formula.</strong>
      <span class="nmb-detail">
        This channel has not chosen one yet, so ideas, scripts and metadata use generic generation
        with no repeatable hook or title grammar. Pick a Formula below, or choose Generic deliberately.
        A Formula never decides or locks an episode's scene rhythm — that stays an episode choice in Scene Plan.
      </span>

      <p v-if="suggestedNiche && suggestion" class="nmb-suggestion">
        <strong>Suggested: {{ displayName(suggestedNiche) }}</strong>
        <span>{{ suggestion.reason }}</span>
      </p>

      <div class="nmb-picker">
        <NichePicker v-model="selectedId" :allow-empty="false" :disabled="saving" />
        <button
          type="button"
          class="btn btn-sm btn-primary"
          :disabled="!selectedId || saving"
          @click="applySelected"
        >{{ saving ? 'Saving…' : 'Use this Formula' }}</button>
      </div>

      <p v-if="suggestion && !suggestedNiche" class="nmb-note">
        The suggested Formula is not installed on this Mac yet. Choose another Formula here, or install it from the Content Store.
      </p>
      <p v-else-if="!suggestion" class="nmb-note">
        No automatic match — choose the Formula that fits this channel.
      </p>
      <p v-if="saveError" class="nmb-error" role="alert">{{ saveError }}</p>
    </div>

    <div class="nmb-actions">
      <button
        v-if="suggestedNiche && suggestion"
        type="button"
        class="btn btn-sm btn-primary nmb-action"
        :disabled="saving"
        @click="applyFormula(suggestion.formulaId)"
      >Use {{ displayName(suggestedNiche) }}</button>
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="saving"
        @click="chooseGeneric"
      >Generic — no Formula</button>
      <NuxtLink :to="`/projects/${slug}/settings#channel`" class="nmb-link">
        Open Channel Settings
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useProject } from '~/composables/useProject'
import { suggestFormulaForChannel } from '~/utils/formula-suggestion'

const props = defineProps<{
  slug: string
  /** The project's saved Formula id. Empty / undefined → no Formula set. */
  nicheId?: string | null
  /** 'selected' / 'generic' once chosen; absent = never chose. */
  formulaChoice?: 'selected' | 'generic' | null
  /** The channel's display name, used only for a suggestion. */
  name?: string | null
}>()

const { find, refresh, setProjectNiche } = useNiches()
const { loadProject } = useProject()

const selectedId = ref('')
const saving = ref(false)
const saveError = ref('')

// Non-dismissable until chosen (owner ruling, 2026-10-25). A channel that
// deliberately chose Generic is settled and sees nothing; a channel that never
// chose sees this every time until it does.
const show = computed(() => (
  !!props.slug
  && !props.nicheId
  && props.formulaChoice !== 'generic'
))

const suggestion = computed(() => suggestFormulaForChannel({ slug: props.slug, name: props.name }))
// A suggestion whose pack is not installed is not a button the customer can
// use, so it is treated as no suggestion rather than shown as a dead end.
const suggestedNiche = computed(() => (
  suggestion.value ? find(suggestion.value.formulaId) : undefined
))

function displayName(niche: { catalogName?: string; name: string }): string {
  return niche.catalogName || niche.name
}

function errorMessage(error: any): string {
  return error?.data?.detail || error?.message || 'Could not save the Series Formula.'
}

async function applyFormula(id: string): Promise<void> {
  if (!id || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    await setProjectNiche(props.slug, id)
    await loadProject(props.slug)
  } catch (error: any) {
    saveError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

async function applySelected(): Promise<void> {
  await applyFormula(selectedId.value)
}

async function chooseGeneric(): Promise<void> {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    // Records the deliberate choice, so this prompt does not return.
    await setProjectNiche(props.slug, null, [], 'generic')
    await loadProject(props.slug)
  } catch (error: any) {
    saveError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  // The shared list loads once per session; this prompt re-reads it so a
  // Formula installed since then can be chosen.
  void refresh()
})
</script>

<style scoped>
.niche-missing-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--warning, #d8a23c);
  border-radius: var(--radius-md, 6px);
  background: var(--warning-dim, rgba(216, 162, 60, 0.1));
  font-size: 13px;
  color: var(--text-primary);
}

.nmb-icon { font-size: 18px; line-height: 1; }

.nmb-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.nmb-detail {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.nmb-suggestion {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm, 4px);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.nmb-suggestion span { color: var(--text-secondary); }

.nmb-picker {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.nmb-picker :deep(.niche-picker) { flex: 1; min-width: 0; }
.nmb-picker > button { flex-shrink: 0; margin-top: 22px; }

.nmb-note { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }
.nmb-error { margin: 0; color: var(--error); font-size: var(--font-xs); }

.nmb-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.nmb-action { white-space: nowrap; }
.nmb-link { color: var(--text-secondary); font-size: var(--font-xs); text-decoration: underline; white-space: nowrap; }
.nmb-link:hover { color: var(--text-primary); }

@media (max-width: 560px) {
  .niche-missing-banner {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px 10px;
  }

  .nmb-icon { grid-column: 1; grid-row: 1; margin-top: 2px; }
  .nmb-body { grid-column: 2; grid-row: 1; }
  .nmb-actions {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: stretch;
  }
  .nmb-picker { flex-direction: column; }
  .nmb-picker > button { width: 100%; margin-top: 0; }
}
</style>
