import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  contentStoreAssetErrors,
  expandArtifactName,
  forbiddenPackageEntry,
  parseChangelog,
  remoteStartupReferences,
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
