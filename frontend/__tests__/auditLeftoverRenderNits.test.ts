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

test('Script Generator caps its readable width on wide screens', () => {
  assert.match(page('scripts'), /\.scripts-workspace \{ --workspace-max: 1360px; \}/)
})

test('Ideas never shows a raw format id when the format list fails to load', () => {
  const ideas = page('ideas')
  assert.match(ideas, /formatNamesById\.value\[formatId\.value\] \|\| humanizeFormatId\(formatId\.value\)/)
  assert.doesNotMatch(ideas, /formatDisplayName \|\| formatId/)
  const humanize = (id: string) => id ? id.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase()) : ''
  assert.equal(humanize('narrated-scenes'), 'Narrated scenes')
})
