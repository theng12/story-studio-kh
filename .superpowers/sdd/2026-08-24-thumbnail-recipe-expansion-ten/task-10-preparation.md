# Task 10 preparation — independent reviews and serialized lifecycle transitions

## Scope and current baseline

This is a preparation record only. It does not qualify a recipe, create a review verdict,
write a lifecycle request/result, mutate the registry, transition a record, update a test,
commit, build, stage, hand off, stock, publish, deploy, tag, or push.

Observed at preparation time:

- branch: `codex/content-expansion-portfolio`
- source commit: `6c7f6d19f038bbd8fd06f68e88f68f40eef3fb05`
- registry: revision `23`, `92` records, valid
- registry lock: absent
- reservation revision: `23`
- common receipt: `authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378`
- reservation coordinator: task `thumbnail-recipe-expansion-ten`, branch
  `codex/content-expansion-portfolio`
- all ten receipt records are currently `reserved`, with `dependencies: []` and both
  stocking proposals still `proposed`
- all ten source roots exist in the commit above; the aggregate source report records
  12/12 passing and registry validation at revision 23

Task 10 changes only the Story authoring status from `reserved` to `authored`. It must not
advance a family or SKU proposal, and it grants no Store, GenStudio, stocking, pricing,
activation, publication, Kit-reachability, or customer-entitlement authority.

## Fixed proposal order and exact identities

This is the only transition proposal order. A blocked recipe is skipped without consuming a
revision; the next clean recipe uses the then-current revision.

