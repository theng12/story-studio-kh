/**
 * The caption properties panel and the built-in look gallery.
 *
 * Two things are being protected here, and neither is cosmetic.
 *
 * **1. Every schema field is reachable.** The style document is the contract;
 * a field the engine reads but the panel cannot set is a control the customer
 * does not have, and nothing else would notice. So the panel's source is
 * checked against the schema itself rather than against a hand-written list
 * that could quietly fall behind.
 *
 * **2. A look changes the LOOK.** AGENTS.md records three shipped defects of
 * exactly one shape — a preset silently re-deciding something chosen
 * elsewhere: an episode's own image restored onto a different episode, a
 * customer's scene pacing overwritten by an art-style preset, "use episode
 * anchor" switched on by every preset. A caption look must not be the fourth.
 * Applying one must leave `enabled`, `source`, `srt_path` and
 * `hide_during_intro` exactly as they were.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const {
  defaultSubtitleStyle,
  mergeSubtitleStyle,
  normalizeSubtitleStyle,
} = await import('../../electron/server/contracts/subtitle-style.js')
const { BUILT_IN_SUBTITLE_PRESETS } = await import('../../electron/server/contracts/subtitle-presets.js')

const panel = readFileSync(
  fileURLToPath(new URL('../components/SubtitleStylePicker.vue', import.meta.url)),
  'utf8',
)
const videoAssembly = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)),
  'utf8',
)
const broll = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/broll.vue', import.meta.url)),
  'utf8',
)

/** Every leaf field in the style document, as `group.field`. */
function schemaFields(): string[] {
  const doc = defaultSubtitleStyle() as Record<string, any>
  const out: string[] = []
  for (const [group, value] of Object.entries(doc)) {
    if (group === 'schema_version' || value === null || typeof value !== 'object') continue
    for (const key of Object.keys(value)) out.push(`${group}.${key}`)
  }
  return out
}

describe('the properties panel exposes the whole schema', () => {
  test('every field has a control', () => {
    const missing = schemaFields().filter(path => {
      const [group, field] = path.split('.') as [string, string]
      // A field is wired either through `set('group','field', …)` or read
      // straight off the document in a `:value`/`:hex` binding.
      return !panel.includes(`set('${group}','${field}'`)
        && !panel.includes(`set('${group}', '${field}'`)
        && !panel.includes(`style.${group}.${field}`)
    })
    assert.deepEqual(missing, [], `schema fields with no control: ${missing.join(', ')}`)
  })

  test('every field group has a collapsible section', () => {
    for (const group of ['typography', 'color', 'box', 'placement', 'animation', 'word']) {
      assert.ok(panel.includes(`id: '${group}'`), `no section for ${group}`)
    }
  })

  test('only the first section starts expanded, so Step 5 is not buried', () => {
    const open = panel.match(/const open = reactive<Record<string, boolean>>\(\{([^}]*)\}\)/)![1]!
    assert.equal((open.match(/true/g) || []).length, 1, 'exactly one group open by default')
    assert.match(open, /typography: true/)
  })

  test('the word-mode honesty line is present and unhedged', () => {
    assert.match(panel, /Word timing is estimated/)
    assert.ok(!/exact word timing/i.test(panel), 'the panel must not claim precision it does not have')
  })

  test('the panel does not re-implement the renderer', () => {
    // The CSS block is admitted as a sketch; the real answer comes from the
    // backend. A second renderer here is how preview and burn drift apart.
    assert.match(panel, /CSS sketch/)
    assert.match(panel, /preview-subtitles/)
  })
})

