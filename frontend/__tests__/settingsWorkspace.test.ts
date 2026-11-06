import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { LEGACY_SETTINGS_HASHES, resolveSettingsSectionHash, settingsAnchorTargetIds } from '../utils/settingsNavigation.ts'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url)),
  'utf8',
)
const settingsIndexSource = readFileSync(
  fileURLToPath(new URL('../utils/settingsIndex.ts', import.meta.url)),
  'utf8',
)
const performanceSource = readFileSync(
  fileURLToPath(new URL('../utils/performanceSettings.ts', import.meta.url)),
  'utf8',
)
const thisMacSettingsSource = readFileSync(
  fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url)),
  'utf8',
)

const filesSource = readFileSync(new URL('../components/AppFilesSettings.vue', import.meta.url), 'utf8')
const notificationsSource = readFileSync(new URL('../components/AppNotificationSettings.vue', import.meta.url), 'utf8')

describe('Settings workspace navigation', () => {
  test('primary Settings groups use the shared modern panel shell', () => {
    // v1.4.249 — one block per section, no shared multi-section cards.
    const templateSource = settingsSource.slice(0, settingsSource.indexOf('<script setup'))
    for (const id of ['identity', 'production', 'writing', 'publishing', 'files', 'safety']) {
      assert.equal(templateSource.match(new RegExp(`v-if="activeTab === '${id}'"`, 'g'))?.length, 1, `${id} renders from exactly one block`)
    }
    assert.doesNotMatch(templateSource, /\.includes\(activeTab\)/, 'no card is shared between sections')
    assert.ok((templateSource.match(/settings-panel/g)?.length || 0) > 10)
  })

  test('uses ten searchable destinations with exact links and explicit scopes', () => {
    for (const id of ['identity', 'production', 'writing', 'publishing', 'files', 'safety']) {
      assert.match(settingsIndexSource, new RegExp(`id: '${id}'`), `${id} is addressable`)
    }
    assert.match(settingsSource, /<SettingsSectionNav v-model="activeTab" :zones="tabZones" @go="goToSetting" \/>/)
    assert.match(settingsSource, /const tabZones = SETTINGS_ZONES\.filter\(zone => zone\.id === 'project'\)/)
    assert.match(settingsSource, /scope="assignment"/)
    assert.doesNotMatch(settingsSource, /<ThisMacSettings|<DefaultModelsSettings|<BackupPanel|<AppNotificationSettings|<AppFilesSettings/)
  })

  test('maps every retired Settings hash to its replacement destination', () => {
    const validSections = ['identity', 'production', 'writing', 'publishing', 'files', 'safety']
    const targetIds = settingsAnchorTargetIds(validSections)
    for (const [oldHash, destination] of [
      ['channel', 'identity'], ['format', 'production'], ['niche', 'identity'],
      ['styles', 'writing'], ['standards', 'writing'], ['folders', 'files'],
      ['storage', 'files'], ['confirmations', 'files'], ['project', 'files'],
    ]) {
      assert.equal(LEGACY_SETTINGS_HASHES[oldHash], destination)
      assert.equal(resolveSettingsSectionHash(`#${oldHash}`, validSections), destination)
      assert.ok(targetIds.includes(oldHash), `${oldHash} has a real compatibility target`)
    }
    for (const section of validSections) assert.ok(targetIds.includes(section), `${section} has a real target`)
    assert.equal(resolveSettingsSectionHash('#publishing', validSections), 'publishing')
    assert.equal(resolveSettingsSectionHash('#does-not-exist', validSections), null)
    assert.match(settingsSource, /resolveSettingsSectionHash\(rawTarget/)
    assert.match(settingsSource, /<h2 :id="activeTab">/)
    assert.match(settingsSource, /v-for="targetId in inactiveSettingsHashTargets"/)
    assert.match(settingsSource, /scrollToTop: to => !to\.hash/)
  })

  test('entering Publishing loads its live YouTube defaults and category choices', () => {
    const destinationWatch = settingsSource.match(/watch\(activeTab, \(t\) => \{[\s\S]*?\n\}\)/)?.[0] || ''
    assert.match(destinationWatch, /t === 'publishing'[\s\S]*?loadYoutubeCategoryList\(\)/)
    assert.match(destinationWatch, /t === 'publishing'[\s\S]*?loadYoutubeAppDefaults\(\)/)
    assert.doesNotMatch(destinationWatch, /t === 'project'/)
  })

  test('focused sections name their actions and keep secondary writing tools behind the current style', () => {
    const templateSource = settingsSource.slice(0, settingsSource.indexOf('<script setup'))
    // Project name is saved through ChannelProfilePanel, not a separate button
    assert.match(templateSource, /ChannelProfilePanel.*data-setting="project-name"/)
    assert.match(templateSource, /@saved="onChannelProfileSaved"/)
    assert.match(templateSource, /Save Upload Defaults/)
    assert.match(templateSource, /Save Numbering/)
    assert.doesNotMatch(templateSource, /metadata PATCH|status\.containsSyntheticMedia/)

    // The current style comes first; the rarer tools are collapsible cards after it.
    const currentStyle = templateSource.indexOf('<label>Art style</label>')
    const writingInstructions = templateSource.indexOf('<CollapsibleCard title="Writing instructions"')
    const customStyles = templateSource.indexOf('<CollapsibleCard title="Custom art styles"')
    assert.ok(currentStyle >= 0 && currentStyle < writingInstructions)
    assert.ok(writingInstructions < customStyles)
    assert.equal(templateSource.match(/<ProjectStyleLibrary/g)?.length, 1)
  })

  test('each project section saves only the fields it owns and preserves hidden drafts', () => {
    const draft = {
      name: 'Pending identity',
      episode_prefix: 'NEW',
      season_prefix: 'Volume',
      season_size: 24,
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
      project: null,
      config: { category_id: 27, mark_as_ai_generated: false },
      hasPendingSeasonSize: false,
    })
    assert.deepEqual(projectSettingsSavePlan('files', draft, 20), {
      project: { episode_prefix: 'NEW', season_prefix: 'Volume' },
      config: null,
      hasPendingSeasonSize: true,
    })
    const saveBlock = settingsSource.match(
      /async function saveProject[\s\S]*?(?=\nasync function deleteProject)/,
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

  test('The Gateway owns admission without a second Story performance policy', () => {
    assert.doesNotMatch(settingsSource, /Save performance/)
    assert.doesNotMatch(settingsSource, /script-concurrency/)
    assert.doesNotMatch(settingsSource, /launch stagger/i)
    assert.doesNotMatch(performanceSource, /[Tt]he Gateway itself accepts 12|what the Gateway accepts/)
    // Same meaning, plain words: Story's number only limits what it sends; the Gateway decides what runs.
    assert.match(performanceSource, /the Gateway still decides/i)
  })

  test('Channel Identity owns the channel-wide recurring guide visibility default', () => {
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
    assert.match(settingsSource, /Use This Style/)
    assert.match(settingsSource, /Not installed\. Get it from the/)
    assert.match(settingsSource, /In use on this channel/)
    // The one place a style is written is the picker's own watcher.
    assert.equal(settingsSource.match(/payload\.active_style_preset_id = activeId/g)?.length, 1)
    assert.equal(settingsSource.match(/active_style_preset_id:/g), null)
  })

  test('an art style that resolves to nothing is visible in the UI, and names what runs instead', () => {
    // The screen must not decide this for itself: it renders the resolver's own
    // answer (`GET …/settings/art-style`), which covers the uninstalled Store
    // style AND the aliased preset whose adopting pack is missing.
    assert.match(settingsSource, /unresolvedArtStyleId/)
    assert.match(settingsSource, /\/settings\/art-style/)
    assert.match(settingsSource, /artStyleStatus\?\.fallback\?\.message/)
    assert.match(settingsSource, /format default style/)
    assert.match(settingsSource, /Style library|Studio Library/)
    assert.doesNotMatch(settingsSource, /label="Built-in styles"/)
    // The old sentence claimed images simply went out without the style; for an
    // aliased preset they go out with the channel's own text, which is not
    // "without it". The wording now says which is which.
    assert.doesNotMatch(settingsSource, /images are being generated without it/)
  })

  test('Gateway catalogs are account-scoped under App & Connections', () => {
    assert.match(thisMacSettingsSource, /section === 'connections'[\s\S]*?<GenStudioCatalogSettings \/>/)
    assert.doesNotMatch(settingsSource, /<GenStudioCatalogSettings/)
    assert.doesNotMatch(settingsSource, /activeTab === 'models'/)
    assert.doesNotMatch(settingsSource, /id: 'models'/)
    assert.equal(LEGACY_SETTINGS_HASHES.models, 'connections')
    // Owner 2026-10-03: the connection is his Gateway, not the paid GenStudio cloud service, and the
    // permission-scope list is jargon he cannot act on. The key test still reports the Studio Library.
    assert.match(thisMacSettingsSource, /<h4>Gateway<\/h4>/)
    assert.match(thisMacSettingsSource, /Your GatewayKH on this Mac or network — it runs your free local models/)
    assert.match(thisMacSettingsSource, /Copy it from Gateway → Settings → Gateway API Key/)
    assert.match(thisMacSettingsSource, /connections: 'Connections'/)
    assert.match(thisMacSettingsSource, /Studio Library: \{\{/)
    assert.doesNotMatch(thisMacSettingsSource, /<code>content:purchase<\/code>|Required scopes|GenStudio API key<\/label>/)
    assert.doesNotMatch(thisMacSettingsSource, /Sole AI boundary|Test scopes/)
    assert.doesNotMatch(thisMacSettingsSource, /one scoped key|Scoped API key|Scoped Gateway API Key saved/i)
    assert.doesNotMatch(thisMacSettingsSource, /\/v1\/api-keys|\/reveal/)
  })

  test('Files: one "Where your files are" card with folder pickers; no storage map, no iCloud', () => {
    // v1.4.249 — "this library and your storage map thing is so confusing. and
    // i no longer use any icloud features."
    const templateSource = filesSource.slice(0, filesSource.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
    assert.match(templateSource, /Where your files are/)
    assert.match(templateSource, /<FolderField[\s\S]{0,120}label="Library folder"/)
    assert.match(templateSource, /<FolderField[\s\S]{0,120}label="Finished videos folder"/)
    assert.match(templateSource, /@change="chooseExportsFolder"/)
    assert.match(templateSource, /Move uploaded videos to another drive/)
    assert.doesNotMatch(templateSource, /storage map|overview-card|Cross-machine and cloud-folder notes/i)
    assert.doesNotMatch(templateSource, /iCloud|cloud sync|cloud-folder/i)
    assert.doesNotMatch(templateSource, /This is not\s+a setting/)
    assert.match(filesSource, /'\/library\/exports'/)
    assert.match(settingsSource, /Small files that let an unfinished script carry on where it stopped/)
    assert.doesNotMatch(settingsSource, /Legacy video assembly presets/)
    assert.doesNotMatch(settingsSource, /legacy-video-assembly-presets/)
  })

  test('Notifications stages changes and guides setup through modern channel controls', () => {
    assert.match(notificationsSource, /<h3>Notifications<\/h3>/)
    assert.match(notificationsSource, /notification-status-grid/)
    assert.match(notificationsSource, /Set up Telegram/)
    assert.match(notificationsSource, /:type="showTelegramToken \? 'text' : 'password'"/)
    assert.match(notificationsSource, /Daily production brief/)
    assert.match(notificationsSource, /notificationsDirty/)
    assert.match(notificationsSource, /Save Notifications/)
    assert.doesNotMatch(notificationsSource, /@change="saveNotifSettings"/)
    assert.doesNotMatch(notificationsSource, /Saved automatically/)
  })
})
