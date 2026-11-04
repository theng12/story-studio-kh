<template>
  <!-- Settings is a page, not a popup (owner, 2026-10-30: "why is settings the
       only one that is a modal popup"). Same shared header as every other
       non-channel page, same frame, same title. The settings themselves are the
       very same component the modal used, with the same sections, the same
       Save/Revert controls and the same queries — nothing about a setting
       moved, and every `?section=` deep link still lands on its section.

       The modal stays for the places that open it from inside another dialog
       (the Gateway strip, a model picker), where navigation would throw away
       the work underneath. -->
  <div class="page-frame settings-page">
    <PlainBackLink />
    <PageTitle
      eyebrow="This Mac"
      title="Settings"
      description="Defaults and connections for the Mac running Story Studio. Changes are saved when you press Save in each section."
    />

    <nav class="settings-section-links" aria-label="Settings sections">
      <NuxtLink
        v-for="entry in sections"
        :key="entry.id"
        :to="{ path: '/settings', query: entry.id === 'all' ? {} : { section: entry.id } }"
        class="settings-section-link"
        :class="{ active: section === entry.id }"
        :aria-current="section === entry.id ? 'page' : undefined"
      >{{ entry.label }}</NuxtLink>
    </nav>

    <ThisMacSettings :key="section" :section="section" />
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const router = useRouter()

type SettingsSection = import('../composables/useAppSettingsModal').AppSettingsSection
const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'all', label: 'This Mac' },
  { id: 'connections', label: 'Connections' },
  { id: 'default-models', label: 'Default models' },
  { id: 'files', label: 'Files & maintenance' },
  { id: 'backup', label: 'Backup & restore' },
  { id: 'performance', label: 'Performance & recovery' },
  { id: 'appearance', label: 'Appearance & app behaviour' },
]
const sections = SECTIONS

/** `?section=` is the deep link, and an unknown or absent one reads as "all". */
const section = computed<SettingsSection>(() => {
  const wanted = String(route.query.section || '')
  return (SECTIONS.find(entry => entry.id === wanted)?.id || 'all')
})

/** Keep the address honest so a copied link reopens the same section. */
watch(section, (now) => {
  if (String(route.query.section || 'all') === now) return
  void router.replace({ query: { ...route.query, section: now === 'all' ? undefined : now } })
}, { immediate: true })

onMounted(() => {
  watch(() => [section.value, route.hash], async () => {
    await nextTick()
    const anchor = route.hash.slice(1)
    if (anchor) [...document.querySelectorAll<HTMLElement>('[data-setting]')]
      .find(element => element.dataset.setting === anchor)?.scrollIntoView({ block: 'start' })
  }, { immediate: true, flush: 'post' })
})

useAppTitle('Settings')
</script>

<style scoped>
.settings-page { padding-bottom: 72px; }
.settings-section-links { display: flex; flex-wrap: wrap; gap: 6px; }
.settings-section-link {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  font-weight: 600;
  text-decoration: none;
}
.settings-section-link:hover { background: var(--bg-hover); color: var(--text-primary); }
.settings-section-link.active { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-dim); color: var(--text-primary); }
/* The save bar sits at the bottom of the page's scroll area; the reserved
   space above keeps the last row from resting underneath it. */
.settings-page :deep(.cost-save-bar),
.settings-page :deep(.perf-save-bar) { bottom: 12px; }
</style>
