import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../pages/projects/[slug]/image-prompts.vue', import.meta.url), 'utf8')
const picker = readFileSync(new URL('../components/ThumbnailTemplatePicker.vue', import.meta.url), 'utf8')

test('Shell browsing uses the shared modal and keeps only the selected Shell on the step', () => {
  const modal = page.indexOf('<Modal :visible="shellLibraryOpen"')
  assert.ok(modal > 0)
  assert.ok(page.indexOf('<ThumbnailTemplatePicker') > modal)
  assert.match(page, /data-testid="selected-shell"/)
  assert.match(picker, /v-model="query" type="search"/)
  assert.match(picker, /!t\.shellImage && !t\.previewImages\?\.length/)
  assert.match(picker, /Preview pending/)
  assert.ok(page.indexOf('aria-label="How closely to follow the Shell layout"') > page.indexOf('What should make someone click?'))
})

test('new uploads become library Shells and select the returned identity', () => {
  const upload = page.slice(page.indexOf('async function extractThumbReferenceStyle()'), page.indexOf('// v1.0.87+:'))
  assert.match(upload, /post<\{ template: SelectedThumbnailRecipe \}>\('\/thumbnail-templates'/)
  assert.match(upload, /shell_template_id: created\.template\.id/)
  assert.match(upload, /await applyThumbnailShell\(data\.template\)/)
  assert.doesNotMatch(upload, /thumb_reference_asset\s*=/)
  assert.doesNotMatch(upload, /channel-reference:/)
})

test('choosing a Shell preserves the separate lettering and visual choices', () => {
  const apply = page.slice(page.indexOf('async function applyThumbnailShell('), page.indexOf('function setReferenceStrength('))
  assert.doesNotMatch(apply, /thumb_(?:headline_mode|text_style|font_style|text_position|art_direction)\s*=/)
  assert.doesNotMatch(apply, /style_tag\s*=/)
  assert.match(apply, /thumbnail_shell_id: template\.id/)
})

test('presets retain reusable identity while foreign channel previews resolve their source', () => {
  assert.match(page, /'thumb_reference_asset', 'thumb_reference_style'/)
  assert.match(page, /thumbnail_shell_id: data\.form\.thumbnail_shell_id/)
  assert.match(page, /sourceSlug = templateId\.slice\('channel-reference:'\.length\)/)
  assert.match(page, /encodeURIComponent\(sourceSlug\).*thumbnail-reference\/image/)
  assert.match(page, /typeof cfg\.thumbnail_shell_id === 'string'/)
  assert.match(page, /if \(!shellSelectionExplicit && !form\.thumbnail\.thumbnail_shell_id/)
})
