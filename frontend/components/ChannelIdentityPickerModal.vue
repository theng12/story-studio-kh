<template>
  <Modal
    :visible="visible"
    size="xxl"
    labelledby="channel-identity-picker-title"
    dialog-class="channel-identity-dialog modal-flush"
    @close="close"
  >
    <div class="identity-shell">
      <header class="identity-header">
        <div>
          <h2 id="channel-identity-picker-title">Choose Formula &amp; Topic Packs</h2>
          <p>Set the repeatable episode promise, then choose the subjects it can explore.</p>
        </div>
        <button type="button" class="identity-close" aria-label="Close channel identity library" :disabled="saving" @click="close">×</button>
      </header>

      <div class="identity-tabs" role="group" aria-label="Channel identity library">
        <button type="button" :aria-pressed="activeShelf === 'formula'" :class="{ active: activeShelf === 'formula' }" @click="activeShelf = 'formula'">
          Formula <span>{{ draftFormulaName }}</span>
        </button>
        <button type="button" :aria-pressed="activeShelf === 'topics'" :class="{ active: activeShelf === 'topics' }" @click="activeShelf = 'topics'">
          Topic Packs <span>{{ draftTopicIds.length }} selected</span>
        </button>
      </div>

      <div class="identity-tools">
        <label class="identity-search">
          <span aria-hidden="true">⌕</span>
          <input ref="searchInput" v-model="query" type="search" :aria-label="activeShelf === 'formula' ? 'Search Formulas' : 'Search Topic Packs'" :placeholder="activeShelf === 'formula' ? 'Search formulas, families, audiences…' : 'Search packs, subjects, coverage…'" />
        </label>
        <select v-model="categoryFilter" class="select identity-category" :aria-label="activeShelf === 'formula' ? 'Formula family' : 'Topic category'">
          <option value="all">All {{ activeShelf === 'formula' ? 'families' : 'categories' }}</option>
          <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
        </select>
      </div>

      <div class="identity-source-filters" aria-label="Library source">
        <button
          v-for="filter in sourceFilters"
          :key="filter.id"
          type="button"
          :class="{ active: sourceFilter === filter.id }"
          @click="sourceFilter = filter.id"
        >{{ filter.label }} <span>{{ filter.count }}</span></button>
      </div>

      <div v-if="removedTopicNames.length" class="identity-notice" role="status">
        <strong>Formula compatibility updated the draft.</strong>
        Removed {{ removedTopicNames.join(', ') }} because {{ draftFormulaName }} does not support {{ removedTopicNames.length === 1 ? 'that pack' : 'those packs' }}.
      </div>
      <div v-if="loadError && activeItems.length" class="identity-catalog-error" role="alert">
        Library refresh failed: {{ loadError }}
        <button type="button" class="btn btn-ghost btn-sm" @click="refreshCatalogs">Try Again</button>
      </div>

      <div class="identity-workspace">
        <section ref="libraryPanel" class="identity-library" tabindex="-1" :aria-label="activeShelf === 'formula' ? 'Formula shelf' : 'Topic Pack shelf'">
          <div v-if="loading && !activeItems.length" class="identity-state" aria-live="polite">
            <strong>Loading the library…</strong><span>Installed Content Packs will appear here.</span>
          </div>
          <div v-else-if="loadError && !activeItems.length" class="identity-state identity-error" role="alert">
            <strong>The Channel Identity library is unavailable</strong>
            <span>{{ loadError }}</span>
            <button type="button" class="btn btn-secondary btn-sm" @click="refreshCatalogs">Try Again</button>
          </div>

          <template v-else-if="activeShelf === 'formula'">
            <button type="button" class="identity-none" :class="{ selected: !draftFormulaId }" :disabled="saving" @click="selectFormula('')">
              <span><strong>No Formula</strong><small>Use general generation without a repeatable channel structure.</small></span>
              <span class="identity-check">{{ !draftFormulaId ? 'Selected' : 'Choose' }}</span>
            </button>
            <div class="identity-card-list" role="list" aria-label="Series Formulas">
              <article
                v-for="formula in filteredFormulas"
                :key="formula.id"
                class="identity-card"
                :class="{ selected: draftFormulaId === formula.id, unavailable: isUnavailable(formula) }"
              >
                <div class="identity-card-heading">
                  <h3>{{ formulaName(formula) }}</h3>
                  <span class="identity-source">{{ sourceLabel(formula) }}</span>
                </div>
                <p>{{ formula.description || 'Details are unavailable for this saved Formula.' }}</p>
                <div class="identity-card-meta">
                  <span>{{ formula.formulaFamily || 'General' }}</span>
                  <span v-if="formula.catalog?.version">v{{ formula.catalog.version }}</span>
                  <span v-if="draftFormulaId === formula.id" class="identity-selected-label">Selected</span>
                </div>
                <div class="identity-card-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="focusFormula(formula, $event)">View Details</button>
                  <button type="button" class="btn btn-secondary btn-sm" :disabled="saving || isUnavailable(formula)" @click="selectFormula(formula.id)">
                    {{ draftFormulaId === formula.id ? 'Selected' : 'Choose Formula' }}
                  </button>
                </div>
              </article>
              <div v-if="!filteredFormulas.length" class="identity-state"><strong>No formulas found</strong><span>Try a broader search or another source.</span></div>
            </div>
          </template>

          <template v-else>
            <div class="topic-scope-row">
              <div class="identity-segmented" role="group" aria-label="Topic Pack compatibility filter">
                <button type="button" :class="{ active: topicScope === 'compatible' }" @click="topicScope = 'compatible'">Compatible</button>
                <button type="button" :class="{ active: topicScope === 'all' }" @click="topicScope = 'all'">All Library</button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="saving || !draftTopicIds.length" @click="draftTopicIds = []">Choose No Topic Packs</button>
            </div>
            <div class="identity-card-list" role="list" aria-label="Topic Packs">
              <article
                v-for="pack in filteredTopics"
                :key="pack.id"
                class="identity-card"
                :class="{ selected: draftTopicIds.includes(pack.id), incompatible: !isCompatible(pack), unavailable: isUnavailable(pack) }"
              >
                <div class="identity-card-heading">
                  <h3>{{ pack.name }}</h3>
                  <span class="identity-source">{{ sourceLabel(pack) }}</span>
                </div>
                <p>{{ pack.description || 'Details are unavailable for this saved Topic Pack.' }}</p>
                <div class="identity-card-meta">
                  <span>{{ topicCategory(pack) }}</span>
                  <span v-if="pack.catalog?.version">v{{ pack.catalog.version }}</span>
                  <span>{{ pack.subjects.length }} subjects</span>
                </div>
                <span v-if="!draftFormulaId" class="identity-reason">Choose a Formula before adding Topic Packs.</span>
                <span v-else-if="!isCompatible(pack)" class="identity-reason">Compatible with {{ compatibleFormulaNames(pack).join(', ') || 'another Formula' }}</span>
                <div class="identity-card-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="focusTopic(pack, $event)">View Details</button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="saving || (!draftTopicIds.includes(pack.id) && (isUnavailable(pack) || !isCompatible(pack)))"
                    @click="toggleTopic(pack)"
                  >{{ draftTopicIds.includes(pack.id) ? 'Remove Pack' : 'Add Pack' }}</button>
                </div>
              </article>
              <div v-if="!filteredTopics.length" class="identity-state">
                <strong>{{ topicScope === 'compatible' ? 'No compatible Topic Packs found' : 'No Topic Packs found' }}</strong>
                <span>{{ topicScope === 'compatible' ? 'Use All library to inspect packs made for other Formulas.' : 'Try a broader search or another source.' }}</span>
              </div>
            </div>
          </template>
        </section>

        <aside ref="detailPanel" class="identity-detail" tabindex="-1" aria-live="polite">
          <button type="button" class="identity-back btn btn-ghost btn-sm" @click="returnToChoices">← Back to Choices</button>
          <template v-if="activeShelf === 'formula' && focusedFormula">
            <div class="identity-detail-head"><div><span>{{ focusedFormula.formulaFamily || 'Formula' }}</span><h3>{{ formulaName(focusedFormula) }}</h3></div><span class="identity-source">{{ sourceLabel(focusedFormula) }}</span></div>
            <p>{{ focusedFormula.description }}</p>
            <dl>
              <div><dt>Audience</dt><dd>{{ focusedFormula.audienceHint || 'Not specified' }}</dd></div>
              <div><dt>Title style</dt><dd>{{ formulaTitleStyle(focusedFormula) }}</dd></div>
              <div><dt>Script structure</dt><dd>{{ focusedFormula.scriptContext || focusedFormula.scriptSystemPromptRole || 'Not specified' }}</dd></div>
              <div><dt>Duration</dt><dd>{{ formulaDuration(focusedFormula) }}</dd></div>
              <div><dt>Chapter range</dt><dd>{{ formulaChapterRange(focusedFormula) }}</dd></div>
              <div><dt>Voice</dt><dd>{{ formulaVoices(focusedFormula) }}</dd></div>
            </dl>
            <div v-if="focusedFormula.exampleTopics?.length" class="identity-detail-list"><strong>Examples</strong><ul><li v-for="topic in focusedFormula.exampleTopics.slice(0, 8)" :key="topic">{{ topic }}</li></ul></div>
            <p v-if="pinDifference(focusedFormula)" class="identity-pin">Library has v{{ focusedFormula.catalog?.version }}. Project uses v{{ pinDifference(focusedFormula) }}.</p>
          </template>
          <template v-else-if="activeShelf === 'topics' && focusedTopic">
            <div class="identity-detail-head"><div><span>{{ topicCategory(focusedTopic) }}</span><h3>{{ focusedTopic.name }}</h3></div><span class="identity-source">{{ sourceLabel(focusedTopic) }}</span></div>
            <p>{{ focusedTopic.description }}</p>
            <dl>
              <div><dt>Subjects</dt><dd>{{ focusedTopic.subjects.length }}</dd></div>
              <div><dt>Coverage</dt><dd>{{ coverageLabel(focusedTopic) }}</dd></div>
              <div><dt>Planning limit</dt><dd>{{ capacityLabel(focusedTopic) }}</dd></div>
              <div><dt>Compatibility</dt><dd>{{ compatibleFormulaNames(focusedTopic).join(', ') || 'Any Formula' }}</dd></div>
            </dl>
            <div v-if="focusedTopic.subjects.length" class="identity-detail-list"><strong>Actual subjects</strong><ul><li v-for="subject in focusedTopic.subjects" :key="subject">{{ subject }}</li></ul></div>
            <p v-if="pinDifference(focusedTopic)" class="identity-pin">Library has v{{ focusedTopic.catalog?.version }}. Project uses v{{ pinDifference(focusedTopic) }}.</p>
          </template>
          <div v-else class="identity-detail-empty"><strong>Select a card to inspect it</strong><span>Details include structure, capacity, compatibility, and project version pins.</span></div>
        </aside>
      </div>

      <footer class="identity-footer">
        <div class="identity-summary"><span>Draft selection</span><strong>{{ draftFormulaName }} · {{ draftTopicLabel }}</strong></div>
        <p v-if="saveError" class="identity-save-error" role="alert">{{ saveError }}</p>
        <div class="identity-actions">
          <button type="button" class="btn btn-secondary" :disabled="saving" @click="close">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : actionLabel }}</button>
        </div>
      </footer>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import type { Niche, TopicPack } from '~/composables/useNiches'

