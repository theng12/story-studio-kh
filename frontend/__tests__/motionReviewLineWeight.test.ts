/**
 * The Sketch Draw line weight in Motion Review.
 *
 * The weight follows the reveal's path exactly: tabs beside the reveal setting, this
 * episode's own value beside its pen and hold and reveal, absent meaning NORMAL. It is saved by
 * the Motion Review preset, because it is a reusable look (AGENTS.md §5).
 *
 * These are behavioural where they can be (the util, the preset's real strip) and textual where
 * the page's own wiring is the thing under test — the same shape the reveal's own tests use.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'

// ── In-memory config store driving the stubbed $fetch ───────────────────────
const configStore: Record<string, any> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]
  if (!configStore[slug]) configStore[slug] = {}
  if (!options.method || options.method === 'GET') return JSON.parse(JSON.stringify(configStore[slug]))
  if (options.method === 'PUT') {
    Object.assign(configStore[slug], JSON.parse(JSON.stringify(options.body)))
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

const { usePresets, DEFAULT_EXCLUDE_KEYS } = await import('../composables/usePresets.js')
const { LINE_WEIGHTS, LINE_WEIGHT_LABELS, lineWeightFromDraft, lineWeightLabel } = await import('../utils/sketch-line-weight.js')

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url)),
  'utf8',
)

beforeEach(() => {
  for (const key of Object.keys(configStore)) delete configStore[key]
})

/** The page's preset controller, wired the way the page wires it. */
function makeMotionPresets(slug: string, live: { value: any }) {
  return usePresets<any>({
    slug,
    configKey: 'motion_review',
    presetType: 'motion-review',
    autoApplyOnLoad: false,
    excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'overrides'],
    snapshot: () => ({
      model: 'live-model',
      duration_mode: 'manual',
      ...(live.value ? { line_weight: live.value } : {}),
    }),
    apply: (data: any) => {
      if (typeof data?.line_weight === 'string' && LINE_WEIGHTS.includes(data.line_weight as any)) {
        live.value = data.line_weight
      }
    },
  })
}

