import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const CONTENT_PACKS_DIR = new URL('content-packs/', ROOT)

// The retired source-only `content-packs/archival-ledger` monolith is excluded
// from generic pack discovery everywhere else in this tooling (see
// scripts/content-packs/README.md's "Generic discovery" note) and is not part
// of what ships to a customer. It is excluded here too.
const EXCLUDED_DIR = 'content-packs/archival-ledger/'

/**
 * A pack declaring `compatible_formula_ids` is asserting "this pack activates
 * when the customer's Series Formula id is exactly this string" — see
 * `isCompatible()` in electron/server/services/topic-pack-loader.ts and its
 * callers. Content-Pack-sourced ids are qualified
 * (`com.storystudio.formula.<slug>`) and can only ever be satisfied by an
 * installed Series Formula pack carrying that exact id. A qualified id with
 * no matching Series Formula pack anywhere in the tree can never match
 * anything at runtime — it is permanently inert, the way
 * `com.storystudio.formula.hidden-mechanics-history` was in the
 * `historical-wars-treaties-world-order` Topic Pack (owner ruling,
 * 2026-08-28): that formula was retired into the paid Archival Ledger and no
 * content-pack Series Formula was ever published under its old id.
 *
 * Coverage note: this guard only checks the qualified content-pack namespace
 * against other content-pack Series Formula sources. It does NOT know about
 * the separate, older short-id niche namespace
 * (`electron/server/niches/*.json`, e.g. `history-narration`) that a few
 * pre-2026-08-28 documents were authored against instead of the qualified
 * convention — checking that namespace is out of scope here. Those
 * pre-existing references, plus the two now-frozen
 * `historical-wars-treaties-world-order` predecessor versions that still
 * carry the stale `hidden-mechanics-history` string forever (their bytes are
 * published-immutable; the fix ships as the v1.0.2 successor instead), are
 * recorded in KNOWN_UNRESOLVED below as documented debt rather than silently
 * ignored. Anything not on that list must resolve.
 */
const KNOWN_UNRESOLVED = new Set([
  'content-packs/free-starters/thumbnail/centered-hero-headline/content/thumbnail-recipe.json::com.storystudio.formula.motivation',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon/content/thumbnail-recipe.json::com.storystudio.formula.fungi',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon/content/thumbnail-recipe.json::com.storystudio.formula.insects',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon/content/thumbnail-recipe.json::com.storystudio.formula.plants',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon-v1.0.1/content/thumbnail-recipe.json::com.storystudio.formula.fungi',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon-v1.0.1/content/thumbnail-recipe.json::com.storystudio.formula.insects',
  'content-packs/free-starters/thumbnail/curiosity-question-cartoon-v1.0.1/content/thumbnail-recipe.json::com.storystudio.formula.plants',
  'content-packs/free-starters/topic/economics-businesses/content/topic-pack.json::com.storystudio.formula.listicle-explainer',
  'content-packs/free-starters/topic/economics-businesses/content/topic-pack.json::com.storystudio.formula.pov-hustle',
  'content-packs/free-starters/topic/economics-businesses-v1.0.1/content/topic-pack.json::com.storystudio.formula.listicle-explainer',
  'content-packs/free-starters/topic/economics-businesses-v1.0.1/content/topic-pack.json::com.storystudio.formula.pov-hustle',
  'content-packs/free-starters/topic/historical-wars-treaties-world-order/content/topic-pack.json::com.storystudio.formula.hidden-mechanics-history',
  'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1/content/topic-pack.json::com.storystudio.formula.hidden-mechanics-history',
  'content-packs/free-starters/topic/natural-world-animals/content/topic-pack.json::com.storystudio.formula.listicle-explainer',
  'content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json::com.storystudio.formula.listicle-explainer',
])

async function collectJsonFiles(dirUrl, out) {
  let entries
  try {
    entries = await readdir(dirUrl, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      await collectJsonFiles(new URL(`${entry.name}/`, dirUrl), out)
    } else if (entry.name.endsWith('.json')) {
      out.push(new URL(entry.name, dirUrl))
    }
  }
}

