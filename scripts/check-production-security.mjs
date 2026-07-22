import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const failures = []

function requireText(file, pattern, message) {
  const source = read(file)
  if (!pattern.test(source)) failures.push(`${file}: ${message}`)
}

function forbidText(file, pattern, message) {
  const source = read(file)
  if (pattern.test(source)) failures.push(`${file}: ${message}`)
}

const main = 'electron/main.ts'
requireText(main, /nodeIntegration:\s*false/, 'nodeIntegration must stay disabled')
requireText(main, /contextIsolation:\s*true/, 'contextIsolation must stay enabled')
requireText(main, /sandbox:\s*true/, 'renderer sandbox must be explicit')
requireText(main, /webSecurity:\s*true/, 'webSecurity must stay enabled')
requireText(main, /allowRunningInsecureContent:\s*false/, 'mixed insecure content must stay disabled')
requireText(main, /webviewTag:\s*false/, 'webview tags must stay disabled')
requireText(main, /devTools:\s*isDev/, 'DevTools must be unavailable in packaged builds')
requireText(main, /setWindowOpenHandler/, 'new-window requests need an explicit deny handler')
requireText(main, /will-navigate/, 'top-level navigation needs an allowlist')
requireText(main, /will-redirect/, 'redirect navigation needs an allowlist')
requireText(main, /will-attach-webview/, 'webview attachment must be denied')
forbidText(main, /writeHeapSnapshot/, 'heap snapshots can contain API keys and customer content')
forbidText(main, /\bcrashReporter\b|\bprocess\.report\b/, 'automatic crash reports can contain API keys and customer content')

const packageManifest = JSON.parse(read('package.json'))
const installedPackages = {
  ...(packageManifest.dependencies || {}),
  ...(packageManifest.devDependencies || {}),
  ...(packageManifest.optionalDependencies || {}),
}
for (const telemetryPackage of [
  '@sentry/electron', '@sentry/node', '@sentry/vue', 'posthog-js',
  'mixpanel', 'mixpanel-browser', '@segment/analytics-node', '@segment/analytics-next',
]) {
  if (installedPackages[telemetryPackage]) {
    failures.push(`package.json: telemetry dependency ${telemetryPackage} requires an explicit privacy review`)
  }
}

const preload = 'electron/preload.cjs'
forbidText(preload, /\bipcRenderer\b|\bremote\b/, 'preload must not expose Electron or IPC capabilities')
requireText(preload, /contextBridge\.exposeInMainWorld\('electron',\s*\{\s*isElectron:\s*true\s*,?\s*\}\)/s,
  'preload may expose only the immutable Electron marker')

const appSource = read('electron/server/app.ts')
const hostGuard = appSource.indexOf('app.use(requireAllowedHost(SERVER_MODE))')
const headers = appSource.indexOf('app.use(applySecurityHeaders)')
const routes = appSource.indexOf('mountRoutes(app)')
if (hostGuard < 0 || headers < 0 || routes < 0 || hostGuard > routes || headers > routes) {
  failures.push('electron/server/app.ts: host guard and security headers must run before protected routes')
}

const policy = read('electron/server/lib/security.ts')
if (/unsafe-eval/i.test(policy)) failures.push('electron/server/lib/security.ts: CSP must never allow unsafe-eval')
for (const directive of ["object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'"]) {
  if (!policy.includes(directive)) failures.push(`electron/server/lib/security.ts: CSP is missing ${directive}`)
}

const builder = JSON.parse(read('electron-builder.json'))
const packaged = Array.isArray(builder.files) ? builder.files : []
const requiredExclusions = [
  '!**/.env*', '!**/*.db', '!**/*.sqlite', '!**/app-secrets.json*',
  '!**/secrets.json*', '!**/jobs.json', '!**/logs/**', '!**/__tests__/**',
  '!**/*.map', '!electron/.story-studio-data/**', '!electron/.preview-cache/**',
]
for (const exclusion of requiredExclusions) {
  if (!packaged.includes(exclusion)) failures.push(`electron-builder.json: missing privacy exclusion ${exclusion}`)
}

const resourceSources = (builder.extraResources || []).map((entry) => String(entry?.from || ''))
for (const source of resourceSources) {
  if (/(?:^|\/)(?:\.env|logs?|projects?|episodes?|app-secrets\.json|secrets\.json|jobs\.json)(?:$|\/)/i.test(source)) {
    failures.push(`electron-builder.json: unsafe extraResource source ${source}`)
  }
}

const templateResource = (builder.extraResources || []).find((entry) => entry?.from === 'electron/templates')
const templateFilters = Array.isArray(templateResource?.filter) ? templateResource.filter : []
for (const exclusion of [
  '!**/.env*', '!**/*.db', '!**/*.sqlite', '!**/app-secrets.json*',
  '!**/secrets.json*', '!**/jobs.json', '!**/logs/**', '!**/generated/**',
]) {
  if (!templateFilters.includes(exclusion)) {
    failures.push(`electron-builder.json: template extraResources is missing privacy exclusion ${exclusion}`)
  }
}

const shouldScanBuilt = process.argv.includes('--built')
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.txt', '.md', '.xml', '.yml', '.yaml'])
const secretPattern = /\b(?:gsk_[A-Za-z0-9._-]{12,}|sk-or-v1-[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9._-]{20,})\b/
const home = os.homedir()
const developerPaths = [root, path.join(home, 'pinokio'), path.join(home, '.pinokio')]

function scanTree(dir) {
  if (!fs.existsSync(dir)) {
    failures.push(`${path.relative(root, dir)}: built output is missing`)
    return
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const relative = path.relative(root, full)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'tests' || entry.name === 'test') continue
      scanTree(full)
      continue
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue
    if (entry.name.endsWith('.map') || fs.statSync(full).size > 5 * 1024 * 1024) continue
    const source = fs.readFileSync(full, 'utf8')
    for (const developerPath of developerPaths) {
      if (developerPath && source.includes(developerPath)) {
        failures.push(`${relative}: embeds developer-only path ${developerPath}`)
      }
    }
    if (secretPattern.test(source)) failures.push(`${relative}: contains a value shaped like a live API key`)
  }
}

if (shouldScanBuilt) {
  scanTree(path.join(root, 'electron', 'dist'))
  scanTree(path.join(root, 'frontend', '.output', 'public'))
}

if (failures.length) {
  console.error('Production security check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Production security check passed${shouldScanBuilt ? ' (including built output)' : ''}.`)
