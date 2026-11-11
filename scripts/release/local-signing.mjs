import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// One shared local identity, proven on Library 0.7.5 (SIGNING.md). It is a
// name, not a credential: the private key stays in this Mac's login Keychain.
export const DEFAULT_LOCAL_SIGNING_IDENTITY = 'KH Studio Local Signing'
export const LOCAL_SIGNING_IDENTITY_ENV = 'STORY_LOCAL_SIGNING_IDENTITY'
export const LOCAL_SIGNING_HOOK_PATH = fileURLToPath(new URL('./sign-mac.cjs', import.meta.url))

export function localSigningIdentity(env = process.env) {
  return String(env[LOCAL_SIGNING_IDENTITY_ENV] || '').trim() || DEFAULT_LOCAL_SIGNING_IDENTITY
}

function defaultExec(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' })
}

/**
 * Parse `security find-identity -p codesigning` (no -v). Without -v the list
 * includes identities whose self-signed certificate is not trusted
 * (`CSSMERR_TP_NOT_TRUSTED`), and repeats them under "Valid identities only";
 * one hash is one certificate with its private key.
 */
export function parseCodeSigningIdentities(output) {
  const identities = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*(?:\(([^)]*)\))?\s*$/)
    if (!match) continue
    const hash = match[1].toUpperCase()
    if (!identities.has(hash)) {
      identities.set(hash, { hash, name: match[2], warning: match[3] || null })
    }
  }
  return [...identities.values()]
}

export function readCodeSigningIdentities({ exec = defaultExec } = {}) {
  const result = exec('security', ['find-identity', '-p', 'codesigning'])
  if (result.error) return { identities: [], error: result.error.message }
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    return { identities: [], error: output || `security exited ${result.status}` }
  }
  return {
    identities: parseCodeSigningIdentities(`${result.stdout || ''}${result.stderr || ''}`),
    error: null,
  }
}

/**
 * Read-only identity requirement. Discovery deliberately omits `-v`: the shared
 * identity is self-signed, so `find-identity -v` reports it as invalid and
 * electron-builder would skip signing entirely. Exactly one certificate with a
 * private key must carry the name; a self-signed trust warning is expected and
 * allowed. Nothing here changes trust or key access.
 */
export function localSigningStatus({ identity = localSigningIdentity(), exec = defaultExec } = {}) {
  const { identities, error } = readCodeSigningIdentities({ exec })
  const matches = identities.filter((entry) => entry.name === identity)
  if (matches.length === 1) {
    return {
      identity,
      valid: true,
      hash: matches[0].hash,
      warning: matches[0].warning,
      identities,
      reason: null,
    }
  }

  const detail = error
    ? ` (${error})`
    : matches.length
      ? `; ${matches.length} certificates with that name and a private key`
      : `; ${identities.length} code-signing identities found`
  return {
    identity,
    valid: false,
    hash: null,
    warning: null,
    identities,
    reason: matches.length
      ? `more than one code-signing identity named "${identity}"${detail}. Remove the duplicate; no identity is chosen for you.`
      : `no code-signing identity named "${identity}"${detail}. Create it once in this Mac's login Keychain; a self-signed certificate is fine. No ad-hoc fallback is used.`,
  }
}

/** The identity name, or a loud error naming the missing/ambiguous identity. */
export function requireLocalSigningIdentity({ identity = localSigningIdentity(), exec = defaultExec } = {}) {
  const status = localSigningStatus({ identity, exec })
  if (!status.valid) throw new Error(`Cannot sign with the local identity: ${status.reason}`)
  return status.identity
}

/**
 * The normal-packager signing settings, or a loud error naming the missing
 * identity. `identity: '-'` makes electron-builder call `mac.sign` even though
 * its trusted-identity search finds nothing; the hook substitutes the shared
 * certificate and disables identity validation. The packager signs nested code
 * and then the bundle — no hand-sealing and no `codesign --deep` signing.
 */
export function localSigningConfig({
  identity = localSigningIdentity(),
  exec = defaultExec,
  hookPath = LOCAL_SIGNING_HOOK_PATH,
} = {}) {
  const status = localSigningStatus({ identity, exec })
  if (!status.valid) throw new Error(`Cannot sign with the local identity: ${status.reason}`)
  return {
    status,
    mac: { identity: '-', sign: hookPath, notarize: false },
    forceCodeSigning: true,
  }
}

/**
 * Persistent helpers electron-builder signs before the app bundle. Comparing
 * their certificate-based designated requirements across two versions is the
 * proof that the identity stayed stable; this inventory is the reusable seam.
 */
export function persistentHelperBundles(appPath) {
  const bundles = []
  const frameworks = path.join(appPath, 'Contents', 'Frameworks')
  if (fs.existsSync(frameworks)) {
    bundles.push(...fs.readdirSync(frameworks, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => path.join(frameworks, entry.name)))
  }
  // One bundle carries the update and render helpers (owner naming rule, 2026-11-11).
  const named = path.join(appPath, 'Contents', 'Resources', 'Story Studio KH Helper.app')
  if (fs.existsSync(named)) bundles.push(named)
  return bundles.sort()
}

/**
 * Strict certificate-signature requirements for a local-signed artifact.
 * A certificate-based designated requirement (`certificate leaf = H"…"`) is
 * what survives a version change; an ad-hoc `cdhash` requirement does not.
 */
export function signatureErrors({ details, requirement, identity }) {
  const errors = []
  const text = String(details)
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())

  if (/^Signature=adhoc$/m.test(text)) {
    errors.push(`the code is ad-hoc signed; expected a certificate signature from "${identity}"`)
  }
  if (!authorities.includes(identity)) {
    const found = authorities.length ? authorities.map((authority) => `"${authority}"`).join(', ') : '(none)'
    errors.push(`the signature authority is ${found}, expected "${identity}"`)
  }
  if (!/certificate leaf = H"[0-9a-f]+"/i.test(String(requirement))) {
    errors.push('the designated requirement is not certificate-based (an ad-hoc cdhash requirement cannot stay stable across versions)')
  }
  return errors
}
