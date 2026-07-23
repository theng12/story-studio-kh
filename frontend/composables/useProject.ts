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
import { ref, readonly } from 'vue'
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

function resetState() {
  currentProject.value = null
  currentConfig.value = null
}

export function useProject() {
  const { get } = useApi()

  async function loadProject(slug: string) {
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
      const [meta, config] = await Promise.all([
        get<ProjectMeta>(`/projects/${slug}`),
        get<ProjectConfig>(`/projects/${slug}/settings/config`),
      ])
      // Guard against out-of-order responses: if the user switched projects
      // again while these requests were in flight, ignore the stale payload.
      if (currentSlug.value !== slug) return
      currentProject.value = meta
      currentConfig.value = config
    } finally {
      if (currentSlug.value === slug) loading.value = false
    }
  }

  async function refreshConfig(slug: string) {
    slug = projectSlug(slug)
    if (!slug) return
    const config = await get<ProjectConfig>(`/projects/${slug}/settings/config`, { cache: 'no-store' })
    if (currentSlug.value === slug) currentConfig.value = config
  }

  /** Clear everything — call on unmount of a top-level project shell if needed. */
  function clearProject() {
    currentSlug.value = null
    resetState()
  }

  return {
    project: currentProject,
    config: currentConfig,
    slug: readonly(currentSlug),
    loading,
    loadProject,
    refreshConfig,
    clearProject,
  }
}
