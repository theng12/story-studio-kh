/**
 * Cross-platform-safe slug sanitiser for project directory names.
 *
 * Project names become literal directory names under PROJECTS_ROOT, which
 * means they have to survive Windows' stricter filesystem rules even though
 * we mostly develop on macOS. The earlier helper (`name.toLowerCase()…`)
 * stripped punctuation with a generic `\w` regex and stopped there, which
 * left three real failure modes:
 *
 *   1. Reserved device names — "CON", "PRN", "AUX", "NUL", "COM1".."COM9",
 *      "LPT1".."LPT9" — can't be used as directory names on Windows. A
 *      project literally titled "CON" would slugify to "con" and then fail
 *      to `mkdir` with an opaque error. We detect the case-folded match and
 *      prefix the slug with "project-" to sidestep the rule.
 *
 *   2. Trailing dots and spaces. Windows silently strips them when creating
 *      a directory, so `existsSync("foo.")` and `existsSync("foo")` resolve
 *      to the same entry, breaking uniqueness checks. We strip them here.
 *
 *   3. Path-length cap. The typical asset path is
 *      `%APPDATA%\Story Studio KH\projects\{slug}\episodes\{season}\
 *      {episode}\02 Metadata\{code}_Metadata.json`, which is already
 *      ~100-150 chars before the user's name. MAX_PATH on Windows is 260
 *      by default, so we cap the slug at 50 chars to leave headroom.
 *
 * Existing slugs on disk are grandfathered — this sanitiser only runs on
 * new project creation / import. We deliberately do NOT Unicode-normalise
 * (NFC/NFD) so round-tripping through the filesystem stays stable on
 * macOS vs Linux.
 */

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

const MAX_SLUG_LENGTH = 50

/**
 * Convert a human-readable project name into a filesystem-safe slug.
 * Always returns a non-empty string (falls back to "project").
 */
export function sanitizeProjectSlug(input: string): string {
  let slug = (input ?? '').toLowerCase()

  // Strip control chars (0x00-0x1f, 0x7f) before anything else — they can
  // sneak past the \w regex in paste scenarios.
  slug = slug.replace(/[\x00-\x1f\x7f]/g, '')

  // Windows-illegal chars plus path separators. Kept explicit so the intent
  // is obvious to readers — the previous generic `[^\w\s-]` also caught
  // most of these but conflated them with ordinary punctuation.
  slug = slug.replace(/[<>:"|?*/\\]/g, '')

  // Remove remaining non-word characters except whitespace and hyphen, the
  // same net effect as the original helper for everyday input.
  slug = slug.replace(/[^\w\s-]/g, '')

  // Collapse whitespace + underscores into single hyphens.
  slug = slug.replace(/[\s_]+/g, '-')
  slug = slug.replace(/-+/g, '-')

  // Strip leading/trailing hyphens, then trailing dots/spaces that Windows
  // would silently trim on disk.
  slug = slug.replace(/^[-.\s]+|[-.\s]+$/g, '')

  if (!slug) return 'project'

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/[-.\s]+$/g, '')
    if (!slug) return 'project'
  }

  if (WINDOWS_RESERVED.has(slug)) {
    slug = `project-${slug}`
  }

  return slug
}
