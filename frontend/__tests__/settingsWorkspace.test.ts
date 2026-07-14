import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)),
  'utf8',
)

describe('Settings workspace navigation', () => {
  test('every Settings surface uses the shared modern panel shell', () => {
    const activeTabPanels = [...settingsSource.matchAll(/activeTab === '([^']+)'[^>]+class="([^"]+)"/g)]

    assert.equal(activeTabPanels.length, 17)
    for (const [, tabId, className] of activeTabPanels) {
      assert.match(className, /settings-panel/, `${tabId} must use the shared Settings panel`)
    }
  })

  test('Local Models is split into focused, non-stacking views', () => {
    for (const view of ['overview', 'hub', 'voice', 'image', 'chat']) {
      assert.match(settingsSource, new RegExp(`id: '${view}'`))
      assert.match(settingsSource, new RegExp(`localModelsView === '${view}'`))
    }

    assert.match(settingsSource, /aria-label="Local model setup sections"/)
  })

  test('model pricing is split by media type', () => {
    for (const view of ['image', 'audio', 'video']) {
      assert.match(settingsSource, new RegExp(`modelPricingView === '${view}'`))
    }

    assert.match(settingsSource, /aria-label="Model pricing categories"/)
  })

  test('Performance exposes compact profiles without hiding individual controls', () => {
    for (const profile of ['Gentle', 'Balanced', 'Fleet']) {
      assert.match(settingsSource, new RegExp(`label: '${profile}'`))
    }

    for (const section of ['Scripts & prompts', 'Images', 'Audio & TTS', 'Motion clips', 'Transcription']) {
      assert.match(settingsSource, new RegExp(section.replace('&', '&amp;')))
    }
    assert.match(settingsSource, /Save performance/)
  })

  test('Storage separates active destinations from optional maintenance and keeps retired migration out', () => {
    assert.match(settingsSource, /Storage control center/)
    assert.match(settingsSource, /Your storage map/)
    assert.match(settingsSource, /Optional storage split/)
    assert.match(settingsSource, /Advanced maintenance/)
    assert.match(settingsSource, /Current resume checkpoints, not legacy assets/)
    assert.doesNotMatch(settingsSource, /Legacy video assembly presets/)
    assert.doesNotMatch(settingsSource, /legacy-video-assembly-presets/)
  })
})
