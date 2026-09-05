import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)),
  'utf8',
)
const thisMacSettingsSource = readFileSync(
  fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url)),
  'utf8',
)

describe('Settings workspace navigation', () => {
  test('every Settings surface uses the shared modern panel shell', () => {
    const activeTabPanels = [...settingsSource.matchAll(/activeTab === '([^']+)'[^>]+class="([^"]+)"/g)]

    // v1.4.3 — the "Named Roots" tab went with the per-machine
    // label → folder map it managed: `${ASSET}` now always means the
    // _Project Assets folder inside the Library, so there is nothing to configure.
    assert.equal(activeTabPanels.length, 13)
    for (const [, tabId, className] of activeTabPanels) {
      assert.match(className, /settings-panel/, `${tabId} must use the shared Settings panel`)
    }
  })

  test('the retired direct-local-generation control surface is gone from Settings', () => {
    // The whole "Local Models" panel (Voice Studio / Image Studio / Chat
    // Studio direct-connection panes, plus the Direct-vs-Hub toggle) talked
    // to nothing — every one of those routes is 410'd by middleware
    // (routes/audio.ts, routes/images.ts, routes/app-settings.ts) — while
    // still naming a routing surface and offering Save/Test buttons that
    // could only ever report "retired". It was removed rather than left
    // dead behind `v-if="false"`.
    assert.doesNotMatch(settingsSource, /local-models-panel/)
    assert.doesNotMatch(settingsSource, /localModelsView/)
    assert.doesNotMatch(settingsSource, /LocalModelView/)
    assert.doesNotMatch(settingsSource, /<EndpointListEditor/)
    assert.doesNotMatch(settingsSource, /route-prefix="\/voicestudio"|route-prefix="\/imagestudio"|route-prefix="\/chatstudio"/)
    assert.doesNotMatch(settingsSource, /aria-label="Local model setup sections"/)
    assert.doesNotMatch(settingsSource, /app-settings\/local-backend|app-settings\/hub\//)
    assert.doesNotMatch(settingsSource, /localBackend|hubUrl|hubToken|renderWorkersEnabled|studioAction/)
    assert.doesNotMatch(settingsSource, /Studio Hub/)
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
    assert.match(settingsSource, /selectedProductionKitThumbnailName/)
    // No `selectedProductionKitStyleName`: the kit's style line is a
    // three-state suggestion now, not a name the card simply prints.
    assert.doesNotMatch(settingsSource, /selectedProductionKitStyleName/)
    assert.match(settingsSource, /selectedProductionKitMotionName/)
    assert.match(settingsSource, /Automatic episode profiles/)
    assert.match(settingsSource, /there is no per-run profile picker/)
  })

  test('a Formula suggests a visual style in three honest states and never writes one', () => {
    // The owner's ruling: *"art style is a selection, a preference for the
    // user. they can't be dictated this way."* Saving a Formula used to write
    // a style id straight into the project config; the only way to see it had
    // happened was to notice the picker had changed by itself.
    assert.doesNotMatch(settingsSource, /applyFormulaVisualDefault/)
    assert.doesNotMatch(settingsSource, /formula_applied_style_id/)
    assert.match(settingsSource, /Suggested visual style/)
    assert.match(settingsSource, /productionKitStyleSuggestion/)
    assert.match(settingsSource, /Use this style/)
    assert.match(settingsSource, /Not installed\. Get it from the/)
    assert.match(settingsSource, /In use on this channel/)
    // The one place a style is written is the picker's own watcher.
    assert.equal(settingsSource.match(/payload\.active_style_preset_id = activeId/g)?.length, 1)
    assert.equal(settingsSource.match(/active_style_preset_id:/g), null)
  })

  test('an art style that resolves to nothing is visible in the UI, not just in a log', () => {
    assert.match(settingsSource, /unresolvedArtStyleId/)
    assert.match(settingsSource, /images are being generated without it/)
    assert.match(settingsSource, /Style library/)
    assert.doesNotMatch(settingsSource, /label="Built-in styles"/)
  })

  test('GenStudio catalogs are account-scoped under App & Connections', () => {
    assert.match(
      settingsSource,
      /activeTab === 'app'[\s\S]*?<ThisMacSettings \/>[\s\S]*?<GenStudioCatalogSettings \/>/,
    )
    assert.doesNotMatch(settingsSource, /activeTab === 'models'/)
    assert.doesNotMatch(settingsSource, /id: 'models'/)
    assert.match(settingsSource, /if \(h === '#models'\)[\s\S]*?activeTab\.value = 'app'/)
    assert.match(thisMacSettingsSource, /music:generate/)
    assert.match(thisMacSettingsSource, /content:read/)
    assert.match(thisMacSettingsSource, /content:purchase/)
    assert.match(thisMacSettingsSource, /Read scope verified/)
    assert.match(thisMacSettingsSource, /Purchase scope required · not safely testable without buying/)
    assert.match(thisMacSettingsSource, /all-access or scoped/i)
    assert.doesNotMatch(thisMacSettingsSource, /one scoped key|Scoped API key|Scoped GenStudio key saved/i)
    assert.doesNotMatch(thisMacSettingsSource, /\/v1\/api-keys|\/reveal/)
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