test('every compatible_formula_ids reference resolves to a Series Formula pack, or is documented debt', async () => {
  const files = []
  await collectJsonFiles(CONTENT_PACKS_DIR, files)
  assert.ok(files.length > 50, 'expected to discover the content-packs source tree')

  const knownFormulaIds = new Set()
  const declarations = []

  for (const fileUrl of files) {
    const relativePath = fileUrl.pathname.slice(ROOT.pathname.length)
    if (relativePath.startsWith(EXCLUDED_DIR)) continue
    let doc
    try {
      doc = JSON.parse(await readFile(fileUrl, 'utf8'))
    } catch {
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    if (doc.kind === 'series-formula' && typeof doc.id === 'string') {
      knownFormulaIds.add(doc.id)
    }
    if (Array.isArray(doc.compatible_formula_ids)) {
      for (const id of doc.compatible_formula_ids) {
        declarations.push({ relativePath, id })
      }
    }
  }

  assert.ok(knownFormulaIds.size > 5, 'expected to discover multiple Series Formula pack ids')
  assert.ok(declarations.length > 20, 'expected to discover multiple compatible_formula_ids declarations')

  const unresolved = declarations.filter(({ id }) => !knownFormulaIds.has(id))
  const unresolvedKeys = unresolved.map(({ relativePath, id }) => `${relativePath}::${id}`)

  const undocumented = unresolvedKeys.filter((key) => !KNOWN_UNRESOLVED.has(key))
  assert.deepEqual(undocumented, [],
    'compatible_formula_ids must resolve to an existing Series Formula pack id, or be added to KNOWN_UNRESOLVED as documented debt')

  // Keep the ledger honest: an entry that now resolves (formula published) or
  // no longer exists (pack edited/removed) must be deleted from the list, not
  // left to rot as a false debt record.
  const unresolvedKeySet = new Set(unresolvedKeys)
  const stale = [...KNOWN_UNRESOLVED].filter((key) => !unresolvedKeySet.has(key))
  assert.deepEqual(stale, [], 'KNOWN_UNRESOLVED has a stale entry that no longer reflects the source tree — remove it')

  // The fix this guard ships with: the current/latest historical-wars-treaties-world-order
  // source (v1.0.2) must not carry the retired hidden-mechanics-history reference.
  const currentDeclaration = declarations.find(({ relativePath }) =>
    relativePath === 'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.2/content/topic-pack.json')
  assert.ok(currentDeclaration, 'expected the v1.0.2 successor to declare compatible_formula_ids')
  const v102Ids = declarations
    .filter(({ relativePath }) => relativePath === 'content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.2/content/topic-pack.json')
    .map(({ id }) => id)
  assert.deepEqual(v102Ids, ['com.storystudio.formula.history-explained'])
})

test('the History Explained 1.0.2 free successor alone adds reciprocal Ancient Civilizations compatibility', async () => {
  const sources = await Promise.all([
    'content-packs/free-starters/formula/history-explained/content/series-formula.json',
    'content-packs/free-starters/formula/history-explained-v1.0.1/content/series-formula.json',
    'content-packs/free-starters/formula/history-explained-v1.0.2/content/series-formula.json',
  ].map(async relativePath => ({ relativePath, document: JSON.parse(await readFile(new URL(`../../../${relativePath}`, import.meta.url), 'utf8')) })))
  const topicId = 'com.storystudio.topic.economics-ancient-civilizations'
  assert.equal(sources[0].document.compatible_topic_pack_ids.includes(topicId), false)
  assert.equal(sources[1].document.compatible_topic_pack_ids.includes(topicId), false)
  assert.equal(sources[2].document.compatible_topic_pack_ids.includes(topicId), true)
  const manifest = JSON.parse(await readFile(new URL('../../../content-packs/free-starters/formula/history-explained-v1.0.2/pack.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.dependencies, [], 'the standalone free successor declares no external dependency')
})
