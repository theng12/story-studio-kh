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
 * The shared metadata-profile catalogue is code, not a pack, and its `label` is
 * rendered on the Metadata page. The `id` beside it is an internal key that is
 * never rendered, so it keeps its historical spelling rather than churning a
 * content-addressed record for no customer-visible gain.
 *
 * Three of these labels are pinned field-for-field to published pack bytes by
 * `free-starter-signed-source-golden.test.ts`, so they cannot be scrubbed until the
 * successors are published. The two that no published pack pins — `calm`, which was
 * already generic, and `faith`, scrubbed in this batch — must stay clean.
 */
const LABELS_PINNED_TO_PUBLISHED_PACKS = [
  'Evidence-led YouTube package',
  'Immersive YouTube package',
  'Reflective YouTube package',
]

test('a metadata-profile label carries the mark only where a published pack pins it', async () => {
  const source = await readFile(new URL('electron/server/services/niche-loader.ts', ROOT), 'utf8')
  const labels = [...source.matchAll(/\blabel:\s*'([^']*)'/g)].map(match => match[1])
  assert.ok(labels.length >= 5, 'expected the metadata-profile labels to be found')
  assert.deepEqual(labels.filter(label => markIn(label)).sort(), LABELS_PINNED_TO_PUBLISHED_PACKS,
    'a metadata-profile label named a third-party product where no published pack pins it, or a pinned one was cleared without updating this ledger')
})

/**
 * The live legacy copy is pinned field-for-field to the PUBLISHED pack bytes by
 * `free-starter-signed-source-golden.test.ts` and `free-starter-signed-style-golden.test.mjs`.
 * Those bytes are frozen, so this copy cannot be scrubbed until the successors above
 * are published and the golden tests are repointed at them.
 *
 * This is therefore a ledger, not an allowance: it names exactly where the mark is
 * still live and why. A mark appearing anywhere else fails, and clearing one of these
 * at republication also fails until the entry is removed — so neither direction can
 * happen silently.
 *
 * THE PUBLISH SEQUENCE, recorded here because a commit body is not where anyone looks
 * when this test goes red. The owner approved publishing the thirteen successors on
 * 2026-08-28. Publication happens through his signed-in Studio Control and is NOT
 * performed by any code in this repository. Whoever runs it:
 *
 *   1. Publish the thirteen successors.
 *   2. In the SAME change, scrub the entries below and the three metadata-profile
 *      labels above, and repoint the two golden tests at the successors. Doing this
 *      before step 1 turns the goldens red; doing step 1 without it leaves the mark
 *      live in the app while the packs claim it is gone.
 *   3. Delete each entry here as it clears. When both lists are empty, delete the
 *      ledger tests — their job is finished, and a ledger of nothing is a trap for
 *      the next reader.
 *
 * Two surfaces reached this boundary independently on 2026-08-28: this batch, and the
 * built-in art-direction scrub on main, which cleared `visualStyleHint` in
 * ancient-humans.json and stopped at `metadataTitleStyleHint` in the same file. If a
 * third arrives here, the wall is real — do not route around it, publish first.
 */
const BLOCKED_UNTIL_REPUBLICATION = [
  'niches/ancient-humans.json',
  'niches/deep-time-documentary.json',
  'thumbnail-templates/curiosity-question-cartoon.json',
  'thumbnail-templates/documentary-label-tableau.json',
]

test('the mark survives only where published pack bytes pin it', async () => {
  const found = []
  for (const directory of ['niches', 'thumbnail-templates']) {
    const base = new URL(`electron/server/${directory}/`, ROOT)
    for (const name of (await readdir(base)).filter(entry => entry.endsWith('.json'))) {
      const document = await readJson(new URL(name, base))
      if (meaningfulStrings(document).some(([, text]) => markIn(text))) {
        found.push(`${directory}/${name}`)
      }
    }
  }
  assert.deepEqual(found.sort(), BLOCKED_UNTIL_REPUBLICATION,
    'a third-party mark appeared in live copy that no published pack pins, or a pinned one was cleared without updating this ledger')
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
