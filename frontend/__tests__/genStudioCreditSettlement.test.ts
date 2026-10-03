import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(process.cwd(), '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('GenStudio credit settlement language', () => {
  it('separates charged, held, and returned credits in batch jobs', () => {
    const source = read('frontend/components/GenStudioBatchLedger.vue')

    assert.match(source, /chargedCredits/)
    assert.match(source, /heldCredits/)
    assert.match(source, /returnedCredits/)
    assert.match(source, /on hold/)
    assert.match(source, /charged/)
    assert.match(source, /returned/)
    assert.doesNotMatch(source, /settledLabel/)
  })

  it('shows only a published provisional hold and points to final Gateway settlement', () => {
    const source = read('frontend/components/GenStudioCreditSettlementHint.vue')

    assert.match(source, /[Tt]he Gateway has published a provisional reservation while this work settles/)
    assert.doesNotMatch(source, /releases their reservation|returns unused credits|not charged a second time/)
    assert.match(source, /to="\/usage"/)
    assert.match(source, /Credits &amp; settlement/)
  })

  it('shows the same reassurance for compact job ledgers', () => {
    const source = read('frontend/pages/projects/[slug]/jobs.vue')

    assert.equal((source.match(/GenStudioCreditSettlementHint/g) || []).length, 2)
    assert.match(source, /on hold/)
  })
})
