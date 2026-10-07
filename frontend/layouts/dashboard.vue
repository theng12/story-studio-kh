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
      <!-- Credits and lanes sit in the top bar on every view, so account
           standing reads the same on a project page as it does on channels
           and the Content Store. -->
      <div class="top-bar-actions">
        <GenStudioStandingStrip variant="inline" class="top-bar-standing-strip" />
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
        aria-label="Channel navigation"
      >
        <NuxtLink to="/" class="sidebar-brand" title="All channels">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
            <path d="M15.5 12a5.5 5.5 0 0 1-9 4.24A7 7 0 0 0 12 5a5.5 5.5 0 0 1 3.5 7Z" fill="var(--accent)" opacity=".65" />
          </svg>
          <div>
            <div class="brand-name">Story Studio KH</div>
            <div class="project-name">{{ project?.name || 'Loading channel…' }}</div>
          </div>
        </NuxtLink>

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
                <span v-if="step.key === 'ideas' || step.key === 'music-formula'" class="nav-hint">Start here</span>
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
            <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="nav-item" active-class="active">Channel Characters</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/effects-library`" class="nav-item" active-class="active">Effects Library</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/presets`" class="nav-item" active-class="active">Presets</NuxtLink>
            <NuxtLink :to="{ path: '/broll-library', query: { project: slug } }" class="nav-item" active-class="active">Assets Library</NuxtLink>
            <NuxtLink :to="`/projects/${slug}/image-pool`" class="nav-item" active-class="active">Image Pool</NuxtLink>
          </div>
        </nav>

        <footer class="sidebar-credits" aria-label="Story Studio status">
          <!-- Pinned, not in the scrolling list: at 1280×800 Jobs and All Channels were
               below the fold of the workflow steps. -->
          <nav class="sidebar-utilities" aria-label="Application utilities">
            <NuxtLink
              :to="`/projects/${slug}/jobs`"
              class="sidebar-utility"
              :class="{ active: isJobsScope('project') }"
              title="This channel's jobs"
            >
              Jobs
              <span v-if="activeJobCount > 0" class="nav-badge">{{ activeJobCount }}</span>
            </NuxtLink>
            <NuxtLink
              :to="{ path: `/projects/${slug}/jobs`, query: { scope: 'all' } }"
              class="sidebar-utility"
              :class="{ active: isJobsScope('all') }"
            >
              All Jobs
              <span v-if="allActiveJobCount > 0" class="nav-badge">{{ allActiveJobCount }}</span>
            </NuxtLink>
            <NuxtLink to="/content-store" class="sidebar-utility" active-class="active">Content Store</NuxtLink>
            <NuxtLink v-if="slug" :to="`/projects/${slug}/settings#free-up-space`" class="sidebar-utility">Free Up Space</NuxtLink>
            <NuxtLink v-if="slug" :to="`/projects/${slug}/settings`" class="sidebar-utility" active-class="active">Settings</NuxtLink>
            <button v-else type="button" class="sidebar-utility" @click="appSettingsModal.open()">Settings</button>
            <NuxtLink to="/" class="sidebar-utility all-projects-link">All Channels</NuxtLink>
          </nav>
          <div class="network-status" :class="connection.tone" role="status">
            <span class="network-dot" aria-hidden="true" />
            <span>{{ connection.label }}</span>
          </div>
          <p v-if="connection.hint" class="network-hint">{{ connection.hint }}</p>
          <!-- Project pages had no version anywhere. The standing strip moved
               up to the top bar; the running build takes its place here, with
               the same content and title behaviour as default.vue's badge. -->
          <button
            type="button"
            class="version-badge"
            :title="`Story Studio KH v${appVersion} · built ${buildDate} — click for What's New`"
            @click="openWhatsNew"
          >
            v{{ appVersion }}
            <span class="version-build">· {{ buildDate }}</span>
          </button>
        </footer>
      </aside>

      <main id="main-content" class="main-content" tabindex="-1">
        <WorkspaceNotice v-if="formatError" tone="warning" title="Production flow unavailable">
          {{ formatError }} Source-dependent workflow navigation will return when the project format can be read.
        </WorkspaceNotice>
        <FlowRibbon v-else-if="slug && visualSource" :slug="slug" :visual-source="visualSource" />
        <WorkspaceNotice v-if="projectLoadError" tone="warning" title="Channel loading failed">
          {{ projectLoadError }}
        </WorkspaceNotice>
        <NicheMissingBanner v-if="slug && project" :key="slug" :slug="slug" :niche-id="project.niche_id" />
        <!-- Content Pack installs / purchases keep running after the Store is left: show them here too. -->
        <ContentInstallStrip class="dashboard-install-strip" />
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { FLOW_PHASES, visualSourceFromFormat, type FlowStep, type VisualSource } from '~/composables/useProjectFlow'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'
import { projectSlug } from '~/utils/project-slug'
import ContentInstallStrip from '~/components/content-store/ContentInstallStrip.vue'