type CatalogItem = Niche | TopicPack
type SourceFilter = 'all' | 'signed-installed' | 'signed-recovery' | 'legacy-builtin' | 'legacy-user-fork'

const props = withDefaults(defineProps<{
  visible: boolean
  projectSlug: string
  selectedFormulaId?: string
  selectedTopicPackIds?: string[]
  projectContentPackVersions?: Record<string, string>
  actionLabel?: string
}>(), {
  selectedFormulaId: '',
  selectedTopicPackIds: () => [],
  projectContentPackVersions: () => ({}),
  actionLabel: 'Apply to channel',
})

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'saved', value: { formulaId: string; topicPackIds: string[] }): void
}>()

const { niches, isLoading: formulasLoading, error: formulasError, refresh: refreshFormulas, setProjectNiche } = useNiches()
const { topicPacks, isLoading: topicsLoading, error: topicsError, refresh: refreshTopics } = useTopicPacks()
const activeShelf = ref<'formula' | 'topics'>('formula')
const query = ref('')
const sourceFilter = ref<SourceFilter>('all')
const categoryFilter = ref('all')
const topicScope = ref<'compatible' | 'all'>('compatible')
const draftFormulaId = ref('')
const draftTopicIds = ref<string[]>([])
const focusedFormulaId = ref('')
const focusedTopicId = ref('')
const removedTopicNames = ref<string[]>([])
const saving = ref(false)
const saveError = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const libraryPanel = ref<HTMLElement | null>(null)
const detailPanel = ref<HTMLElement | null>(null)
const detailTrigger = ref<HTMLElement | null>(null)

