import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const ideas = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/ideas.vue', import.meta.url)),
  'utf8',
)

describe('Ideas freeform creative flow', () => {
  test('opens with unrestricted creative defaults', () => {
    const initializer = ideas.match(/const form = reactive\(\{([\s\S]*?)\n\}\)/)?.[1] || ''
    assert.ok(initializer, 'Ideas form initializer is missing')
    assert.match(initializer, /genre: ''/)
    assert.match(initializer, /audience: ''/)
    assert.match(initializer, /mood: ''/)
    assert.match(initializer, /creative_mode: 'open'/)
    assert.doesNotMatch(initializer, /genre: 'fantasy'|audience: 'adults'|mood: 'calming'/)
  })

  test('puts the creative brief before optional refinements', () => {
    const brief = ideas.indexOf('class="textarea idea-brief-input"')
    const refinements = ideas.indexOf('label="Refine topic, audience, and titles"')
    assert.ok(brief >= 0, 'freeform creative brief is missing')
    assert.ok(refinements > brief, 'advanced refinements must follow the creative brief')
    assert.match(ideas, /v-for="lens in creativeLensOptions"/)
    assert.match(ideas, /toggleCreativeLens\(lens\.prompt\)/)
    assert.match(ideas, /creative_lenses: \[\] as string\[\]/)
  })

  test('keeps the full-history originality guard visible, enabled, and preset-backed', () => {
    assert.match(ideas, /Prevent repeated ideas/)
    assert.match(ideas, /avoid_repeated_ideas: true/)
    assert.match(ideas, /avoid_repeated_ideas: form\.avoid_repeated_ideas/)
    assert.match(ideas, /typeof data\.avoid_repeated_ideas === 'boolean'/)
    assert.match(ideas, /saved and verified/i)
  })

  test('keeps count and generation actions in a compact launch dock', () => {
    assert.match(ideas, /class="idea-launch-dock"/)
    assert.match(ideas, /Queue \{\{ form\.count \}\} ideas/)
    assert.match(ideas, /Randomize attributes/)
    assert.match(ideas, /Surprise me/)
  })
})

test('preset and model sit above the disclosure, per-batch overrides stay inside it', () => {
  const preset = ideas.indexOf('label="Ideas preset"')
  const model = ideas.indexOf('idea-generation-card')
  const disclosure = ideas.indexOf('label="Refine topic, audience, and titles"')

  // Ideas was the only generator that buried its presets and model picker in a
  // drawer. Both answer "what am I about to run" and must stay reachable
  // without a click.
  assert.ok(preset >= 0 && model >= 0 && disclosure >= 0, 'ideas layout markers are missing')
  assert.ok(preset < disclosure, 'the preset picker must sit above the disclosure')
  assert.ok(model < disclosure, 'the generation settings card must sit above the disclosure')

  // The genuinely optional per-batch overrides stay collapsed — hoisting them
  // would push the creative brief, the primary input, off the screen.
  const attributes = ideas.indexOf('<strong>Creative attributes</strong>')
  const titleShape = ideas.indexOf('<strong>Topic and title shape</strong>')
  assert.ok(attributes > disclosure, 'creative attributes belong inside the disclosure')
  assert.ok(titleShape > disclosure, 'topic and title shape belongs inside the disclosure')

  // The badge counts only what is hidden. items_per_listicle moved out with the
  // model, so counting it would make "N active" describe a visible field.
  const count = ideas.match(/const refinementCount = computed\(\(\) => \[([\s\S]*?)\]\.filter/)?.[1] || ''
  assert.ok(count, 'refinementCount is missing')
  assert.doesNotMatch(count, /form\.items_per_listicle/)
})
