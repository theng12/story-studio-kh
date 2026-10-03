// v1.4.249 owner/coordinator decisions on Settings storage flows:
// one Free Up Space card, heavy-media split hidden unless the project uses it,
// confirmation rows only for prompts something reads, no youtube_channel_url.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const settings = read('../pages/projects/[slug]/settings.vue')
const template = settings.slice(0, settings.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
const panel = read('../components/MediaCleanupPanel.vue')

test('Free Up Space is one card: recommended preset first, then the other ways, then what is using space', () => {
  const start = template.indexOf('data-setting="free-up-space"')
  const card = template.slice(start, template.indexOf('</section>', template.indexOf('data-setting="episode-storage"')))
  const order = ['<MediaCleanupPanel', 'data-setting="clear-uploaded-finals"', 'data-setting="move-uploaded"', 'data-setting="episode-storage"']
    .map(marker => card.indexOf(marker))
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `card order ${order}`)
  // Inside the panel: recommended preset, then "Other ways" with Choose exactly which files.
  const recommended = panel.indexOf('Recommended: shrink and tidy uploaded episodes')
  const other = panel.indexOf('Other ways')
  const exact = panel.indexOf('Choose exactly which files')
  assert.ok(recommended > 0 && recommended < panel.indexOf('Free Up Space for {{ selected.length }} Selected') && other < exact && recommended < other)
  // Each option says in one sentence what happens and where files go.
  assert.match(card, /Clear uploaded final videos \(verified\)<\/strong><small>[^<]*moved to this project's <code>_trash<\/code> folder/)
  assert.match(card, /Move uploaded videos to another drive<\/strong><small>[^<]*copied to a folder you choose/)
  assert.match(panel, /Choose exactly which files<\/strong><small>[^<]*<code>_trash<\/code>, or are copied to a folder you choose/)
  // The archive sweep is no longer a second entry point inside "Where your files are".
  const where = template.slice(template.indexOf('Where your files are'), start)
  assert.doesNotMatch(where, /archive|Move Uploaded Videos/i)
})

test('"What\'s using space" is read-only and no longer lives under Project files & behavior', () => {
  const view = template.slice(template.indexOf('data-setting="episode-storage"'), template.indexOf('</details>', template.indexOf('data-setting="episode-storage"')))
  assert.match(view, /What's using space/)
  assert.doesNotMatch(view, /cleanupRow|runBulkCleanup|col-actions|Verify &amp; clear|Verify & clear/)
  const filesTab = template.slice(template.indexOf("activeTab === 'files'"))
  assert.doesNotMatch(filesTab.slice(0, filesTab.indexOf('</template>')), /episode-storage|Space used by each episode/)
  assert.match(read('../utils/settingsIndex.ts'), /section: 'maintenance', anchor: 'episode-storage'/)
})

test('Free up space links land on the one card; the Upload overview button is gone, the sidebar link stays', () => {
  assert.doesNotMatch(read('../pages/projects/[slug]/upload/index.vue'), /free-up-space/)
  assert.match(read('../layouts/dashboard.vue'), /settings#free-up-space`" class="sidebar-utility">Free Up Space<\/NuxtLink>/)
  assert.match(read('../pages/projects/[slug]/upload/publish.vue'), /settings#free-up-space/)
  assert.match(panel, /<section id="free-up-space"/)
})

test('heavy media on another drive shows only for a project that already has media_root', () => {
  assert.match(template, /<details v-if="mediaRootSavedValue" id="media-root-section"/)
  assert.match(template, /:label="mediaRootSavedValue \? 'Advanced: heavy media on another drive, script recovery data' : 'Advanced: script recovery data'"/)
  assert.match(settings, /mediaRootSavedValue\.value = mediaRootInput\.value/)
  // Clearing is one-way, so it asks first — including a Save of an emptied field.
  assert.match(settings, /async function clearMediaRoot\(\) \{[\s\S]{0,200}await ask\(/)
  assert.match(template, /@click="mediaRootInput\.trim\(\) \? saveMediaRoot\(\) : clearMediaRoot\(\)"/)
  assert.doesNotMatch(read('../utils/settingsIndex.ts'), /heavy-media/)
})

test('confirmation rows exist exactly for the prompts something reads, and saving keeps the others on disk', () => {
  const block = settings.slice(settings.indexOf('const confirmGenerators = ['), settings.indexOf(']', settings.indexOf('const confirmGenerators = [')))
  const rows = [...block.matchAll(/key: '([a-z_]+)'/g)].map(m => m[1]).sort()
  // Keys consulted anywhere in the frontend: confirmGeneration(slug, '<key>', …) and askSkippable({ skipKey: '<key>' }).
  const consulted = new Set<string>()
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(new URL(`${entry.name}/`, dir)); continue }
      if (!/\.(vue|ts)$/.test(entry.name)) continue
      const src = readFileSync(new URL(entry.name, dir), 'utf8')
      for (const m of src.matchAll(/confirmGeneration\([^,]+,\s*'([a-z_]+)'/g)) consulted.add(m[1]!)
      for (const m of src.matchAll(/skipKey: '([a-z_]+)'/g)) consulted.add(m[1]!)
    }
  }
  for (const dir of ['../pages/', '../components/', '../composables/']) walk(new URL(dir, import.meta.url))
  assert.deepEqual(rows, [...consulted].sort())
  assert.ok(rows.includes('introduction'))
  for (const dead of ['thumb_prompts', 'scene_plan', 'scene_review', 'description', 'video']) assert.ok(!rows.includes(dead), dead)
  const save = settings.slice(settings.indexOf('async function saveConfirmPrefs('), settings.indexOf('async function saveStandards('))
  assert.match(save, /\.\.\.\(\(config\.value as any\)\?\.confirmation_preferences \|\| \{\}\), \.\.\.confirmPrefs/)
})

test('the unused youtube_channel_url field is gone from Settings and its save plan', () => {
  assert.doesNotMatch(settings, /youtube_channel_url/)
  assert.doesNotMatch(read('../utils/projectSettingsSave.ts'), /youtube_channel_url/)
  // Publishing owns no project.json field, so its save does not rewrite project.json.
  assert.match(settings, /const savedProject = plan\.project \? await put<any>\(`\/projects\/\$\{targetSlug\}`, plan\.project\) : null/)
  assert.equal(projectSettingsSavePlan('publishing', { category_id: 27 }, 20).project, null)
})
