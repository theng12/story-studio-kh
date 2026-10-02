import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/GenStudioCatalogSettings.vue', import.meta.url)),
  'utf8',
)

describe('Gateway catalog diagnostics', () => {
  test('shows live catalog health without reviving retired access controls', () => {
    assert.match(source, /GenStudio Catalog/)
    assert.match(source, /Connection/)
    assert.match(source, /Last refresh/)
    assert.match(source, /View catalog details/)
    assert.match(source, /Credits &amp; settlement/)
    assert.doesNotMatch(source, /GenStudio Catalog &amp; Access/)
    assert.doesNotMatch(source, /useGenStudioAccess|relaxed_concurrency|Unlimited Relaxed/)
    assert.doesNotMatch(source, /Save (?:catalog|pricing|model)/i)
  })

  test('loads music diagnostics instead of the retired voice list while keeping partial failures visible', () => {
    for (const endpoint of [
      'chat-models',
      'music-models',
      'transcription-models',
    ]) {
      assert.match(source, new RegExp(endpoint))
    }
    assert.match(source, /useGenStudioImageModels\(\)/)
    assert.match(source, /useGenStudioMediaModels\(\)/)
    assert.match(source, /Promise\.allSettled/)
    assert.match(source, /combinedErrors/)
    assert.match(source, /Music models/)
    assert.match(source, /provider_name/)
    assert.match(source, /Coming soon/)
    assert.match(source, /status-coming-soon/)
    assert.match(source, /item\.statusLabel/)
    assert.doesNotMatch(source, /app-settings\/genstudio\/voices/)
    assert.doesNotMatch(source, /label: 'Voices'/)
  })

  test('keeps account-locked products visible but excludes them from Available totals', () => {
    assert.match(source, /locked\?: boolean/)
    assert.match(source, /lock_reason\?: string \| null/)
    assert.match(source, /entry\.locked !== true/)
    assert.match(source, /statusLabel: .*'Locked'/)
    assert.match(source, /statusTone: .*'locked'/)
    assert.match(source, /item\.lockReason/)
    assert.match(source, /genStudioModelLockReason/)
  })
})
