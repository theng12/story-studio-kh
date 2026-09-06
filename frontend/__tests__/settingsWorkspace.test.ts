import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { LEGACY_SETTINGS_HASHES, resolveSettingsSectionHash } from '../utils/settingsNavigation.ts'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)),
  'utf8',
)
const thisMacSettingsSource = readFileSync(
  fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url)),
  'utf8',
)

describe('Settings workspace navigation', () => {
  test('primary Settings groups use the shared modern panel shell', () => {
    for (const id of ['connections', 'performance', 'appearance', 'writing', 'production', 'maintenance']) {
      assert.match(settingsSource, new RegExp(`activeTab === '${id}'[^>]+class="[^"]*settings-panel`))
    }
    assert.match(settingsSource, /\['identity', 'publishing', 'writing', 'files'\]\.includes\(activeTab\)" class="card settings-panel/)
    assert.match(settingsSource, /\['identity', 'production', 'publishing'\]\.includes\(activeTab\)" class="card settings-panel/)
  })

  test('uses nine searchable destinations with exact links and explicit scopes', () => {
    for (const id of ['connections', 'performance', 'appearance', 'maintenance', 'identity', 'production', 'writing', 'publishing', 'files']) {
      assert.match(settingsSource, new RegExp(`id: '${id}'`), `${id} is addressable`)
    }
    assert.match(settingsSource, /<SettingsSectionNav/)
    assert.match(settingsSource, /scope="connections"/)
    assert.match(settingsSource, /scope="assignment"/)
    assert.match(settingsSource, /section="performance"/)
    assert.match(settingsSource, /section="appearance"/)
  })

  test('maps every retired Settings hash to its replacement destination', () => {
    const validSections = ['connections', 'performance', 'appearance', 'maintenance', 'identity', 'production', 'writing', 'publishing', 'files']
    for (const [oldHash, destination] of [
      ['app', 'connections'], ['models', 'connections'], ['youtube', 'connections'],
      ['ffmpeg', 'maintenance'], ['notifications', 'appearance'], ['about', 'maintenance'],
      ['channel', 'identity'], ['format', 'production'], ['niche', 'identity'],
      ['styles', 'writing'], ['standards', 'writing'], ['folders', 'files'],
      ['storage', 'files'], ['confirmations', 'files'], ['project', 'files'],
    ]) {
      assert.equal(LEGACY_SETTINGS_HASHES[oldHash], destination)
      assert.equal(resolveSettingsSectionHash(`#${oldHash}`, validSections), destination)
    }
    assert.equal(resolveSettingsSectionHash('#publishing', validSections), 'publishing')
    assert.equal(resolveSettingsSectionHash('#does-not-exist', validSections), null)
    assert.match(settingsSource, /resolveSettingsSectionHash\(rawTarget/)
  })

  test('entering Publishing loads its live YouTube defaults and category choices', () => {
    const destinationWatch = settingsSource.match(/watch\(activeTab, \(t\) => \{[\s\S]*?\n\}\)/)?.[0] || ''
    assert.match(destinationWatch, /t === 'publishing'[\s\S]*?loadYoutubeCategoryList\(\)/)
    assert.match(destinationWatch, /t === 'publishing'[\s\S]*?loadYoutubeAppDefaults\(\)/)
    assert.doesNotMatch(destinationWatch, /t === 'project'/)
  })

  test('focused sections name their actions and keep secondary writing tools behind the current style', () => {
    const templateSource = settingsSource.slice(0, settingsSource.indexOf('<script setup'))
    assert.match(templateSource, /Save project name/)
    assert.match(templateSource, /Save publishing defaults/)
    assert.match(templateSource, /Save file settings/)
    assert.doesNotMatch(templateSource, /metadata PATCH|status\.containsSyntheticMedia/)
    assert.match(templateSource, /href="#identity">Channel identity<\/a> owns the/)

    const currentStyle = templateSource.indexOf('<label>Art Style')
    const customStyles = templateSource.indexOf('<strong>Browse or create custom styles</strong>')
    const writingInstructions = templateSource.indexOf('<strong>Writing instructions</strong>')
    assert.ok(currentStyle >= 0 && currentStyle < customStyles)
    assert.ok(customStyles < writingInstructions)
    assert.equal(templateSource.match(/<ProjectStyleLibrary/g)?.length, 1)
  })

  test('each project section saves only the fields it owns and preserves hidden drafts', () => {
    const draft = {
      name: 'Pending identity',
      episode_prefix: 'NEW',
      season_prefix: 'Volume',
      season_size: 24,
      youtube_channel_url: 'https://youtube.com/@pending',
      category_id: 27,
      mark_as_ai_generated: false,
      active_style_preset_id: 'pending-style-must-not-travel',
    }

    assert.deepEqual(projectSettingsSavePlan('identity', draft, 20), {
      project: { name: 'Pending identity' },
      config: null,
      hasPendingSeasonSize: false,
    })
    assert.deepEqual(projectSettingsSavePlan('publishing', draft, 20), {
      project: { youtube_channel_url: 'https://youtube.com/@pending' },
      config: { category_id: 27, mark_as_ai_generated: false },
      hasPendingSeasonSize: false,
    })
    assert.deepEqual(projectSettingsSavePlan('files', draft, 20), {
      project: { episode_prefix: 'NEW', season_prefix: 'Volume' },
      config: null,
      hasPendingSeasonSize: true,
    })
    const saveBlock = settingsSource.match(
      /async function saveProject[\s\S]*?(?=\nasync function syncFolders)/,
    )?.[0] || ''
    assert.doesNotMatch(saveBlock, /loadProject\(|refreshConfig\(/)
    assert.match(saveBlock, /Object\.keys\(plan\.project\)/)
    assert.match(saveBlock, /Object\.entries\(plan\.config\)/)
    assert.match(saveBlock, /const targetSlug = slug\.value/)
    assert.equal(saveBlock.match(/if \(slug\.value !== targetSlug\) return/g)?.length, 1)
    const configPut = saveBlock.indexOf('/projects/${targetSlug}/settings/config')
    const routeGuard = saveBlock.indexOf('if (slug.value !== targetSlug) return')
    const sharedProjectUpdate = saveBlock.indexOf('Object.keys(plan.project)')
    assert.ok(configPut >= 0 && configPut < routeGuard)
    assert.ok(routeGuard < sharedProjectUpdate)
    assert.doesNotMatch(saveBlock, /`\/projects\/\$\{slug\.value\}/)
    assert.match(settingsSource, /saveProject\('publishing'\)/)
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

  test('removes the two literal-hidden retired editors and their exclusive state', () => {
    assert.doesNotMatch(settingsSource, /v-if="false"/)
    assert.doesNotMatch(settingsSource, /modelPricingView|editImageModels|editVideoModels|saveImagePricing|refreshVideoCatalog/)
    assert.doesNotMatch(settingsSource, /editVoices|voiceProviderFilter|saveVoices|VOICE_PROVIDER_OPTIONS/)
  })

  test('GenStudio owns admission without a second Story performance policy', () => {
    assert.doesNotMatch(settingsSource, /Save performance/)
    assert.doesNotMatch(settingsSource, /script-concurrency/)
    assert.doesNotMatch(settingsSource, /launch stagger/i)
    assert.doesNotMatch(thisMacSettingsSource, /GenStudio itself accepts 12|what GenStudio accepts/)
    assert.match(thisMacSettingsSource, /local staging preference/i)
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
      /activeTab === 'connections'[\s\S]*?<ThisMacSettings section="connections" \/>[\s\S]*?<GenStudioCatalogSettings \/>/,
    )
    assert.doesNotMatch(settingsSource, /activeTab === 'models'/)
    assert.doesNotMatch(settingsSource, /id: 'models'/)
    assert.equal(LEGACY_SETTINGS_HASHES.models, 'connections')
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
    assert.match(settingsSource, /Library & exports/)
    assert.match(settingsSource, /Project storage/)
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
