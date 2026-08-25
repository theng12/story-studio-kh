# Task 11 preparation — deterministic candidates, staging, and receiver handoff

## Scope and current facts

This is preparation only. It does not add a durable test, modify the staging helper, build an
archive, create either external destination, stage or stock anything, mutate GenStudio, commit,
publish, deploy, tag, or push.

Observed at preparation time:

- branch: `codex/content-expansion-portfolio`
- source commit: `6c7f6d19f038bbd8fd06f68e88f68f40eef3fb05`
- common reservation receipt:
  `authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378`
- all ten source roots and all twenty independent review files exist; each review currently ends
  in `PASS`
- Task 10 has not yet completed its serialized registry transitions, so the ten current records
  remain `reserved` at registry revision 23. Task 11 must derive eligibility again after Task 10;
  it must not treat this preparation-time PASS inventory as lifecycle authority.
- delivery profile: `genstudio-store-receipt-v1`
- resolved minimum application version: `1.0.843`
- maximum archive bytes: `52_428_800`

The real destinations are fixed and currently must be absent before execution:

```text
<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/
<owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json
```

The archive filename for each delivered slug is exactly `<slug>.sspack`; no pack ID, version,
timestamp, or suffix is added.

## Important implementation-plan discrepancy

`scripts/content-packs/stage-handoff-artifacts.mjs` is hardened but is not presently reusable by
this wave. It hard-codes the five Reusable Primitives Wave 2 slugs, identities, source paths,
kinds, and receipt, and rejects any other `allowedSlugs` or entry. It also emits successful
release entries without the Story identity/dependency fields required by Task 11 and emits no
receiver `status`. Calling it unchanged for this ten-recipe wave must fail before writing.

The smallest safe resolution is to extend the existing helper rather than clone its filesystem
logic:

1. Add an internal immutable wave contract named `thumbnail-recipe-expansion-ten`, containing
   the exact ten bindings and exact receipt below. Keep the existing Wave 2 contract and existing
   default behavior intact.
2. Accept `waveId: 'thumbnail-recipe-expansion-ten'` in the helper input. Resolve bindings,
   allowed order, receipt, and output schema from the internal contract; do not accept an
   arbitrary caller-supplied bindings map or caller-supplied expected receipt.
3. Preserve every existing no-follow, physical-containment, stable-read, exclusive-create,
   cleanup/failure-inventory, copy-hash, and post-write revalidation guarantee.
4. For this contract, include the exact Story identity/dependency fields in successful
   release/receiver entries and include the receiver status defined below. Do not add those
   fields to `ledger.json`.
5. Add focused backward-compatibility coverage by running the existing
   `reusable-content-primitives-pack.test.mjs` unchanged apart from any narrowly necessary
   assertion update caused by the new optional `waveId`; its historical Wave 2 shapes and
   behavior must remain valid.

This helper change is necessary implementation, not a product/runtime/schema change. The Task 11
plan's file list says only to consume the helper, so the coordinator should record this discovered
plan correction before editing it.

## Fixed bindings and order

All rows use version `1.0.0`, publisher `com.storystudio`, kind `thumbnail-recipe`, empty
dependencies, and the common receipt above.

