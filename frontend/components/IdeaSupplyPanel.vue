<template>
  <section v-if="supply" class="idea-supply" :data-status="supply.status" aria-label="Idea supply">
    <p class="idea-supply-line">
      <strong>{{ statusLabel }}</strong>
      <span>{{ supply.waiting_ideas }} {{ supply.waiting_ideas === 1 ? 'idea' : 'ideas' }} waiting{{ supply.days_left !== null ? ` (about ${supply.days_left} days at the last 30 days’ pace)` : '' }}</span>
      <span v-if="supply.unused_subjects.kind === 'measured'">· {{ supply.unused_subjects.value }} of {{ supply.unused_subjects.total }} Topic Pack subjects unused ({{ supply.unused_subjects.per_pack.map(pack => `${pack.name} ${pack.unused}`).join(', ') }})</span>
      <span v-else>· {{ supply.unused_subjects.reason }}</span>
      <span v-if="supply.ignored_packs.length">· {{ supply.ignored_packs.length }} selected {{ supply.ignored_packs.length === 1 ? 'pack is' : 'packs are' }} ignored: {{ supply.ignored_packs.map(pack => `${pack.id} (${pack.reason})`).join(', ') }}</span>
    </p>
    <p v-if="supply.status !== 'ok'" class="idea-supply-reasons">{{ supply.reasons.join(' ') }}</p>
    <details v-if="map" class="idea-covered">
      <summary>What this channel has covered — {{ map.entries.subjects.length }} subjects from {{ map.covered_idea_ids.length }} ideas</summary>
      <dl>
        <template v-for="group in groups" :key="group.id">
          <template v-if="map.entries[group.id]?.length">
            <dt>{{ group.label }}</dt>
            <dd>{{ map.entries[group.id].map(entry => entry.count > 1 ? `${entry.name} ×${entry.count}` : entry.name).join(' · ') }}</dd>
          </template>
        </template>
      </dl>
      <small>Built {{ new Date(map.built_at).toLocaleString() }} by {{ map.helper_model }}. It only guides the idea model; nothing is blocked or deleted. Settings → Channel identity → Idea supply and repeat checks.</small>
    </details>
    <details v-if="supply.mode === 'packs'" class="idea-covered idea-grown">
      <summary>Grown subjects — {{ grown?.pack?.subjects.length || 0 }} in use{{ grown?.pack?.grown.rejected.length ? `, ${grown.pack.grown.rejected.length} removed` : '' }}</summary>
      <div class="idea-grown-actions">
        <button class="btn btn-secondary btn-sm" :disabled="growing" @click="grow">{{ growing ? 'Growing…' : 'Grow Subjects Now' }}</button>
        <span v-if="growResult" class="idea-grown-result" role="status">{{ growResult }}</span>
      </div>
      <ul v-if="grownEntries.length">
        <li v-for="entry in grownEntries" :key="entry.subject">
          <span>{{ entry.subject }}</span>
          <a v-if="entry.source_url" :href="entry.source_url" target="_blank" rel="noopener noreferrer">{{ entry.source.replace('wikipedia:', 'Wikipedia ') }}</a>
          <small v-else>{{ entry.source === 'model' ? 'helper model' : entry.source }}</small>
          <button class="btn btn-sm" :disabled="removing === entry.subject" :aria-label="`Remove ${entry.subject}`" @click="remove(entry.subject)">Remove</button>
        </li>
      </ul>
      <small>Story adds subjects here when unused ones run low and “Self-growing Topic Packs” is on for this channel. Your own Topic Packs are never changed; Remove stops a subject being used and it is never suggested again.</small>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'

type Group = 'subjects' | 'people' | 'places' | 'eras' | 'angles'
interface Supply {
  status: 'ok' | 'low' | 'empty'
  mode: 'packs' | 'freeform' | 'no-formula'
  waiting_ideas: number
  days_left: number | null
  unused_subjects: { kind: 'measured'; value: number; total: number; per_pack: { id: string; name: string; unused: number; total: number }[] } | { kind: 'not-applicable'; reason: string }
  ignored_packs: { id: string; reason: string }[]
  reasons: string[]
}
interface GrownEntry { subject: string; source: string; source_url?: string; added_at: string }
interface Grown { pack: { subjects: string[]; grown: { entries: GrownEntry[]; rejected: { subject: string }[] } } | null }
interface CoveredMap { built_at: string; helper_model: string; covered_idea_ids: string[]; entries: Record<Group, { name: string; count: number }[]> }

