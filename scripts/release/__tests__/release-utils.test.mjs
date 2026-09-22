import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compareVersions,
  contentStoreAssetErrors,
  expandArtifactName,
  forbiddenPackageEntry,
  parseChangelog,
  remoteStartupReferences,
  packagedDependencyClosure,
  packagingTreeErrors,
  resolvePackagedDependency,
  restoreSourceManifests,
  snapshotSourceManifests,
  validateServiceBaseUrl,
} from '../release-utils.mjs'

describe('release utility contracts', () => {
  test('parses the exact changelog shape used by What\'s New', () => {
    const entries = parseChangelog([
      '# Changelog',
      '',
      '## v1.2.3 — 2026-07-23',
      '',
      '- Current details',
      '',
      '## v1.2.2 — 2026-07-22',
      '- Previous details',
    ].join('\n'))
    assert.deepEqual(entries, [
      { version: '1.2.3', date: '2026-07-23', body: '- Current details' },
      { version: '1.2.2', date: '2026-07-22', body: '- Previous details' },
    ])
  })

  test('compares semantic release versions numerically', () => {
    assert.ok(compareVersions('1.10.0', '1.9.99') > 0)
    assert.equal(compareVersions('1.0.668', '1.0.668'), 0)
  })

  test('expands the checked artifact name without shell interpolation', () => {
    assert.equal(
      expandArtifactName('${productName} ${version}-${arch}.${ext}', {
        productName: 'Story Studio KH', version: '1.2.3', arch: 'arm64', ext: 'dmg',
      }),
      'Story Studio KH 1.2.3-arm64.dmg',
    )
  })

  test('detects remote startup dependencies but permits local assets', () => {
    const html = '<link href="/_nuxt/a.css"><script src="https://cdn.invalid/a.js"></script>'
    assert.deepEqual(remoteStartupReferences(html), ['https://cdn.invalid/a.js'])
  })

  test('requires the generated Content Store route and lazy page chunk in release inputs', () => {
    const contents = new Map([
      ['frontend/.output/public/_nuxt/routes.js', 'name:`content-store`,path:`/content-store`,component:()=>import(`./content-store-page.js`)'],
      ['frontend/.output/public/_nuxt/content-store-page.js', 'Content Store'],
    ])
    const entries = [
      'frontend/.output/public/content-store/index.html',
      ...contents.keys(),
    ]
    const readText = entry => contents.get(entry) || ''

    assert.deepEqual(contentStoreAssetErrors(entries, readText), [])
    assert.match(
      contentStoreAssetErrors(entries.filter(entry => !entry.endsWith('content-store-page.js')), readText).join('\n'),
      /lazy page chunk is missing/,
    )
    assert.match(
      contentStoreAssetErrors(entries.filter(entry => entry !== 'frontend/.output/public/content-store/index.html'), readText).join('\n'),
      /static route entry is missing/,
    )
  })

  test('rejects secret, database, test, map, log, and generated-data package entries', () => {
    for (const entry of [
      '.env.production', 'cache.sqlite', 'electron/dist/server/__tests__/x.js',
      'electron/dist/main.js.map', 'logs/server.log', '.story-studio-data/projects/a.json',
      'app-secrets.json', 'jobs.json',
    ]) assert.equal(forbiddenPackageEntry(entry), true, entry)
    assert.equal(forbiddenPackageEntry('electron/dist/server/services/app-secrets-store.js'), false)
  })

  test('accepts loopback HTTP and public HTTPS GenStudio origins only', () => {
    assert.equal(validateServiceBaseUrl('http://127.0.0.1:8000'), null)
    assert.equal(validateServiceBaseUrl('https://api.example.com'), null)
    assert.match(validateServiceBaseUrl('http://api.example.com'), /HTTPS/)
    assert.match(validateServiceBaseUrl('https://api.example.com/v1'), /without a path/)
    assert.match(validateServiceBaseUrl('file:///Users/dev/server'), /HTTP/)
  })
})

