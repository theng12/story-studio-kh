import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  DEFAULT_LOCAL_SIGNING_IDENTITY,
  localSigningConfig,
  localSigningIdentity,
  localSigningStatus,
  parseCodeSigningIdentities,
  persistentHelperBundles,
  requireLocalSigningIdentity,
  signatureErrors,
} from '../local-signing.mjs'

// Pure logic and a mocked process boundary only: no signing-certificate write, no build,
// no network, no signing. Temporary directories are left in place because this
// project never rm's files.

const HASH = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'
const OTHER_HASH = 'B1B2C3D4E5F60718293A4B5C6D7E8F9012345678'
// `security find-identity -p codesigning` without -v lists a self-signed,
// untrusted identity under "Matching identities" and repeats trusted ones under
// "Valid identities only".
const untrustedOutput = `Policy: Code Signing
  Matching identities
  1) ${HASH} "KH Studio Local Signing" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`
const trustedOutput = `  Matching identities
  1) ${HASH} "KH Studio Local Signing"
     1 identities found

  Valid identities only
  1) ${HASH} "KH Studio Local Signing"
     1 valid identities found
`
const emptyOutput = `  Matching identities
     0 identities found

  Valid identities only
     0 valid identities found
`
const ambiguousOutput = `  Matching identities
  1) ${HASH} "KH Studio Local Signing" (CSSMERR_TP_NOT_TRUSTED)
  2) ${OTHER_HASH} "KH Studio Local Signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found
`
const execReturning = (output, status = 0) => () => ({ status, stdout: output, stderr: '' })

describe('local signing identity discovery', () => {
  test('parses untrusted identities, dedupes the repeated valid section and keeps the warning', () => {
    assert.deepEqual(parseCodeSigningIdentities(trustedOutput), [
      { hash: HASH, name: 'KH Studio Local Signing', warning: null },
    ])
    assert.deepEqual(parseCodeSigningIdentities(untrustedOutput), [
      { hash: HASH, name: 'KH Studio Local Signing', warning: 'CSSMERR_TP_NOT_TRUSTED' },
    ])
    assert.deepEqual(parseCodeSigningIdentities(emptyOutput), [])
    assert.deepEqual(parseCodeSigningIdentities('  1) not-a-hash "Other"\n'), [])
  })

  test('accepts the self-signed identity that only the no -v listing finds', () => {
    const status = localSigningStatus({ exec: execReturning(untrustedOutput) })
    assert.equal(status.valid, true)
    assert.equal(status.hash, HASH)
    assert.equal(status.warning, 'CSSMERR_TP_NOT_TRUSTED')
    assert.equal(status.identity, DEFAULT_LOCAL_SIGNING_IDENTITY)
  })

  test('a missing identity fails loudly, with no ad-hoc fallback', () => {
    const status = localSigningStatus({ exec: execReturning(emptyOutput) })
    assert.equal(status.valid, false)
    assert.match(status.reason, /KH Studio Local Signing/)
    assert.match(status.reason, /self-signed certificate is fine/)
    assert.match(status.reason, /No ad-hoc fallback/)
  })

  test('two certificates with the same name are ambiguous, never silently chosen', () => {
    const status = localSigningStatus({ exec: execReturning(ambiguousOutput) })
    assert.equal(status.valid, false)
    assert.match(status.reason, /more than one code-signing identity/)
    assert.match(status.reason, /2 certificates/)
  })

  test('a failing security command is reported, never treated as valid', () => {
    const status = localSigningStatus({ exec: () => ({ status: 1, stdout: '', stderr: 'denied' }) })
    assert.equal(status.valid, false)
    assert.match(status.reason, /denied/)
  })

  test('the identity name is overridable without changing the default', () => {
    assert.equal(localSigningIdentity({}), DEFAULT_LOCAL_SIGNING_IDENTITY)
    assert.equal(localSigningIdentity({ STORY_LOCAL_SIGNING_IDENTITY: 'Other Identity' }), 'Other Identity')
  })
})

