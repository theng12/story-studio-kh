<template>
  <section class="installed-library" aria-labelledby="installed-library-heading">
    <header><h2 id="installed-library-heading">Installed</h2><span>{{ installsResolved ? `${installed.length} ${installed.length === 1 ? 'pack' : 'packs'}` : 'Not checked yet' }}</span></header>
    <p>Signed packs installed on this Mac.</p>
    <!-- Installed packs are read from this Mac, so only a state where no answer
         has arrived at all is "not checked yet" — a Gateway that could not be
         asked does not make this list unknown. -->
    <div v-if="!installsResolved" class="library-empty" role="status" aria-live="polite"><h3>Not checked yet</h3><p>Story Studio is checking which signed packs are installed on this Mac. This list appears as soon as it answers.</p></div>
    <template v-else>
      <p v-if="removals?.unreadable" class="removal-notice warning" role="status">Story Studio could not read its Content Pack removal records, so it cannot say which channels use a pack or what it removed before.</p>
      <p v-if="removalNotice" :class="['removal-notice', removalNotice.tone]" role="status" aria-live="polite">{{ removalNotice.detail }}</p>
      <p v-if="versionNotice" :class="['removal-notice', versionNotice.tone]" role="status" aria-live="polite">{{ versionNotice.detail }}</p>
      <ul v-if="installed.length" class="installed-list">
        <li v-for="pack in installed" :key="`${pack.packId}@${pack.version}`">
          <div><h3>{{ pack.title }}</h3><p>{{ pack.packId }} · {{ pack.version }}</p></div>
          <span :class="['status', pack.installState]">{{ pack.installState === 'incomplete' ? 'Incomplete' : pack.active ? 'Installed' : 'Retained' }}</span>
          <p v-if="pack.installState === 'incomplete'">{{ missing(pack) || 'Story Studio could not verify this installed pack.' }}</p>
          <p class="usage">{{ usageLabel(pack.packId) }}</p>
          <p v-if="removalNote(pack.packId)" class="removal-notice warning">{{ removalNote(pack.packId) }}</p>
          <button type="button" class="btn btn-secondary remove-action" :disabled="removalBusy === pack.packId" @click="$emit('remove', pack.packId)">{{ removalBusy === pack.packId ? 'Removing…' : 'Remove from this Mac' }}</button>
          <button
            v-if="!pack.active"
            type="button"
            class="btn btn-secondary remove-action"
            :disabled="versionBusy === versionKey(pack)"
            @click="uninstallVersion(pack)"
          >{{ versionBusy === versionKey(pack) ? 'Uninstalling…' : 'Uninstall this version' }}</button>
        </li>
      </ul>
      <div v-else class="library-empty" role="status"><h3>No installed packs yet</h3><p>Install a pack from the library to use it on this Mac.</p></div>
      <section v-if="removedPacks.length" class="removed-packs" aria-labelledby="removed-packs-heading">
        <h3 id="removed-packs-heading">Removed from this Mac</h3>
        <p>Story Studio never deletes a pack. Removed packs sit in Story Studio's Trash and can be put back here.</p>
        <ul>
          <li v-for="entry in removedPacks" :key="entry.pack_id">
            <div><strong>{{ entry.pack_id }}</strong><span>{{ entry.versions.map(version => version.version).join(', ') || 'No version recorded' }} · removed {{ formatWhen(entry.removed_at) }}</span><span v-if="entry.gateway_remove_at">The Gateway stopped offering it.</span></div>
            <button type="button" class="btn btn-secondary" :disabled="removalBusy === entry.pack_id" @click="$emit('restore', entry.pack_id)">{{ removalBusy === entry.pack_id ? 'Restoring…' : 'Put it back' }}</button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { splitPackUsage } from '~/content-store/library-organisation'
import { useContentStore, type ContentPackRemovalEntry, type ContentPackRemovalState, type ContentStoreInstalledPack } from '~/composables/useContentStore'

const props = withDefaults(defineProps<{
  installed: readonly ContentStoreInstalledPack[]
  installsResolved?: boolean
  removals?: ContentPackRemovalState | null
  removalBusy?: string
  removalNotice?: { tone: 'success' | 'warning'; detail: string } | null
}>(), { installsResolved: true, removals: null, removalBusy: '', removalNotice: null })

defineEmits<{ remove: [packId: string]; restore: [packId: string] }>()

const store = useContentStore()
const versionBusy = ref('')
const versionNotice = ref<{ tone: 'success' | 'warning'; detail: string } | null>(null)

