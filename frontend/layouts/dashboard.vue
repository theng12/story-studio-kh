<template>
  <div class="dashboard-layout">
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <header class="top-bar">
      <button
        ref="menuToggle"
        type="button"
        class="menu-toggle"
        :aria-expanded="mobileNavOpen"
        aria-controls="project-navigation"
        :aria-label="mobileNavOpen ? 'Close navigation' : 'Open navigation'"
        @click="toggleMobileNav"
      >
        <span aria-hidden="true">{{ mobileNavOpen ? 'Close' : 'Menu' }}</span>
      </button>
      <div class="titlebar-drag" />
      <div class="top-bar-actions">
        <FeatureHelpCenter />
        <NotificationCenter v-if="slug" :slug="slug" />
      </div>
    </header>

    <FfmpegSetupDialog />

    <div class="layout-body">
      <div v-if="mobileNavOpen" class="sidebar-overlay" aria-hidden="true" @click="closeMobileNav()" />

      <aside
        id="project-navigation"
        ref="sidebar"
        class="sidebar"
        :class="{ 'mobile-open': mobileNavOpen }"
        aria-label="Project navigation"
      >
        <div class="sidebar-brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
            <path d="M15.5 12a5.5 5.5 0 0 1-9 4.24A7 7 0 0 0 12 5a5.5 5.5 0 0 1 3.5 7Z" fill="var(--accent)" opacity=".65" />
          </svg>
          <div>
            <div class="brand-name">Story Studio KH</div>
            <div class="project-name">{{ project?.name || 'Loading channel…' }}</div>
          </div>
        </div>

        <NuxtLink v-if="slug" :to="`/projects/${slug}/settings#channel`" class="channel-identity-card">
          <span class="channel-identity-label">Channel identity</span>
          <strong>{{ channelFormulaName }}</strong>
          <span>{{ productionPathName }}</span>
        </NuxtLink>

        <nav class="sidebar-nav" aria-label="Channel workspace">
          <div class="nav-group">
            <span class="nav-section-label">Overview</span>
            <NuxtLink :to="`/projects/${slug}`" class="nav-item" exact-active-class="active">Dashboard</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/pipeline`" class="nav-item" active-class="active">Pipeline</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/board`" class="nav-item" active-class="active">Production Board</NuxtLink>
          </div>

          <div class="nav-group nav-workflow">
            <span class="nav-section-label">Workflow</span>
            <div v-for="(phase, index) in workflowPhases" :key="phase.key" class="nav-phase">
              <span class="nav-phase-label">{{ index + 1 }} · {{ phase.label }}</span>
              <NuxtLink
                v-for="step in phase.steps"
                :key="step.key"
                :to="workflowRouteFor(step)"
                class="nav-item"
                :class="{ active: currentWorkflowKey === step.key }"
                :title="step.optional ? `${workflowLabel(step)} is optional for this production path` : undefined"
              >
                <span class="nav-item-main"><span aria-hidden="true">{{ step.icon }}</span>{{ workflowLabel(step) }}</span>
                <span v-if="step.key === 'ideas'" class="nav-hint">Start here</span>
                <span v-else-if="step.optional" class="nav-hint nav-hint-muted">Optional</span>
              </NuxtLink>
            </div>
          </div>

          <div class="nav-group">
            <span class="nav-section-label">Publish</span>
            <NuxtLink :to="`/projects/${slug}/upload`" class="nav-item" active-class="active">YouTube Upload</NuxtLink>
          </div>

          <div class="nav-group">
            <span class="nav-section-label">Manage</span>
            <NuxtLink
              :to="`/projects/${slug}/jobs`"
              class="nav-item"
              :class="{ active: isJobsScope('project') }"
            >
              <span>Project Jobs</span>
              <span v-if="activeJobCount > 0" class="nav-badge">{{ activeJobCount }}</span>
            </NuxtLink>
            <NuxtLink
              :to="{ path: `/projects/${slug}/jobs`, query: { scope: 'all' } }"
              class="nav-item"
              :class="{ active: isJobsScope('all') }"
            >All Jobs</NuxtLink>
            <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="nav-item" active-class="active">Channel Characters</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/presets`" class="nav-item" active-class="active">Presets</NuxtLink>
            <NuxtLink :to="{ path: '/broll-library', query: { project: slug } }" class="nav-item" active-class="active">Assets Library</NuxtLink>
            <NuxtLink to="/content-store" class="nav-item" active-class="active">Content Store</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/settings`" class="nav-item" active-class="active">Settings</NuxtLink>
          </div>

          <NuxtLink to="/" class="all-projects-link">All Projects <span aria-hidden="true">→</span></NuxtLink>
        </nav>

        <footer class="sidebar-credits" aria-label="Story Studio status">
          <div
            class="network-status"
            :class="[networkOnline ? 'online' : 'offline', { 'queue-warn': networkQueueSyncFailed }]"
          >
            <span class="network-dot" aria-hidden="true" />
            <span>{{ networkOnline ? 'Story Studio online' : 'Story Studio unavailable' }}</span>
          </div>
          <GenStudioStandingStrip />
        </footer>
      </aside>

      <main id="main-content" class="main-content" tabindex="-1">
        <FlowRibbon v-if="slug" :slug="slug" :visual-source="visualSource" />
        <NicheMissingBanner v-if="slug" :slug="slug" :niche-id="project?.niche_id" />
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { FLOW_PHASES, normalizeVisualSource, type FlowStep, type VisualSource } from '~/composables/useProjectFlow'
import { projectSlug } from '~/utils/project-slug'