describe('normal-packager signing configuration', () => {
  test('reaches the mac.sign hook with the shared identity and forceCodeSigning', () => {
    const config = localSigningConfig({ exec: execReturning(untrustedOutput) })
    assert.equal(config.mac.identity, '-', 'electron-builder only calls mac.sign for "-"')
    assert.equal(config.mac.notarize, false)
    assert.match(config.mac.sign, /scripts\/release\/sign-mac\.cjs$/)
    assert.equal(config.forceCodeSigning, true)
  })

  test('missing identity fails loudly instead of falling back to ad-hoc', () => {
    assert.throws(
      () => localSigningConfig({ exec: execReturning(emptyOutput) }),
      /Cannot sign with the local identity: .*no code-signing identity/,
    )
    assert.throws(
      () => requireLocalSigningIdentity({ exec: execReturning(ambiguousOutput) }),
      /Cannot sign with the local identity: .*more than one/,
    )
  })

  test('requireLocalSigningIdentity returns the exact configured name', () => {
    assert.equal(requireLocalSigningIdentity({ exec: execReturning(untrustedOutput) }), DEFAULT_LOCAL_SIGNING_IDENTITY)
  })
})

describe('mac.sign hook', () => {
  const require = createRequire(import.meta.url)
  const hook = require('../sign-mac.cjs')

  test('exports a function for electron-builder and substitutes the identity', async () => {
    assert.equal(typeof hook, 'function')
    const calls = []
    const result = await hook.signWithLocalIdentity({
      opts: { app: '/tmp/Story.app', platform: 'darwin', type: 'distribution' },
      identity: DEFAULT_LOCAL_SIGNING_IDENTITY,
      signApp: async (options) => { calls.push(options); return 'signed' },
    })
    assert.equal(result, 'signed')
    assert.deepEqual(calls, [{
      app: '/tmp/Story.app',
      platform: 'darwin',
      type: 'distribution',
      identity: DEFAULT_LOCAL_SIGNING_IDENTITY,
      identityValidation: false,
    }])
  })

  test('never uses afterPack/afterSign or deep signing', () => {
    const source = fs.readFileSync(new URL('../sign-mac.cjs', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bafterPack\b|\bafterSign\b/)
    assert.doesNotMatch(source, /--deep/)
  })
})

describe('certificate signature requirements', () => {
  const goodDetails = [
    'Identifier=com.storystudio.kh',
    'Authority=KH Studio Local Signing',
    'TeamIdentifier=not set',
  ].join('\n')
  const goodRequirement = 'designated => identifier "com.storystudio.kh" and certificate leaf = H"aabbccdd"'

  test('accepts a strict certificate signature from the required identity', () => {
    assert.deepEqual(
      signatureErrors({ details: goodDetails, requirement: goodRequirement, identity: 'KH Studio Local Signing' }),
      [],
    )
  })

  test('rejects an ad-hoc signature and its cdhash requirement', () => {
    const errors = signatureErrors({
      details: 'Signature=adhoc\nIdentifier=com.storystudio.kh',
      requirement: 'designated => cdhash H"aabbccdd"',
      identity: 'KH Studio Local Signing',
    })
    assert.ok(errors.some((error) => /ad-hoc/.test(error)))
    assert.ok(errors.some((error) => /authority is \(none\)/.test(error)))
    assert.ok(errors.some((error) => /not certificate-based/.test(error)))
  })

  test('rejects a Developer ID signature when the local identity is required', () => {
    const errors = signatureErrors({
      details: 'Authority=Developer ID Application: Someone (TEAM123)\nTeamIdentifier=TEAM123',
      requirement: goodRequirement,
      identity: 'KH Studio Local Signing',
    })
    assert.ok(errors.some((error) => /expected "KH Studio Local Signing"/.test(error)))
  })
})

describe('persistent helper inventory', () => {
  test('lists nested app bundles under Contents/Frameworks only', () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-helpers-'))
    const frameworks = path.join(appPath, 'Contents', 'Frameworks')
    fs.mkdirSync(path.join(frameworks, 'Story Studio KH Helper.app'), { recursive: true })
    fs.mkdirSync(path.join(frameworks, 'Electron Framework.framework'), { recursive: true })
    fs.writeFileSync(path.join(frameworks, 'not-a-bundle.txt'), '')

    assert.deepEqual(persistentHelperBundles(appPath), [
      path.join(frameworks, 'Story Studio KH Helper.app'),
    ])
    assert.deepEqual(persistentHelperBundles(path.join(appPath, 'missing')), [])
  })
})
