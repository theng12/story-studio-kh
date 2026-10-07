import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const templatePage = readFileSync(
  new URL('../pages/projects/[slug]/metadata-template.vue', import.meta.url),
  'utf8',
)
const finalizerPage = readFileSync(
  new URL('../pages/projects/[slug]/metadata.vue', import.meta.url),
  'utf8',
)

test('channel publishing profile defaults the description formula picker to "None" and only saves what it holds', () => {
  // Both pages must consume the same list endpoint.
  assert.match(templatePage, /`\/projects\/\$\{projectSlug\}\/metadata\/formulas`/)

  // The manual-sections option is the first option and maps to "" — this is
  // what must be shown/selected for a channel that has never picked a formula.
  assert.match(
    templatePage,
    /<option value="">None — build sections manually \(current behaviour\)<\/option>\s*\n\s*<option v-for="f in formulas"/,
  )

  // Loading hydrates the picker straight from channel_default_id, defaulting
  // to "" (no auto-pick for anyone) — never a hardcoded formula id.
  assert.match(templatePage, /const selectedFormulaId = ref\(''\)/)
  assert.match(templatePage, /selectedFormulaId\.value = data\?\.channel_default_id \|\| ''/)

  // Saving always sends the current selection explicitly, so picking "None"
  // (empty string) persists as "no formula" rather than being silently
  // dropped like the optional metadata_template fields are.
  assert.match(templatePage, /metadata_formula_id: selectedFormulaId\.value/)

  // Nothing about a specific formula (name, id, architecture) is hardcoded —
  // every displayed value must come off the loaded `formulas` / `selectedFormula`.
  assert.doesNotMatch(templatePage, /com\.storystudio\.metadata-formula\./)
})

test('episode override defaults to "use channel default" and omits metadata_formula_id from the generation body until the user picks one', () => {
  assert.match(finalizerPage, /`\/projects\/\$\{slug\.value\}\/metadata\/formulas`/)

  // UI-only sentinel — never a real formula id — and it is the ref's initial value.
  assert.match(finalizerPage, /const CHANNEL_DEFAULT_FORMULA = '__channel_default__'/)
  assert.match(finalizerPage, /const metadataFormulaSelection = ref<string>\(CHANNEL_DEFAULT_FORMULA\)/)

  // Episode switches must not carry one episode's explicit override onto the next.
  assert.match(finalizerPage, /metadataFormulaSelection\.value = CHANNEL_DEFAULT_FORMULA/)

  // The generation POST body only includes the key behind the sentinel check —
  // there must be exactly one occurrence of the key in the whole file (inside
  // that conditional), so a left-at-default run sends nothing and the backend
  // channel-default fallback applies.
  const formulaKeyOccurrences = (finalizerPage.match(/metadata_formula_id:/g) || []).length
  assert.equal(formulaKeyOccurrences, 1, 'metadata_formula_id must only be written once, inside the conditional spread')
  assert.match(
    finalizerPage,
    /\.\.\.\(metadataFormulaSelection\.value !== CHANNEL_DEFAULT_FORMULA\s*\n\s*\?\s*\{\s*metadata_formula_id:\s*metadataFormulaSelection\.value\s*\}\s*\n\s*:\s*\{\}\)/,
  )

  // That conditional spread must land inside the same generate/metadata POST
  // call the page already makes (not some unrelated body).
  const genCallIndex = finalizerPage.indexOf('/projects/${projectSlug}/generate/metadata`,')
  const spreadIndex = finalizerPage.indexOf('metadata_formula_id: metadataFormulaSelection.value')
  const saveCallIndex = finalizerPage.indexOf('/generate/metadata/save`')
  assert.ok(genCallIndex !== -1 && spreadIndex !== -1 && saveCallIndex !== -1)
  const payloadIndex = finalizerPage.lastIndexOf('const payload = {', genCallIndex)
  assert.ok(payloadIndex >= 0 && spreadIndex > payloadIndex && spreadIndex < genCallIndex && genCallIndex < saveCallIndex, 'override must belong to the generation payload, not the autosave body')
  assert.match(finalizerPage.slice(genCallIndex, genCallIndex + 180), /\{ \.\.\.payload, operation_id: operationId \}/)

  // The outline preview only renders once a real formula (not the sentinel,
  // not "None") is selected, and shows each section id with its header text
  // or an explicit "no header" marker — never hardcoded formula content.
  assert.match(finalizerPage, /selectedOverrideFormula\.outline/)
  assert.match(finalizerPage, /item\.header \? `[^`]*\$\{item\.header\}[^`]*` : 'no header'/)
  assert.doesNotMatch(finalizerPage, /com\.storystudio\.metadata-formula\./)
})

test('a formula in effect owns the description fields, so picking one is not inert', () => {
  // The backend rule is that an explicit request field beats the formula. This
  // page used to assert sections/max_chars/counts on EVERY run, which would
  // have left a picked formula unable to change the description architecture —
  // the one thing it exists to change. So the formula-owned fields are sent
  // only when no formula is in effect.
  assert.match(
    finalizerPage,
    /\.\.\.\(effectiveFormulaId\.value \? \{\} : \{\s*\n\s*sections: sections\.value\.filter/,
  )
  // `max_chars` is gone (2026-10-07): the description limit is YouTube's byte limit, not a formula field.
  for (const field of ['sections:', 'title_count:', 'title_max_length:', 'title_mode:', 'tag_count:']) {
    const index = finalizerPage.indexOf(`\n          ${field}`)
    assert.ok(index !== -1, `${field} must live inside the no-formula spread`)
  }

  // The channel's own default counts as "in effect" too — otherwise setting a
  // channel default would do nothing from this page.
  assert.match(
    finalizerPage,
    /const effectiveFormulaId = computed\(\(\) => \(\s*\n\s*metadataFormulaSelection\.value === CHANNEL_DEFAULT_FORMULA\s*\n\s*\? channelDefaultFormulaId\.value/,
  )

  // Channel-level title wrapping is not a formula's business and must survive.
  assert.match(finalizerPage, /title_prefix: titleConfig\.prefix,/)
  assert.match(finalizerPage, /title_suffix: titleConfig\.suffix,/)

  // And the user is told the builder is not being used, rather than it looking live.
  assert.match(finalizerPage, /supplies this run's description sections, lengths and counts/)
})