function versionKey(pack: ContentStoreInstalledPack): string { return `${pack.packId}@${pack.version}` }

/** One retained version only; active, pinned and dependent versions are refused by the server. */
async function uninstallVersion(pack: ContentStoreInstalledPack): Promise<void> {
  if (versionBusy.value) return
  versionBusy.value = versionKey(pack)
  versionNotice.value = null
  try {
    await store.uninstallPackVersion(pack.packId, pack.version)
    versionNotice.value = { tone: 'success', detail: `${pack.packId} ${pack.version} is off this Mac. Its files are in Story Studio's Trash.` }
  } catch (cause: any) {
    const data = cause?.data || cause?.response?._data || {}
    versionNotice.value = { tone: 'warning', detail: typeof data.detail === 'string' && data.detail ? data.detail : cause?.message || 'This version could not be uninstalled.' }
  } finally {
    versionBusy.value = ''
  }
}

function missing(pack: ContentStoreInstalledPack): string { return pack.missingDependencies.map(dependency => `${dependency.packId} ${dependency.version} (${dependency.reason})`).join(', ') }

/** Which channels use it, said plainly — including "none" and "could not tell". */
function usageLabel(packId: string): string {
  if (!props.removals) return 'Checking which channels use it…'
  const { channels, unchecked } = splitPackUsage(props.removals.channels[packId] ?? [])
  const parts: string[] = []
  if (channels.length) parts.push(`Used by ${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}: ${channels.join(', ')}.`)
  if (unchecked.length) parts.push(`Could not check ${unchecked.join(', ')} — that is not the same as unused.`)
  return parts.length ? parts.join(' ') : 'Not used by any channel.'
}

/** Why the Gateway's removal request did not take this pack off this Mac. */
function removalNote(packId: string): string {
  const entry = props.removals?.packs[packId]
  if (!entry || entry.restored_at || entry.outcome === 'removed') return ''
  if (entry.outcome === 'kept_in_use') {
    const { channels, unchecked } = splitPackUsage(entry.channels)
    if (channels.length) {
      return `The Gateway stopped offering this pack, but ${channels.length === 1 ? 'a channel still uses' : 'channels still use'} it: ${channels.join(', ')}, so it stays installed.`
    }
    return `The Gateway stopped offering this pack, but Story Studio could not check ${unchecked.join(', ')}, so it stays installed.`
  }
  return `The Gateway stopped offering this pack, but Story Studio could not remove it${entry.detail ? `: ${entry.detail}` : '.'}`
}

const removedPacks = computed<ContentPackRemovalEntry[]>(() => Object.values(props.removals?.packs ?? {})
  .filter(entry => entry.outcome === 'removed' && !entry.restored_at)
  .sort((left, right) => right.removed_at.localeCompare(left.removed_at)))

function formatWhen(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.installed-library { display: grid; gap: 12px; }.installed-library > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }.installed-library h2 { font-size: var(--font-2xl); letter-spacing: -.025em; }.installed-library > p, .installed-list p, .library-empty p, .removed-packs p { color: var(--text-secondary); line-height: 1.5; }.installed-library header span { color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }.installed-list { display: grid; gap: 12px; padding: 0; list-style: none; }.installed-list li { display: grid; gap: 5px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.installed-list h3 { overflow-wrap: anywhere; font-size: var(--font-xl); letter-spacing: -.02em; }.status { width: fit-content; padding: 3px 7px; border: 1px solid var(--border-light); border-radius: 999px; font-size: var(--font-xs); }.status.incomplete { color: var(--warning); }.usage { color: var(--text-muted); font-size: var(--font-sm); }.remove-action { width: fit-content; min-height: var(--control-height-sm); }.removal-notice { padding: 10px; border-radius: var(--radius-md); background: var(--bg-tertiary); color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }.removal-notice.warning { color: var(--text-primary); }.removed-packs { display: grid; gap: 8px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--border); }.removed-packs h3 { font-size: var(--font-lg); }.removed-packs ul { display: grid; gap: 8px; padding: 0; list-style: none; }.removed-packs li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); }.removed-packs li div { display: grid; gap: 2px; min-width: 0; }.removed-packs li span { color: var(--text-secondary); font-size: var(--font-sm); overflow-wrap: anywhere; }.library-empty { display: grid; justify-items: start; gap: 7px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.library-empty h3 { font-size: var(--font-xl); letter-spacing: -.02em; } @media (max-width: 560px) { .remove-action, .removed-packs li .btn { min-height: 44px; } .removed-packs li { align-items: stretch; flex-direction: column; } }
</style>