const route = useRoute()
const slug = computed(() => (
  projectSlug(route.params.slug)
  || projectSlug(route.query.project)
  || projectSlug(route.query.channel)
))
const mobileNavOpen = ref(false)
const menuToggle = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)

const { project, loadProject, clearProject } = useProject()
const projectLoadError = ref('')
const { jobs, stats, startPolling: startJobPolling, stopPolling: stopJobPolling } = useJobs()
const { stats: allJobStats, start: startAllJobs, stop: stopAllJobs } = useAllJobs()
const { refreshReadiness } = useNotifications()
const { connection } = useConnectionStatus()
const { get: apiGet } = useApi()
const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')
const whatsNewModal = useWhatsNewModal()
const appSettingsModal = useAppSettingsModal()
function openWhatsNew(): void { whatsNewModal.open() }

const visualSource = ref<VisualSource | null>(null)
const formatError = ref('')
let formatRequest = 0
const {
  steps: workflowSteps,
  routeFor: workflowRouteFor,
  currentKey: currentWorkflowKey,
} = useProjectFlow(slug, visualSource)
const workflowPhases = computed(() => FLOW_PHASES.map(phase => ({
  ...phase,
  steps: workflowSteps.value.filter(step => step.phase === phase.key),
})).filter(phase => phase.steps.length))
// 1.4.257 — only this project's Formula, not the whole catalogue: `/niches`
// re-verified every installed Content Pack on each project open (40–82 s on
// the owner's mini) to show one name.
const channelFormula = ref<{ name?: string; catalogName?: string } | null>(null)
const channelFormulaLoading = ref(true)
let formulaRequest = 0
async function loadChannelFormula(): Promise<void> {
  const projectSlug = slug.value
  const request = ++formulaRequest
  channelFormula.value = null
  channelFormulaLoading.value = true
  if (!projectSlug) return
  try {
    const { niche } = await apiGet<{ niche: { name?: string; catalogName?: string } | null }>(`/projects/${projectSlug}/effective-niche`)
    if (request === formulaRequest) channelFormula.value = niche
  } catch { /* named below as unavailable */ }
  if (request === formulaRequest) channelFormulaLoading.value = false
}
const channelFormulaName = computed(() => {
  if (!project.value) return 'Loading channel…'
  if (!project.value.niche_id) return 'Choose a Series Formula'
  if (channelFormula.value) return channelFormula.value.catalogName || channelFormula.value.name
  return channelFormulaLoading.value ? 'Loading Series Formula…' : 'Series Formula unavailable'
})
const productionPathName = computed(() => {
  if (visualSource.value === 'music') return 'Music channel formula'
  switch (project.value?.continuity_mode) {
    case 'character-continuity': return 'Character continuity'
    case 'explainer-stills': return 'Explainer boards'
    default: return 'Independent scenes'
  }
})
const activeJobCount = computed(() => Number(stats.value.running || 0) + Number(stats.value.queued || 0))
const allActiveJobCount = computed(() => Number(allJobStats.value.running || 0) + Number(allJobStats.value.queued || 0))
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
  const projectSlug = slug.value
  const request = ++formatRequest
  visualSource.value = null
  formatError.value = ''
  if (!projectSlug) return
  try {
    const format = await apiGet<{ visualSource?: unknown; musicChannel?: unknown }>(`/projects/${projectSlug}/effective-format`)
    if (request !== formatRequest || projectSlug !== slug.value) return
    // A Series Formula with a `musicFormat` block makes this a music channel (SPEC §1).
    const source: VisualSource | null = visualSourceFromFormat(format)
    if (!source) {
      formatError.value = 'The project returned an unknown production format. Refresh this project before choosing workflow work.'
      return
    }
    visualSource.value = source
  } catch (error: any) {
    if (request !== formatRequest || projectSlug !== slug.value) return
    formatError.value = error?.data?.detail || error?.message || 'Could not load this project’s production format.'
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
  projectLoadError.value = ''
  if (!currentSlug) {
    clearProject()
    stopJobPolling()
    void loadVisualSource()
    return
  }
  startJobPolling(currentSlug)
  void refreshReadiness(currentSlug)
  void loadVisualSource()
  try {
    await loadProject(currentSlug)
  } catch (error: any) {
    if (currentSlug !== slug.value) return
    projectLoadError.value = error?.data?.detail || error?.message || 'Could not read this channel. Reopen it to retry.'
  }
}, { immediate: true })

