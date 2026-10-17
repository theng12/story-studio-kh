import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = (name: string) => readFileSync(new URL(`../pages/projects/[slug]/${name}.vue`, import.meta.url), 'utf8')

// Geometry is verified with renders (story-audit/leftovers/*-b.png); these pin the rules that fixed it.
test('Introduction: the channel Save button never wraps', () => {
  assert.match(page('introduction'), /\.recipe-heading > \.btn \{ flex-shrink: 0; white-space: nowrap; \}/)
})

test('Contextual Cues: setup controls wrap instead of clipping Density; cue controls sit in a compact grid', () => {
  const cues = page('contextual-cues')
  assert.match(cues, /\.cue-settings-controls \{ display:grid; grid-template-columns:repeat\(auto-fit, minmax\(16rem, 1fr\)\)/)
  assert.match(cues, /\.cue-meta \{ grid-column:1\/-1; display:grid; grid-template-columns:repeat\(auto-fill, minmax\(9\.5rem, 1fr\)\)/)
})

test('Script Generator uses the full workspace width like the other generators; only its prose keeps a readable measure', () => {
  const scripts = page('scripts')
  assert.doesNotMatch(scripts, /--workspace-max:/)
  assert.match(scripts, /\.scripts-workspace :deep\(:is\(\.preview-content, \.chp-preview-content\)\) \{ max-width: var\(--prose-max\); \}/)
})

test('Ideas never shows a raw format id when the format list fails to load', () => {
  const ideas = page('ideas')
  assert.match(ideas, /formatNamesById\.value\[formatId\.value\] \|\| humanizeFormatId\(formatId\.value\)/)
  assert.doesNotMatch(ideas, /formatDisplayName \|\| formatId/)
  const humanize = (id: string) => id ? id.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase()) : ''
  assert.equal(humanize('narrated-scenes'), 'Narrated scenes')
})

test('Settings storage: why a video stays local is visible text', () => {
  const settings = page('settings')
  assert.match(settings, /<small v-if="!row\.cleanup_eligible && row\.uploaded_to_youtube" class="row-reason">/)
  assert.doesNotMatch(settings, /This receipt cannot authorize cleanup/)
})