const route = useRoute()
const slug = computed(() => (
  projectSlug(route.params.slug)
  || projectSlug(route.query.project)
  || projectSlug(route.query.channel)
))
const mobileNavOpen = ref(false)
const menuToggle = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)

const { project, loadProject } = useProject()
const { jobs, stats, startPolling: startJobPolling, stopPolling: stopJobPolling } = useJobs()
const { niches } = useNiches()
const { refreshReadiness } = useNotifications()
const { online: networkOnline, queueSyncFailed: networkQueueSyncFailed } = useNetworkStatus()
const { get: apiGet } = useApi()

const visualSource = ref<VisualSource>('narrated-scenes')
const {
  steps: workflowSteps,
  routeFor: workflowRouteFor,
  currentKey: currentWorkflowKey,
} = useProjectFlow(slug, visualSource)
const workflowPhases = computed(() => FLOW_PHASES.map(phase => ({
  ...phase,
  steps: workflowSteps.value.filter(step => step.phase === phase.key),
})).filter(phase => phase.steps.length))
const channelFormula = computed(() => niches.value.find(niche => niche.id === project.value?.niche_id))
const channelFormulaName = computed(() => channelFormula.value?.catalogName || channelFormula.value?.name || 'Choose a Series Formula')
const productionPathName = computed(() => {
  switch (project.value?.continuity_mode) {
    case 'character-continuity': return 'Character continuity'
    case 'explainer-stills': return 'Explainer boards'
    default: return 'Independent scenes'
  }
})
const activeJobCount = computed(() => Number(stats.value.running || 0) + Number(stats.value.queued || 0))
function isJobsScope(scope: 'project' | 'all'): boolean {
  if (!route.path.endsWith('/jobs')) return false
  return scope === 'all' ? route.query.scope === 'all' : route.query.scope !== 'all'
}

function workflowLabel(step: FlowStep): string {
  switch (step.key) {
    case 'ideas': return 'Ideas Generator'
    case 'script': return 'Script Generator'
    case 'thumbnails': return 'Thumbnail Generator'
    case 'audio': return 'Audio Generator'
    default: return step.label
  }
}

