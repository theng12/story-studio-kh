import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectPublicReleaseCredentials,
  publicReleaseCredentialErrors,
} from '../public-release-credentials.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// The owner's home directory, assembled at runtime rather than written out, so
// this gate does not itself become the thing it forbids.
const OWNER_HOME = ['', 'Users', 'thengmacmini'].join('/')

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

  test('both packaging paths verify staged outputs before exposing them', () => {
    for (const script of ['build-public-dmg.mjs', 'build-unsigned-dmg.mjs']) {
      const source = fs.readFileSync(path.join(root, 'scripts/release', script), 'utf8')
      assert.match(source, /config\.directories = \{ \.\.\.config\.directories, output: buildDir \}/)
      assert.match(source, /path\.join\(buildDir, 'mac-arm64'/)
      assert.ok(source.indexOf('createDmgBuildDirectory(outputDir, trashDist)') < source.indexOf("['run', 'fetch:ffmpeg']"))
      assert.ok(source.indexOf('promoteDmgBuild(buildDir,') > source.lastIndexOf('restoreSourceManifests(root,'))
      assert.doesNotMatch(source, /fs\.rmSync|trashOldDmgs/)
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.dist, 'npm run dist:smoke')
    assert.equal(pkg.scripts['dist:retain'], 'python3 -I "$HOME/Developer/Shared Tools/portfolio/tools/release-dist.py"')
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

  /**
   * NOTHING IDENTIFYING SHIPS.
   *
   * Tracked files must refer to the owner's home directory as `<owner-home>`,
   * never by its real absolute path. The placeholder convention already existed
   * and a sweep had already scrubbed ~52 files, but the convention was only
   * ENFORCED for asset-provenance records — so nothing stopped the raw path
   * coming back. On 2026-08-29 it had: a planning document carried four literal
   * `<owner-home>/Developer/_handoffs/...` lines into main, and every one of the
   * 22 unmerged `codex/*` branches still carries the raw path in 8-22 files, so
   * any future harvest from one of them re-leaks it.
   *
   * The floor is the whole tracked tree, not a curated list, because a curated
   * list is exactly what let the planning document through.
   */
  test('no tracked file contains the owner\'s real home path', () => {
    let output = ''
    try {
      // No `-I`: binary files are searched too. Excluding them is the kind of
      // blind spot that makes a clean report meaningless.
      output = execFileSync('git', ['grep', '-l', '--', OWNER_HOME], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // `git grep` exits 1 with no output when nothing matches — the passing
      // case. Any other status is a broken gate, and a gate that cannot run
      // must fail rather than report clean.
      if (error.status !== 1) throw error
      output = error.stdout ?? ''
    }

    const offenders = output.split('\n').filter(Boolean)
    assert.deepEqual(
      offenders,
      [],
      'these tracked files name the owner\'s home directory; use the '
        + `"<owner-home>" placeholder instead:\n  ${offenders.join('\n  ')}`,
    )
  })
})
