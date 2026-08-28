import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { reserveAuthoringBatch, transitionAuthoringRecord, validateAuthoringRegistry } from '../authoring-registry.mjs'
import { mintSandboxAtRevision, repairAuthoringBatch } from '../remint-registry.mjs'

/**
 * The re-mint helper, exercised against a registry that has moved past the
 * event being repaired — which is the only situation that needs it.
 *
 * The revisions here are the real ones from the incident this was built for:
 * the batch sits at 92, its transitions at 93-94, and further events land on
 * top so the repair target is genuinely historical rather than at head.
 */

const SOURCE_ROOT = 'content-packs/fixture/style'
const packId = slug => `com.storystudio.pack.style.${slug}`
const itemId = slug => `com.storystudio.style.${slug}`

const reservationRecord = slug => ({
  pack_id: packId(slug),
  item_id: itemId(slug),
  version: '1.0.0',
  publisher_id: 'com.storystudio',
  min_app_version: '{{MIN_APP_VERSION}}',
  min_app_version_status: 'release-bound',
  kind: 'visual-style',
  source_path: `${SOURCE_ROOT}/${slug}`,
  status: 'reserved',
  dependencies: [],
  stocking_proposal: {
    family: { id: `com.storystudio.family.style.${slug}`, status: 'proposed' },
    sku: { id: `com.storystudio.sku.style.${slug}`, status: 'proposed' },
  },
})

async function writeSource(repo, slug) {
  const directory = join(repo, SOURCE_ROOT, slug)
  await mkdir(join(directory, 'content'), { recursive: true })
  await writeFile(join(directory, 'pack.json'), `${JSON.stringify({
    pack_format: 1,
    pack_id: packId(slug),
    publisher_id: 'com.storystudio',
    key_id: '{{KEY_ID}}',
    version: '1.0.0',
    min_app_version: '{{MIN_APP_VERSION}}',
    lifecycle: 'active',
    entitlement: { sku: `com.storystudio.sku.style.${slug}`, family: `com.storystudio.family.style.${slug}` },
  }, null, 2)}\n`)
  await writeFile(join(directory, 'content/visual-style.json'), `${JSON.stringify({
    kind: 'visual-style',
    schema_version: 1,
    id: itemId(slug),
    name: slug,
    description: 'fixture',
    category: 'Digital',
    tags: ['fixture'],
    style_bible: 'fixture',
    negative_prompt: 'fixture',
    preview_assets: [],
    compatible_formula_ids: [],
  }, null, 2)}\n`)
}

/**
 * A registry whose batch at revision 92 holds two packs, both advanced to
 * `authored` at 93 and 94, with a further reservation at 95 on top of them.
 */
async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'remint-fixture-'))
  const { registryPath } = await mintSandboxAtRevision(91, { directory: repo })

  const request = {
    expected_revision: 91,
    coordinator: { task: 'fixture-lineage', branch: 'fixture-lineage' },
    proposal_ref: 'docs/fixture.md',
    records: [reservationRecord('marked-pack'), reservationRecord('clean-pack')],
  }
  const reserved = await reserveAuthoringBatch({ registryPath, repositoryRoot: repo, request })

  // Sources appear between reservation and authoring, exactly as real history runs.
  for (const slug of ['marked-pack', 'clean-pack']) await writeSource(repo, slug)
  for (const slug of ['marked-pack', 'clean-pack']) {
    await transitionAuthoringRecord({
      registryPath,
      repositoryRoot: repo,
      request: {
        expected_revision: slug === 'marked-pack' ? 92 : 93,
        coordinator: { task: 'fixture-lineage', branch: 'fixture-lineage' },
        receipt_ref: reserved.receipt_ref,
        pack_id: packId(slug),
        version: '1.0.0',
        changes: { status: 'authored' },
      },
    })
  }
  // A later event, so revision 92 is genuinely behind head.
  await reserveAuthoringBatch({
    registryPath,
    repositoryRoot: repo,
    request: {
      expected_revision: 94,
      coordinator: { task: 'later-work', branch: 'later-work' },
      proposal_ref: 'docs/later.md',
      records: [reservationRecord('later-pack')],
    },
  })

  return { repo, registryPath, receipt: reserved.receipt_ref }
}

/** Rename the pack on disk, the way the operator would before repairing. */
async function renameSource(repo, from, to) {
  await cp(join(repo, SOURCE_ROOT, from), join(repo, SOURCE_ROOT, to), { recursive: true })
  await rm(join(repo, SOURCE_ROOT, from), { recursive: true, force: true })
  await writeSource(repo, to)
}

const overridesFor = to => ({
  [packId('marked-pack')]: {
    pack_id: packId(to),
    item_id: itemId(to),
    source_path: `${SOURCE_ROOT}/${to}`,
    stocking_proposal: {
      family: { id: `com.storystudio.family.style.${to}` },
      sku: { id: `com.storystudio.sku.style.${to}` },
    },
  },
})

