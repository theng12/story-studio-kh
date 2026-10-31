import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatDigestMessage } from '../services/digest-formatter.js'
import type { DigestData } from '../services/digest-builder.js'

function digest(overrides: Partial<DigestData> = {}): DigestData {
  return {
    generated_at: '2026-07-14T01:00:00.000Z',
    local_today_ymd: '2026-07-14',
    local_today_label: 'Tue, Jul 14, 2026',
    projects: [],
    totals: { going_live_today: 0, scheduled_future: 0, not_uploaded: 0, uploaded: 0 },
    ...overrides,
  }
}

describe('daily production brief wording', () => {
  test('states free disk, and says so when it could not be read', () => {
    assert.match(formatDigestMessage(digest({ free_disk_bytes: 41_500_000_000 })).body, /Free disk: 41\.5 GB$/)
    assert.match(formatDigestMessage(digest({ free_disk_bytes: 0 })).body, /Free disk: 0\.0 GB$/)
    assert.match(formatDigestMessage(digest({ free_disk_bytes: null })).body, /Free disk: could not be read$/)
  })

  test('keeps an inactive fleet neutral and free of decorative emoji', () => {
    const payload = formatDigestMessage(digest())

    assert.equal(payload.title, 'Daily production brief — Tue, Jul 14, 2026')
    assert.equal(payload.body, 'Nothing is scheduled across your projects.')
    assert.doesNotMatch(`${payload.title}${payload.body}`, /[📺🚀📅🏖📦⚠️📊]/u)
  })

  test('summarizes publishing, schedule coverage, and upload backlog once', () => {
    const payload = formatDigestMessage(digest({
      projects: [{
        slug: 'night-tales',
        name: 'Night Tales',
        going_live_today: [{ episode_code: 'DK0040', scheduled_for: '2026-07-14T09:00:00.000Z' }],
        total_scheduled_future: 2,
        total_scheduled_past: 10,
        total_not_uploaded: 3,
        total_uploaded: 12,
        next_scheduled: { episode_code: 'DK0040', scheduled_for: '2026-07-14T09:00:00.000Z' },
        last_scheduled: { episode_code: 'DK0041', scheduled_for: '2026-07-18T09:00:00.000Z' },
      }],
      totals: { going_live_today: 1, scheduled_future: 2, not_uploaded: 3, uploaded: 12 },
    }))

    assert.match(payload.body, /Night Tales/)
    assert.match(payload.body, /Publishing today: DK0040 at/)
    assert.match(payload.body, /Schedule: 2 future upload\(s\).*coverage through/)
    assert.match(payload.body, /Awaiting upload: 3 accepted episode\(s\)/)
    assert.match(payload.body, /Schedule low: 2 future upload\(s\) remain/)
    assert.match(payload.body, /Across all projects: 1 publishing today · 2 scheduled · 3 awaiting upload/)
    assert.doesNotMatch(payload.body, /chill|time to make|Queue is thin/i)
  })
})
