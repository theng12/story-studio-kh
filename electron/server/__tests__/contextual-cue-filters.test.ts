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

  // ── Placement (v1.3.0) ────────────────────────────────────────────────
  //
  // Bottom corners were always computed correctly here and always unreachable
  // everywhere else. These lock down the geometry now that they can actually
  // be chosen, and — just as importantly — pin the corner path byte-for-byte,
  // so adding precise anchors cannot quietly move a label in an episode that
  // was already delivered.

  test('each corner emits exactly the insets it always has', () => {
    const at = (placement: string) => {
      const filter = buildContextualCueDrawtextFilters({ ...cue('documentary-label'), placement } as any)[0]!
      return {
        x: /(?:^|:)x=([^:]+)/.exec(filter)?.[1],
        y: /(?:^|:)y=([^:]+)/.exec(filter)?.[1],
      }
    }
    assert.deepEqual(at('top-left'), { x: '56', y: '56' })
    assert.deepEqual(at('top-right'), { x: 'w-text_w-56', y: '56' })
    assert.deepEqual(at('bottom-left'), { x: '56', y: 'h-text_h-56' })
    assert.deepEqual(at('bottom-right'), { x: 'w-text_w-56', y: 'h-text_h-56' })
  })

  test('a precise anchor is clamped inside the safe band on both axes', () => {
    const filter = buildContextualCueDrawtextFilters({
      ...cue('documentary-label'), position_x_pct: 50, position_y_pct: 50,
    } as any)[0]!
    // Centred: the label is pulled back by half its own measured size, and
    // clip() keeps it inside the 6% band whatever that size turns out to be.
    assert.match(filter, /x=clip\(w\*0\.5000-text_w\/2\\,w\*0\.0600\\,w-text_w-w\*0\.0600\)/)
    assert.match(filter, /y=clip\(h\*0\.5000-text_h\/2\\,h\*0\.0600\\,h-text_h-h\*0\.0600\)/)
  })

  test('a label near an edge grows away from it, not off the frame', () => {
    const nearLeft = buildContextualCueDrawtextFilters({
      ...cue('documentary-label'), position_x_pct: 10, position_y_pct: 10,
    } as any)[0]!
    // Inside the outer third the leading edge sits on the point, so the text
    // extends inward — no `-text_w` term at all.
    assert.match(nearLeft, /x=clip\(w\*0\.1000\\,/)
    assert.match(nearLeft, /y=clip\(h\*0\.1000\\,/)

    const nearRight = buildContextualCueDrawtextFilters({
      ...cue('documentary-label'), position_x_pct: 90, position_y_pct: 90,
    } as any)[0]!
    assert.match(nearRight, /x=clip\(w\*0\.9000-text_w\\,/)
    assert.match(nearRight, /y=clip\(h\*0\.9000-text_h\\,/)
  })

  test('a precise anchor overrides the corner the cue still carries', () => {
    const filter = buildContextualCueDrawtextFilters({
      ...cue('documentary-label'), placement: 'top-right', position_x_pct: 20, position_y_pct: 80,
    } as any)[0]!
    assert.ok(!filter.includes('x=w-text_w-56'), 'the stored corner must not win over a precise anchor')
    assert.match(filter, /x=clip\(w\*0\.2000\\,/)
  })

  test('a chapter plate stays centred until it is placed by hand', () => {
    const plain = buildContextualCueDrawtextFilters(cue('chapter-plate'))[0]!
    // Unchanged: a plate is a centred title card, and honouring the corner now
    // would move every plate in every episode already delivered.
    assert.match(plain, /x=\(w-text_w\)\/2/)
    assert.match(plain, /y=h\*0\.18/)

    const placed = buildContextualCueDrawtextFilters({
      ...cue('chapter-plate'), position_x_pct: 25, position_y_pct: 75,
    } as any)[0]!
    assert.match(placed, /x=clip\(w\*0\.2500\\,/)
  })

  test('a precisely placed map pin keeps its label clear of the pin', () => {
    const [pin, label] = buildContextualCueDrawtextFilters({
      ...cue('map-pin'), position_x_pct: 15, position_y_pct: 40,
    } as any)
    assert.match(pin!, /x=clip\(w\*0\.1500\\,/)
    // The same 34px step the left-corner inset pair has always produced (56 → 90).
    assert.match(label!, /x=clip\(w\*0\.1500\+34\\,/)
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

  // ── The derived intro offset ─────────────────────────────────────────────
  // A cue is reviewed against Scene Plan time; the composed video may open with
  // a branded opening the plan does not carry. Video Assembly measures that
  // opening from the real clips and hands the difference in here, so the owner
  // never restates how long his intro is. See `sceneTimelineOffsetSec` in
  // `generators/video.ts`.
  test('no intro means no shift — the reviewed window renders exactly as approved', () => {
    // The requirement stated as a test rather than assumed: an episode with
    // nothing before its scenes must render byte-identically to before.
    const unshifted = buildContextualCueDrawtextFilters(cue('documentary-label'))
    for (const offset of [0, undefined as unknown as number]) {
      assert.deepEqual(
        buildContextualCueDrawtextFilters(cue('documentary-label'), offset),
        unshifted,
        'a zero/absent offset must not change a single character of the filter',
      )
    }
    assert.ok(unshifted.every(filter => filter.includes('enable=between(t\\,10.000\\,13.500)')))
  })

  test('a branded opening moves every timing expression by exactly the measured length', () => {
    // 10s intro, plan starting at 0 — the live branded-intro case, where cues used
    // to fire 10s early because nothing added the opening to their times.
    const shifted = buildContextualCueDrawtextFilters(cue('documentary-label'), 10)
    assert.ok(shifted.every(filter => filter.includes('enable=between(t\\,20.000\\,23.500)')))
    // Every clock in the filter has to move together, not just the gate: an
    // alpha ramp or slide left on the old clock would fade in over the intro.
    assert.match(shifted[0]!, /alpha=if\(lt\(t\\,20\.200\)/)
    const slide = buildContextualCueDrawtextFilters(cue('documentary-label', 'slide'), 10)[0]!
    assert.match(slide, /x=if\(lt\(t\\,20\.280\)/)
    assert.ok(!slide.includes('10.280'), 'no expression may keep the unshifted clock')
    // Both label filters of a two-part treatment move as one.
    const pin = buildContextualCueDrawtextFilters(cue('map-pin'), 10)
    assert.equal(pin.length, 2)
    assert.ok(pin.every(filter => filter.includes('enable=between(t\\,20.000\\,23.500)')))
  })

  test('a negative shift is applied too, because the cue follows its scene', () => {
    // Legacy plans begin their scenes after the merged audio's lead-in. With a
    // shorter opening the scene track lands EARLIER than plan time, and the cue
    // has to come with it.
    const shifted = buildContextualCueDrawtextFilters(cue('documentary-label'), -6.066)
    assert.ok(shifted.every(filter => filter.includes('enable=between(t\\,3.934\\,7.434)')))
  })

  test('shifting does not mutate the caller\'s approved cue', () => {
    const approved = cue('documentary-label')
    buildContextualCueDrawtextFilters(approved, 10)
    assert.equal(approved.start_sec, 10, 'the reviewed timeline is immutable')
    assert.equal(approved.end_sec, 13.5)
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
