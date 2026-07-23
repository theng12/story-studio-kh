/**
 * Return a route-safe project slug.
 *
 * Nuxt can briefly expose an unresolved dynamic parameter during navigation.
 * Converting that value to a template literal used to turn it into the real
 * string "undefined", which then escaped into project API paths and UI.
 */
export function projectSlug(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''

  const slug = raw.trim()
  return slug && slug !== 'undefined' && slug !== 'null' ? slug : ''
}
