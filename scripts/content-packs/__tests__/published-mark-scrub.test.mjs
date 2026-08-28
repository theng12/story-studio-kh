import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { MARKS, markIn, meaningfulStrings } from './forbidden-marks.mjs'

const ROOT = new URL('../../../', import.meta.url)
const FREE_STARTERS = new URL('content-packs/free-starters/', ROOT)

/**
 * The 2026-08-28 published-pack mark scrub.
 *
 * The owner ruled that a third-party video-platform mark must leave customer-visible
 * text. The earlier batch could edit the six Production Looks in place because they
 * were pre-stock. These thirteen packs are already published, and a published pack's
 * (pack_id, version, sha) is frozen — so the scrub ships as a NEW version beside the
 * untouched original, and this file pins the successors clean.
 */
const SUCCESSORS = [
  ['formula', 'ancient-humans-v1.0.2'],
  ['formula', 'deep-time-documentary-v1.0.2'],
  ['formula', 'economics-of-v1.0.1'],
  ['formula', 'guided-mindfulness-v1.0.1'],
  ['formula', 'history-explained-v1.0.1'],
  ['formula', 'human-behavior-explained-v1.0.2'],
  ['formula', 'natural-world-explained-v1.0.2'],
  ['formula', 'pov-your-life-as-v1.0.2'],
  ['formula', 'practical-motivation-v1.0.1'],
  ['style', 'minimal-stick-figure-explainer-v1.0.1'],
  ['style', 'prehistoric-stick-cartoon-v1.0.1'],
  ['thumbnail', 'curiosity-question-cartoon-v1.0.1'],
  ['thumbnail', 'documentary-label-tableau-v1.0.1'],
]

const DOCUMENT = { formula: 'series-formula', style: 'visual-style', thumbnail: 'thumbnail-recipe' }

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

test('every mark-scrub successor pack is free of third-party product marks', async () => {
  for (const [kind, directory] of SUCCESSORS) {
    const document = await readJson(
      new URL(`${kind}/${directory}/content/${DOCUMENT[kind]}.json`, FREE_STARTERS),
    )
    for (const [field, text] of meaningfulStrings(document)) {
      const mark = markIn(text)
      assert.ok(!mark, `${directory} ${field} names a third-party product mark (${mark}): ${text}`)
    }
  }
})

test('a mark-scrub successor supersedes its predecessor without touching it', async () => {
  for (const [kind, directory] of SUCCESSORS) {
    const successor = await readJson(new URL(`${kind}/${directory}/pack.json`, FREE_STARTERS))
    const version = /-v(\d+\.\d+\.\d+)$/.exec(directory)?.[1]
    assert.equal(successor.version, version, `${directory} must declare the version its name claims`)
    assert.ok(successor.changelog, `${directory} must say why a new version exists`)

    // The predecessor still has to be there, still carrying the mark: that is the
    // whole reason a successor was needed rather than an edit.
    const predecessor = await readJson(
      new URL(`${kind}/${directory.replace(/-v\d+\.\d+\.\d+$/, '')}/pack.json`, FREE_STARTERS),
    )
    assert.equal(predecessor.pack_id, successor.pack_id)
    assert.notEqual(predecessor.version, successor.version)
  }
})

/**
 * THE LEDGER IS GONE, AND THAT IS THE POINT.
 *
 * Two ledgers stood here until 2026-08-29: one naming the three metadata-profile
 * labels that still carried the mark, one naming the four live documents that did.
 * Both existed because the live copy is pinned field-for-field to PUBLISHED pack
 * bytes, and a published `(pack_id, version, sha256)` is frozen — so the copy could
 * not be scrubbed until successors carrying the scrubbed wording were on the shelf.
 *
 * The thirteen successors were published on 2026-08-29, the copy moved with them in
 * this change, and both lists emptied. Their own instructions said to delete them at
 * that point, because a ledger of nothing is a trap for the next reader: it reads as
 * permission rather than as history.
 *
 * What replaces them is not a ledger. It is the plain rule with no list to edit and
 * no exception to grant — the guard the two ledgers were always standing in for.
 * The `id` beside each label keeps its historical spelling deliberately: it is an
 * internal key, never rendered, and `meaningfulStrings` skips it.
 */
test('no live metadata-profile label or built-in document names a third-party mark', async () => {
  const source = await readFile(new URL('electron/server/services/niche-loader.ts', ROOT), 'utf8')
  const labels = [...source.matchAll(/\blabel:\s*'([^']*)'/g)].map(match => match[1])
  assert.ok(labels.length >= 5, 'expected the metadata-profile labels to be found')
  assert.deepEqual(labels.filter(label => markIn(label)).sort(), [],
    'a metadata-profile label names a third-party product mark')

  const found = []
  for (const directory of ['niches', 'thumbnail-templates']) {
    const base = new URL(`electron/server/${directory}/`, ROOT)
    for (const name of (await readdir(base)).filter(entry => entry.endsWith('.json'))) {
      const document = await readJson(new URL(name, base))
      if (meaningfulStrings(document).some(([, text]) => markIn(text))) found.push(`${directory}/${name}`)
    }
  }
  assert.deepEqual(found.sort(), [], 'a third-party mark appeared in live built-in copy')
})

test('the forbidden-mark list still covers the marks this batch scrubbed', () => {
  for (const sample of ['YouTube', 'MS Paint', 'Microsoft', 'TikTok', 'Instagram']) {
    assert.ok(MARKS.some(mark => mark.test(sample)), `${sample} must stay forbidden`)
  }
  // Field names carrying the mark are not customer-visible text, and the word
  // boundary already spares them: the next character is a word character.
  for (const fieldName of ['youtube_tags_hint', 'youtubeTagsHint']) {
    assert.ok(!markIn(fieldName), `${fieldName} is a field name, not customer-visible text`)
  }
  // An internal id such as `evidence-youtube` DOES match the mark. It is spared
  // only because `meaningfulStrings` never yields an `id` value — so if that
  // filter is ever loosened, this is the assertion that will notice.
  assert.ok(markIn('evidence-youtube'), 'the id spelling still matches, so the key filter is what protects it')
  assert.deepEqual(meaningfulStrings({ id: 'evidence-youtube', label: 'Evidence-led video package' }),
    [['label', 'Evidence-led video package']])
})
