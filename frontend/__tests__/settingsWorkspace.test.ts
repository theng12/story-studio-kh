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

    assert.equal(activeTabPanels.length, 15)
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

  test('Video Studio owns its live model catalog instead of project settings', () => {
    assert.match(settingsSource, /Video Studio owns provider setup, availability, pricing, and model retirement/)
    assert.match(settingsSource, /refresh_video_models=1/)
    assert.match(settingsSource, /Refresh live catalog/)
    assert.doesNotMatch(settingsSource, /Save Video Pricing/)
    assert.doesNotMatch(settingsSource, /video_models: editVideoModels/)
  })

  test('Performance exposes compact profiles without hiding individual controls', () => {
    for (const profile of ['Gentle', 'Balanced', 'Fleet']) {
      assert.match(settingsSource, new RegExp(`label: '${profile}'`))
    }

    for (const section of ['Scripts & prompts', 'Images', 'Audio & TTS', 'Motion clips', 'Transcription']) {
      assert.match(settingsSource, new RegExp(section.replace('&', '&amp;')))
    }
    assert.match(settingsSource, /GenStudio request safeguards/)
    assert.match(settingsSource, /GenStudio remains authoritative for provider capacity, credits, and settlement/)
    assert.match(settingsSource, /GenStudio chooses the qualified provider or fleet route/)
    assert.doesNotMatch(settingsSource, /Local Studio work automatically uses the available fleet/)
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

  test('Notifications stages changes and guides setup through modern channel controls', () => {
    assert.match(settingsSource, /Notification center/)
    assert.match(settingsSource, /notification-status-grid/)
    assert.match(settingsSource, /Set up Telegram/)
    assert.match(settingsSource, /:type="showTelegramToken \? 'text' : 'password'"/)
    assert.match(settingsSource, /Daily production brief/)
    assert.match(settingsSource, /notificationsDirty/)
    assert.match(settingsSource, /Save notifications/)
    assert.doesNotMatch(settingsSource, /@change="saveNotifSettings"/)
    assert.doesNotMatch(settingsSource, /Saved automatically/)
  })
})
