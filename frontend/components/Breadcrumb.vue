<template>
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
      <li v-for="(crumb, i) in crumbs" :key="i" class="crumb-item">
        <NuxtLink v-if="crumb.to && i < crumbs.length - 1" :to="crumb.to">
          {{ crumb.label }}
        </NuxtLink>
        <span v-else aria-current="page">{{ crumb.label }}</span>
        <span v-if="i < crumbs.length - 1" class="crumb-sep" aria-hidden="true">/</span>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
const route = useRoute()
const { project } = useProject()

const crumbs = computed(() => {
  const slug = route.params.slug as string | undefined
  const segs = route.path.split('/').filter(Boolean)
  const items: Array<{ label: string; to?: string }> = [
    { label: 'Projects', to: '/' },
  ]
  if (slug) {
    items.push({
      label: project.value?.name || slug,
      to: `/projects/${slug}`,
    })
    // If we're on a sub-page (not the project dashboard), add the section name
    if (segs.length > 2 && segs[2]) {
      items.push({ label: sectionLabel(segs[2]) })
    }
  }
  return items
})

function sectionLabel(path: string): string {
  const map: Record<string, string> = {
    ideas: 'Ideas',
    scripts: 'Script Generator',
    youtube: 'Description Generator',
    metadata: 'Metadata Generator',
    'image-prompts': 'Image Prompts',
    images: 'Images',
    audio: 'Audio Generator',
    'audio-merge': 'Audio Assembly',
    pipeline: 'Pipeline',
    jobs: 'Jobs',
    settings: 'Settings',
    video: 'Video Generator',
    'video-assembly': 'Video Assembly',
  }
  return map[path] || path
}
</script>

<style scoped>
.breadcrumb ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0;
  margin: 0 0 12px 0;
  list-style: none;
  font-size: 12px;
  color: var(--text-muted);
}
.crumb-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.crumb-item a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s;
}
.crumb-item a:hover { color: var(--text-primary); }
.crumb-item [aria-current="page"] {
  color: var(--text-secondary);
  font-weight: 500;
}
.crumb-sep { color: var(--text-muted); opacity: 0.5; }
</style>