| Order | Slug | Pack ID | Item ID | Source path |
| ---: | --- | --- | --- | --- |
| 1 | `before-after-proof-panel` | `com.storystudio.pack.thumbnail.before-after-proof-panel` | `com.storystudio.thumbnail.before-after-proof-panel` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel` |
| 2 | `two-option-criteria-split` | `com.storystudio.pack.thumbnail.two-option-criteria-split` | `com.storystudio.thumbnail.two-option-criteria-split` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/two-option-criteria-split` |
| 3 | `reaction-evidence-inset` | `com.storystudio.pack.thumbnail.reaction-evidence-inset` | `com.storystudio.thumbnail.reaction-evidence-inset` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/reaction-evidence-inset` |
| 4 | `cutaway-exploded-object` | `com.storystudio.pack.thumbnail.cutaway-exploded-object` | `com.storystudio.thumbnail.cutaway-exploded-object` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/cutaway-exploded-object` |
| 5 | `hero-payoff-companion` | `com.storystudio.pack.thumbnail.hero-payoff-companion` | `com.storystudio.thumbnail.hero-payoff-companion` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hero-payoff-companion` |
| 6 | `iconic-result-closeup` | `com.storystudio.pack.thumbnail.iconic-result-closeup` | `com.storystudio.thumbnail.iconic-result-closeup` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/iconic-result-closeup` |
| 7 | `scale-journey` | `com.storystudio.pack.thumbnail.scale-journey` | `com.storystudio.thumbnail.scale-journey` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/scale-journey` |
| 8 | `numbered-lineup` | `com.storystudio.pack.thumbnail.numbered-lineup` | `com.storystudio.thumbnail.numbered-lineup` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/numbered-lineup` |
| 9 | `macro-mystery-detail` | `com.storystudio.pack.thumbnail.macro-mystery-detail` | `com.storystudio.thumbnail.macro-mystery-detail` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/macro-mystery-detail` |
| 10 | `hands-on-pov-moment` | `com.storystudio.pack.thumbnail.hands-on-pov-moment` | `com.storystudio.thumbnail.hands-on-pov-moment` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hands-on-pov-moment` |

## Eligibility and partition equations

After Task 10 completes, derive the three ordered sets from current durable/ignored evidence:

```js
allowedSlugs = [
  'before-after-proof-panel',
  'two-option-criteria-split',
  'reaction-evidence-inset',
  'cutaway-exploded-object',
  'hero-payoff-companion',
  'iconic-result-closeup',
  'scale-journey',
  'numbered-lineup',
  'macro-mystery-detail',
  'hands-on-pov-moment',
]

eligibleSlugs = allowedSlugs.filter(slug =>
  registryRecord(slug).status === 'authored'
  && receiptStillVerifies(slug)
  && sourceQualificationPasses(slug)
  && specReview(slug).verdict === 'PASS'
  && qualityReview(slug).verdict === 'PASS'
  && noOpenImportantOrCriticalFinding(slug)
)

blockedSlugs = allowedSlugs.filter(slug => !eligibleSlugs.includes(slug))
entries.map(entry => entry.slug) === eligibleSlugs
blockedEntries.map(entry => entry.slug) === blockedSlugs
```

Enforce these as exact unique ordered partitions before any filesystem write:

```js
new Set(allowedSlugs).size === 10
new Set(eligibleSlugs).size === eligibleSlugs.length
eligibleSlugs.every(slug => allowedSlugs.includes(slug))
new Set(entries.map(({ slug }) => slug)).size === entries.length
new Set(blockedEntries.map(({ slug }) => slug)).size === blockedEntries.length
set(entries.slugs) === set(eligibleSlugs)
set(blockedEntries.slugs) === set(allowedSlugs \\ eligibleSlugs)
set(entries.slugs) intersect set(blockedEntries.slugs) === empty
set(entries.slugs) union set(blockedEntries.slugs) === set(allowedSlugs)
```

Every blocked row is exactly `{ "slug": "<allowed slug>", "blocker": "<specific failed or
missing gate and evidence path>" }`. It has no archive path, hash, size, summary, or successful
review claim. A present source alone never makes a slug eligible. A staging error delivers none:
do not turn already-finalized intermediate paths into partial success.

## Minimal durable test structure

Create only
`scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs` for wave-specific
coverage. Reuse the established Wave 2 helpers/patterns, `buildContentPack`,
`validateContentPack`, JSZip, and the hardened staging helper.

Recommended structure:

1. **Constants and fixed matrix** — repository root, registry path, staging module, profile,
   floor, size cap, receipt, allowed order, bindings, summaries, required review names, and
   exact external path strings (strings only; tests never use the real destinations).
2. **Pure helpers** — SHA-256, recursive-key walker, forbidden-field/value walker, archive JSON
   reader, exact-set/order assertions, PASS-review parser, and `buildTwice`.