test('a historical batch is re-minted in place and the whole chain still resolves', async () => {
  const { repo, registryPath, receipt } = await fixture()
  const before = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(before.revision, 95, 'the repair target must sit behind head')

  await renameSource(repo, 'marked-pack', 'renamed-pack')
  const result = await repairAuthoringBatch({
    registryPath, repositoryRoot: repo, batchRevision: 92, overrides: overridesFor('renamed-pack'),
  })

  assert.equal(result.written, true)
  assert.equal(result.head, 95, 'a repair must not advance the head')
  assert.notEqual(result.receipt.new, result.receipt.old, 'the receipt must be re-minted, not reused')
  assert.equal(result.transitions.length, 2)
  for (const transition of result.transitions) {
    assert.notEqual(transition.new, transition.old, `transition ${transition.revision} must be re-minted`)
  }

  // The registry validates against its own rules, end to end.
  const validated = await validateAuthoringRegistry({ registryPath, repositoryRoot: repo })
  assert.equal(validated.revision, 95)

  const after = JSON.parse(await readFile(registryPath, 'utf8'))
  const revisions = [...after.batches, ...after.transitions].map(event => event.revision).sort((a, b) => a - b)
  assert.deepEqual(revisions, Array.from({ length: 94 }, (_, index) => index + 2), 'revisions must stay contiguous')

  // No stale reference survives anywhere in the document.
  assert.equal(JSON.stringify(after).includes(receipt), false, 'the superseded receipt must be gone')
  for (const transition of result.transitions) {
    assert.equal(JSON.stringify(after).includes(transition.old), false, `stale transition_ref ${transition.old} survived`)
  }

  // The renamed pack carries its new identity; its batch-mate keeps its own.
  const bound = after.records.filter(record => record.receipt_ref === result.receipt.new)
  assert.equal(bound.length, 2)
  const renamed = bound.find(record => record.pack_id === packId('renamed-pack'))
  assert.ok(renamed, 'the renamed identity must be present')
  assert.equal(renamed.item_id, itemId('renamed-pack'))
  assert.equal(renamed.source_path, `${SOURCE_ROOT}/renamed-pack`)
  assert.equal(renamed.stocking_proposal.family.id, 'com.storystudio.family.style.renamed-pack')
  assert.equal(renamed.stocking_proposal.sku.id, 'com.storystudio.sku.style.renamed-pack')
  assert.equal(renamed.status, 'authored', 'lifecycle reached by the replayed transitions must survive')

  const mate = bound.find(record => record.pack_id === packId('clean-pack'))
  assert.equal(mate.item_id, itemId('clean-pack'), 'a batch-mate keeps its identity')
  assert.equal(mate.status, 'authored')

  // Events outside the repaired batch are untouched, byte for byte.
  const untouched = document => JSON.stringify([
    document.batches.filter(batch => batch.revision !== 92),
    document.transitions.filter(transition => transition.revision > 94),
    document.records.filter(record => record.receipt_ref !== receipt && record.receipt_ref !== result.receipt.new),
  ])
  assert.equal(untouched(after), untouched(before), 'the repair must not disturb anything it was not asked to')

  await rm(repo, { recursive: true, force: true })
})

test('a repair that would not validate writes nothing at all', async () => {
  const { repo, registryPath } = await fixture()
  const before = await readFile(registryPath, 'utf8')

  // The identifiers move but the source tree does NOT, so the finished document
  // would name an authored source that does not exist. A partial write here is
  // the corruption mode this tool exists to prevent.
  await assert.rejects(
    () => repairAuthoringBatch({
      registryPath, repositoryRoot: repo, batchRevision: 92, overrides: overridesFor('never-created'),
    }),
    /does not exist|not registered/,
  )
  assert.equal(await readFile(registryPath, 'utf8'), before, 'a failed repair must leave the registry byte-identical')

  await rm(repo, { recursive: true, force: true })
})

test('a dry run reports the re-minted values without touching the registry', async () => {
  const { repo, registryPath, receipt } = await fixture()
  const before = await readFile(registryPath, 'utf8')

  await renameSource(repo, 'marked-pack', 'renamed-pack')
  const result = await repairAuthoringBatch({
    registryPath, repositoryRoot: repo, batchRevision: 92, overrides: overridesFor('renamed-pack'), dryRun: true,
  })

  assert.equal(result.written, false)
  assert.notEqual(result.receipt.new, receipt, 'a dry run still reports the value it would have written')
  assert.equal(await readFile(registryPath, 'utf8'), before, 'a dry run must not write')

  await rm(repo, { recursive: true, force: true })
})

test('the tool refuses inputs it cannot honour instead of guessing', async () => {
  const { repo, registryPath } = await fixture()

  await assert.rejects(() => repairAuthoringBatch({
    registryPath, repositoryRoot: repo, batchRevision: 93, overrides: overridesFor('renamed-pack'),
  }), /no batch at revision 93/, 'a revision that holds a transition is not a batch')

  await assert.rejects(() => repairAuthoringBatch({
    registryPath, repositoryRoot: repo, batchRevision: 92, overrides: { 'com.storystudio.pack.style.absent': {} },
  }), /absent from revision 92/, 'an override must name a record the batch actually holds')

  await assert.rejects(() => repairAuthoringBatch({
    registryPath, repositoryRoot: repo, batchRevision: 92, overrides: {},
  }), /non-empty overrides/, 'an empty repair is a mistake, not a no-op')

  await rm(repo, { recursive: true, force: true })
})