describe('the line weight control', () => {
  test('three weights, and "follow the channel" is not a weight', () => {
    assert.deepEqual([...LINE_WEIGHTS], ['thin', 'normal', 'bold'])
    assert.deepEqual(Object.keys(LINE_WEIGHT_LABELS), ['thin', 'normal', 'bold'])
    assert.equal(lineWeightLabel('thin'), 'Thin')
    assert.deepEqual(lineWeightFromDraft('channel'), { ok: true, weight: null })
    assert.deepEqual(lineWeightFromDraft('bold'), { ok: true, weight: 'bold' })
    assert.equal(lineWeightFromDraft('').ok, false, 'nothing chosen is not a weight')
  })

  test('the weight tabs sit beside the reveal setting and edit THIS episode', () => {
    assert.match(page, /<span>Line weight for \{\{ episodeId \}\}<\/span>/)
    assert.match(page, /role="group" aria-label="Sketch Draw line weight for this episode"/)
    assert.match(page, /v-for="weight in LINE_WEIGHTS"[^>]*:aria-pressed="activeLineWeight === weight"/)
    assert.match(page, /:class="\{ 'is-active': activeLineWeight === weight \}"/)
    assert.match(page, /:disabled="!lineWeightLoaded \|\| lineWeightSaving"/)
    assert.doesNotMatch(page, /<select v-model="lineWeightChoice"/)
    assert.match(page, /function chooseLineWeight\(weight: SketchLineWeight\)/)
    assert.match(page, /click="chooseLineWeight\(weight\)"/)
    // It says whose weight is in force, in both directions.
    assert.match(page, /\{\{ episodeId \}\} uses its own weight: \{\{ lineWeightLabel\(episodeLineWeight\) \}\}\. Other episodes are not affected\./)
    assert.match(page, /\{\{ episodeId \}\} follows the channel default weight: \{\{ lineWeightLabel\(channelLineWeight\) \}\}/)
  })

  test('an inherited weight selects its tab, and the episode can go back to following the channel', () => {
    // The tab in force: the channel's weight while following it, this episode's own once it has one.
    const active = page.slice(page.indexOf('const activeLineWeight = computed'))
    assert.match(active, /if \(!lineWeightLoaded\.value\) return null/)
    assert.match(active, /choice === 'channel'\) return channelLineWeight\.value/)
    assert.match(active, /return choice \|\| null/)
    // Clicking the weight already in force changes nothing, so inheriting never stores a duplicate.
    const chooseStart = page.indexOf('function chooseLineWeight(')
    const choose = page.slice(chooseStart, page.indexOf('\n}', chooseStart))
    assert.match(choose, /if \(lineWeightChoice\.value === weight\) return/)
    assert.match(choose, /if \(lineWeightChoice\.value === 'channel' && channelLineWeight\.value === weight\) return/)
    // The quiet "Channel default (...)" action clears this episode's own weight via the
    // existing handler — and it is a button in the weight field, not a fourth tab.
    assert.match(page, /<button v-if="isSketchDraw && lineWeightLoaded && episodeLineWeight"[^>]*@click="followChannelLineWeight"[^>]*>Channel default \(\{\{ lineWeightLabel\(channelLineWeight\) \}\}\)<\/button>/)
    const followStart = page.indexOf('function followChannelLineWeight(')
    const follow = page.slice(followStart, page.indexOf('\n}', followStart))
    assert.match(follow, /lineWeightChoice\.value = 'channel'/)
    assert.match(follow, /onLineWeightChoice\(\)/)
    const group = page.slice(page.indexOf('role="group" aria-label="Sketch Draw line weight for this episode"'))
    const tabs = group.slice(0, group.indexOf('</div>'))
    assert.doesNotMatch(tabs, /channel/, 'the group holds only the three weights')
    assert.equal([...tabs.matchAll(/weight-tab/g)].length, 1, 'one v-for produces all three tabs')
  })

  test('the save goes to THIS episode, and a late answer never lands on the next one', () => {
    const start = page.indexOf('async function saveLineWeight(')
    assert.ok(start >= 0, 'expected saveLineWeight')
    const save = page.slice(start, page.indexOf('\n}', start))
    assert.match(save, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-line-weight`, \{ line_weight: next \}/)
    assert.match(save, /if \(ep !== episodeId\.value\) return/)
    assert.match(save, /episodeLineWeight\.value = next/)
    // "Follow the channel" clears this episode's own value; a weight sets it.
    const choice = page.slice(page.indexOf('function onLineWeightChoice('))
    assert.match(choice, /if \(lineWeightChoice\.value === 'channel'\) \{ void saveLineWeight\(null\); return \}/)
    assert.match(choice, /const parsed = lineWeightFromDraft\(lineWeightChoice\.value\)/)
  })

  test('the state is episode-scoped: an episode change blanks it', () => {
    const reset = page.slice(page.indexOf('function resetEpisodeScopedMotionState()'))
    assert.match(reset, /episodeLineWeight\.value = null/)
    assert.match(reset, /lineWeightChoice\.value = 'channel'/)
    assert.match(reset, /lineWeightLoaded\.value = false/)
    assert.match(reset, /lineWeightSaving\.value = false/)
    assert.match(reset, /lineWeightUnreadable\.value = ''/)
    assert.match(page, /watch\(episodeId, \(\) => \{[\s\S]*resetEpisodeScopedMotionState\(\)[\s\S]*void loadEpisodeLineWeight\(\)/)
    assert.match(page, /:disabled="!lineWeightLoaded \|\| lineWeightSaving"/)
    const load = page.slice(page.indexOf('async function loadEpisodeLineWeight('))
    assert.match(load, /if \(ep !== episodeId\.value\) return/)
    assert.match(load, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-line-weight`/)
    assert.match(load, /episodeLineWeight\.value = result\.episode_line_weight/)
    assert.match(load, /channelLineWeight\.value = result\.channel_line_weight/)
  })

  test('the channel default moves only on purpose, and only when the episode differs from it', () => {
    assert.match(page, /<button v-if="isSketchDraw && lineWeightLoaded && episodeLineWeight && episodeLineWeight !== channelLineWeight"[^>]*>Set as channel default</)
    assert.match(page, /v-if="isSketchDraw && lineWeightLoaded && episodeLineWeight && episodeLineWeight !== channelLineWeight"/)
    const setDefault = page.slice(page.indexOf('async function setChannelLineWeightDefault('))
    assert.match(setDefault, /if \(!await ask\(\{/, 'it asks first')
    assert.match(setDefault, /Make channel default/)
    assert.match(setDefault, /motion-presentation`, \{ renderer: clipRenderer\.value, line_weight: weight \}/)
  })

  test('a popup picker with samples is NOT built here: the weights are tabs', () => {
    assert.doesNotMatch(page, /line-weight-picker|lineWeightPicker/)
    assert.doesNotMatch(page, /<dialog[^>]*line.weight/i)
  })
})

describe('the Motion Review preset carries the weight', () => {
  test('a saved preset stores the weight, and applying it restores the weight', async () => {
    const live = { value: 'bold' as any }
    const presets = makeMotionPresets('presets', live)
    await presets.load()
    const saved = await presets.saveAs('Bold look')
    assert.equal(saved.data.line_weight, 'bold')
    live.value = 'thin'
    presets.applyActive()
    assert.equal(live.value, 'bold')
  })

  test('a preset that stored no weight leaves the live one alone', async () => {
    const live = { value: null as any }
    const presets = makeMotionPresets('empty', live)
    await presets.load()
    await presets.saveAs('No weight')
    assert.equal(configStore.empty.motion_review_presets[0].data.line_weight, undefined)
    live.value = 'thin'
    presets.applyActive()
    assert.equal(live.value, 'thin')
  })

  test('the page wires the weight into the preset snapshot and the apply', () => {
    const start = page.indexOf('const motionPresets = usePresets(')
    const snapshot = page.slice(start, page.indexOf('\n  apply:', start))
    assert.ok(snapshot.includes('episodeLineWeight.value'), 'the weight is captured')
    const apply = page.slice(page.indexOf('\n  apply:', start))
    assert.match(apply, /if \(lineWeightLoaded\.value && typeof data\?\.line_weight === 'string'/)
    assert.match(apply, /void saveLineWeight\(nextWeight\)/)
  })
})