const loading = computed(() => formulasLoading.value || topicsLoading.value)
const loadError = computed(() => formatError(formulasError.value || topicsError.value))
const unavailableFormula = computed<Niche | null>(() => draftFormulaId.value && !niches.value.some(item => item.id === draftFormulaId.value) ? {
  id: draftFormulaId.value, name: draftFormulaId.value, description: '', builtin: false, schemaVersion: 1, exampleTopics: [],
} : null)
const unavailableTopics = computed<TopicPack[]>(() => draftTopicIds.value
  .filter(id => !topicPacks.value.some(item => item.id === id))
  .map(id => ({ id, name: id, description: '', builtin: false, schemaVersion: 1, compatibleNicheIds: [], subjects: [] })))
const allFormulas = computed(() => unavailableFormula.value ? [unavailableFormula.value, ...niches.value] : niches.value)
const allTopics = computed(() => [...unavailableTopics.value, ...topicPacks.value])
const activeItems = computed<CatalogItem[]>(() => activeShelf.value === 'formula' ? allFormulas.value : allTopics.value)
const focusedFormula = computed(() => allFormulas.value.find(item => item.id === focusedFormulaId.value) || allFormulas.value.find(item => item.id === draftFormulaId.value) || null)
const focusedTopic = computed(() => allTopics.value.find(item => item.id === focusedTopicId.value) || allTopics.value.find(item => draftTopicIds.value.includes(item.id)) || null)
const draftFormulaName = computed(() => allFormulas.value.find(item => item.id === draftFormulaId.value)?.catalogName || allFormulas.value.find(item => item.id === draftFormulaId.value)?.name || 'No Formula')
const draftTopicLabel = computed(() => draftTopicIds.value.length ? `${draftTopicIds.value.length} Topic Pack${draftTopicIds.value.length === 1 ? '' : 's'}` : 'No Topic Packs')
const categories = computed(() => Array.from(new Set(activeShelf.value === 'formula'
  ? allFormulas.value.map(item => item.formulaFamily || 'General')
  : allTopics.value.map(topicCategory))).sort())
