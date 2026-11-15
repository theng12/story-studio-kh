<script setup lang="ts">
/**
 * The episode's format-pool row — owner 2026-11-15. Shows which pool member
 * this episode runs under (the same member shapes its thumbnail and its
 * YouTube title) and lets the owner override it before upload. Renders
 * NOTHING while the channel's switch is off, so every channel saved before
 * this feature looks exactly as it did.
 */
import type { FormatPoolMember } from '@shared/format-pool'

const props = defineProps<{
  slug: string
  episodeId: string
}>()

interface AssignmentResponse {
  enabled: boolean
  member: FormatPoolMember | null
  source: 'stored' | 'pooled' | null
  index: number | null
  members: FormatPoolMember[]
}

const { get, put } = useApi()
const assignment = ref<AssignmentResponse | null>(null)
const message = ref('')
const saving = ref(false)

async function load() {
  assignment.value = null
  message.value = ''
  if (!props.episodeId) return
  try {
    assignment.value = await get<AssignmentResponse>(
      `/projects/${props.slug}/episodes/${encodeURIComponent(props.episodeId)}/format-assignment`,
    )
  } catch (e: any) {
    // Honest failure: say why instead of rendering a silent empty state.
    message.value = e?.data?.detail || e?.message || 'Could not read this episode’s format.'
  }
}

watch(() => [props.slug, props.episodeId], () => void load(), { immediate: true })

const shown = computed(() => assignment.value?.enabled === true)
const member = computed(() => assignment.value?.member || null)
const memberLabel = computed(() => member.value?.label || member.value?.id || 'No format')
const detail = computed(() => {
  const a = assignment.value
  if (!a) return ''
  const bits: string[] = []
  if (member.value) {
    bits.push(member.value.thumbnail_shell_id
      ? `Shell ${member.value.thumbnail_shell_id}`
      : member.value.thumbnail_template_id
        ? `Template ${member.value.thumbnail_template_id}`
        : 'channel thumbnail default')
    bits.push(member.value.title_mode ? `title style “${member.value.title_mode}”` : 'channel title style')
  }
  const base = member.value
    ? `Drives this episode's thumbnail (${bits[0]}) and its YouTube title (${bits[1]}).`
    : 'No member assigned yet — it is picked when the episode next generates.'
  const source = a.source === 'stored'
    ? ' Pinned for this episode.'
    : a.source === 'pooled'
      ? ' Picked from the episode id, so it never changes.'
      : ''
  const one = a.members.length === 1 ? ' Only one format is in the pool, so every episode uses it.' : ''
  return `${base}${source}${one}`
})

async function override(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  saving.value = true
  message.value = 'Saving…'
  try {
    assignment.value = await put<AssignmentResponse>(
      `/projects/${props.slug}/episodes/${encodeURIComponent(props.episodeId)}/format-assignment`,
      { member_id: value === '__pool__' ? null : value },
    )
    message.value = 'Saved.'
    setTimeout(() => { if (message.value === 'Saved.') message.value = '' }, 2000)
  } catch (e: any) {
    message.value = e?.data?.detail || e?.message || 'Failed to save this episode’s format'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="shown" class="format-pool-episode">
    <div class="format-pool-episode-head">
      <span class="settings-section-kicker">Format pool</span>
      <strong>{{ memberLabel }}</strong>
    </div>
    <p class="settings-hint">{{ detail }}</p>
    <label class="format-pool-field">
      <span>This episode's format</span>
      <select :value="member?.id || '__pool__'" :disabled="saving" @change="override">
        <option v-for="m in assignment?.members || []" :key="m.id" :value="m.id">
          {{ m.label || m.id }}
        </option>
        <option value="__pool__">Follow the pool's pick</option>
      </select>
    </label>
    <span v-if="message" class="text-muted" style="font-size: var(--font-xs)">{{ message }}</span>
  </div>
</template>
