/**
 * Tests for the Brand loader (services/brand-loader.ts).
 *
 * Coverage:
 *   - loadBrand returns null for unknown id
 *   - loadBrand reads + validates a well-formed brand
 *   - loadBrand throws on malformed JSON
 *   - loadBrand throws when required fields missing
 *   - listBrands returns sorted, skipping malformed files (warn)
 *   - listBrands returns empty list when .brands/ doesn't exist
 *   - mtime cache invalidates on file edit
 *   - getEffectiveBrandFor returns null when project.brand_id unset
 *   - getEffectiveBrandFor returns null + warns when brand file missing
 *   - getEffectiveBrandFor returns the brand for a valid project
 *
 * IMPORTANT — module-load ordering: same constraint as format-loader.test.ts.
 * STORY_STUDIO_DATA_DIR must be set before brand-loader (or its deps) imports.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let loader: typeof import('../services/brand-loader.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

function makeBrand(overrides: Record<string, any> = {}): any {
  return {
    id: 'demo',
    name: 'Demo Brand',
    schemaVersion: 1,
    channel: { name: 'Demo Channel' },
    ...overrides,
  }
}

describe('brand-loader', () => {
  before(async () => {
    tmp = await useTempDataDir()
    loader = await import('../services/brand-loader.js')
    pm = await import('../services/project-manager.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'),
      'PROJECTS_ROOT must point at temp dir — env was set too late')
  })

  after(async () => {
    await tmp.cleanup()
  })

  beforeEach(async () => {
    loader._clearBrandCaches()
    // Reset .brands/ between tests so each starts clean
    const brandsDir = path.join(pm.PROJECTS_ROOT, '.brands')
    await fs.rm(brandsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('loadBrand returns null for unknown id', async () => {
    const brand = await loader.loadBrand('does-not-exist')
    assert.equal(brand, null)
  })

  test('loadBrand returns null for empty id', async () => {
    const brand = await loader.loadBrand('')
    assert.equal(brand, null)
  })

  test('loadBrand reads + validates a well-formed brand', async () => {
    await loader.ensureBrandsDir()
    await fs.writeFile(loader.brandFilePath('demo'), JSON.stringify(makeBrand()))
    const brand = await loader.loadBrand('demo')
    assert.ok(brand, 'should load')
    assert.equal(brand!.id, 'demo')
    assert.equal(brand!.name, 'Demo Brand')
    assert.equal(brand!.channel?.name, 'Demo Channel')
  })

  test('loadBrand throws on malformed JSON', async () => {
    await loader.ensureBrandsDir()
    await fs.writeFile(loader.brandFilePath('broken'), '{ not valid json')
    await assert.rejects(
      () => loader.loadBrand('broken'),
      /Brand JSON parse failed/,
    )
  })

  test('loadBrand throws when required fields missing', async () => {
    await loader.ensureBrandsDir()
    await fs.writeFile(loader.brandFilePath('incomplete'), JSON.stringify({ id: 'incomplete' }))
    await assert.rejects(
      () => loader.loadBrand('incomplete'),
      /missing required fields/,
    )
  })

  test('listBrands returns empty when .brands/ does not exist', async () => {
    const brands = await loader.listBrands()
    assert.deepEqual(brands, [])
  })

  test('listBrands returns sorted by name, skips malformed', async () => {
    await loader.ensureBrandsDir()
    await fs.writeFile(loader.brandFilePath('zed'), JSON.stringify(makeBrand({ id: 'zed', name: 'Zebra' })))
    await fs.writeFile(loader.brandFilePath('alpha'), JSON.stringify(makeBrand({ id: 'alpha', name: 'Alpha' })))
    await fs.writeFile(loader.brandFilePath('broken'), '{ not valid json')

    // Suppress the expected warn so test output stays clean
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const brands = await loader.listBrands()
      assert.equal(brands.length, 2, 'malformed file is skipped')
      assert.deepEqual(brands.map(b => b.id), ['alpha', 'zed'], 'sorted by name')
    } finally {
      console.warn = origWarn
    }
  })

  test('mtime cache invalidates on file edit', async () => {
    await loader.ensureBrandsDir()
    const file = loader.brandFilePath('demo')
    await fs.writeFile(file, JSON.stringify(makeBrand({ name: 'First' })))
    const first = await loader.loadBrand('demo')
    assert.equal(first!.name, 'First')

    // Bump mtime explicitly — fs.writeFile alone may share an mtime tick
    // on fast disks, defeating the cache-invalidation check.
    await fs.writeFile(file, JSON.stringify(makeBrand({ name: 'Second' })))
    const future = new Date(Date.now() + 5_000)
    await fs.utimes(file, future, future)

    const second = await loader.loadBrand('demo')
    assert.equal(second!.name, 'Second', 'cache must invalidate on mtime change')
  })

  test('getEffectiveBrandFor returns null when project.brand_id is unset', async () => {
    const project: any = { slug: 'no-brand', name: 'No Brand' }
    const brand = await loader.getEffectiveBrandFor(project)
    assert.equal(brand, null)
  })

  test('getEffectiveBrandFor returns null + warns when brand file is missing', async () => {
    const project: any = { slug: 'dangling', name: 'Dangling', brand_id: 'ghost' }
    const origWarn = console.warn
    let warned = false
    console.warn = (msg: string) => { if (typeof msg === 'string' && msg.includes('ghost')) warned = true }
    try {
      const brand = await loader.getEffectiveBrandFor(project)
      assert.equal(brand, null)
      assert.equal(warned, true, 'should warn about missing brand file')
    } finally {
      console.warn = origWarn
    }
  })

  test('getEffectiveBrandFor returns the brand for a valid project', async () => {
    await loader.ensureBrandsDir()
    await fs.writeFile(loader.brandFilePath('demo'), JSON.stringify(makeBrand()))
    const project: any = { slug: 'p1', name: 'P1', brand_id: 'demo' }
    const brand = await loader.getEffectiveBrandFor(project)
    assert.ok(brand)
    assert.equal(brand!.id, 'demo')
  })

  test('invalidateBrandCache drops a single entry', async () => {
    await loader.ensureBrandsDir()
    const file = loader.brandFilePath('demo')
    await fs.writeFile(file, JSON.stringify(makeBrand({ name: 'First' })))
    await loader.loadBrand('demo')

    // Edit + bump mtime AND invalidate → reads new content even on
    // disks where mtime might land on the same tick.
    await fs.writeFile(file, JSON.stringify(makeBrand({ name: 'Second' })))
    loader.invalidateBrandCache('demo')
    const fresh = await loader.loadBrand('demo')
    assert.equal(fresh!.name, 'Second')
  })
})
