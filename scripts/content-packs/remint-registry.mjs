/**
 * Re-mint dependent authoring-registry references, by driving the registry's
 * own write functions.
 *
 * WHY THIS EXISTS. `receipt_ref` and `transition_ref` are
 * `sha256(canonical(request))` over a request that embeds `expected_revision`,
 * `pack_id`, `item_id` and `source_path`. Anything that moves one of those
 * fields invalidates every reference derived from it, and the registry then
 * refuses EVERY write, because `reserveAuthoringBatch` and
 * `transitionAuthoringRecord` both validate the current document before
 * mutating it. That has happened twice, from two unrelated causes:
 *
 *   - 2026-08-28, `d0b741f0` — two merges re-sequenced entries onto main's
 *     advance and preserved everything else byte-for-byte, which is exactly
 *     backwards for a reference derived FROM the renumbered field. Four refs
 *     went stale and two waves of content work were blocked behind them.
 *   - 2026-08-28, the Retro Paint Fantasy rename — a pre-sale pack's
 *     identifiers had to change, which re-derived revision 43's receipt, the
 *     six records bound to it, and the six transitions that embed it.
 *
 * Both repairs were hand-rolled by whoever was holding the problem, and neither
 * tool survived. An earlier brief that said "renumber, preserving everything
 * else byte-for-byte" corrupted four entries for precisely this reason. This
 * module is that tool, built once.
 *
 * THE ONE RULE. It never hashes anything. Every minted value is produced by
 * `reserveAuthoringBatch` / `transitionAuthoringRecord` in this repository's
 * own `authoring-registry.mjs`. If those functions change, this tool follows
 * for free; it cannot drift from them, because it does not know how a
 * reference is computed.
 *
 * IT WRITES ONLY A RESULT THAT VALIDATES. Every mutation happens against a
 * temporary registry file. The real file is replaced, atomically, only after
 * `validateAuthoringRegistry` accepts the finished document. A half-applied
 * replay is the corruption mode this exists to prevent, so there is no code
 * path that writes the destination mid-replay.
 *
 * ── ONE OPERATION, DELIBERATELY ───────────────────────────────────────────
 *
 * `repair` — an event that is NOT at head has to be re-minted in place, because
 * an identity field inside it changed. Appending cannot express this: the
 * registry has no retire or supersede verb, an authored record's `source_path`
 * must exist on disk, `source_path` is unique across records, and a batch's
 * bound-record count must equal its request's count. So the historical event is
 * re-minted where it sits. This one does need a sandbox — a throwaway registry
 * walked to the target revision by discarded spacer reservations — because the
 * real registry is already past that revision.
 *
 * THERE IS DELIBERATELY NO `rebase`. Rebasing a branch's own reservations onto
 * a moved head looks like the same problem and is not: the events are still at
 * head, so a driver that reads the current revision from the registry each
 * iteration and takes the receipt from the batch it just minted rebases for
 * free. That was MEASURED on 2026-08-28 against a real lineage at revisions
 * 92-93 — the whole rebase cost one integer, `expected_revision`, and its
 * thirteen transitions needed no edit at all. Tooling for it would duplicate
 * every content driver and carry a real trap besides: on a MERGED tree the
 * branch's sources are already on disk while the destination registry does not
 * yet know them, so `reconcileSources` rejects the pre-state and the replay
 * would need to grow a sandbox tree event by event. Not worth building for a
 * case that costs one integer by hand. Add it when a rebase actually fails.
 *
 * ── DESIGN NOTES FOR THE RETIRE VERB, WHICH IS NOT BUILT ──────────────────
 *
 * `repair` exists only because the registry cannot express withdrawal. If a
 * terminal status is ever added, two things must be true of it, both of which
 * were established while writing this and should not be rediscovered:
 *
 *   1. A withdrawn record must NEVER release its `item_id`, family or sku back
 *      to the ownership map in `validateLineages`. An identifier that has been
 *      issued stays burned. Releasing it reintroduces exactly the cross-pack
 *      collision those lineage rules exist to prevent, and it would let a later
 *      pack silently inherit an id a customer may already hold.
 *   2. Pre-sale withdrawal and post-sale retirement are NOT the same operation.
 *      A pre-sale withdrawal may delete the source tree, because nothing was
 *      ever sold from it. A post-sale retirement may not, ever — customers hold
 *      that pack, its archive must stay reproducible, and the runtime already
 *      models this separately as `lifecycle: "retired"` inside `pack.json`.
 *      One status cannot mean both.
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  reserveAuthoringBatch, transitionAuthoringRecord, validateAuthoringRegistry,
} from './authoring-registry.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_REGISTRY = join(root, 'content-packs/authoring-registry.json')
const MAX_SPACERS = 5_000

function fail(message) {
  throw new Error(`Registry re-mint: ${message}`)
}

const readJson = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return fail(`${label} could not be read as JSON (${path}): ${error.message}`)
  }
}

/** Copy a registry to a scratch path so no mutation ever touches the destination. */
async function scratchCopy(registryPath) {
  const directory = await mkdtemp(join(tmpdir(), 'registry-remint-'))
  const scratch = join(directory, 'authoring-registry.json')
  await copyFile(registryPath, scratch)
  return { directory, scratch }
}

