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
      assert.ok(filters.every(filter => filter.includes("enable='between(t,10.000,13.500)'")))
    }
  })

  test('makes slide an actual position expression and dissolve a longer alpha transition', () => {
    const slide = buildContextualCueDrawtextFilters(cue('documentary-label', 'slide'))[0]!
    const dissolve = buildContextualCueDrawtextFilters(cue('documentary-label', 'dissolve'))[0]!
    assert.match(slide, /x=if\(lt\(t\\,/)
    assert.match(dissolve, /alpha='if\(lt\(t\\,10\.420\)/)
  })
})
