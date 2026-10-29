/**
 * Project (channel) slugs — the ONE rule for turning a channel name into the
 * folder name under the Library, shared by the backend create path and the
 * channel-creation form.
 *
 * This module is zero-dependency on purpose: frontend runtime imports it (via
 * `@shared/project-slug`) so the form can show the slug the server will really
 * use. A value that is enforced must also be shown, and a preview computed by a
 * second copy of the rule is not the value — it is a guess that drifts.
 *
 * ── Why the rules look like this ──
 *
 * A slug becomes a literal directory name under the Library, so it has to
 * survive Windows' stricter filesystem rules even though we mostly develop on
 * macOS:
 *
 *   1. Reserved device names — "CON", "PRN", "AUX", "NUL", "COM1".."COM9",
 *      "LPT1".."LPT9" — can't be used as directory names on Windows. A channel
 *      literally titled "CON" would slugify to "con" and then fail to `mkdir`
 *      with an opaque error. We prefix it with "project-".
 *
 *   2. Trailing dots and spaces. Windows silently strips them when creating a
 *      directory, so `existsSync("foo.")` and `existsSync("foo")` resolve to the
 *      same entry, breaking uniqueness checks. They are stripped here.
 *
 *   3. Path-length cap. The typical asset path is
 *      `%APPDATA%\Story Studio KH\projects\{slug}\episodes\{season}\
 *      {episode}\02 Metadata\{code}_Metadata.json`, which is already
 *      ~100-150 chars before the user's name. MAX_PATH on Windows is 260 by
 *      default, so the slug is capped at 50 chars to leave headroom.
 *
 * Existing slugs on disk are grandfathered — this rule only runs on new
 * channel creation. We deliberately do NOT Unicode-normalise (NFC/NFD) so
 * round-tripping through the filesystem stays stable on macOS vs Linux.
 *
 * ── The defect this module was extracted for (2026-10-28) ──
 *
 * A Khmer-only channel name (ពិភពទេវកថា) has no Latin characters, so the
 * sanitiser removed every character and the old fallback was the literal
 * "project" — every such channel collided on one meaningless folder. The
 * fallback is now `channel-<8 hex digits of a hash of the name>`: unique per
 * name, stable for that name, and always safe Latin. The explicit-slug path lets
 * a caller (or the form) choose the folder name outright.
 */

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export const MAX_PROJECT_SLUG_LENGTH = 50

/**
 * The sanitised Latin core of a name, or '' when the name has none.
 *
 * Callers that must create a channel use `projectSlugBase()` (which supplies the
 * unique fallback). `sanitizeProjectSlug()` keeps the historical "project"
 * fallback for everything that predates the explicit-fallback rule.
 */
export function projectSlugCore(input: string): string {
  let slug = (input ?? '').toLowerCase()

  // Strip control chars (0x00-0x1f, 0x7f) before anything else — they can
  // sneak past the \w regex in paste scenarios.
  slug = slug.replace(/[\x00-\x1f\x7f]/g, '')

  // Windows-illegal chars plus path separators. Kept explicit so the intent
  // is obvious to readers — a generic `[^\w\s-]` swallowed these together
  // with ordinary punctuation, which hid what was being removed.
  slug = slug.replace(/[<>:"|?*/\\]/g, '')

  // Remove remaining non-word characters except whitespace and hyphen.
  slug = slug.replace(/[^\w\s-]/g, '')

  // Collapse whitespace + underscores into single hyphens.
  slug = slug.replace(/[\s_]+/g, '-')
  slug = slug.replace(/-+/g, '-')

  // Strip leading/trailing hyphens, then trailing dots/spaces that Windows
  // would silently trim on disk.
  slug = slug.replace(/^[-.\s]+|[-.\s]+$/g, '')

  if (!slug) return ''

  if (slug.length > MAX_PROJECT_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(/[-.\s]+$/g, '')
    if (!slug) return ''
  }

  if (WINDOWS_RESERVED.has(slug)) {
    slug = `project-${slug}`
  }

  return slug
}

/**
 * The historical sanitiser: always non-empty, falling back to "project".
 * Kept for the icon/preset/import callers that predate the unique fallback and
 * for the pinned contract in `__tests__/slug.test.ts`. Channel CREATION must not
 * use this — see `projectSlugBase()`.
 */
export function sanitizeProjectSlug(input: string): string {
  return projectSlugCore(input) || 'project'
}

/** FNV-1a, 32-bit. Small, dependency-free, identical in Node and the browser. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The unique, stable folder name for a name that yields no Latin characters:
 * `channel-` plus 8 hex digits of a hash of the name. Deterministic, so the
 * creation form and the server compute the same value; distinct for distinct
 * names. Two channels with the SAME name still collide, and `uniqueProjectSlug`
 * resolves that with the usual `-2` suffix.
 */
export function fallbackChannelSlug(name: string): string {
  return `channel-${fnv1a32(String(name ?? '').trim()).toString(16).padStart(8, '0')}`
}

/** The slug base for a new channel: its Latin core, else the unique fallback. */
export function projectSlugBase(name: string): string {
  return projectSlugCore(name) || fallbackChannelSlug(name)
}

/**
 * Return `base`, or `base-2`, `base-3`, … — the first that no existing channel
 * already uses. Case-insensitive on purpose: APFS, HFS+ and default NTFS treat
 * "Foo" and "foo" as one entry, so a case-only difference must not be allowed.
 */
export function uniqueProjectSlug(base: string, taken: Iterable<string>): string {
  const existing = new Set<string>()
  for (const entry of taken) existing.add(String(entry).toLowerCase())
  if (!existing.has(base.toLowerCase())) return base
  let counter = 2
  while (existing.has(`${base}-${counter}`.toLowerCase())) counter += 1
  return `${base}-${counter}`
}

/** Trim + lowercase. An explicit slug is stored exactly as validated. */
export function normalizeExplicitProjectSlug(value: string): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * True when an explicit slug is safe to use as a folder name: lowercase ASCII
 * letters, digits and single interior hyphens, at most 50 characters, and not a
 * Windows device name. Anything else is refused with a plain message rather than
 * quietly rewritten — the caller asked for a specific folder.
 */
export function isValidExplicitProjectSlug(value: string): boolean {
  const slug = normalizeExplicitProjectSlug(value)
  if (!slug || slug.length > MAX_PROJECT_SLUG_LENGTH) return false
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false
  return !WINDOWS_RESERVED.has(slug)
}