const sourceFilters = computed(() => {
  const items = activeItems.value
  const options: Array<{ id: SourceFilter; label: string }> = [
    { id: 'all', label: 'All sources' }, { id: 'signed-installed', label: 'Installed' },
    { id: 'signed-recovery', label: 'Included' }, { id: 'legacy-builtin', label: 'Built in' },
    { id: 'legacy-user-fork', label: 'Custom' },
  ]
  return options.map(option => ({ ...option, count: option.id === 'all' ? items.length : items.filter(item => sourceOf(item) === option.id).length }))
})

const filteredFormulas = computed(() => allFormulas.value.filter((formula) => {
  const selected = draftFormulaId.value === formula.id
  if (!passesSharedFilters(formula, formula.formulaFamily || 'General', selected)) return false
  if (selected) return true
  return matchesQuery([formulaName(formula), formula.description, formula.formulaFamily, formula.audienceHint, formula.scriptContext, ...(formula.exampleTopics || [])])
}))
const filteredTopics = computed(() => allTopics.value.filter((pack) => {
  if (topicScope.value === 'compatible' && !isCompatible(pack) && !draftTopicIds.value.includes(pack.id)) return false
  const selected = draftTopicIds.value.includes(pack.id)
  if (!passesSharedFilters(pack, topicCategory(pack), selected)) return false
  if (selected) return true
  return matchesQuery([pack.name, pack.description, ...(pack.subjects || []), ...(pack.tags || [])])
}))