watch(
  () => [project.value?.format_id, project.value?.niche_id] as const,
  () => { void loadVisualSource(); void loadChannelFormula() },
)

useBatchCompletionSignals(() => jobs.value as any)

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown)
  startAllJobs()
})
onUnmounted(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
  stopJobPolling()
  stopAllJobs()
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
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: no-drag;
}
/* The strip yields the bar's width to the Page guide and notification
   controls before it yields anything of its own; below the 900px minimum
   window width the bar is tight enough that it steps aside entirely. */
.top-bar-standing-strip { min-width: 0; flex: 0 1 auto; }
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
.sidebar-brand { color: inherit; text-decoration: none; }
.sidebar-brand:hover { background: var(--bg-hover); }
.sidebar-brand:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; }
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
.nav-item {
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
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active { border-color: color-mix(in srgb, var(--accent) 34%, transparent); background: var(--accent-dim); color: var(--text-primary); }
/* The accent bar is positioned, not a flex item: as a flex item beside a bare
   text label ("Pipeline", "Dashboard") `space-between` pushed the label to the
   right edge of the active row. */
.nav-item { position: relative; }
.nav-item.active::before { content: ''; position: absolute; top: 50%; left: 3px; width: 3px; height: 18px; border-radius: 999px; background: var(--accent); transform: translateY(-50%); }
.nav-item-main { display: flex; min-width: 0; align-items: center; gap: 8px; }
.nav-item-main > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-hint { color: var(--accent); font-size: var(--font-xs); font-weight: 750; }
.nav-hint-muted { color: var(--text-secondary); font-weight: 600; }
.nav-badge { min-width: 22px; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--accent-on); text-align: center; font-size: var(--font-xs); }

.sidebar-credits {
  display: grid;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.sidebar-utilities { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.sidebar-utility {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-xs);
  gap: 6px;
  cursor: pointer;
}
.sidebar-utility { white-space: nowrap; }
.sidebar-utility .nav-badge { min-width: 18px; padding: 0 5px; }
.all-projects-link { color: var(--text-primary); }
.sidebar-utility:hover, .sidebar-utility.active { border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); background: var(--bg-hover); color: var(--text-primary); }
.sidebar-utility:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
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
.network-status.unknown .network-dot { background: var(--text-muted); }
.network-hint { margin: -4px 0 0; padding: 0 8px; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }

.version-badge {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-xs);
  line-height: 1.2;
}
.version-badge:hover { border-color: var(--accent); background: var(--bg-hover); color: var(--text-primary); }
.version-badge:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; box-shadow: none; }
.version-build { color: var(--text-muted); font-size: var(--font-xs); }

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
  /* Clear of the macOS traffic lights (x 16, ~52 px wide): at the 900 px minimum window the sidebar
     collapses here, and a Menu button under the lights could not be clicked at all. */
  .menu-toggle { display: inline-flex; align-items: center; justify-content: center; padding-left: 78px; min-width: 138px; }
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
.dashboard-install-strip { margin-bottom: 12px; }
</style>