// v1.4.69 — v1.4.68 shipped an app.asar with no express in it and every
// existing check passed. These pin the two guards that now make that
// impossible, so neither can be quietly weakened later.
describe('packaged runtime dependency guard', () => {
  const closureOf = (entries, manifests) => {
    const set = new Set(entries)
    return packagedDependencyClosure(
      manifests[''],
      (relative) => set.has(relative),
      (dir) => manifests[dir] || null,
    )
  }

  test('rejects the exact v1.4.68 shape: a manifest whose dependencies are absent', () => {
    const { missing, resolved } = closureOf(
      ['package.json', 'electron/dist/server/app.js', 'node_modules/argparse/package.json'],
      { '': { name: 'story-studio-kh', dependencies: { express: '^5.0.0', sharp: '^0.34.0' } } },
    )
    assert.equal(resolved.size, 0)
    assert.deepEqual(missing.map((entry) => entry.name).sort(), ['express', 'sharp'])
    assert.equal(missing[0].requiredBy, 'story-studio-kh')
  })

  test('accepts a complete tree and follows it transitively', () => {
    const manifests = {
      '': { name: 'story-studio-kh', dependencies: { express: '^5.0.0' } },
      'node_modules/express': { name: 'express', dependencies: { 'body-parser': '^2.0.0' } },
      'node_modules/body-parser': { name: 'body-parser', dependencies: {} },
    }
    const { missing, resolved } = closureOf(
      ['node_modules/express/package.json', 'node_modules/body-parser/package.json'],
      manifests,
    )
    assert.deepEqual(missing, [])
    assert.equal(resolved.size, 2)
  })

  test('a dependency of a dependency going missing still fails the build', () => {
    const manifests = {
      '': { name: 'story-studio-kh', dependencies: { express: '^5.0.0' } },
      'node_modules/express': { name: 'express', dependencies: { 'body-parser': '^2.0.0' } },
    }
    const { missing } = closureOf(['node_modules/express/package.json'], manifests)
    assert.deepEqual(missing, [{ name: 'body-parser', requiredBy: 'express' }])
  })

  test('resolves nested copies the way Node does, nearest first then upward', () => {
    const set = new Set([
      'node_modules/a/node_modules/debug/package.json',
      'node_modules/debug/package.json',
    ])
    const has = (relative) => set.has(relative)
    assert.equal(resolvePackagedDependency('debug', 'node_modules/a', has), 'node_modules/a/node_modules/debug')
    assert.equal(resolvePackagedDependency('debug', 'node_modules/b', has), 'node_modules/debug')
    assert.equal(resolvePackagedDependency('nope', 'node_modules/a', has), null)
  })
})

describe('packaging tree guard', () => {
  test('refuses a symlinked node_modules, which electron-builder will not follow', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-tree-'))
    try {
      const real = path.join(sandbox, 'real')
      const worktree = path.join(sandbox, 'worktree')
      fs.mkdirSync(path.join(real, 'node_modules'), { recursive: true })
      fs.mkdirSync(worktree)
      fs.symlinkSync(path.join(real, 'node_modules'), path.join(worktree, 'node_modules'))

      assert.deepEqual(packagingTreeErrors(real), [])
      const errors = packagingTreeErrors(worktree)
      assert.equal(errors.length, 1)
      assert.match(errors[0], /symlink/)
      assert.match(packagingTreeErrors(sandbox)[0], /missing/)
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })
  test('packaging cannot leave the checkout\'s own manifests rewritten', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'source-manifests-'))
    try {
      const original = JSON.stringify({
        name: 'story-studio-kh', version: '1.4.218',
        scripts: { build: 'node build.mjs' }, devDependencies: { typescript: '~5.9.2' },
      }, null, 2)
      const lockOriginal = JSON.stringify({ name: 'story-studio-kh', version: '1.4.218', packages: {} }, null, 2)
      fs.writeFileSync(path.join(sandbox, 'package.json'), original)
      fs.writeFileSync(path.join(sandbox, 'package-lock.json'), lockOriginal)

      const snapshot = snapshotSourceManifests(sandbox)
      assert.deepEqual(snapshot.map(entry => entry.rel), ['package.json', 'package-lock.json'])

      // The exact damage observed after `npm run dist:smoke` (NEW-11): the manifest
      // is replaced with electron-builder's trimmed packaging shape.
      fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({
        name: 'story-studio-kh', version: '1.4.218', dependencies: { express: '~5.2.1' },
      }, null, 2))

      const restored = restoreSourceManifests(sandbox, snapshot)
      assert.deepEqual(restored, ['package.json'], 'only the rewritten manifest is reported')
      assert.equal(fs.readFileSync(path.join(sandbox, 'package.json'), 'utf8'), original)
      assert.equal(fs.readFileSync(path.join(sandbox, 'package-lock.json'), 'utf8'), lockOriginal)

      // A second call is a no-op: the guard must not keep rewriting healthy files.
      assert.deepEqual(restoreSourceManifests(sandbox, snapshot), [])
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