/**
 * Replace `destination` with `source` only after the finished document passes
 * the registry's own validation. Nothing before this point can write it.
 */
async function commitIfValid(source, destination, repositoryRoot, { dryRun }) {
  const validated = await validateAuthoringRegistry({ registryPath: source, repositoryRoot })
  if (dryRun) return { ...validated, written: false }
  const temporary = join(dirname(destination), `.${process.pid}-${Date.now()}-remint.tmp`)
  await copyFile(source, temporary)
  try {
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { ...validated, written: true }
}

/**
 * Walk a fresh registry to `revision` using discarded spacer reservations, so a
 * historical event can be re-minted at the revision it actually occupies. The
 * spacers are thrown away with the sandbox; only the target event's minted
 * values are ever read back out.
 */
export async function mintSandboxAtRevision(revision, { directory } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1) fail('sandbox revision must be a positive integer')
  if (revision - 1 > MAX_SPACERS) fail(`sandbox revision ${revision} exceeds the ${MAX_SPACERS}-spacer limit`)
  const sandbox = directory ?? await mkdtemp(join(tmpdir(), 'registry-remint-sandbox-'))
  await mkdir(join(sandbox, 'content-packs'), { recursive: true })
  const registryPath = join(sandbox, 'content-packs/authoring-registry.json')
  await writeFile(registryPath, `${JSON.stringify({ revision: 1, batches: [], transitions: [], records: [] }, null, 2)}\n`)

  for (let next = 2; next <= revision; next += 1) {
    const slug = `remint-spacer-${next}`
    await reserveAuthoringBatch({
      registryPath,
      repositoryRoot: sandbox,
      request: {
        expected_revision: next - 1,
        coordinator: { task: 'registry-remint-spacer', branch: 'registry-remint-spacer' },
        proposal_ref: 'registry-remint-spacer',
        records: [{
          pack_id: `com.storystudio.pack.style.${slug}`,
          item_id: `com.storystudio.style.${slug}`,
          version: '1.0.0',
          publisher_id: 'com.storystudio',
          min_app_version: '{{MIN_APP_VERSION}}',
          min_app_version_status: 'release-bound',
          kind: 'visual-style',
          // Never materialised: a reserved record may name a source that does
          // not exist, which is what keeps the spacers free.
          source_path: `content-packs/remint-spacer/style/${slug}`,
          status: 'reserved',
          dependencies: [],
          stocking_proposal: {
            family: { id: `com.storystudio.family.style.${slug}`, status: 'proposed' },
            sku: { id: `com.storystudio.sku.style.${slug}`, status: 'proposed' },
          },
        }],
      },
    })
  }
  return { sandbox, registryPath }
}

/**
 * Re-mint one historical batch, and the transitions bound to it, after an
 * identity field inside it changed.
 *
 * `overrides` is keyed by the record's CURRENT `pack_id`; each value carries
 * only the fields that change. Nothing else about the request may move — the
 * point is to re-derive references, not to rewrite history's content.
 */
