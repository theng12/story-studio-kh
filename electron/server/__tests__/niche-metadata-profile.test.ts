/** Formula-owned metadata profiles must be present on every built-in Formula.
 * This keeps the Metadata page and queued generator from falling back to the
 * retired format-starter-template taxonomy. */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { useTempDataDir } from './_helpers.js'

let nicheLoader: typeof import('../services/niche-loader.js')
let tmp: { cleanup: () => Promise<void> }

describe('Formula metadata profiles', () => {
  before(async () => {
    tmp = await useTempDataDir()
    nicheLoader = await import('../services/niche-loader.js')
  })

  after(async () => { await tmp.cleanup() })

  test('active built-in Formulas resolve a complete YouTube publishing blueprint', async () => {
    // Owner ruling 2026-10-29: the Formula picker lists installed packs only, so
    // "every built-in" is read from the shipped sources through the compatibility
    // loader rather than from the catalogue list.
    const names = (await readdir(nicheLoader.BUILTIN_NICHES_DIR)).filter(name => name.endsWith('.json'))
    const shipped = (await Promise.all(names.map(async name =>
      (await nicheLoader.loadLegacyNiche(name.slice(0, -'.json'.length)))?.document ?? null)))
      .flatMap(document => (document ? [document] : []))
    const activeBuiltIns = shipped.filter(n => n.catalogStatus !== 'legacy')
    assert.ok(activeBuiltIns.length > 0)
    for (const formula of activeBuiltIns) {
      const profile = formula.metadataProfile
      assert.ok(profile, `${formula.id}: metadata profile is required`)
      assert.ok(profile!.label.length > 0, `${formula.id}: profile label`)
      assert.ok(profile!.description.length > 0, `${formula.id}: profile description`)
      assert.ok(profile!.descriptionSectionIds.length > 0, `${formula.id}: description shape`)
      assert.ok(profile!.descriptionMaxChars >= 200 && profile!.descriptionMaxChars <= 5000, `${formula.id}: description cap`)
      assert.ok(profile!.titleMaxLength >= 20 && profile!.titleMaxLength <= 200, `${formula.id}: title cap`)
      assert.ok(profile!.tagCount >= 1 && profile!.tagCount <= 50, `${formula.id}: tag count`)
    }
  })

  test('evidence Formulas include sources while calm Formulas omit pressure-oriented CTA blocks', async () => {
    const economics = await nicheLoader.loadNiche('business-economics')
    const sleep = await nicheLoader.loadNiche('sleep')
    assert.ok(economics?.metadataProfile?.descriptionSectionIds.includes('sources'))
    assert.deepEqual(sleep?.metadataProfile?.descriptionSectionIds, ['hook', 'hashtags'])
  })
})
