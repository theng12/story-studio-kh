import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  genStudioPlanNotice,
  genStudioUnlimitedBadge,
  type GenStudioAccessStatus,
} from '../utils/genstudio-relaxed'

function access(overrides: Partial<GenStudioAccessStatus> = {}): GenStudioAccessStatus {
  return {
    plan_name: 'Angkor Pro',
    credit_balance: 500,
    relaxed_concurrency_limit: 3,
    relaxed_capacity_reported: true,
    activation: 'after-credit-exhaustion',
    api_eligibility: 'verified-by-genstudio-at-submission',
    plan_portal_available: false,
    plan_portal_url: null,
    ...overrides,
  }
}

describe('GenStudio Unlimited Relaxed guidance', () => {
  test('models without support never receive an Unlimited badge', () => {
    assert.equal(genStudioUnlimitedBadge(false, access()), null)
  })

  test('eligible models explain that credits are consumed before Relaxed capacity', () => {
    const badge = genStudioUnlimitedBadge(true, access())
    assert.equal(badge?.label, '∞ After credits')
    assert.match(badge?.title || '', /spends credits first/i)
    assert.match(badge?.title || '', /Angkor Pro/)
  })

  test('zero-credit accounts show current Relaxed eligibility', () => {
    const badge = genStudioUnlimitedBadge(true, access({ credit_balance: 0 }))
    assert.equal(badge?.label, '∞ Relaxed eligible')
    assert.match(badge?.title || '', /GenStudio verifies model and API eligibility/)
  })

  test('plans without capacity show upgrade guidance without blocking paid access', () => {
    const status = access({
      plan_name: 'Starter',
      relaxed_concurrency_limit: 0,
      relaxed_capacity_reported: false,
    })
    const badge = genStudioUnlimitedBadge(true, status)
    assert.equal(badge?.label, '∞ Plan required')
    assert.match(badge?.title || '', /Paid credits may still use it/)
    assert.match(genStudioPlanNotice(status), /does not report Unlimited Relaxed capacity/)
  })
})
