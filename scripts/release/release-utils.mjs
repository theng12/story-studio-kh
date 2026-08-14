import fs from 'node:fs'
import path from 'node:path'

const CHANGELOG_HEADER = /^##\s+v?(\d+\.\d+(?:\.\d+)?)\b\s*(?:[—\-:]\s*([\d-]+))?\s*$/

export function parseChangelog(raw) {
  const entries = []
  let current = null

  for (const line of String(raw).split(/\r?\n/)) {
    const match = line.match(CHANGELOG_HEADER)
    if (match) {
      if (current) {
        current.body = current.body.trimEnd()
        entries.push(current)
      }
      current = { version: match[1], date: match[2] || null, body: '' }
      continue
    }
    if (!current) continue
    if (!current.body && !line.trim()) continue
    current.body += `${line}\n`
  }

  if (current) {
    current.body = current.body.trimEnd()
    entries.push(current)
  }
  return entries
}

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0)
    if (delta) return delta
  }
  return 0
}

export function expandArtifactName(template, values) {
  return String(template).replace(/\$\{(productName|version|arch|ext)\}/g, (_all, key) => {
    if (!(key in values)) throw new Error(`Missing artifact-name value: ${key}`)
    return String(values[key])
  })
}

export function startupReferences(html) {
  const refs = []
  const tagRe = /<(script|link)\b[^>]*?\b(?:src|href)=(['"])(.*?)\2[^>]*>/gi
  for (const match of String(html).matchAll(tagRe)) refs.push(match[3])
  return refs
}

export function remoteStartupReferences(html) {
  return startupReferences(html).filter((ref) => /^(?:https?:)?\/\//i.test(ref))
}

/**
 * The Content Store is a statically generated route, but its page code is a
 * lazy client chunk. Check both sides of that mapping so an old/partial
 * frontend cannot pass the release gate while silently dropping the page.
 */
export function contentStoreAssetErrors(entries, readText) {
  const present = new Set(entries.map(entry => String(entry).replace(/\\/g, '/').replace(/^\/+/, '')))
  const errors = []
  const routeEntry = 'frontend/.output/public/content-store/index.html'
  if (!present.has(routeEntry)) errors.push('Content Store static route entry is missing')

  const routeManifestEntries = [...present].filter(entry => (
    entry.startsWith('frontend/.output/public/_nuxt/') && entry.endsWith('.js')
  ))
  let pageChunkEntry = null
  let foundRouteManifest = false
  for (const entry of routeManifestEntries) {
    const source = String(readText(entry))
    if (!/name:[`"']content-store[`"']/.test(source)) continue
    foundRouteManifest = true
    const match = source.match(
      /name:[`"']content-store[`"'][\s\S]{0,180}?path:[`"']\/content-store[`"'][\s\S]{0,320}?import\([`"']\.\/([^`"']+\.js)[`"']\)/,
    )
    if (match) {
      pageChunkEntry = `frontend/.output/public/_nuxt/${match[1]}`
      break
    }
  }
  if (!foundRouteManifest) errors.push('Content Store client route manifest is missing')
  else if (!pageChunkEntry) errors.push('Content Store lazy page chunk mapping is missing')
  else if (!present.has(pageChunkEntry)) errors.push(`Content Store lazy page chunk is missing: ${pageChunkEntry}`)
  return errors
}

export function localStartupPath(publicRoot, reference) {
  if (!reference || /^(?:[a-z]+:|#|\/\/)/i.test(reference)) return null
  const clean = reference.split(/[?#]/, 1)[0]
  if (!clean) return null
  return path.join(publicRoot, clean.replace(/^\/+/, ''))
}

export function forbiddenPackageEntry(rawEntry) {
  const entry = String(rawEntry).replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = entry.split('/')
  const basename = segments.at(-1) || ''

  if (segments.some((part) => ['__tests__', 'tests', 'test', 'logs'].includes(part))) return true
  if (segments.some((part) => ['.story-studio-data', '.preview-cache', '.style-previews'].includes(part))) return true
  if (/^\.env(?:\.|$)/i.test(basename)) return true
  if (/\.(?:db|db-wal|db-shm|sqlite|sqlite3|log|map)$/i.test(basename)) return true
  if (/^(?:app-secrets|secrets|app-settings|last-session|migrations|jobs)\.json(?:\.|$)/i.test(basename)) return true
  return false
}

export function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function validateServiceBaseUrl(rawUrl, { allowPlainHttpForLoopbackOnly = true } = {}) {
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    return 'must be an absolute HTTP(S) URL'
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'must use HTTP or HTTPS'
  if (parsed.username || parsed.password) return 'must not contain credentials'
  if (parsed.search || parsed.hash) return 'must not contain a query string or fragment'
  if (parsed.pathname && parsed.pathname !== '/') return 'must be an origin without a path'
  if (allowPlainHttpForLoopbackOnly && parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return 'must use HTTPS unless the host is loopback'
  }
  return null
}

export function walkFiles(root) {
  if (!fs.existsSync(root)) return []
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  visit(root)
  return files
}
