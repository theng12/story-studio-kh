import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeChannelSegments, beatLinesForPrompt, BEAT_LIBRARY, defaultSegmentRecipe } from '../lib/episode-segments.js'
import { INTRO_STYLES, INTRO_SECTIONS, introStyleBeats, introSample, introSampleFor } from '../contracts/intro-settings.js'

const welcome = 'សូមស្វាគមន៍មកកាន់ឆានែលកម្សាន្ត។'
const komsan = {
  enabled: true,
  recipe: { host_name: '', model: '', word_target: 160, custom_opening_line: welcome,
    beats: ['welcome', 'story_teaser', 'subscribe_cta', 'community_question', 'transition'].map(id => ({
      id, label: BEAT_LIBRARY[id].label, enabled: true, custom_text: `Saved ${id} instructions`,
    })) },
}

test('Komsan legacy recipe round-trips exactly, without adding style/tone choices', () => {
  const before = JSON.stringify(komsan)
  const normalized = normalizeChannelSegments({ introduction: komsan }).introduction
  assert.deepEqual(normalized, komsan)
  assert.deepEqual(normalizeChannelSegments({ introduction: normalized }).introduction, komsan)
  assert.equal(JSON.stringify(komsan), before)
  assert.deepEqual(beatLinesForPrompt(normalized.recipe), komsan.recipe.beats.map(b => `${b.label} — specifically cover: ${b.custom_text}`))
  assert.equal(introSample(normalized.recipe.beats[0], 'km', 'កម្សាន្ត', normalized.recipe.custom_opening_line), welcome)
})

test('legacy disabled/custom sections keep order, wording and adapter output', () => {
  const recipe = { ...defaultSegmentRecipe('introduction'), beats: [
    { id: 'custom-1', label: 'My own section', enabled: true, custom_text: '  Exact words  ' },
    { id: 'welcome', label: BEAT_LIBRARY.welcome.label, enabled: false },
  ] }
  const normalized = normalizeChannelSegments({ introduction: { recipe } }).introduction.recipe
  assert.deepEqual(normalized, recipe)
  assert.deepEqual(beatLinesForPrompt(normalized), ['My own section — specifically cover: Exact words'])
})

for (const style of INTRO_STYLES) test(`${style.label} survives normalization and adapts into existing beats`, () => {
  const recipe = { ...defaultSegmentRecipe('introduction'), beats: introStyleBeats(style.id), starting_style: style.id, tone: style.tone, length: 'standard' as const, word_target: 160 }
  const normalized = normalizeChannelSegments({ introduction: { recipe } }).introduction.recipe
  assert.deepEqual(normalizeChannelSegments({ introduction: { recipe: normalized } }).introduction.recipe, normalized)
  assert.equal(normalized.tone, style.tone)
  assert.deepEqual(normalized.beats.map(b => b.id), [...style.sections])
  const lines = beatLinesForPrompt(normalized)
  assert.equal(lines.length, style.sections.length + 1)
  assert.match(lines.at(-1)!, new RegExp(style.tone))
  assert.ok(lines.some(line => line.includes('chapter') || line.includes('story')))
})

test('start from scratch stays empty through normalization, not reseeded', () => {
  const recipe = { ...defaultSegmentRecipe('introduction'), beats: [], starting_style: 'scratch' }
  const result = normalizeChannelSegments({ introduction: { recipe } }, { beats: ['welcome'] }).introduction.recipe
  assert.deepEqual(result.beats, [])
  assert.deepEqual(beatLinesForPrompt(result), [])
})

test('every offered choice has purpose and Khmer/English sample; other languages get no invented sample', () => {
  for (const [id, section] of Object.entries(INTRO_SECTIONS)) for (const choice of section.options) {
    assert.ok(choice.hint)
    const beat = { id, label: section.label, enabled: true, choice: choice.id }
    assert.match(introSample(beat, 'km', 'កម្សាន្ត'), /[ក-៿]/)
    assert.ok(introSample(beat, 'en', 'Real channel'))
    assert.equal(introSample(beat, 'fr', 'Real channel'), '')
  }
})

test('a sample says whose words it is, and invents nothing when nobody chose', () => {
  // The owner's own saved wording, with no option picked, must show THOSE words
  // — the catalogue's first option is a different sentence from the one that
  // would be generated.
  const mine = { id: 'story_teaser', label: 'Story teaser', enabled: true, custom_text: 'Mention the flood.' }
  assert.deepEqual(introSampleFor(mine, 'km', 'កម្សាន្ត'), { text: 'Mention the flood.', source: 'custom' })
  // Neither chosen nor written: nothing, so the purpose hint stands alone.
  const bare = { id: 'story_teaser', label: 'Story teaser', enabled: true }
  assert.deepEqual(introSampleFor(bare, 'km', 'កម្សាន្ត'), { text: '', source: '' })
  // A picked option is the page's example, in the channel's language.
  assert.equal(introSampleFor({ ...bare, choice: 'explain' }, 'km', 'កម្សាន្ត').source, 'choice')
  // The channel's exact opening line outranks a section's own wording.
  assert.deepEqual(introSampleFor({ ...mine, id: 'welcome' }, 'km', 'កម្សាន្ត', 'សូមស្វាគមន៍។'),
    { text: 'សូមស្វាគមន៍។', source: 'opening' })
})