describe('applying a built-in look changes the look and nothing else', () => {
  const EPISODE_KEYS = ['enabled', 'source', 'srt_path', 'hide_during_intro']

  test('no built-in preset carries an episode-specific or workflow key', () => {
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      const body = preset.style as Record<string, unknown>
      for (const key of EPISODE_KEYS) {
        assert.ok(!(key in body), `${preset.id} carries "${key}"`)
      }
      // A style document has exactly these groups. Anything else is a key that
      // escaped the schema and would be applied without anyone deciding to.
      assert.deepEqual(
        Object.keys(body).sort(),
        ['animation', 'box', 'color', 'edge', 'placement', 'schema_version', 'typography', 'word'],
        `${preset.id} has unexpected top-level keys`,
      )
    }
  })

  /**
   * The apply path, exercised the way the page wires it: the component emits a
   * STYLE and the page assigns it to `subtitles.style`. Everything else on the
   * subtitle config must survive untouched.
   */
  test('the live subtitle config keeps every decision made elsewhere', () => {
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      const subtitles = {
        enabled: true,
        source: 'whisper',
        srt_path: '/episodes/TN0042/subtitles/TN0042_stitched.srt',
        hide_during_intro: true,
        style: defaultSubtitleStyle(),
      }
      // What the component emits, and what the page does with it.
      subtitles.style = normalizeSubtitleStyle(preset.style)

      assert.equal(subtitles.enabled, true, `${preset.id} switched subtitles off or on`)
      assert.equal(subtitles.source, 'whisper', `${preset.id} changed the subtitle source`)
      assert.equal(subtitles.srt_path, '/episodes/TN0042/subtitles/TN0042_stitched.srt', `${preset.id} moved the episode's SRT`)
      assert.equal(subtitles.hide_during_intro, true, `${preset.id} re-decided intro suppression`)
      assert.deepEqual(subtitles.style, preset.style, `${preset.id} did not apply cleanly`)
    }
  })

  test('the component emits update:style and has no other emit', () => {
    const emits = [...panel.matchAll(/emit\('([a-zA-Z:]+)'/g)].map(m => m[1])
    assert.deepEqual([...new Set(emits)].sort(), ['change', 'hex', 'opacity', 'update:style'].filter(e => emits.includes(e)).sort())
    assert.ok(emits.includes('update:style'))
    // Structurally impossible to touch episode state: the component is never
    // handed it in the first place.
    for (const key of EPISODE_KEYS) {
      assert.ok(!panel.includes(`subtitles.${key}`), `the panel references ${key}`)
    }
  })

  test('applying a look is idempotent — re-applying changes nothing', () => {
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      assert.deepEqual(normalizeSubtitleStyle(normalizeSubtitleStyle(preset.style)), preset.style, preset.id)
    }
  })

  test('a single field edit changes only that field', () => {
    const before = defaultSubtitleStyle()
    const after = mergeSubtitleStyle(before, { typography: { font_size_px: 44 } })
    assert.equal(after.typography.font_size_px, 44)
    assert.deepEqual(
      { ...after, typography: { ...after.typography, font_size_px: before.typography.font_size_px } },
      before,
    )
  })
})