const props = defineProps<{ slug: string; refreshKey?: unknown }>()
const { get, post } = useApi()
const grown = ref<Grown | null>(null)
const growing = ref(false)
const growResult = ref('')
const removing = ref('')
const grownEntries = computed(() => {
  const pack = grown.value?.pack
  return pack ? pack.grown.entries.filter(entry => pack.subjects.includes(entry.subject)).slice().reverse() : []
})
const supply = ref<Supply | null>(null)
const map = ref<CoveredMap | null>(null)
const groups: { id: Group; label: string }[] = [
  { id: 'subjects', label: 'Subjects' }, { id: 'people', label: 'People' }, { id: 'places', label: 'Places' },
  { id: 'eras', label: 'Eras' }, { id: 'angles', label: 'Angles' },
]
const statusLabel = computed(() => supply.value?.status === 'empty' ? 'Ideas have run out:' : supply.value?.status === 'low' ? 'Ideas running low:' : 'Idea supply:')

async function load() {
  const slug = props.slug
  if (!slug) return
  // Read-only and optional: a failure leaves the page as it was.
  const [nextSupply, covered, nextGrown] = await Promise.all([
    get<Supply>(`/projects/${slug}/ideas/supply`).catch(() => null),
    get<{ map: CoveredMap | null }>(`/projects/${slug}/ideas/covered-topics`).catch(() => null),
    get<Grown>(`/projects/${slug}/ideas/grown`).catch(() => null),
  ])
  if (slug !== props.slug) return
  supply.value = nextSupply
  map.value = covered?.map || null
  grown.value = nextGrown
}

function failure(error: any, fallback: string): string {
  return error?.data?.detail || error?.message || fallback
}

async function grow() {
  growing.value = true
  growResult.value = ''
  try {
    const data = await post<{ added: GrownEntry[]; notes: string[] }>(`/projects/${props.slug}/ideas/grown/grow`, {})
    growResult.value = `Added ${data.added.length}: ${data.added.map(entry => entry.subject).join(', ')}.${data.notes.length ? ` ${data.notes.join('; ')}.` : ''}`
    await load()
  } catch (error) {
    growResult.value = failure(error, 'Could not grow subjects.')
  } finally {
    growing.value = false
  }
}

async function remove(subject: string) {
  removing.value = subject
  try {
    await post(`/projects/${props.slug}/ideas/grown/remove`, { subject })
    await load()
  } catch (error) {
    growResult.value = failure(error, 'Could not remove that subject.')
  } finally {
    removing.value = ''
  }
}

watch(() => [props.slug, props.refreshKey], () => { void load() }, { immediate: true })
</script>

<style scoped>
.idea-supply { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 0 0 16px; background: var(--bg-secondary); }
.idea-supply[data-status='low'] { border-color: var(--warning, #e0b050); }
.idea-supply[data-status='empty'] { border-color: var(--error, #ff9696); }
.idea-supply-line { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
.idea-supply-reasons { margin: 6px 0 0; color: var(--text-secondary); font-size: var(--font-sm); }
.idea-covered { margin-top: 8px; }
.idea-covered summary { cursor: pointer; color: var(--text-secondary); }
.idea-covered dl { max-height: 320px; overflow: auto; margin: 8px 0; }
.idea-covered dt { font-weight: 600; margin-top: 8px; }
.idea-covered dd { margin: 2px 0 0; line-height: 1.5; overflow-wrap: anywhere; color: var(--text-secondary); }
.idea-covered small { color: var(--text-muted); }
.idea-grown-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.idea-grown-result { color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }
.idea-grown ul { list-style: none; padding: 0; margin: 8px 0; max-height: 320px; overflow: auto; }
.idea-grown li { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 4px 0; border-bottom: 1px solid var(--border); }
.idea-grown li span { flex: 1 1 200px; overflow-wrap: anywhere; }
.idea-grown li a, .idea-grown li small { color: var(--text-secondary); font-size: var(--font-sm); }
:where(summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
