import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectPublicReleaseCredentials,
  publicReleaseCredentialErrors,
} from '../public-release-credentials.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('public desktop release gate', () => {
  test('requires signing and one complete notarization credential set', () => {
    assert.equal(publicReleaseCredentialErrors({}).length, 2)
    assert.deepEqual(inspectPublicReleaseCredentials({
      CSC_LINK: 'certificate',
      APPLE_API_KEY: '/secure/key.p8',
      APPLE_API_KEY_ID: 'KEY',
      APPLE_API_ISSUER: 'ISSUER',
    }), {
      signingReady: true,
      notarizationReady: true,
      notarizationKind: 'api-key',
    })
  })

  test('public packaging signs, notarizes, staples, and verifies the finished artifacts', () => {
    const buildSource = fs.readFileSync(path.join(root, 'scripts/release/build-public-dmg.mjs'), 'utf8')
    const verifySource = fs.readFileSync(path.join(root, 'scripts/release/verify-signed-desktop-artifact.mjs'), 'utf8')
    assert.match(buildSource, /forceCodeSigning = true/)
    assert.match(buildSource, /notarize: true/)
    assert.match(buildSource, /notarytool', 'submit'/)
    assert.match(buildSource, /stapler', 'staple'/)
    assert.match(verifySource, /Developer ID Application/)
    assert.match(verifySource, /stapler', 'validate'/)
  })

  test('desktop packaging uses the lockfile-installed Electron runtime', () => {
    for (const script of ['build-public-dmg.mjs', 'build-unsigned-dmg.mjs']) {
      const source = fs.readFileSync(path.join(root, 'scripts/release', script), 'utf8')
      assert.match(source, /config\.electronDist = electronDist/)
      assert.match(source, /path\.join\(electronDist, 'Electron\.app'\)/)
    }
  })

  test('desktop runtime does not depend on the vulnerable extract-zip package', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    const electron = lock.packages?.['node_modules/electron']

    assert.ok(electron, 'package-lock.json must contain the Electron runtime')
    assert.equal(electron.dependencies?.['extract-zip'], undefined)
    assert.ok(
      electron.dependencies?.['@electron-internal/extract-zip'],
      'Electron must use its maintained internal archive extractor',
    )
  })
})