3. **`buildTwice` qualification test** — for each current `authored` plus review-clean slug,
   build two archives in one test-owned `mkdtemp`, validate both with the exact profile and
   `includeManifest: true`, and compare exact bytes and SHA. Assert:
   - byte length is positive and `<= 52_428_800`;
   - `manifest.json` plus the one declared content JSON and three declared WebPs are present;
   - every ZIP file entry has regular-file Unix permissions `0100644`; no executable bit or
     executable extension exists;
   - manifest pack/item/version/publisher/kind/floor/profile match the fixed binding;
   - `dependencies` is exactly `[]`, no `key_id`, and no `signature.ed25519`;
   - parsed archive JSON contains no recursive `component_summary`;
   - parsed JSON has no credential/secret/private-key, provider/model/route, price/credit/
     discount/commerce, product/release/account/wire field, and no URL-valued string;
   - the three WebPs are retained as declared source bytes rather than replaced.
4. **Partial-staging shape test** — use a different test-owned temp root and an explicit
   two-slug eligible subset. Set `waveId: 'thumbnail-recipe-expansion-ten'`. Require copied
   archives to be byte-identical and revalidated; verify exact ledger, release, and receiver
   schemas below, exact partial status, exact blocked complement, exact summary placement, and
   both destinations' exclusive creation.
5. **Fail-closed table test** — at minimum reject duplicate/unknown/omitted/overlapping slug
   partitions, wrong receipt/binding/profile/floor/digest/bytes, incomplete review set, wrong
   summary literal/shape, pre-existing destination, destination inside the repository,
   symlinked ancestry/source, source escaping candidate root, and an unvalidated/mislabeled
   archive. For each preflight case assert neither destination exists.
6. **Status truth test** — `ready-for-owner-stocking` iff all ten exact slugs are eligible and
   delivered after helper `phase: 'complete'`; otherwise exactly `partial-ready-blocked` with a
   non-empty exact blocked complement. No non-complete staging result can claim either delivered
   entry or ready status.

Run RED only long enough to prove the missing ten-wave helper contract, then implement the
minimum helper extension and run both the new and existing helper suites together. Do not commit
a failing test boundary.

## Exact review array for each delivered entry

Use these nine unique logical rows in this order. Each has `status: "passed"`; its `evidence`
is the exact Task 10 review path plus the relevant section/table, not a generic claim.

```json
[
  { "review": "schema", "status": "passed", "evidence": "<slug>.spec.md" },
  { "review": "originality-provenance", "status": "passed", "evidence": "<slug>.quality.md" },
  { "review": "compatibility", "status": "passed", "evidence": "<slug>.spec.md" },
  { "review": "prompt-equivalence", "status": "passed", "evidence": "<slug>.spec.md" },
  { "review": "visual", "status": "passed", "evidence": "<slug>.quality.md" },
  { "review": "thumbnail", "status": "passed", "evidence": "<slug>.quality.md" },
  { "review": "safety", "status": "passed", "evidence": "<slug>.quality.md" },
  { "review": "copy", "status": "passed", "evidence": "<slug>.quality.md" },
  { "review": "commercial-boundary", "status": "passed", "evidence": "<slug>.spec.md and <slug>.quality.md" }
]
```

In execution, replace each shorthand with the repository-relative full path
`.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/<slug>.<spec|quality>.md`
and, preferably, the exact evidence heading. The helper requires every applicable review and
must reject `pending`, `not_applicable`, duplicate, or missing rows for these Recipe entries.

## Exact staging argument contract

The real coordinator uses an ignored temporary execution script and a fresh candidate root
from `mkdtemp(join(tmpdir(), 'story-thumbnail-expansion-ten-candidates-'))`. It builds every
eligible slug twice there, retains the first only after equality/validation, and passes:

```js
await stageHandoffArtifacts({
  waveId: 'thumbnail-recipe-expansion-ten',
  repositoryRoot: '<owner-home>/Developer/story-studio-kh/.worktrees/content-expansion-portfolio',
  candidateRoot,
  artifactRoot: '<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24',
  receiverHandoffPath: '<owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json',
  allowedSlugs,
  eligibleSlugs,
  entries,
  blockedEntries,
})
```

