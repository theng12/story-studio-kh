/**
 * Backend entry point for the project-slug rule.
 *
 * The rule itself lives in `../contracts/project-slug.ts` — a zero-dependency
 * module the channel-creation form also imports (`@shared/project-slug`), so the
 * slug a customer is shown is computed by the same code that creates the folder.
 * This file stays because services (and their pinned tests) import `slug.js`.
 *
 * Channel CREATION must use `projectSlugBase()` (unique fallback) or an explicit
 * slug, never `sanitizeProjectSlug()` — its historical "project" fallback is what
 * gave a Khmer-only name the meaningless folder name reported on 2026-10-28.
 */

export {
  MAX_PROJECT_SLUG_LENGTH,
  projectSlugCore,
  sanitizeProjectSlug,
  fallbackChannelSlug,
  projectSlugBase,
  uniqueProjectSlug,
  normalizeExplicitProjectSlug,
  isValidExplicitProjectSlug,
} from '../contracts/project-slug.js'
