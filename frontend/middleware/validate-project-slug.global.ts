import { projectSlug } from '~/utils/project-slug'

/**
 * A project page without a resolved slug is never a valid destination.
 *
 * This can occur while Nuxt replaces a route during startup/restore. Redirect
 * before the dashboard layout or page composables mount, so no request is
 * built with `/projects/undefined` and no transient internal guard reaches
 * the customer-facing UI.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith('/projects/')) return
  if (projectSlug(to.params.slug)) return

  return navigateTo('/', { replace: true })
})
