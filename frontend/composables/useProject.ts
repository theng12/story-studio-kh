/**
 * Current project state composable.
 *
 * State is module-scoped (singleton per tab). Whenever `loadProject` is called
 * with a different slug than the one currently held, we clear the project +
 * config refs synchronously before kicking off the fetch — otherwise pages
 * that navigate between /projects/foo/* and /projects/bar/* briefly render
 * the *previous* project while the new data is still in flight.
 *
 * Response shapes come from `@shared/contracts` — the same module the backend
 * validates against — so any payload-shape change that makes it through the
 * server fails the frontend typecheck too.
 */
// Explicit Vue + composable imports so this module is usable from plain
// node:test (no Nuxt auto-import context). Nuxt's auto-imports remain
// additive inside .vue files.
import { ref, readonly, computed } from 'vue'
import { useApi } from './useApi.js'
import { projectSlug } from '~/utils/project-slug'
import type {
  ProjectMetaResponse,
  SafeProjectConfigResponse,
} from '@shared/contracts'

// Re-export the shared shapes under the old names so existing importers don't
// have to change in a single commit.
export type ProjectMeta = ProjectMetaResponse
export type ProjectConfig = SafeProjectConfigResponse

const currentProject = ref<ProjectMeta | null>(null)
const currentConfig = ref<ProjectConfig | null>(null)
const currentSlug = ref<string | null>(null)
const loading = ref(false)
let loadRevision = 0
let configRevision = 0

/**
 * The ABSOLUTE episodes folder for the loaded project — the base a
 * `${PROJECT}/…` portable path resolves against.
 *
 * One computed, in one place, because the alternative was every page reading
 * `project.value?.output_root` — the RELATIVE './episodes' that used to be
 * stored in project.json — and handing it to the path resolver, where it
 * silently produced a path relative to the process cwd. Nine call sites made
 * that mistake; the stored field is gone now, and this is what they should
 * have been reading all along.
 */
const currentEpisodesRoot = computed(() => currentProject.value?.output_root_resolved || '')

function resetState() {
  currentProject.value = null
  currentConfig.value = null
}

export function useProject() {
  const { get } = useApi()

  async function loadProject(slug: string) {
    const revision = ++loadRevision
    const configRequest = ++configRevision
    // Race guard: a route transition can briefly produce slug="undefined"
    // (the literal string from a template-literal of an undefined value)
    // or empty. Hitting /projects/undefined/* always 404s and the UI
    // would show stale-state errors. Clear any prior project instead;
    // route middleware redirects malformed project URLs before pages mount.
    const safeSlug = projectSlug(slug)
    if (!safeSlug) {
      currentSlug.value = null
      resetState()
      loading.value = false
      return
    }
    slug = safeSlug
    // Switching projects — drop stale state synchronously so no component
    // renders the old project's data against the new slug.
    if (currentSlug.value && currentSlug.value !== slug) {
      resetState()
    }
    currentSlug.value = slug
    loading.value = true
    try {
      await Promise.all([
        get<ProjectMeta>(`/projects/${slug}`).then(meta => {
          // Identity can paint while the larger settings request is pending.
          if (currentSlug.value === slug && revision === loadRevision) currentProject.value = meta
        }),
        get<ProjectConfig>(`/projects/${slug}/settings/config`).then(config => {
          if (currentSlug.value === slug && revision === loadRevision && configRequest === configRevision) currentConfig.value = config
        }),
      ])
    } finally {
      if (currentSlug.value === slug && revision === loadRevision) loading.value = false
    }
  }

  async function refreshConfig(slug: string) {
    slug = projectSlug(slug)
    if (!slug || currentSlug.value !== slug) return
    const revision = loadRevision
    const configRequest = ++configRevision
    const config = await get<ProjectConfig>(`/projects/${slug}/settings/config`, { cache: 'no-store' })
    if (currentSlug.value === slug && revision === loadRevision && configRequest === configRevision) currentConfig.value = config
  }

  /** Clear everything — call on unmount of a top-level project shell if needed. */
  function clearProject() {
    ++loadRevision
    currentSlug.value = null
    loading.value = false
    resetState()
  }

  return {
    project: currentProject,
    config: currentConfig,
    episodesRoot: currentEpisodesRoot,
    slug: readonly(currentSlug),
    loading,
    loadProject,
    refreshConfig,
    clearProject,
  }
}
