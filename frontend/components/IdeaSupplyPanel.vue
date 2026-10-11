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
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'

type Group = 'subjects' | 'people' | 'places' | 'eras' | 'angles'
interface Supply {
  status: 'ok' | 'low' | 'empty'
  waiting_ideas: number
  days_left: number | null
  unused_subjects: { kind: 'measured'; value: number; total: number; per_pack: { id: string; name: string; unused: number; total: number }[] } | { kind: 'not-applicable'; reason: string }
  ignored_packs: { id: string; reason: string }[]
  reasons: string[]
}
interface CoveredMap { built_at: string; helper_model: string; covered_idea_ids: string[]; entries: Record<Group, { name: string; count: number }[]> }

const props = defineProps<{ slug: string; refreshKey?: unknown }>()
const { get } = useApi()
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
  const [nextSupply, covered] = await Promise.all([
    get<Supply>(`/projects/${slug}/ideas/supply`).catch(() => null),
    get<{ map: CoveredMap | null }>(`/projects/${slug}/ideas/covered-topics`).catch(() => null),
  ])
  if (slug !== props.slug) return
  supply.value = nextSupply
  map.value = covered?.map || null
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
:where(summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