export async function repairAuthoringBatch({
  registryPath = DEFAULT_REGISTRY, repositoryRoot = root, batchRevision, overrides, dryRun = false,
} = {}) {
  if (!Number.isSafeInteger(batchRevision) || batchRevision < 2) fail('repair requires the batch revision to re-mint')
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || !Object.keys(overrides).length) {
    fail('repair requires a non-empty overrides object keyed by current pack_id')
  }

  const current = await readJson(registryPath, 'registry')
  const batch = current.batches.find((candidate) => candidate.revision === batchRevision)
  if (!batch) fail(`no batch at revision ${batchRevision}`)

  const unknown = Object.keys(overrides).filter(
    (packId) => !batch.request.records.some((record) => record.pack_id === packId))
  if (unknown.length) fail(`overrides name pack_id(s) absent from revision ${batchRevision}: ${unknown.join(', ')}`)

  const bound = current.transitions
    .filter((transition) => transition.request.receipt_ref === batch.receipt_ref)
    .sort((left, right) => left.revision - right.revision)
  const strayed = bound.filter((transition) => transition.revision <= batchRevision)
  if (strayed.length) fail(`transitions at ${strayed.map((t) => t.revision).join(', ')} precede the batch they target`)

  const corrected = {
    ...batch.request,
    records: batch.request.records.map((record) => {
      const override = overrides[record.pack_id]
      if (!override) return record
      // A shallow merge would drop the untouched half of stocking_proposal.
      return {
        ...record,
        ...override,
        stocking_proposal: {
          family: { ...record.stocking_proposal.family, ...(override.stocking_proposal?.family ?? {}) },
          sku: { ...record.stocking_proposal.sku, ...(override.stocking_proposal?.sku ?? {}) },
        },
      }
    }),
  }
  const renamed = new Map(batch.request.records.map((record, index) => [record.pack_id, corrected.records[index].pack_id]))

  const { sandbox, registryPath: sandboxRegistry } = await mintSandboxAtRevision(batch.request.expected_revision)
  try {
    const reserved = await reserveAuthoringBatch({
      registryPath: sandboxRegistry, repositoryRoot: sandbox, request: corrected,
    })
    // Sources become authored between their reservation and their transitions,
    // which is the order the real history ran in.
    for (const record of corrected.records) {
      if (!await stat(join(repositoryRoot, record.source_path)).catch(() => null)) continue
      await cp(join(repositoryRoot, record.source_path), join(sandbox, record.source_path), { recursive: true })
    }
    for (const transition of bound) {
      await transitionAuthoringRecord({
        registryPath: sandboxRegistry,
        repositoryRoot: sandbox,
        request: {
          ...transition.request,
          receipt_ref: reserved.receipt_ref,
          pack_id: renamed.get(transition.request.pack_id) ?? transition.request.pack_id,
        },
      })
    }

    const replayed = await readJson(sandboxRegistry, 'sandbox registry')
    const mintedBatch = replayed.batches.find((candidate) => candidate.revision === batchRevision)
    const mintedTransitions = new Map(replayed.transitions.map((transition) => [transition.revision, transition]))
    const mintedRecords = new Map(batch.request.records.map((record, index) => {
      const minted = replayed.records.find((candidate) => candidate.receipt_ref === reserved.receipt_ref
        && candidate.pack_id === corrected.records[index].pack_id)
      return [record.pack_id, minted]
    }))
    if (!mintedBatch || [...mintedRecords.values()].some((record) => !record)) fail('the sandbox replay did not produce a complete batch')

    const next = {
      revision: current.revision,
      batches: current.batches.map((candidate) => (candidate.revision === batchRevision ? mintedBatch : candidate)),
      transitions: current.transitions.map((candidate) => mintedTransitions.get(candidate.revision) ?? candidate),
      records: current.records.map((record) => (record.receipt_ref === batch.receipt_ref
        ? mintedRecords.get(record.pack_id) ?? fail(`record ${record.pack_id} is bound to revision ${batchRevision} but was not re-minted`)
        : record)),
    }

    const { directory, scratch } = await scratchCopy(registryPath)
    try {
      await writeFile(scratch, `${JSON.stringify(next, null, 2)}\n`)
      const result = await commitIfValid(scratch, registryPath, repositoryRoot, { dryRun })
      return {
        operation: 'repair',
        batch_revision: batchRevision,
        head: result.revision,
        written: result.written,
        receipt: { old: batch.receipt_ref, new: reserved.receipt_ref },
        transitions: bound.map((transition) => ({
          revision: transition.revision,
          pack_id: renamed.get(transition.request.pack_id) ?? transition.request.pack_id,
          old: transition.transition_ref,
          new: mintedTransitions.get(transition.revision).transition_ref,
        })),
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

const flag = (argv, name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const registryPath = flag(argv, '--registry') ? resolve(flag(argv, '--registry')) : DEFAULT_REGISTRY
  const repositoryRoot = flag(argv, '--repository-root') ? resolve(flag(argv, '--repository-root')) : root
  if (argv[0] === 'rebase' && flag(argv, '--from') && flag(argv, '--base')) {
    const result = await rebaseAuthoringLineage({
      registryPath, repositoryRoot, sourceRegistryPath: resolve(flag(argv, '--from')),
      baseRevision: Number(flag(argv, '--base')), dryRun,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (argv[0] === 'repair' && flag(argv, '--batch') && flag(argv, '--overrides')) {
    const result = await repairAuthoringBatch({
      registryPath, repositoryRoot, batchRevision: Number(flag(argv, '--batch')),
      overrides: await readJson(resolve(flag(argv, '--overrides')), 'overrides file'), dryRun,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    fail('usage: remint-registry.mjs rebase --from <branch-registry> --base <revision> [--registry <path>] '
      + '[--repository-root <path>] [--dry-run]\n'
      + '   or: remint-registry.mjs repair --batch <revision> --overrides <path> [--registry <path>] '
      + '[--repository-root <path>] [--dry-run]')
  }
}
