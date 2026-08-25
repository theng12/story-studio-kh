# Task 2 report — promote the three reserved sources

Status: complete

## Scope and guardrails

- Started from registry revision 10 with 72 records; `npm run content-pack:registry -- validate` passed.
- Promoted exactly three existing records, serially, with `changes: { "status": "authored" }` only.
- Preserved each original authoring receipt, all component identity fields, version `1.0.0`, source paths, dependencies, and proposed family/SKU states.
- Used coordinator task `symbolic-psychology-studio-wave-1` on branch `codex/content-expansion-portfolio`.
- Did not reserve records, create a component source, generate/alter images, build an archive, request an external handoff, mutate GenStudio, or alter family/SKU state.

## Receipt verification

The expected identity files omit only `receipt_ref` and verified against the original persisted reservations:

| Component | Receipt revision | Receipt |
| --- | ---: | --- |
| `com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split@1.0.0` | 2 | `authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa` |
| `com.storystudio.pack.style.pastel-surreal-psychological-collage@1.0.0` | 2 | `authoring:796cd98f44cfda76d08559f0d07229aaa598d4792a79ba1e2b58f15745172aaa` |
| `com.storystudio.pack.style.impasto-psychological-animals@1.0.0` | 3 | `authoring:befab004ee2231cdbfc5f076f5b8a87d1fae03b58716cf5ab45d512fce7904b5` |

All three `verify-receipt` commands passed before mutation.

## Serial lifecycle CAS results

| Registry revision | Component | Transition receipt |
| ---: | --- | --- |
| 10 → 11 | Editorial Psychology Symbolic Split | `lifecycle:6a9674ddc1f3155d30dee19d82e9cb7d260fe9e4a248b7a781067949306924fb` |
| 11 → 12 | Pastel Surreal Psychological Collage | `lifecycle:2c583fbf8ecc29a750b3bd20c4ee6f281c1d8a1e8808a1364585b55d34aebf84` |
| 12 → 13 | Impasto Psychological Animals | `lifecycle:d42917ecb3e5ba3a8d885161328327e689e249514920594ac6aa85aafcde6516` |

The registry validated before and after every individual transition. Final state: revision 13, 72 records, all three listed components authored.

## Tests and validation

- RED observed first: `promotion receipts` failed because Editorial Psychology Symbolic Split was still `reserved`.
- GREEN: named `promotion receipts` test passed after the three promotions.
- `npx tsx --test electron/server/__tests__/editorial-psychology-components-source.test.ts` — 5 passed.
- Focused Impasto restoration source test — 1 passed.
- Focused Wave 1 Editorial/Impasto source-evidence tests — 2 passed.
- `node --test scripts/content-packs/__tests__/legacy-thumbnail-restoration-pack.test.mjs` — 24 passed.
- `npm run content-pack:registry -- validate` — passed at revision 13 with 72 records.

The full Wave 1 source and pack suites remain intentionally RED for later Oil/Kit/candidate contracts, per the recorded task-interface ruling; no later assertions were weakened or removed.

## Concerns

None.