| Order | Slug | Pack ID | Version | Source path |
| ---: | --- | --- | --- | --- |
| 1 | `before-after-proof-panel` | `com.storystudio.pack.thumbnail.before-after-proof-panel` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel` |
| 2 | `two-option-criteria-split` | `com.storystudio.pack.thumbnail.two-option-criteria-split` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/two-option-criteria-split` |
| 3 | `reaction-evidence-inset` | `com.storystudio.pack.thumbnail.reaction-evidence-inset` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/reaction-evidence-inset` |
| 4 | `cutaway-exploded-object` | `com.storystudio.pack.thumbnail.cutaway-exploded-object` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/cutaway-exploded-object` |
| 5 | `hero-payoff-companion` | `com.storystudio.pack.thumbnail.hero-payoff-companion` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hero-payoff-companion` |
| 6 | `iconic-result-closeup` | `com.storystudio.pack.thumbnail.iconic-result-closeup` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/iconic-result-closeup` |
| 7 | `scale-journey` | `com.storystudio.pack.thumbnail.scale-journey` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/scale-journey` |
| 8 | `numbered-lineup` | `com.storystudio.pack.thumbnail.numbered-lineup` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/numbered-lineup` |
| 9 | `macro-mystery-detail` | `com.storystudio.pack.thumbnail.macro-mystery-detail` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/macro-mystery-detail` |
| 10 | `hands-on-pov-moment` | `com.storystudio.pack.thumbnail.hands-on-pov-moment` | `1.0.0` | `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hands-on-pov-moment` |

## Review artifact names and required content

Create exactly these two files per slug under
`.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reviews/`:

- `<slug>.spec.md`
- `<slug>.quality.md`

The filename rule implements the plan's requirement that the exact slug prefix both
`spec.md` and `quality.md`. Reviewers must be independent of the source author. A missing,
non-applicable-without-reason, or inconclusive applicable check blocks that recipe. Findings
use exactly `Critical`, `Important`, or `Minor`; any open `Critical` or `Important` finding
makes the verdict `BLOCKED`. `PASS` means every applicable item below has concrete evidence
and there is no open Critical/Important finding.

### `<slug>.spec.md`

Required sections and evidence:

1. **Review identity** — exact slug, reviewer/task identity, source commit, UTC review time,
   and a statement that the reviewer did not author the source.
2. **Inputs** — design, Task 10 plan, registry, exact expected-identity file, `pack.json`,
   `content/thumbnail-recipe.json`, three preview paths, immutable prompt-batch rows,
   `PREVIEW-PROVENANCE.md`, returned-evidence ledger, and aggregate source-test evidence.
3. **Receipt identity** — exact reservation revision 23, common receipt, pack/item/version,
   publisher, release-bound minimum, kind, source path, empty dependencies, family/SKU IDs,
   and a successful `verify-receipt` result against the slug's original reserved identity.
4. **Schema/source contract** — strict manifest/document validity, exact one content document,
   exactly three receipt-bound preview paths, `title_mode: "ai"`, supported active Formula IDs
   only, and active Visual Style authority for rendering medium/palette/texture/lighting.
5. **Composition invariant** — quote the recipe's exact positive invariant from design section
   4/5 and show how `composition`, `prompt_template`, and exclusions preserve it.
6. **Collision boundary** — check every named `Must remain distinct from` entry for that slug,
   plus the other nine recipes; explain why this is not a restyle or duplicate.
7. **Exact preview-row contract** — a three-row table containing exact asset path, exact
   headline, exact required line count 1/2/3, and exact approved preview brief.
8. **Title and exclusions** — in-image native complete headline; no post-render overlay/title
   plate/masking/inpainting/compositing/collage/UI screenshot; recipe-specific truth, safety,
   count, anatomy, branding, and likeness exclusions.
9. **Compatibility and commerce boundary** — compatibility is declarative and limited to
   existing active Formula IDs; it is not a pack dependency; source contains no provider,
   route, price, discount, product/release, activation, purchase, grant, or Kit mutation.
10. **Findings and verdict** — table of severity/evidence/disposition, then exactly `PASS` or
    `BLOCKED` and a one-sentence reason.

### `<slug>.quality.md`

Required sections and evidence:

1. **Review identity and inspected bytes** — independent reviewer/task identity, source
   commit, UTC time, exact three WebP paths, SHA-256/bytes, and provenance-row references.
2. **Decode** — independently decode all three WebPs; each must be WebP and exactly
   `1672x941`. A file-presence check alone is insufficient.
3. **Originality/provenance** — reconcile each converted hash to its untouched selected PNG,
   prompt hash, local draft-job ID, text-only/no-reference declaration, deterministic
   conversion proof, embedded OpenAI/C2PA facts, rights basis and stated unavailable route
   fields. Provenance signals are evidence, not proof of ownership or accuracy.
4. **Per-preview visual table** — exact visible headline transcription, observed line count,
   approved subject/angle/distance/setting/palette, invariant verdict, readable-at-mobile-size
   verdict, malformed text/anatomy/numeral verdict, and safety/copy verdict.
5. **Material diversity** — demonstrate material differences across all three in subject,
   angle/distance, setting, and palette/symbol while retaining the defining invariant; reject
   palette-only or near-duplicate variants.
6. **Visual/thumbnail quality** — full-frame native render; clear focal hierarchy and title-safe
   space; no clipping, accidental title plate, pasted block, watermark, copied UI/screenshot,
   creator likeness, trademark, logo, copied trade dress, or misleading factual claim.
7. **Recipe-specific checks** — hands/anatomy for POV/host recipes; exact entry/numeral agreement
   for Numbered Lineup; honest clue for Macro; no false causality/winner/reveal/result/scale
   claims where applicable.
8. **Commercial boundary** — original/generic/unbranded customer-facing preview suitability;
   no claim of exclusivity, performance rank, A/B winner, or permission to stock/publish.
9. **Findings and verdict** — severity/evidence/disposition table followed by exactly `PASS` or
   `BLOCKED` and a one-sentence reason.

The two review files must not merely point to the earlier aggregate wave/diversity review.
Those are inputs; Task 10 requires a fresh per-recipe spec review and a fresh per-recipe
quality/visual review.

## Eligibility decision

After all twenty review files exist, build two literal ordered lists:

- `cleanSlugs`: both review files say `PASS`, all applicable checks have evidence, no open
  Critical/Important finding, source exists, exact receipt verifies, and focused tests pass.
- `blockedSlugs`: exact complement of the ten proposal slugs, with the failed/missing gate and
  review path recorded.

The two lists must be disjoint, contain unique entries, preserve proposal order, and their
union must equal the exact ten slugs. Never transition a slug merely because an aggregate
review passed. Never repair a review failure by editing the registry.

## Exact lifecycle request shape

For each clean slug only, materialize the raw CLI request at
`.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-requests/<slug>.json`
using the revision returned by the immediately preceding validation/transition:

```json
{
  "expected_revision": 23,
  "coordinator": {
    "task": "thumbnail-recipe-expansion-ten",
    "branch": "codex/content-expansion-portfolio"
  },
  "receipt_ref": "authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378",
  "pack_id": "com.storystudio.pack.thumbnail.before-after-proof-panel",
  "version": "1.0.0",
  "changes": {
    "status": "authored"
  }
}
```

Only `expected_revision` and the slug-derived `pack_id` vary. `changes` must be exactly
`{ "status": "authored" }`; do not include `stocking_proposal`.

The corresponding raw CLI stdout belongs at
`.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-results/<slug>.json`
and has exactly this accepted shape:

```json
{
  "revision": 24,
  "transition_ref": "lifecycle:<64 lowercase hex characters>"
}
```

There is no repository-defined blocked-request JSON schema. Do not create a valid-looking
transition request for a blocked recipe: it could be submitted accidentally and would also
become stale as later clean recipes advance the revision. If any recipe is blocked, its two
review files are the authoritative no-transition evidence. The plan's broad file-list wording
(`one request and one result JSON per recipe`) conflicts with its hard rule to transition only
clean recipes and with the CLI's raw request schema. The safe interpretation is: raw lifecycle
request/result pairs exist for every transitioned recipe; blocked recipes remain deliberately
absent from both lifecycle directories. If strict ten-file cardinality is later required, the
plan must first define a separate non-CLI blocked-evidence schema rather than inventing one in
execution.

## Serialized command procedure

Run from the repository root. Do not background or parallelize any registry command.

### One-time preflight

```bash
git status --short --branch
npm run content-pack:registry -- validate
test ! -e content-packs/authoring-registry.json.lock
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
```

Expected before the first transition: valid revision 23, no lock, exact receipt-bound ten-row
batch, and clean sources. Any different registry revision requires re-reading current state and
rebuilding the first request from that state; never reuse the table below blindly.

### Exact loop for each clean slug, in proposal order

1. Run `npm run content-pack:registry -- validate` and read the numeric current revision.
2. Assert no lock exists and that this slug is still reserved under the exact common receipt.
3. Run the original identity verification. The revision argument remains reservation revision
   `23`, even after the live registry advances:

```bash
npm run content-pack:registry -- verify-receipt \
  --revision 23 \
  --receipt authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378 \
  --expected-identity .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/expected-identities/<slug>.json