async function loadVisualSource(): Promise<void> {
  if (!slug.value) return
  try {
    const format = await apiGet<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug.value}/effective-format`)
    visualSource.value = normalizeVisualSource(format?.visualSource, format?.sceneAlignment)
  } catch {
    visualSource.value = 'narrated-scenes'
  }
}

function focusableSidebarItems(): HTMLElement[] {
  if (!sidebar.value) return []
  return Array.from(sidebar.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
    .filter(item => !item.hasAttribute('aria-hidden'))
}

function openMobileNav(): void {
  mobileNavOpen.value = true
  nextTick(() => focusableSidebarItems()[0]?.focus())
}

function closeMobileNav(restoreFocus = true): void {
  mobileNavOpen.value = false
  if (restoreFocus) nextTick(() => menuToggle.value?.focus())
}

function toggleMobileNav(): void {
  if (mobileNavOpen.value) closeMobileNav()
  else openMobileNav()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (!mobileNavOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMobileNav()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusableSidebarItems()
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => route.fullPath, () => {
  if (mobileNavOpen.value) closeMobileNav(false)
})

watch(slug, async currentSlug => {
  if (!currentSlug) return
  await loadProject(currentSlug)
  startJobPolling(currentSlug)
  void refreshReadiness(currentSlug)
  void loadVisualSource()
}, { immediate: true })

watch(
  () => [project.value?.format_id, project.value?.niche_id] as const,
  () => { void loadVisualSource() },
)

useBatchCompletionSignals(() => jobs.value as any)

onMounted(() => document.addEventListener('keydown', onDocumentKeydown))
onUnmounted(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
  stopJobPolling()
})
</script>

<style scoped>
.dashboard-layout {
  display: flex;
  height: 100dvh;
  flex-direction: column;
  overflow: hidden;
}

.top-bar {
  z-index: 200;
  display: flex;
  flex: 0 0 38px;
  background: var(--bg-secondary);
}
.titlebar-drag {
  flex: 1;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.top-bar-actions {
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: no-drag;
}
.menu-toggle {
  display: none;
  min-width: 60px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font: 650 var(--font-sm)/1 inherit;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.layout-body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.sidebar {
  display: flex;
  width: 232px;
  flex: 0 0 232px;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px;
  border-bottom: 1px solid var(--border);
}
.sidebar-brand > div { min-width: 0; }
.brand-name { color: var(--accent); font-size: var(--font-md); font-weight: 750; }
.project-name { overflow: hidden; color: var(--text-secondary); font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }

.channel-identity-card {
  display: flex;
  margin: 12px 10px 4px;
  padding: 11px 12px;
  flex-direction: column;
  gap: 3px;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
  border-radius: var(--radius-md);
  background: var(--accent-dim);
  color: var(--text-primary);
}
.channel-identity-card:hover { border-color: var(--accent); color: var(--text-primary); }
.channel-identity-label { color: var(--accent); font-size: var(--font-xs); font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.channel-identity-card strong { overflow: hidden; font-size: var(--font-sm); text-overflow: ellipsis; white-space: nowrap; }
.channel-identity-card > span:last-child { color: var(--text-secondary); font-size: var(--font-xs); }

.sidebar-nav {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  padding: 12px 8px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.nav-group { display: grid; gap: 3px; }
.nav-workflow { gap: 6px; }
.nav-phase { display: grid; gap: 2px; }
.nav-phase + .nav-phase { margin-top: 5px; padding-top: 7px; border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent); }
.nav-phase-label {
  padding: 1px 10px 3px 18px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.nav-section-label {
  padding: 4px 10px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 750;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.nav-item,
.all-projects-link {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--font-sm);
  font-weight: 550;
}
.nav-item:hover,
.all-projects-link:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active { border-color: color-mix(in srgb, var(--accent) 34%, transparent); background: var(--accent-dim); color: var(--text-primary); }
.nav-item.active::before { content: ''; width: 3px; height: 18px; margin-left: -5px; border-radius: 999px; background: var(--accent); }
.nav-item.active > span:first-child { margin-right: auto; }
.nav-item-main { display: flex; min-width: 0; align-items: center; gap: 8px; }
.nav-item-main > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-hint { color: var(--accent); font-size: var(--font-xs); font-weight: 750; }
.nav-hint-muted { color: var(--text-secondary); font-weight: 600; }
.nav-badge { min-width: 22px; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--accent-on); text-align: center; font-size: var(--font-xs); }
.all-projects-link { margin-top: auto; border-color: var(--border); color: var(--text-primary); }

.sidebar-credits {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.network-status {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.network-status { justify-content: flex-start; }
.network-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--error); }
.network-status.online .network-dot { background: var(--success); }

.main-content {
  min-width: 0;
  min-height: 0;
  flex: 1;
  padding: var(--workspace-gutter);
  overflow-x: hidden;
  overflow-y: auto;
}

.sidebar-overlay { display: none; }

@media (max-width: 900px) {
  .menu-toggle { display: inline-flex; align-items: center; justify-content: center; }
  .sidebar {
    position: fixed;
    z-index: 300;
    inset: 0 auto 0 0;
    width: min(286px, 84vw);
    transform: translateX(-100%);
    transition: transform var(--motion-base) ease;
  }
  .sidebar.mobile-open { transform: translateX(0); box-shadow: 18px 0 50px rgba(0, 0, 0, .42); }
  .sidebar-overlay { position: fixed; z-index: 250; inset: 0; display: block; background: rgba(0, 0, 0, .5); }
  .main-content { padding: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar { transition: none; }
}
</style>
