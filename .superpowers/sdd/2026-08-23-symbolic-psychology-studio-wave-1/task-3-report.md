# Task 3 report — Oil evidence and atomic Oil/Kit reservation

## Status

Completed the evidence and reservation scope only. No component source, Gothic identity, image generation, archive, external handoff, GenStudio mutation, or family/SKU confirmation was performed.

## Evidence

- Added `content-packs/symbolic-psychology-studio/PREVIEW-PROVENANCE.md`.
- The Oil entry records the owner-supplied built-in asset path, source commit `3838fbccc33d7f58485063c2819e23c80c792976`, SHA-256 `721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a`, 402056-byte size, decoded 1672×941 WebP dimensions, owner-supplied built-in rights basis, and verbatim `style_bible`/`negative_prompt` parity.
- The Gothic entry is explicitly `blocked`, creates no identity or source, and names all five absent prerequisites: original preview bytes, source/rightsholder provenance, rights/license basis, transformation record, and independent visual review.

## Atomic reservation

- Validated the registry at revision 13 with 72 records before mutation.
- Submitted exactly one two-record request at `reservation-requests/oil-and-symbolic-psychology-studio-kit.json`, with coordinator task `symbolic-psychology-studio-wave-1` and branch `codex/content-expansion-portfolio`.
- The request reserved Oil with no dependencies, then the channel-kit coordinator with the exact ordered six-node Global Constraint closure.
- Received revision `14` and receipt `authoring:0c62aa74cc54d68d7671de008b1893af243589f8c5a0ce91d4ca46c1d6c12270`.
- Derived both expected identities from the returned records, omitting only `receipt_ref`, then independently verified each with `verify-receipt` against revision 14 and that receipt before any source authoring.
- Both records remain `reserved`; family and SKU fields remain `proposed`.

## Validation

- `npx tsx --test --test-name-pattern='Gothic evidence' electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts` — passed (1/1).
- `npm run content-pack:registry -- validate` — passed at revision 14 with 74 records.
- Both receipt verification CLI calls — passed, returning the exact Oil and Kit records.
- Source-authoring guard: confirmed that Oil, Kit, and Gothic component directories do not exist.
- `git diff --check` — passed.

## Concern

`node --test scripts/content-packs/__tests__/authoring-registry.test.mjs` has one stale global-count failure: `reconciles the strict 60-pack authored registry against source manifests` expects 60 authored records but observes 63 after Task 2 promoted the three specified reserved records. The remaining 31 tests pass; this task did not alter authored source count or that suite.