```

4. Write the exact raw request above with `expected_revision` equal to the just-reported current
   revision and the slug's exact pack ID. Parse it and assert exact top-level/change fields,
   coordinator, receipt, version, and one target.
5. Submit exactly once and capture stdout directly:

```bash
npm run content-pack:registry -- transition \
  --request .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-requests/<slug>.json \
  > .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/lifecycle-results/<slug>.json
```

6. Parse the result and assert `revision === expected_revision + 1` and
   `transition_ref` matches `^lifecycle:[a-f0-9]{64}$`.
7. Re-run the exact original `verify-receipt` command above.
8. Run `npm run content-pack:registry -- validate` and assert the reported revision equals the
   result revision, this exact record alone advanced to `authored`, its proposals remain
   `proposed`, and every not-yet-transitioned/blocked sibling remains `reserved`.
9. Only then prepare the next clean slug's request from the newly reported revision.

A stale revision, lock, source mismatch, receipt mismatch, unexpected record mutation, malformed
result, or validation failure is a hard stop. Do not retry with the same request, submit a batch,
renumber prior request/result evidence, or skip validation to continue.

### All-ten-clean revision chain

This table is exact only if all ten reviews pass and no unrelated registry mutation occurs.
It is a verification oracle, not authority to ignore a live revision.

| Slug | Expected revision | Returned revision | Expected transition ref |
| --- | ---: | ---: | --- |
| `before-after-proof-panel` | 23 | 24 | `lifecycle:8a21d77aa406bcc9b376ac5a93f004d99206a176c72fd5abb0f693151db8b989` |
| `two-option-criteria-split` | 24 | 25 | `lifecycle:5e31d2d624ec8b47e97c5d08398b8381132598a0cd6d57dc04843c2e69b46654` |
| `reaction-evidence-inset` | 25 | 26 | `lifecycle:5ef402c11ea171a08006d869f54b66dffda3a61c7c4b4b95f19074e89e37a72c` |
| `cutaway-exploded-object` | 26 | 27 | `lifecycle:0fca73d3d1ea33a737aaa7126a380ffd9866e21b0a8e0a58060d69d4eea7e5bb` |
| `hero-payoff-companion` | 27 | 28 | `lifecycle:afd1eb17dbb474b2580d6296d461f8e6d50b6013d39f526f2177d1ec9f98ab14` |
| `iconic-result-closeup` | 28 | 29 | `lifecycle:862760388b7341d7cc5d350aec208a016d4b0065c4239ef212cea470420a5760` |
| `scale-journey` | 29 | 30 | `lifecycle:f3f40985059c2469da4f390e672337212306c941324eac34d67ca2cd596af5d4` |
| `numbered-lineup` | 30 | 31 | `lifecycle:c8bb5f11a4df5e0d3e603416a30f26aa1c78fd0f6c707d6771a6e76a1a5f57a7` |
| `macro-mystery-detail` | 31 | 32 | `lifecycle:3c71328496b2e102e91a2b556a3e5556d2daea2d15addb40394558fa94c8eb47` |
| `hands-on-pov-moment` | 32 | 33 | `lifecycle:e3ded206b79d31f5ed862c9955e3d8df3851a482fb8a25c6a2fd89a6672b7b75` |

If any slug is blocked, later clean slugs shift left by one revision for each skipped slug, and
their transition refs necessarily differ because `expected_revision` is part of the canonical
request hash. Recompute; never copy an all-clean transition ref into a partial run.

## Durable registry-test update for partial truth

Modify only the existing ten-recipe reservation test and the authored-count assertion needed
to reflect actual clean reviews. Do not make the durable test read ignored SDD review/request
files. Materialize the exact review outcome as two literal ordered slug arrays in the test:

```js
const expectedAuthoredSlugs = [/* exact PASS/PASS slugs, proposal order */]
const expectedReservedSlugs = [/* exact complement, proposal order */]
```

The updated ten-recipe test must retain all current immutable reservation assertions:

- one exact batch at revision 23 and `expected_revision: 22`;
- exact ten original request identities, each originally `status: 'reserved'`;
- exact common receipt, proposal reference, source paths, IDs, version, publisher, kind,
  minimum-version token/status, dependencies, and proposed family/SKU identities;
- exactly ten current registry rows under that receipt and no cross-lineage collision.

Add lifecycle/partial-truth assertions matching the established Wave 2 pattern:

- the authored and reserved lists are unique, disjoint, and their union is exactly all ten;
- lifecycle transitions for the common receipt and exact coordinator have unique target pack IDs;
- each authored slug has exactly one transition; each reserved slug has zero;
- every matching transition has `revision === request.expected_revision + 1`, exact coordinator,
  exact receipt/pack/version, and `changes` exactly `{ status: 'authored' }`;
- transition revisions are strictly increasing in proposal order with no per-wave parallelism;
- each current registry row is the immutable original identity plus only the expected status;
- every current family/SKU state remains `proposed` and every dependency remains `[]`;
- `verifyAuthoringReceipt` still succeeds for every original reserved identity using revision 23;
- validated authored source paths equal exactly the PASS/PASS set;
- validated reserved source paths equal exactly the complement;
- source `pack.json` exists for every transitioned recipe (and source completeness alone does
  not make a blocked recipe authored).

Update the first global registry reconciliation test so its authored count is truthful. The
pre-wave baseline is 69, so use `69 + expectedAuthoredSlugs.length`; leaf authored count is
`52 + expectedAuthoredSlugs.length`; bundle authored count remains 17. Define the ordered outcome
constants at module scope so both tests use one durable truth and cannot drift.

This test shape proves partial truth even when all ten happen to pass: the complement is computed
and asserted exactly rather than assuming source presence equals authored status. If a recipe is
blocked, the same assertions require it to stay reserved without weakening the test.

## Final Task 10 gates and commit boundary

After the serialized loop and test update, run exactly:

```bash
npm run content-pack:registry -- validate
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git status --short
```

Before committing, inspect the diff and require changes only to:

- `content-packs/authoring-registry.json`
- `scripts/content-packs/__tests__/authoring-registry.test.mjs`

The review/request/result files are ignored SDD evidence and must exist as required for the actual
review outcome, but must not be force-added. Then:

```bash
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs
git diff --cached --check
git commit -m "chore(content-packs): qualify ten thumbnail recipes"
```

Do not start Task 11 from a failed Task 10 gate. Task 11 may consume only the exact authored,
review-clean subset; every complement row must remain blocked/reserved and receive no candidate
archive path.
