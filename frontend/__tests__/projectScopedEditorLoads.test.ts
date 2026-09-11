import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const settings = source('../pages/projects/[slug]/settings.vue')
const metadataTemplate = source('../pages/projects/[slug]/metadata-template.vue')
const thumbnailTemplates = source('../pages/projects/[slug]/thumbnail-templates.vue')

test('Settings replaces Files and Writing drafts when its project changes', () => {
  for (const loader of ['loadFolderConfig', 'loadStandards']) {
    assert.match(
      settings,
      new RegExp(`async function ${loader}\\(\\)[\\s\\S]*?const projectSlug = slug\\.value[\\s\\S]*?const request = \\+\\+${loader}Request[\\s\\S]*?const current = \\(\\) => projectSlug === slug\\.value && request === ${loader}Request[\\s\\S]*?if \\(!current\\(\\)\\) return`),
      `${loader} must ignore stale project data`,
    )
  }
  assert.match(settings, /watch\(slug, \(\) => \{[\s\S]*?standards\.value = ''[\s\S]*?folderConfig\.value = \[\][\s\S]*?if \(activeTab\.value === 'files'\) void loadFolderConfig\(\)[\s\S]*?if \(activeTab\.value === 'writing'\) void loadStandards\(\)/)
  assert.match(settings, /:disabled="folderConfigLoading \|\| !!folderConfigError" @click="saveFolderConfig"/)
  assert.match(settings, /writingConfigLoadedSlug = ''[\s\S]*?introStandards\.value = ''[\s\S]*?standardsPresets\.value = \[\][\s\S]*?introPresets\.value = \[\]/)
  assert.match(settings, /const writingControlsDisabled = computed\(\(\) => !writingConfigReady\.value/)
  assert.match(settings, /:disabled="writingControlsDisabled" @click="saveStandardsCurrent"/)
  assert.match(settings, /async function savePreset\(\)[\s\S]*?const projectSlug = slug\.value[\s\S]*?const next = \[\.\.\.list\.value, preset\][\s\S]*?await put\(`\/projects\/\$\{projectSlug\}\/settings\/config`[\s\S]*?list\.value = next/)
  assert.match(settings, /async function deletePreset\(\)[\s\S]*?const projectSlug = slug\.value[\s\S]*?const next = list\.value\.filter[\s\S]*?await put\(`\/projects\/\$\{projectSlug\}\/settings\/config`[\s\S]*?list\.value = next/)
})

test('Metadata Template clears stale drafts, reports reads that fail, and cannot save until both reads belong to this project', () => {
  assert.match(metadataTemplate, /const metadataTemplateLoadError = ref\(''\)/)
  assert.match(metadataTemplate, /:disabled="saving \|\| metadataTemplateLoading \|\| !!metadataTemplateLoadError" @click="save"/)
  assert.equal((metadataTemplate.match(/:disabled="saving \|\| metadataTemplateLoading \|\| !!metadataTemplateLoadError"/g) || []).length, 6)
  for (const [loader, requestName] of [['load', 'metadataTemplateConfigRequest'], ['loadFormulas', 'metadataFormulaRequest']] as const) {
    assert.match(
      metadataTemplate,
      new RegExp(`async function ${loader}\\(\\)[\\s\\S]*?const projectSlug = slug\\.value[\\s\\S]*?const request = \\+\\+${requestName}[\\s\\S]*?const current = \\(\\) => projectSlug === slug\\.value[\\s\\S]*?request === ${requestName}[\\s\\S]*?if \\(!current\\(\\)\\) return`),
      `${loader} must reject stale results`,
    )
  }
  assert.match(metadataTemplate, /watch\(slug, \(\) => \{[\s\S]*?resetMetadataTemplate\(\)[\s\S]*?void load\(\)[\s\S]*?void loadFormulas\(\)/)
  assert.match(metadataTemplate, /const projectSlug = slug\.value[\s\S]*?await put\(`\/projects\/\$\{projectSlug\}\/settings\/config`/)
})

test('Thumbnail Templates reloads the active project and reports an editor default-save failure', () => {
  assert.match(thumbnailTemplates, /let thumbnailTemplateScope = 0/)
  assert.match(thumbnailTemplates, /async function loadAll\(\)[\s\S]*?const projectSlug = slug\.value[\s\S]*?const request = \+\+thumbnailTemplateLoadRequest[\s\S]*?const current = \(\) => projectSlug === slug\.value[\s\S]*?request === thumbnailTemplateLoadRequest[\s\S]*?if \(!current\(\)\) return/)
  assert.match(thumbnailTemplates, /watch\(slug, \(\) => \{[\s\S]*?thumbnailTemplateScope\+\+[\s\S]*?resetThumbnailTemplateState\(\)[\s\S]*?void loadAll\(\)/)
  assert.match(thumbnailTemplates, /async function onEditorSaved[\s\S]*?await put\(`\/projects\/\$\{projectSlug\}\/settings\/config`[\s\S]*?catch \(e: any\) \{[\s\S]*?toastError\(e\?\.data\?\.detail \|\| e\?\.message \|\| 'Could not set the edited template as this project’s default'\)/)
  assert.match(thumbnailTemplates, /let thumbnailTemplateMutation = 0[\s\S]*?const templateMutationBusy = ref\(false\)/)
  for (const mutation of ['onTemplateChange', 'onEditorSaved', 'clearProjectOverride']) {
    assert.match(thumbnailTemplates, new RegExp(`async function ${mutation}[\\s\\S]*?const mutation = \\+\\+thumbnailTemplateMutation[\\s\\S]*?mutation === thumbnailTemplateMutation`))
  }
})
