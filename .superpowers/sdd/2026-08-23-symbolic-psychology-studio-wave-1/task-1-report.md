# Task 1 report — Symbolic Psychology Studio Wave 1

## Result

Created the two required RED contract suites without changing registry state, authoring sources, previews, candidates, or external handoff artifacts:

- `electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
- `scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`

The suites are intentionally partitioned by capability:

- `source evidence:` verifies the existing Editorial provenance hashes and current Impasto image/compatibility evidence.
- `Oil source:` requires the future Store source to preserve the shared built-in strings verbatim, carry the approved SHA-256 WebP, and exclude runtime-identifying/commercial/routing data.
- `Gothic evidence:` requires no Gothic source directory and a five-item blocked evidence disclosure in the new provenance ledger.
- `promotion receipts:` is the Task 2-focused gate. It proves each later-authored Editorial/Impasto record comes from its original reservation receipt and must have transitioned to `authored`.
- `kit closure:` requires the source-free coordinator and exact ordered six-node closure.
- `candidate summaries:` requires the future external `evidence-ledger.json` to use the minimal Story-owned v1 summary object for Recipe, Pastel, Oil, and Kit candidates.

Task 2 can run only its gate with:

```bash
node --test --test-name-pattern='promotion receipts' scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
```

## RED evidence

Executed:

```bash
npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
npm run content-pack:registry -- validate
node --check scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
git diff --check
```

Observed results:

- Source suite: 2 pass (current Editorial/Impasto evidence), 2 expected RED failures: absent Oil Store source and absent Symbolic Psychology provenance ledger/Gothic block.
- Registry/candidate suite: 3 expected RED failures: the three receipt-bound records remain `reserved`, the bundle-only Kit root is absent, and the external `evidence-ledger.json` is absent.
- Registry validation passed at revision 10 with 72 records.
- JavaScript syntax and whitespace checks passed.

## Self-review

- All exact receipt, SHA-256, source-root, identity, and closure constants come from the approved Wave 1 plan/brief.
- The receipt test checks the original reservation request as well as current transition state; it does not permit a replacement receipt or derived identity.
- The coordinator test preserves order and checks that manifest dependencies and bundle components agree exactly.
- `component_summary` remains candidate-ledger metadata only; no assertion asks for it in strict source manifests/documents.
- No registry mutation, reservation, lifecycle transition, authoring source, generated asset, image request, archive, or external handoff was performed.

## Fix Round 1

Bound every Editorial SHA-256 to the ledger line that names its exact asset, rather than accepting independent hash presence anywhere in the ledger. Added the approved Impasto preview SHA-256 `27050a92b2b71afd9a238ccd8ac9e72497ba2dda576bd4ad05fd01e465178e07`, with both asset-byte and provenance-line assertions.

Executed:

```bash
npx tsx --test electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
node --check scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
node --test --test-name-pattern='promotion receipts' scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs
npm run content-pack:registry -- validate
git diff --check
```

Observed output:

- Source suite: Editorial and Impasto evidence subtests pass; Oil and Gothic remain intentionally RED because their Wave 1 source/ledger artifacts are absent.
- Promotion-only gate remains intentionally RED: the Recipe record is still `reserved`, expected `authored`.
- Registry validation passed: `authoring registry revision 10: 72 records`.
- JavaScript syntax and whitespace checks passed.