The real invocation supplies no `afterPhase` hook. Every `entries[]` row is exactly:

```json
{
  "slug": "before-after-proof-panel",
  "pack_id": "com.storystudio.pack.thumbnail.before-after-proof-panel",
  "item_id": "com.storystudio.thumbnail.before-after-proof-panel",
  "version": "1.0.0",
  "publisher_id": "com.storystudio",
  "kind": "thumbnail-recipe",
  "source_path": "content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel",
  "dependencies": [],
  "candidate_path": "<absolute path under the fresh candidateRoot>/before-after-proof-panel.sspack",
  "bytes": 1,
  "sha256": "<64 lowercase hex measured from the candidate>",
  "delivery_profile": "genstudio-store-receipt-v1",
  "min_app_version": "1.0.843",
  "receipt_ref": "authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378",
  "reviews": ["<the nine exact passed review objects above>"],
  "component_summary": "<the exact object for this slug below>"
}
```

`bytes`, `sha256`, and the two array/object placeholders above are illustrative types only; the
real row must contain measured values and materialized arrays/objects. Do not copy the literal
`1` or angle-bracket placeholders.

## Exact output schemas

### `ledger.json`

Top-level keys are exactly `schema_version`, `entries`. Each delivered ledger entry has exactly
the eight existing hardened-helper facts; it deliberately omits Story identity and summary:

```json
{
  "schema_version": 1,
  "entries": [
    {
      "absolute_path": "<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/before-after-proof-panel.sspack",
      "bytes": 1,
      "delivery_profile": "genstudio-store-receipt-v1",
      "min_app_version": "1.0.843",
      "receipt_ref": "authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378",
      "reviews": ["<nine exact passed review objects>"],
      "sha256": "<64 lowercase hex>",
      "slug": "before-after-proof-panel"
    }
  ]
}
```

### `release-handoff.json`

Top-level keys are exactly `schema_version`, `entries`, matching the existing hardened-helper
contract. A delivered entry has
exactly these fields; `component_summary` occurs here and in the matching receiver successful
entry only:

```json
{
  "schema_version": 1,
  "entries": [
    {
      "slug": "before-after-proof-panel",
      "pack_id": "com.storystudio.pack.thumbnail.before-after-proof-panel",
      "item_id": "com.storystudio.thumbnail.before-after-proof-panel",
      "version": "1.0.0",
      "publisher_id": "com.storystudio",
      "kind": "thumbnail-recipe",
      "source_path": "content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel",
      "dependencies": [],
      "absolute_path": "<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/before-after-proof-panel.sspack",
      "bytes": 1,
      "delivery_profile": "genstudio-store-receipt-v1",
      "min_app_version": "1.0.843",
      "receipt_ref": "authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378",
      "reviews": ["<nine exact passed review objects>"],
      "sha256": "<64 lowercase hex>",
      "component_summary": "<exact object below>"
    }
  ]
}
```

### External receiver handoff

Top-level keys are exactly those below. `successful_entries` is byte-for-JSON-value equal to
`release-handoff.json.entries`; `blocked_entries` equals its exact complement. The status equation
is enforced, not selected by the caller.

```json
{
  "schema_version": 1,
  "status": "ready-for-owner-stocking",
  "artifact_root": "<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24",
  "ledger_path": "<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24/ledger.json",
  "successful_entries": ["<exact release-handoff delivered entries>"],
  "blocked_entries": [],
  "explicitly_not_done": [
    "upload",
    "product-or-release-draft-creation",
    "price-or-discount-decision",
    "purchase",
    "grant",
    "publication",
    "production-signing",
    "deploy",
    "push"
  ]
}
```

Exact status equation:

```js
status = phase === 'complete'
  && successfulEntries.length === 10
  && blockedEntries.length === 0
  && successfulEntries.map(({ slug }) => slug) deepEquals allowedSlugs
    ? 'ready-for-owner-stocking'
    : 'partial-ready-blocked'
```

