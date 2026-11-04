// v1.4.249 owner/coordinator decisions on Settings storage flows:
// one Free Up Space card, heavy-media split hidden unless the project uses it,
// confirmation rows only for prompts something reads, no youtube_channel_url.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h } from 'vue'
import { compileTemplate, parse as parseSfc } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import ts from 'typescript'
import { projectSettingsSavePlan } from '../utils/projectSettingsSave.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const settings = read('../pages/projects/[slug]/settings.vue')
const template = settings.slice(0, settings.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
const panel = read('../components/MediaCleanupPanel.vue')

function confirmationKeyUsage(source: string, filename = 'source.ts') {
  const scripts = filename.endsWith('.vue')
    ? (() => {
        const { descriptor } = parseSfc(source, { filename })
        return [descriptor.script?.content, descriptor.scriptSetup?.content].filter((part): part is string => Boolean(part))
      })()
    : [source]
  const keys = new Set<string>()
  const mandatoryKeys: string[] = []
  const propertyName = (name: ts.PropertyName) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) {
      return name.expression.text
    }
    return null
  }
  const hasLiteralAlwaysTrue = (argument: ts.Expression | undefined) => {
    if (!argument || !ts.isObjectLiteralExpression(argument)) return false
    let always: boolean | undefined
    for (const property of argument.properties) {
      if (ts.isSpreadAssignment(property)) {
        always = undefined
      } else if ('name' in property && property.name) {
        const name = propertyName(property.name)
        if (name === 'always') {
          always = ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword
            ? true
            : ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword
              ? false
              : undefined
        } else if (name === null && ts.isComputedPropertyName(property.name)) {
          always = undefined
        }
      }
    }
    return always === true
  }
  for (const script of scripts) {
    const ast = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : ''
        if (name === 'confirmGeneration' && ts.isStringLiteral(node.arguments[1])) {
          if (hasLiteralAlwaysTrue(node.arguments[3])) mandatoryKeys.push(node.arguments[1].text)
          else keys.add(node.arguments[1].text)
        }
        if (name === 'askSkippable' && ts.isObjectLiteralExpression(node.arguments[0])) {
          for (const property of node.arguments[0].properties) {
            if (ts.isPropertyAssignment(property) && propertyName(property.name) === 'skipKey' && ts.isStringLiteral(property.initializer)) {
              keys.add(property.initializer.text)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return { preferenceKeys: keys, mandatoryKeys }
}

const preferenceConsultingConfirmationKeys = (source: string, filename = 'source.ts') =>
  confirmationKeyUsage(source, filename).preferenceKeys

async function storageSummaryFragment() {
  const start = settings.indexOf('<div v-if="storage?.space" class="storage-summary mt-2">')
  const source = settings.slice(start, settings.indexOf('</div>', start) + '</div>'.length)
  const compiled = compileTemplate({ source, filename: 'settings-storage-summary.vue', id: 'settings-storage-summary' })
  assert.deepEqual(compiled.errors, [])
  const module = await transform(`${compiled.code}\nexport default { props: ['storage', 'formatMeasurement'], render }`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(module.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
}

test('Free Up Space is one card: the two all-channel actions, then what is using space', () => {
  // v1.4.317 split: the all-channel Free Up Space card lives in <AppFilesSettings>;
  // the channel page keeps only the read-only per-episode breakdown.
  const appFiles = read('../components/AppFilesSettings.vue')
  const appFilesTemplate = appFiles.slice(0, appFiles.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
  const start = appFilesTemplate.indexOf('data-setting="free-up-space"')
  const card = appFilesTemplate.slice(start, appFilesTemplate.indexOf('</section>', start))
  // The panel offers exactly the two all-channel actions, shrink first.
  const shrinkAll = panel.indexOf('Shrink Images (All Channels)')
  const cleanAll = panel.indexOf('Clean Up All Channels')
  assert.ok(shrinkAll > 0 && cleanAll > shrinkAll, 'both all-channel actions are present, shrink first')
  // The duplicated per-channel / category / conversion / leftover tools are gone from the panel.
  for (const gone of ['This channel only', 'Other ways', 'Choose exactly which files', 'Convert PNG scenes to JPEG', 'data-setting="leftover-files"', 'data-setting="convert-png"', 'Free Up Space for {{ selected.length }} Selected']) {
    assert.ok(panel.indexOf(gone) < 0, `${gone} is removed from the panel`)
  }
  // The archive sweep lives under "Where your files are" in the same panel, not in Free up space.
  assert.doesNotMatch(card, /clear-uploaded-finals|Clear uploaded final videos \(verified\)/)
  assert.doesNotMatch(card, /data-setting="move-uploaded"|Move uploaded videos to another drive/)
  const where = appFilesTemplate.slice(appFilesTemplate.indexOf('Where your files are'), start)
  assert.match(where, /data-setting="move-uploaded"/)
  // The channel page's read-only breakdown stays on the channel card, and nothing
  // anywhere promises a permanent delete.
  assert.match(template, /data-setting="episode-storage"/)
  assert.doesNotMatch(appFiles, /permanent/i)
})

test('"What\'s using space" is read-only and lives on the channel files tab only', () => {
  const view = template.slice(template.indexOf('data-setting="episode-storage"'), template.indexOf('</details>', template.indexOf('data-setting="episode-storage"')))
  assert.match(view, /What's using space/)
  assert.doesNotMatch(view, /cleanupRow|runBulkCleanup|col-actions|Verify &amp; clear|Verify & clear/)
  assert.doesNotMatch(read('../components/AppFilesSettings.vue'), /episode-storage|Space used by each episode/,
    'the per-episode breakdown stays a per-channel control')
  assert.match(read('../utils/settingsIndex.ts'), /section: 'maintenance', anchor: 'episode-storage'/)
})

test('the actual Settings storage fragment renders every unavailable summary metric honestly', async () => {
  const Fragment = await storageSummaryFragment()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(Fragment, {
      storage: { space: { free_bytes: null, project_trash_bytes: null, library_trash_bytes: null, app_trash_bytes: null } },
      formatMeasurement: (bytes: number | null) => bytes === null ? 'could not be measured' : `${bytes} bytes`,
    }),
  }))
  app.component('NuxtLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  try {
    app.mount(host)
    const text = host.textContent || ''
    for (const label of ['Free on this drive', 'This channel in the Trash', 'Whole Trash', 'Old app copies from updates']) {
      assert.match(text, new RegExp(`${label}: could not be measured`))
    }
    assert.equal((text.match(/could not be measured/g) || []).length, 4)
    assert.equal(host.querySelector('button'), null, 'the read-only summary has no cleanup action')
  } finally {
    app.unmount()
    host.remove()
  }
})

test('Free up space links land on the one card; the Upload overview button is gone, the sidebar link stays', () => {
  assert.doesNotMatch(read('../pages/projects/[slug]/upload/index.vue'), /free-up-space/)
  assert.match(read('../layouts/dashboard.vue'), /settings#free-up-space`" class="nav-item">[\s\S]{0,120}Free Up Space/)
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
  const mandatory: string[] = []
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(new URL(`${entry.name}/`, dir)); continue }
      if (!/\.(vue|ts)$/.test(entry.name)) continue
      const src = readFileSync(new URL(entry.name, dir), 'utf8')
      const usage = confirmationKeyUsage(src, entry.name)
      for (const key of usage.preferenceKeys) consulted.add(key)
      mandatory.push(...usage.mandatoryKeys)
    }
  }
  for (const dir of ['../pages/', '../components/', '../composables/']) walk(new URL(dir, import.meta.url))
  assert.deepEqual(rows, [...consulted].sort())
  assert.deepEqual(mandatory.sort(), ['image', 'music', 'music'])
  assert.ok(!rows.includes('image') && !rows.includes('music'))
  assert.ok(rows.includes('introduction'))
  for (const dead of ['thumb_prompts', 'scene_plan', 'scene_review', 'description', 'video']) assert.ok(!rows.includes(dead), dead)
  const save = settings.slice(settings.indexOf('async function saveConfirmPrefs('), settings.indexOf('async function saveStandards('))
  assert.match(save, /\.\.\.\(\(config\.value as any\)\?\.confirmation_preferences \|\| \{\}\), \.\.\.confirmPrefs/)
})

test('confirmation-key discovery excludes only literal mandatory prompts', () => {
  const source = `<script setup lang="ts">
    confirmation.confirmGeneration(slug, 'normal', body)
    confirmation.confirmGeneration(slug, 'mandatory', body, { always: true })
    confirmation.confirmGeneration(slug, 'dynamic-options', body, options)
    confirmation.confirmGeneration(slug, 'dynamic-always', body, { always: required })
    confirmation.confirmGeneration(slug, 'spread-after', body, { always: true, ...options })
    confirmation.confirmGeneration(slug, 'spread-before', body, { ...options, always: true })
    confirmation.confirmGeneration(slug, 'computed-after', body, { always: true, [key]: false })
    confirmation.confirmGeneration(slug, 'computed-always-after', body, { always: true, ['always']: false })
    confirmation.confirmGeneration(slug, 'computed-before', body, { [key]: false, always: true })
    askSkippable({ skipKey: 'reveal_folder' })
  </script>`
  assert.deepEqual([...preferenceConsultingConfirmationKeys(source, 'fixture.vue')].sort(), [
    'computed-after',
    'computed-always-after',
    'dynamic-always',
    'dynamic-options',
    'normal',
    'reveal_folder',
    'spread-after',
  ])
})

test('the unused youtube_channel_url field is gone from Settings and its save plan', () => {
  assert.doesNotMatch(settings, /youtube_channel_url/)
  assert.doesNotMatch(read('../utils/projectSettingsSave.ts'), /youtube_channel_url/)
  // Publishing owns no project.json field, so its save does not rewrite project.json.
  assert.match(settings, /const savedProject = plan\.project \? await put<any>\(`\/projects\/\$\{targetSlug\}`, plan\.project\) : null/)
  assert.equal(projectSettingsSavePlan('publishing', { category_id: 27 }, 20).project, null)
})