watch(() => props.visible, async (visible) => {
  if (!visible) return
  draftFormulaId.value = props.selectedFormulaId
  draftTopicIds.value = [...props.selectedTopicPackIds]
  focusedFormulaId.value = props.selectedFormulaId
  focusedTopicId.value = props.selectedTopicPackIds[0] || ''
  activeShelf.value = 'formula'
  query.value = ''
  categoryFilter.value = 'all'
  removedTopicNames.value = []
  saveError.value = ''
  await refreshCatalogs()
  if (!props.visible) return
  chooseDefaultSource()
  await nextTick()
  await nextTick()
  if (!props.visible) return
  searchInput.value?.focus({ preventScroll: true })
}, { immediate: true })
watch(activeShelf, () => {
  query.value = ''
  categoryFilter.value = 'all'
  chooseDefaultSource()
})

async function refreshCatalogs(): Promise<void> {
  await Promise.all([refreshFormulas(), refreshTopics()])
}
function chooseDefaultSource(): void {
  sourceFilter.value = activeItems.value.some(item => sourceOf(item) === 'signed-installed') ? 'signed-installed' : 'all'
}
function sourceOf(item: CatalogItem): SourceFilter {
  return item.catalog?.source || (item.builtin ? 'legacy-builtin' : 'legacy-user-fork')
}
function sourceLabel(item: CatalogItem): string {
  if (isUnavailable(item)) return 'Unavailable saved selection'
  return ({ 'signed-installed': 'Installed', 'signed-recovery': 'Included', 'legacy-builtin': 'Built in', 'legacy-user-fork': 'Custom' } as const)[sourceOf(item)]
}
function formulaName(formula: Niche): string { return formula.catalogName || formula.name }
function topicCategory(pack: TopicPack): string { return pack.tags?.[0] || 'Topic Pack' }
function matchesQuery(values: Array<string | undefined>): boolean {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = values.filter(Boolean).join(' ').toLowerCase()
  return terms.every(term => haystack.includes(term))
}
function passesSharedFilters(item: CatalogItem, category: string, selected: boolean): boolean {
  if (selected) return true
  if (categoryFilter.value !== 'all' && categoryFilter.value !== category) return false
  return sourceFilter.value === 'all' || sourceOf(item) === sourceFilter.value
}
function isUnavailable(item: CatalogItem): boolean {
  return !item.description && !item.catalog && !item.builtin
}
function compatibilityIds(pack: TopicPack): string[] {
  return [...new Set([...(pack.compatibleFormulaIds || []), ...(pack.compatibleNicheIds || [])])]
}
function isCompatible(pack: TopicPack, formulaId = draftFormulaId.value): boolean {
  const ids = compatibilityIds(pack)
  return !!formulaId && (!ids.length || ids.includes(formulaId))
}
function compatibleFormulaNames(pack: TopicPack): string[] {
  return compatibilityIds(pack).map(id => allFormulas.value.find(formula => formula.id === id)?.catalogName || allFormulas.value.find(formula => formula.id === id)?.name || id)
}
function isNarrow(): boolean { return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 780px)').matches }
async function revealDetails(trigger: EventTarget | null): Promise<void> {
  if (!isNarrow()) return
  detailTrigger.value = trigger instanceof HTMLElement ? trigger : null
  await nextTick()
  detailPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  detailPanel.value?.focus({ preventScroll: true })
}
function focusFormula(formula: Niche, event: Event): void { focusedFormulaId.value = formula.id; void revealDetails(event.currentTarget) }
function focusTopic(pack: TopicPack, event: Event): void { focusedTopicId.value = pack.id; void revealDetails(event.currentTarget) }
function returnToChoices(): void {
  const focusTarget = detailTrigger.value?.isConnected ? detailTrigger.value : libraryPanel.value
  focusTarget?.scrollIntoView({ behavior: 'smooth', block: detailTrigger.value?.isConnected ? 'center' : 'start' })
  focusTarget?.focus({ preventScroll: true })
}
function selectFormula(id: string): void {
  if (saving.value || id === draftFormulaId.value) return
  const topicNames = new Map(allTopics.value.map(pack => [pack.id, pack.name]))
  const removedIds = id
    ? draftTopicIds.value.filter(topicId => {
        const pack = topicPacks.value.find(candidate => candidate.id === topicId)
        return !!pack && !isCompatible(pack, id)
      })
    : [...draftTopicIds.value]
  draftTopicIds.value = draftTopicIds.value.filter(topicId => !removedIds.includes(topicId))
  removedTopicNames.value = removedIds.map(topicId => topicNames.get(topicId) || topicId)
  draftFormulaId.value = id
  focusedFormulaId.value = id
}
function toggleTopic(pack: TopicPack): void {
  if (saving.value) return
  const selected = draftTopicIds.value.includes(pack.id)
  if (!selected && (!isCompatible(pack) || isUnavailable(pack))) return
  draftTopicIds.value = selected ? draftTopicIds.value.filter(id => id !== pack.id) : [...draftTopicIds.value, pack.id]
  focusedTopicId.value = pack.id
}
function formulaTitleStyle(formula: Niche): string {
  return formula.titleShapeRules?.join(' · ') || formula.metadataTitleStyleHint || formula.metadataProfile?.description || 'Not specified'
}
function formulaDuration(formula: Niche): string {
  const structure = formula.scriptStructure
  // 1.4.369 — a short-form Formula states its length in seconds (Quote
  // Shorts: 10–60 s); a whole-minute figure next to its prose would contradict it.
  if (structure?.lengthSecondsRange) return `${structure.lengthSecondsRange[0]}–${structure.lengthSecondsRange[1]} seconds`
  if (typeof structure?.defaultLengthSeconds === 'number') return `${structure.defaultLengthSeconds} seconds`
  if (structure?.lengthMinutesRange) return `${structure.lengthMinutesRange[0]}–${structure.lengthMinutesRange[1]} minutes`
  return structure?.defaultLengthMinutes ? `${structure.defaultLengthMinutes} minutes` : 'Not specified'
}
function formulaChapterRange(formula: Niche): string {
  const structure = formula.scriptStructure
  if (structure?.chapterCountRange) return `${structure.chapterCountRange[0]}–${structure.chapterCountRange[1]} chapters`
  return structure?.defaultChapterCount ? `${structure.defaultChapterCount} chapters` : 'Not specified'
}
function formulaVoices(formula: Niche): string {
  return formula.narratorStyles?.map(voice => voice.label).join(', ') || formula.openingProfile?.label || 'Not specified'
}
function coverageLabel(pack: TopicPack): string {
  if (!pack.coverageProfiles?.length) return pack.ideaAxes?.map(axis => `${axis.label}: ${axis.values.length}`).join(' · ') || 'Not declared'
  return pack.coverageProfiles.map(profile => `${profile.label || profile.id || 'Profile'} (${profile.tuple_count ?? profile.tuples?.length ?? 0} angles)`).join(' · ')
}
function capacityLabel(pack: TopicPack): string {
  if (pack.maxSiblingsPerSubject === undefined) return 'Not declared'
  return `Up to ${pack.maxSiblingsPerSubject} episode${pack.maxSiblingsPerSubject === 1 ? '' : 's'} per subject. Available plans depend on coverage and saved history.`
}
function pinDifference(item: CatalogItem): string {
  const catalog = item.catalog
  if (!catalog?.pack_id || !catalog.version) return ''
  const pinned = props.projectContentPackVersions[catalog.pack_id]
  return pinned && pinned !== catalog.version ? pinned : ''
}
function formatError(error: any): string { return error?.data?.detail || error?.message || (error ? String(error) : '') }
function close(): void { if (!saving.value) emit('close') }
async function save(): Promise<void> {
  if (saving.value) return
  const savedFormulaId = draftFormulaId.value
  const savedTopicIds = [...draftTopicIds.value]
  saving.value = true
  saveError.value = ''
  try {
    await setProjectNiche(props.projectSlug, savedFormulaId || null, savedTopicIds)
    emit('saved', { formulaId: savedFormulaId, topicPackIds: savedTopicIds })
    emit('close')
  } catch (error: any) {
    saveError.value = formatError(error) || 'Could not save Channel Identity. Try again.'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.identity-shell { display: flex; height: min(820px, calc(100dvh - 48px)); min-height: 560px; flex-direction: column; background: var(--bg-secondary); color: var(--text-primary); }
.identity-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 24px 16px; }
.identity-header h2 { margin: 0 0 5px; font-size: 25px; letter-spacing: -.025em; }
.identity-header p { max-width: 68ch; margin: 0; color: var(--text-secondary); font-size: 13px; }
.identity-close { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 50%; background: var(--bg-tertiary); color: var(--text-secondary); cursor: pointer; font-size: 22px; line-height: 1; }
.identity-close:hover { border-color: var(--accent); color: var(--text-primary); }
.identity-close:focus-visible, .identity-tabs button:focus-visible, .identity-source-filters button:focus-visible, .identity-segmented button:focus-visible, .identity-none:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.identity-tabs { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid var(--border); }
.identity-tabs button { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; }
.identity-tabs button.active { border-bottom-color: var(--accent); color: var(--text-primary); }
.identity-tabs span { color: var(--text-muted); font-size: var(--font-xs); font-weight: 500; }
.identity-tools { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 10px; padding: 14px 24px 10px; }
.identity-search { display: flex; min-height: 42px; align-items: center; gap: 9px; padding: 0 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); color: var(--text-muted); }
.identity-search:focus-within { border-color: var(--accent); box-shadow: var(--focus-ring); }
.identity-search input { width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; }
.identity-category { min-width: 0; }
.identity-source-filters { display: flex; gap: 6px; overflow-x: auto; padding: 0 24px 12px; scrollbar-width: thin; }
.identity-source-filters button, .identity-segmented button { flex: 0 0 auto; padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-xs); }
.identity-source-filters button.active, .identity-segmented button.active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); color: var(--accent); }
.identity-source-filters span { margin-left: 4px; color: var(--text-muted); }
.identity-notice { margin: 0 24px 12px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--warning) 8%, var(--bg-secondary)); color: var(--text-secondary); font-size: var(--font-xs); }
.identity-notice strong { color: var(--text-primary); }
.identity-catalog-error { display: flex; align-items: center; gap: 8px; margin: 0 24px 12px; color: var(--error); font-size: var(--font-xs); }
.identity-workspace { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 1.65fr) minmax(280px, .85fr); border-top: 1px solid var(--border); }
.identity-library, .identity-detail { min-height: 0; overflow-y: auto; padding: 16px 18px 18px 24px; scrollbar-width: thin; }
.identity-detail { border-left: 1px solid var(--border); background: var(--bg-primary); padding-right: 24px; }
.identity-none { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; padding: 11px 13px; border: 1px dashed var(--border-light); border-radius: 11px; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }
.identity-none.selected { border-style: solid; border-color: var(--accent); background: var(--accent-dim); }
.identity-none span:first-child { display: grid; gap: 2px; }
.identity-none small { color: var(--text-muted); }
.identity-check { color: var(--accent); font-size: var(--font-xs); font-weight: 800; }
.topic-scope-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.identity-segmented { display: flex; gap: 5px; }
.identity-card-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-content: start; }
.identity-card { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-primary); transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease; }
.identity-card:hover { transform: translateY(-1px); border-color: var(--border-light); box-shadow: 0 10px 24px rgba(0, 0, 0, .14); }
.identity-card.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.identity-card.incompatible:not(.selected), .identity-card.unavailable { opacity: .62; }
.identity-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.identity-card h3 { margin: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.35; }
.identity-source { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.identity-card > p { display: -webkit-box; min-height: 34px; margin: 0; overflow: hidden; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.identity-card-meta { display: flex; flex-wrap: wrap; gap: 5px 10px; color: var(--text-muted); font-size: var(--font-xs); }
.identity-selected-label { color: var(--accent); font-weight: 800; }
.identity-reason { color: var(--warning); font-size: var(--font-xs); line-height: 1.35; }
.identity-card-actions { display: flex; align-items: center; gap: 6px; margin-top: auto; }
.identity-back { display: none; margin-bottom: 8px; }
.identity-state { grid-column: 1 / -1; display: flex; min-height: 180px; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--text-muted); text-align: center; }
.identity-state strong { color: var(--text-primary); }
.identity-error span, .identity-save-error { color: var(--error); }
.identity-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.identity-detail-head div > span { color: var(--accent); font-size: var(--font-xs); font-weight: 750; }
.identity-detail h3 { margin: 3px 0 0; font-size: 18px; }
.identity-detail > p { color: var(--text-secondary); font-size: 12px; line-height: 1.55; }
.identity-detail dl { display: grid; gap: 0; margin: 14px 0; }
.identity-detail dl div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); font-size: var(--font-xs); }
.identity-detail dt { color: var(--text-muted); }
.identity-detail dd { margin: 0; color: var(--text-primary); line-height: 1.45; }
.identity-detail-list { display: grid; gap: 7px; }
.identity-detail-list strong { font-size: 12px; }
.identity-detail-list ul { display: flex; max-height: 180px; flex-wrap: wrap; gap: 5px; overflow-y: auto; margin: 0; padding: 0; list-style: none; scrollbar-width: thin; }
.identity-detail-list li { padding: 4px 7px; border-radius: 7px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-xs); }
.identity-pin { padding: 9px; border-radius: 8px; background: var(--accent-dim); color: var(--accent) !important; }
.identity-detail-empty { display: flex; min-height: 100%; align-items: center; justify-content: center; flex-direction: column; gap: 5px; color: var(--text-muted); text-align: center; }
.identity-detail-empty strong { color: var(--text-primary); }
.identity-footer { display: flex; align-items: center; gap: 14px; padding: 14px 24px; border-top: 1px solid var(--border); background: var(--bg-secondary); }
.identity-summary { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.identity-summary span { color: var(--text-muted); font-size: var(--font-xs); }
.identity-summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.identity-save-error { flex: 1; margin: 0; font-size: var(--font-xs); text-align: right; }
.identity-actions { display: flex; flex: 0 0 auto; gap: 8px; }
@media (max-width: 780px) {
  .identity-shell { height: calc(100dvh - 24px); min-height: 0; }
  .identity-header { padding: 18px 18px 14px; }
  .identity-tools { grid-template-columns: 1fr; padding-inline: 18px; }
  .identity-source-filters, .identity-tabs { padding-inline: 18px; }
  .identity-workspace { display: block; overflow-y: auto; }
  .identity-library, .identity-detail { overflow: visible; padding: 14px 18px; }
  .identity-detail { border-top: 1px solid var(--border); border-left: 0; }
  .identity-back { display: inline-flex; }
  .identity-card-list { grid-template-columns: 1fr; }
  .identity-footer { align-items: stretch; flex-wrap: wrap; padding: 12px 18px; }
  .identity-summary { width: 100%; flex-basis: 100%; }
  .identity-save-error { order: 3; flex-basis: 100%; text-align: left; }
  .identity-actions { margin-left: auto; }
}
</style>

<style>
.channel-identity-dialog { overflow: hidden; }
</style>