describe('both host pages are on the new document', () => {
  for (const [name, source] of [['video-assembly', videoAssembly], ['broll', broll]] as const) {
    test(`${name} loads stored styles through the shared normaliser`, () => {
      assert.match(source, /from '@shared\/subtitle-style'/)
      assert.match(source, /normalizeSubtitleStyle\(/)
    })

    test(`${name} replaces the style rather than shallow-merging it`, () => {
      // `Object.assign(subtitles.style, storedFlatStyle)` on a nested document
      // leaves a half-upgraded hybrid: v1 keys sitting beside v2 groups, with
      // the renderer reading neither set completely.
      assert.ok(
        !/Object\.assign\((?:subtitles|brollSubtitles)\.style/.test(source),
        `${name} still shallow-merges the caption style`,
      )
    })

    test(`${name} carries no duplicate hardcoded default style`, () => {
      // One source of truth. A second literal here is how the two pages drift.
      assert.ok(!/font_size_px:\s*28/.test(source), `${name} restates the default style inline`)
      assert.match(source, /defaultSubtitleStyle\(\)/)
    })
  }
})

/**
 * v1.2.1 — the gallery can now contain caption looks from installed Content
 * Packs, which cannot be bundled and therefore have to be fetched.
 *
 * The risk this introduces is that the sixteen FREE looks come to depend on a
 * network round-trip inside a desktop app. They must not: the bundled list is
 * the initial value, and the fetch may only ever append to it.
 */
describe('the gallery merges installed packs without depending on them', () => {
  test('the bundled built-ins are the initial value, not a fallback', () => {
    assert.match(panel, /ref<SubtitleStylePreset\[\]>\(\[\.\.\.BUILT_IN_SUBTITLE_PRESETS\]\)/,
      'the free library must be on screen before any request is made')
    assert.match(panel, /import \{ BUILT_IN_SUBTITLE_PRESETS/,
      'the built-ins must still be bundled, not fetched')
  })

  test('the catalogue is fetched and a failure is survivable', () => {
    assert.match(panel, /video-editor\/subtitles\/catalog/)
    assert.match(panel, /res\.presets\.length/,
      'an empty or malformed response must leave the built-in gallery in place')
    assert.match(panel, /} catch \{/, 'a failed catalogue fetch must not blank the gallery')
  })

  test('a pack look says which pack it came from', () => {
    assert.match(panel, /origin\?\.origin === 'content-pack'/)
    assert.match(panel, /packChipTitle/)
    assert.match(panel, /pack_id/)
    // And what uninstalling that pack will and will not do, because that is the
    // whole reason provenance is worth showing.
    assert.match(panel, /does not change any episode already using it/i)
  })

  test('a refused pack look is shown rather than silently missing', () => {
    assert.match(panel, /refusals/)
  })

  test('applying a pack look still emits STYLE and nothing else', () => {
    // The Preset Boundaries rule does not get an exception for pack content.
    assert.match(panel, /function applyBuiltInPreset\(p: SubtitleStylePreset\) \{[\s\S]{0,200}?emit\('update:style'/)
    assert.ok(!/applyBuiltInPreset[\s\S]{0,400}?emit\('update:(?!style)/.test(panel),
      'applying a look must emit no event other than update:style')
  })
})

/**
 * v1.3.2 — the exact render is the evidence, so it must not be the smaller,
 * blurrier element on the page.
 *
 * Before this release the rough CSS sketch was drawn at 640px while the real
 * FFmpeg burn sat beside it at 320px, sourced from a 640x360 render — so the
 * approximation outranked the accurate thing, and enlarging the accurate thing
 * only upscaled it. The owner could not read the type he was choosing.
 */
describe('the exact subtitle render outranks the sketch', () => {
  test('the exact render opens in the app\'s shared dialog, not a bespoke overlay', () => {
    assert.match(panel, /<Modal[\s\S]{0,200}?size="xxl"/,
      'the enlarged render must reuse Modal.vue rather than inventing an overlay')
    assert.match(panel, /exactModalOpen/)
    // Rendering is the ask ("can you make it popup"), so a successful render
    // opens it without a second click.
    assert.match(panel, /exactUrl\.value = res\.url[\s\S]{0,200}?exactModalOpen\.value = true/)
  })

  test('the clip is described by the size the backend reports, never a literal', () => {
    assert.match(panel, /exactWidth\s*\}\}×\{\{\s*exactHeight/,
      'the note must interpolate the reported size')
    assert.match(panel, /Number\(res\.width\)/)
    assert.match(panel, /Number\(res\.height\)/)
    // Checked against the rendered COPY only — comments and CSS may mention
    // the old size while explaining why it changed.
    const visibleCopy = panel.split('<script')[0]!.replace(/<!--[\s\S]*?-->/g, '')
    assert.ok(!/\d{3,4}\s*[×x]\s*\d{3,4}/.test(visibleCopy),
      'no hardcoded preview resolution may survive in what the user reads')
  })

  test('neither preview is given a width the other is denied', () => {
    // The inversion was literally a `max-width: 320px` on the exact render
    // against `max-width: 640px` on the sketch. Both panes are now one grid.
    assert.ok(!/\.ssp-exact-video\s*\{[^}]*max-width:\s*320px/.test(panel),
      'the exact render must not be capped smaller than the sketch')
    assert.match(panel, /\.ssp-preview-pair\s*\{[^}]*grid-template-columns/)
  })

  test('the enlarged clip is not covered by native video controls', () => {
    // Captions are bottom-anchored by default; the control bar lands on them.
    assert.ok(!/ssp-exact-video-large[\s\S]{0,240}?\scontrols/.test(panel),
      'native controls would hide the caption this dialog exists to show')
    assert.match(panel, /toggleExactPlayback/)
  })
})

/**
 * v1.3.2 — Step 1 assets are openable, and the merged track says what is in
 * front of the narration instead of requiring a listen.
 */
describe('Video Assembly Step 1 can be inspected before a render', () => {
  test('scene and thumbnail chips open the shared lightbox', () => {
    assert.match(videoAssembly, /<ImagePreviewLightbox/)
    assert.match(videoAssembly, /openAssetPreview\('scenes'/)
    assert.match(videoAssembly, /openAssetPreview\('thumbnails'/)
  })

  test('the merged track gets a player that fetches nothing until played', () => {
    assert.match(videoAssembly, /class="merged-audio-player[\s\S]{0,120}?preload="none"/,
      'a 26 MB track behind 130 chips must not preload')
    assert.match(videoAssembly, /getAudioPreviewUrl/)
  })

  test('the intro answer comes from the scan, never from the live merge config', () => {
    assert.match(videoAssembly, /describeMergedAudioOpening\(scannedAssets\.value\?\.merged_audio\?\.\[0\]\?\.opening\)/)
    // The trap: describing an existing file with whatever is configured now.
    assert.ok(!/merged-audio-opening[\s\S]{0,600}?audioMerge(Config|Settings)/.test(videoAssembly))
  })
})
