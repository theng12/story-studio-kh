/** Formula-owned metadata profiles must be present on every built-in Formula.
 * This keeps the Metadata page and queued generator from falling back to the
 * retired format-starter-template taxonomy. */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
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
    const formulas = await nicheLoader.listNiches()
    const activeBuiltIns = formulas.filter(n => n.builtin && n.catalogStatus !== 'legacy')
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
