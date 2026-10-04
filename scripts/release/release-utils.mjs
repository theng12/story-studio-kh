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

// ── Packaged runtime dependency closure ─────────────────────────────────────
// v1.4.69. v1.4.68 shipped an app.asar with 72 node_modules entries and no
// express, because it was packaged from a worktree whose node_modules was a
// SYMLINK that electron-builder did not follow. Every structural check passed
// — signature, Info.plist, asar layout, DMG mounting — and the app still died
// on launch with ERR_MODULE_NOT_FOUND. Nothing asserted that the code the app
// imports was actually in the package.
//
// This walks the real dependency closure declared by the packaged
// package.json, resolving each name the way Node does (nearest node_modules
// first, then up the tree). It is derived entirely from the manifests, so it
// cannot rot the way a hardcoded file count or package allowlist would: add a
// dependency and it is covered on the next build with no edit here.

/**
 * Resolve `name` as Node would from a package living at `fromDir`
 * (a package-root-relative path such as '' or 'node_modules/a').
 * Returns the resolved directory, or null when nothing satisfies it.
 */
export function resolvePackagedDependency(name, fromDir, hasEntry) {
  const bases = []
  let cursor = fromDir.replace(/^\/+|\/+$/g, '')
  bases.push(cursor)
  while (cursor) {
    const idx = cursor.lastIndexOf('node_modules')
    if (idx < 0) break
    cursor = cursor.slice(0, idx).replace(/\/+$/, '')
    bases.push(cursor)
  }
  for (const base of bases) {
    const dir = base ? `${base}/node_modules/${name}` : `node_modules/${name}`
    if (hasEntry(`${dir}/package.json`)) return dir
  }
  return null
}

/**
 * Breadth-first walk of the production dependency closure.
 *
 * @param rootManifest  parsed package.json of the packaged app
 * @param hasEntry      (packageRelativePath) => boolean
 * @param readManifest  (packageDir) => parsed package.json | null
 * @returns { missing: [{ name, requiredBy }], resolved: Set<string> }
 */
export function packagedDependencyClosure(rootManifest, hasEntry, readManifest) {
  const missing = []
  const resolved = new Set()
  const seen = new Set()
  const queue = []

  const enqueue = (manifest, fromDir, requiredBy) => {
    for (const name of Object.keys(manifest?.dependencies || {})) {
      const key = `${fromDir}::${name}`
      if (seen.has(key)) continue
      seen.add(key)
      queue.push({ name, fromDir, requiredBy })
    }
  }

  enqueue(rootManifest, '', rootManifest?.name || 'package.json')

  while (queue.length) {
    const { name, fromDir, requiredBy } = queue.shift()
    const dir = resolvePackagedDependency(name, fromDir, hasEntry)
    if (!dir) {
      missing.push({ name, requiredBy })
      continue
    }
    if (resolved.has(dir)) continue
    resolved.add(dir)
    enqueue(readManifest(dir), dir, name)
  }

  return { missing, resolved }
}

/**
 * Refuse to package from a tree electron-builder cannot read dependencies
 * from. v1.4.68 was built in a scratch worktree whose node_modules was a
 * symlink; `node_modules/**` matched almost nothing, and the failure only
 * surfaced when the owner double-clicked the finished DMG. Catch it before
 * the twenty-minute build instead of after it.
 */
export function packagingTreeErrors(root) {
  const nodeModules = path.join(root, 'node_modules')
  let stat
  try {
    stat = fs.lstatSync(nodeModules)
  } catch {
    return [`node_modules is missing at ${nodeModules} — run \`npm ci\` before packaging`]
  }
  if (stat.isSymbolicLink()) {
    return [
      `node_modules at ${nodeModules} is a symlink. electron-builder does not follow it, so the packaged `
        + 'app would carry no runtime dependencies and would die at launch with ERR_MODULE_NOT_FOUND '
        + '(this is exactly what shipped as v1.4.68). Package from a checkout with a real node_modules directory.',
    ]
  }
  if (!stat.isDirectory()) return [`node_modules at ${nodeModules} is not a directory`]
  return []
}

/** The repository's own manifests, which packaging must never leave rewritten. */
const SOURCE_MANIFESTS = ['package.json', 'package-lock.json']

/**
 * Capture the checkout's manifests before electron-builder runs.
 *
 * NEW-11 was recorded as "packaging rewrites the repository's own `package.json` into its
 * trimmed shape — no `scripts`, no `devDependencies`". **That diagnosis was wrong**, and
 * corrected 2026-09-26 when the symptom recurred: during a real `dist:smoke` this guard
 * reported no rewrite at all, because electron-builder never touched the file. The actual
 * cause is an INSPECTION command:
 *
 *     npx asar extract-file "<app>.app/Contents/Resources/app.asar" package.json
 *
 * `asar extract-file` writes the named file into the CURRENT WORKING DIRECTORY, so run
 * from the repository root it overwrites the source manifest with the packaged one.
 * Reproduced on demand from a clean tree.
 *
 * The snapshot/restore is kept anyway — it is cheap, and a future electron-builder release
 * that does rewrite the file would otherwise go unnoticed. It is no longer the guard that
 * matters, though: `electron/server/__tests__/source-manifest-integrity.test.ts` is, because
 * it catches the shape however the file got that way.
 */
export function snapshotSourceManifests(root) {
  return SOURCE_MANIFESTS.map(rel => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }))
}

/**
 * Put back any manifest packaging changed. Returns the paths that differed, so
 * the caller can say what happened instead of restoring silently.
 */
export function restoreSourceManifests(root, snapshot) {
  const changed = []
  for (const { rel, text } of snapshot) {
    const file = path.join(root, rel)
    if (fs.readFileSync(file, 'utf8') === text) continue
    fs.writeFileSync(file, text)
    changed.push(rel)
  }
  return changed
}

/**
 * Move every DMG (and blockmap) in `outputDir` to `trashDist` with a timestamp
 * (owner's rule, 2026-09-26: old DMGs are never `rm`d). Creates `outputDir`
 * first: a fresh checkout or worktree has no `dist/` yet, and reading it crashed.
 */
export function trashOldDmgs(outputDir, trashDist, now = new Date()) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(trashDist, { recursive: true })
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (const entry of fs.readdirSync(outputDir)) {
    if (!entry.endsWith('.dmg') && !entry.endsWith('.dmg.blockmap')) continue
    // The stamp goes BEFORE the extension, so a trashed blockmap still reads as one:
    // `…-arm64-<stamp>.dmg.blockmap`. Stripping only the last extension left
    // `…-arm64.dmg-<stamp>.blockmap`, which reads as a blockmap of a `.dmg-…` file.
    const suffix = entry.endsWith('.blockmap') ? '.dmg.blockmap' : '.dmg'
    const stem = entry.slice(0, -suffix.length)
    fs.renameSync(path.join(outputDir, entry), path.join(trashDist, `${stem}-${stamp}${suffix}`))
  }
}
