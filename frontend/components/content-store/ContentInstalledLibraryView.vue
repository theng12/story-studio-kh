<template>
  <section class="installed-library" aria-labelledby="installed-library-heading">
    <header><h2 id="installed-library-heading">Installed</h2><span>{{ installed.length }} {{ installed.length === 1 ? 'pack' : 'packs' }}</span></header>
    <p>Verified signed packs available on this Mac. Local installation does not grant ownership.</p>
    <ul v-if="installed.length" class="installed-list">
      <li v-for="pack in installed" :key="`${pack.packId}@${pack.version}`">
        <div><h3>{{ pack.title }}</h3><p>{{ pack.packId }} · {{ pack.version }}</p></div>
        <span :class="['status', pack.installState]">{{ pack.installState === 'incomplete' ? 'Incomplete' : pack.active ? 'Installed' : 'Retained' }}</span>
        <p v-if="pack.installState === 'incomplete'">{{ missing(pack) || 'Story Studio could not verify this installed pack.' }}</p>
        <p v-else-if="pack.ownedByActiveAccount">Owned by this GenStudio account.</p>
        <p v-else>Installed locally; ownership is not verified for this GenStudio account.</p>
      </li>
    </ul>
    <div v-else class="library-empty" role="status"><h3>No installed packs yet</h3><p>Install an owned pack explicitly to use it on this Mac.</p></div>
  </section>
</template>

<script setup lang="ts">
import type { ContentStoreInstalledPack } from '~/composables/useContentStore'

defineProps<{ installed: readonly ContentStoreInstalledPack[] }>()
function missing(pack: ContentStoreInstalledPack): string { return pack.missingDependencies.map(dependency => `${dependency.packId} ${dependency.version} (${dependency.reason})`).join(', ') }
</script>

<style scoped>
.installed-library { display: grid; gap: 12px; }.installed-library > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }.installed-library h2 { font-size: var(--font-2xl); letter-spacing: -.025em; }.installed-library > p, .installed-list p, .library-empty p { color: var(--text-secondary); line-height: 1.5; }.installed-library header span { color: var(--text-muted); font-size: var(--font-sm); font-variant-numeric: tabular-nums; }.installed-list { display: grid; gap: 12px; padding: 0; list-style: none; }.installed-list li { display: grid; gap: 5px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.installed-list h3 { overflow-wrap: anywhere; font-size: var(--font-xl); letter-spacing: -.02em; }.status { width: fit-content; padding: 3px 7px; border: 1px solid var(--border-light); border-radius: 999px; font-size: var(--font-xs); }.status.incomplete { color: var(--warning); }.library-empty { display: grid; justify-items: start; gap: 7px; padding: 26px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }.library-empty h3 { font-size: var(--font-xl); letter-spacing: -.02em; }
</style>