The helper is not called when `eligibleSlugs` is empty; in that case both destinations remain
absent and the coordinator records a blocked execution result only in ignored SDD evidence. A
caught helper failure also creates no receiver handoff. Therefore a persisted receiver always
represents a complete staging transaction, though it may truthfully represent a partial eligible
set.

## Exact component summaries

Every object has keys exactly `schema_version`, `kind`, `summary`, `slots`; no identity,
version, digest, dependency, closure, price, or Store state appears in it.

| Slug | Exact `component_summary` |
| --- | --- |
| `before-after-proof-panel` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"Matched before-and-after states show one subject changing across a truthful temporal seam.","slots":{"thumbnail-recipe":1}}` |
| `two-option-criteria-split` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.","slots":{"thumbnail-recipe":1}}` |
| `reaction-evidence-inset` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"A reaction subject directs attention to one original in-scene evidence detail.","slots":{"thumbnail-recipe":1}}` |
| `cutaway-exploded-object` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"One object opens into an ordered, readable view of its meaningful internal layers.","slots":{"thumbnail-recipe":1}}` |
| `hero-payoff-companion` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"A generic hero visibly interacts with a separate, tangible result object.","slots":{"thumbnail-recipe":1}}` |
| `iconic-result-closeup` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"One truthful finished outcome dominates the frame at a detail-revealing angle.","slots":{"thumbnail-recipe":1}}` |
| `scale-journey` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"Three related forms progress through continuous depth to communicate scale or magnitude.","slots":{"thumbnail-recipe":1}}` |
| `numbered-lineup` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"Three to five equal-status entries form a precise lineup with matching native numerals.","slots":{"thumbnail-recipe":1}}` |
| `macro-mystery-detail` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"An extreme close detail creates bounded curiosity while a small honest clue preserves context.","slots":{"thumbnail-recipe":1}}` |
| `hands-on-pov-moment` | `{"schema_version":1,"kind":"thumbnail-recipe","summary":"First-person or over-shoulder hands perform one clear, safe action in task context.","slots":{"thumbnail-recipe":1}}` |

## Exact execution and verification commands

Run from
`<owner-home>/Developer/story-studio-kh/.worktrees/content-expansion-portfolio`.

Preflight after Task 10:

```bash
git status --short --branch
npm run content-pack:registry -- validate
test ! -e content-packs/authoring-registry.json.lock
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
test ! -e <owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24
test ! -e <owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json
test -z "$(find content-packs/thumbnail-recipe-expansion-ten -type f -name '*.sspack' -print -quit)"
git diff --check
```

Focused TDD/helper gates:

```bash
node --test scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs
git diff --check
```

Real build/stage invocation (the ignored execution script creates/removes its own fresh candidate
root and never writes candidates into the repository):

```bash
node .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/task-11-stage.mjs
```

Post-stage audit:

```bash
node --test \
  scripts/content-packs/__tests__/authoring-registry.test.mjs \
  scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs \
  scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
npm run content-pack:registry -- validate
git diff --check
test -z "$(find content-packs/thumbnail-recipe-expansion-ten -type f -name '*.sspack' -print -quit)"
```

The execution script must then independently re-open all staged archives, hash/recount them,
call `validateContentPack` with the exact profile, parse all three JSON outputs, verify the
allowed/eligible/blocked/status equations, and run a semantic parsed-JSON recursive scan proving
`component_summary` occurs only under delivered entries in `release-handoff.json` and the external
receiver. It must not auto-delete, overwrite, rename, or reuse a pre-existing external root.

Only after those checks pass may the durable helper/test changes be committed with:

```bash
git add \
  scripts/content-packs/stage-handoff-artifacts.mjs \
  scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs
git commit -m "test(content-packs): qualify thumbnail expansion candidates"
```

If the coordinator chooses a different commit boundary because the helper-plan correction needs
its own review, it must still commit no ignored SDD evidence, candidate archive, external ledger,
release handoff, or receiver handoff. No command here grants GenStudio authority to create a
draft, upload, stock, price, activate, publish, or mutate a Channel Kit.
