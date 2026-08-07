import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextualCueDrawtextFilters } from '../lib/contextual-cue-filters.js'

function cue(template: 'documentary-label' | 'map-pin' | 'archival-caption' | 'chapter-plate', transition: 'fade' | 'slide' | 'dissolve' = 'fade') {
  return {
    id: 'cue-1', scene_id: 'scene-1', start_sec: 10, end_sec: 13.5,
    title: 'Berlin', subtitle: '1919', kind: 'location_date', placement: 'top-right',
    template, entrance: transition, exit: transition, status: 'approved', created_at: '', updated_at: '',
  } as any
}

describe('contextual cue FFmpeg treatments', () => {
  test('renders each reviewed treatment without changing its approved time window', () => {
    for (const template of ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'] as const) {
      const filters = buildContextualCueDrawtextFilters(cue(template))
      assert.ok(filters.length >= 1)
      // Values are emitted unquoted with both FFmpeg escaping levels applied,
      // so the commas inside the timing expression carry a backslash.
      assert.ok(filters.every(filter => filter.includes('enable=between(t\\,10.000\\,13.500)')))
    }
  })

  test('makes slide an actual position expression and dissolve a longer alpha transition', () => {
    const slide = buildContextualCueDrawtextFilters(cue('documentary-label', 'slide'))[0]!
    const dissolve = buildContextualCueDrawtextFilters(cue('documentary-label', 'dissolve'))[0]!
    assert.match(slide, /x=if\(lt\(t\\,/)
    assert.match(dissolve, /alpha=if\(lt\(t\\,10\.420\)/)
  })

  test('joins title and subtitle with a real newline so two-line cues render as two lines', () => {
    // Previously the pair was joined and then escaped to the two-character
    // sequence `\n`, which FFmpeg's option parser unescaped to a literal "n" —
    // every two-line cue would have rendered as "Berlinn1919" on one line even
    // once the graph parsed. The newline has to survive as a newline.
    const filter = buildContextualCueDrawtextFilters(cue('documentary-label'))[0]!
    assert.ok(filter.includes('Berlin\n1919'), 'expected a literal newline between title and subtitle')
    assert.ok(!filter.includes('Berlin\\n1919'), 'newline must not be flattened to an escape sequence')
  })

  test('treats approved copy as literal text rather than a drawtext template', () => {
    // `%` and `%{...}` are strftime/metadata expansion syntax by default, so a
    // cue reading "40% dead" must be pinned to literal expansion.
    const filter = buildContextualCueDrawtextFilters(cue('documentary-label'))[0]!
    assert.ok(filter.includes('expansion=none'))
  })

  test('an apostrophe in approved copy stays inside the text value', () => {
    const withQuote = buildContextualCueDrawtextFilters({
      ...cue('map-pin'), subtitle: "Constantinople's main avenue",
    } as any)
    // The label filter must not contain a bare apostrophe — that is precisely
    // what closed the quoted run and destroyed the whole graph.
    const label = withQuote[1]!
    assert.ok(label.includes("\\\\\\'"), 'apostrophe must carry both escaping levels')
    assert.ok(!/[^\\]'/.test(label.replace(/\\\\\\'/g, '')), 'no unescaped apostrophe may remain')
  })
})
