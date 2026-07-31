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

    assert.equal(activeTabPanels.length, 13)
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
    for (const view of ['image', 'video']) {
      assert.match(settingsSource, new RegExp(`modelPricingView === '${view}'`))
    }
    // The audio pricing table is gone: GenStudio publishes TTS pricing per
    // model on the live catalogue, so there was nothing left for a project to
    // edit but a misleading "0 per 1k chars".
    assert.doesNotMatch(settingsSource, /modelPricingView === 'audio'/)
    assert.doesNotMatch(settingsSource, /cost_per_1k_chars|saveAudioPricing|editAudioModels/)

    assert.match(settingsSource, /aria-label="Model pricing categories"/)
  })

  test('Video Studio owns its live model catalog instead of project settings', () => {
    assert.match(settingsSource, /Video Studio owns provider setup, availability, pricing, and model retirement/)
    assert.match(settingsSource, /refresh_video_models=1/)
    assert.match(settingsSource, /Refresh live catalog/)
    assert.doesNotMatch(settingsSource, /Save Video Pricing/)
    assert.doesNotMatch(settingsSource, /video_models: editVideoModels/)
  })

  test('GenStudio owns admission without a second Story performance policy', () => {
    assert.doesNotMatch(settingsSource, /id: 'performance'/)
    assert.doesNotMatch(settingsSource, /Save performance/)
    assert.doesNotMatch(settingsSource, /script-concurrency/)
    assert.doesNotMatch(settingsSource, /launch stagger/i)
  })

  test('Channel Identity owns the channel-wide recurring guide visibility default', () => {
    assert.match(settingsSource, /Visual planning defaults/)
    assert.match(settingsSource, /Recurring guide visibility/)
    assert.match(settingsSource, /character_density: guideDensity\.value/)
    assert.match(settingsSource, /Existing Scene Plans stay unchanged/)
  })

  test('Formula production kits expose coherent defaults without adding episode pickers', () => {
    assert.match(settingsSource, /Formula production kit/)
    assert.match(settingsSource, /selectedProductionKitStyleName/)
    assert.match(settingsSource, /selectedProductionKitThumbnailName/)
    assert.match(settingsSource, /selectedProductionKitMotionName/)
    assert.match(settingsSource, /Automatic episode profiles/)
    assert.match(settingsSource, /there is no per-run profile picker/)
    assert.match(settingsSource, /applyFormulaVisualDefault/)
    assert.match(settingsSource, /formula_applied_style_id/)
  })

  test('GenStudio catalogs are account-scoped under App & Connections', () => {
    assert.match(
      settingsSource,
      /activeTab === 'app'[\s\S]*?<ThisMacSettings \/>[\s\S]*?<GenStudioCatalogSettings \/>/,
    )
    assert.doesNotMatch(settingsSource, /activeTab === 'models'/)
    assert.doesNotMatch(settingsSource, /id: 'models'/)
    assert.match(settingsSource, /if \(h === '#models'\)[\s\S]*?activeTab\.value = 'app'/)
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
