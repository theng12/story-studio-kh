# Story content consolidation — 2026-09-08

Status: **Content qualification and independent reviews approved; complete application verification passed. Exact Store archives are ready for GenStudio publication. Repository integration is tracked by [PR72](https://github.com/theng12/story-studio-kh/pull/72).**

Owner request: resolve the Royal History content blocker, inspect Claude’s other handoffs, and consolidate remaining work before new channel setup. Source baseline is main `864781d9` (PR79). This content correction is independently compatible with the existing runtime; the pending app v1.4.130 is required for its separate upload/subtitle fixes, not for these packs.

## Reconciled work

| Work | Verified state | Remaining action |
|---|---|---|
| Royal History eight standalone components | Merged through PR66; thirteen previews through PR71 | Topic correction below; no new Channel Kit |
| Seven new collections / preview backfill | Source merged through PR78/PR79; 200 current catalogue identities | Do not duplicate these changes |
| Content Store request-size fix | Already on main in v1.4.129 | Done; see GENSTUDIO/STORY body-limit handoff |
| Rulers and Dynasties topic | Corrective 1.0.1 source, retaining original 1.0.0 | Validated Store archive ready; GenStudio catalogue publication remains |
| Legends Across Every Civilisation topic | Corrective 1.0.1 source, retaining original 1.0.0 | Validated Store archive ready; GenStudio catalogue publication remains |
| Provider queue position / ETA | GenStudio contract documented; Story UI work remains open | Separate Story task in [queue handoff](GENSTUDIO-PROVIDER-QUEUE-POSITION-2026-09-08.md); not a channel-setup prerequisite |

Claude’s later stocking record confirms the prior 1.0.0 releases, not publication of these new 1.0.1 corrections. No live catalogue, purchase, price, grant, entitlement, installed pack, or production project was changed here.

## Separate content candidates

Both are `topic-pack`, `content-only`, publisher `com.storystudio`, dependencies `[]`, minimum app **1.0.843** from `content-packs/release-floor.json`. Both retain schema, prompt contract and compatibility with `com.storystudio.formula.sleep-history-compilation`. Each source declares only `pack.json` and `content/topic-pack.json`; no visual assets, model routing or executable payload.

| Field | Royal History | Timeless Dreams |
|---|---|---|
| Pack/version | `com.storystudio.pack.topic.rulers-and-dynasties@1.0.1` | `com.storystudio.pack.topic.legends-across-every-civilisation@1.0.1` |
| Item | `com.storystudio.topic.rulers-and-dynasties` | `com.storystudio.topic.legends-across-every-civilisation` |
| Source | `content-packs/royal-history/topic/rulers-and-dynasties-v1.0.1` | `content-packs/timeless-dreams/topic/legends-across-every-civilisation-v1.0.1` |
| Reservation revision | 220 | 221 |
| Receipt | `authoring:20355f2535b5d11e46bc9d1838ee237d41633c366162e28278a46dec2e5d6ebe` | `authoring:8e7d1cd69b78e9d0834c64118ca5c3dd45335f2931a4c75d9b67d03ffe2cc1bd` |
| Family proposal | `com.storystudio.family.topic.rulers-and-dynasties` | `com.storystudio.family.topic.legends-across-every-civilisation` |
| SKU proposal | `com.storystudio.sku.topic.rulers-and-dynasties` | `com.storystudio.sku.topic.legends-across-every-civilisation` |
| Source/provenance | [Royal correction](../../content-packs/royal-history/TOPIC-CORRECTION-1.0.1.md) | [Legends correction](../../content-packs/timeless-dreams/TOPIC-CORRECTION-1.0.1.md) |

Family/SKU remain `proposed` in Story’s registry; no GenStudio confirmation IDs were fabricated. These are updates to existing standalone identities, not new purchases or bundled products. GenStudio’s owner must resolve the existing release/entitlement update policy and approve any production mutation.

## Evidence and qualification boundaries

- Schema/compatibility: source and archive validation, existing floor; unchanged formula compatibility and technical dependencies.
- Coverage: each retains 50 profiles × 20 assignments. The unchanged anti-padding gate measures distinct scopes, repeated affixes and subject-tag padding. It does not prove 1,000 semantically unique generated episodes or exhaustively fact-check all claims.
- Originality/editorial review: new date/place contexts tied to sources; Legends duplicate narratives replaced; precise uncertainty language retained. See per-pack provenance for reviewer corrections.
- Prompt parity: no continuity contract changed; root axes are exact first-occurrence projections of their authored tuples.
- Decoded previews: not applicable to these text-only topic successors. Existing collection previews were independently byte/dimension checked by pack tests.
- Archives: local ephemeral Ed25519 review key only; build twice and byte-compare per pack; validate each archive separately. Key and review archives are removed after qualification. Their test-key digests are evidence, not production delivery attestations.
- Production gates remaining: GenStudio catalogue release publication, receipt attestation on delivery, and owner-approved update behavior. The official keyless Store archives are qualified below. This handoff does not authorize Story to mutate GenStudio.

## Suggested Royal channel setup

Use **Sleep History Compilation** as the formula and **Rulers and Dynasties** as the topic source. Choose the Royal portrait/oil visual style, thumbnail recipe and lettering separately; **Documentary for Sleep Titles** supplies the matching metadata treatment. These are compatible choices, not forced dependencies. Existing purchases remain separate from selecting components for a project.

Do not call the new topic correction installed or live until the published version and the project’s installed catalogue confirm 1.0.1.

## Focused qualification results

- Registry validation: revision 223, 243 records, exit 0. Original 1.0.0 source files are byte-identical to main `864781d9`.
- Royal/Timeless pack tests: 16 tests, 16 pass, exit 0 (`/tmp/story-topic-pack-focused.log`). These include successor manifest/entitlement checks, exact formula compatibility, topic shape and existing preview evidence.
- Official focused anti-padding harness: 1/1 selected file completed, 2 tests, 2 pass, exit 0 (`/tmp/story-topic-corrections-focused.log`). This is not the full release gate. Royal minimum distinct scopes per profile: 19; largest repeated four-word affix: 49/1000. Legends: 20 and 49/1000 respectively. Guard thresholds were unchanged.
- Legends final independent review: approved after correcting the two semantic duplicates, Newburgh attribution, successor changelog and manifest test coverage. Royal independent review corrections are documented separately, including the final Mongol mechanism review and disputed-causation qualifications.

## Final local archive qualification

Both candidates built twice to byte-identical archives and separately validated with the local review key at floor 1.0.843 (exit 0). Private review key and archives were deleted after qualification, per the handoff contract. These hashes identify that test-key validation run, not a production-signed release.

| Candidate | Bytes | Review SHA-256 |
|---|---:|---|
| `com.storystudio.pack.topic.rulers-and-dynasties@1.0.1` | 195,568 | `82326eb4e8bb620d704fdc07059ac38e2ada603037b99791c970655bab7677ff` |
| `com.storystudio.pack.topic.legends-across-every-civilisation@1.0.1` | 162,593 | `dbf17f680547526612725c9e0b9a7d17c3e991c2f662888d54fb3bac00f348c9` |

Royal changes 117 assignment tuples across 18 profiles; Legends changes 16 across 13 profiles. Original 1.0.0 sources remain byte-identical. No generated assets or application dependencies were added.

Final Royal independent review approved: 117 changed tuples, 1,000 assignments, exact root unions, unchanged schema/formula compatibility, original 1.0.0 byte-identical. Legends independent review separately approved its 16 corrections and successor test/manifest wiring. Neither review ran competing tests.

## Queue-display follow-up evidence

Source search confirms that current `queue_position` in `services/job-queue.ts` is Story’s local pending-array position. There is no current `provider_pace`/`queue_eta_seconds` consumer in backend/frontend source. Do not reinterpret that local field as GenStudio’s provider position. The follow-up should preserve the existing local queue and carry provider job metadata separately through the normal polling/display flow. No provider dispatch/routing decision belongs in Story.

## Later Claude stocking records reconciled

While verification ran, main advanced to `d73cd7ea` through two documentation-only commits (`60a84450`, `d73cd7ea`). Their [stocking record](../catalogue/STOCKING-2026-09-08.md) supplies exact prior 1.0.0 publication evidence:

| Pack | Existing GenStudio product | Prior 1.0.0 release |
|---|---|---|
| Rulers and Dynasties | `cprod_ec25121b1a1346b186b055691ce23177` | `crel_7080084ca4fa40d3bfde35343a5fc91e` |
| Legends Across Every Civilisation | `cprod_c9233e0c05994cb3ac8908ea1b8fe2ea` | `crel_1caeae065c12412f87059cb33b398ab1` |

These are recorded prior-release IDs, not new IDs or live checks performed by GPT. The correction versions must update these existing products; do not create duplicate products or reset their existing prices, discounts, purchases or grants. The record also confirms the deployed Store delivery profile is keyless `genstudio-store-receipt-v1`; official `content-pack:ship` can prepare the two new local archives and manifest without production signing credentials or a network mutation. That artifact step is complete below from committed source.

## Complete release verification

`npm run verify` completed with exit **0**, including lint (1,813 existing warnings, zero errors), Electron/frontend type checks, all test lanes and the production build:

| Lane | Files completed | Tests | Passed | Skipped | Exit |
|---|---:|---:|---:|---:|---:|
| Backend | 436/436 | 4,950 | 4,950 | 0 | 0 |
| Frontend | 159/159 | 1,545 | 1,545 | 0 | 0 |
| Release | 4/4 | 36 | 36 | 0 | 0 |
| Content packs | 36/36 | 313 | 311 | 2 optional external-evidence checks | 0 |

Total: 6,844 tests, 6,842 passed, two skipped, zero failed. Configured production projects remained byte-identical. Log: `<owner-home>/pinokio/_handoffs/logs/story-content-consolidation-2026-09-08/story-upload130-content-final-verify.log`. The test run includes all executable/content changes; later main `60a84450`/`d73cd7ea` and final evidence additions are documentation only.

## Ready for GenStudio publication — exact local Store artifacts

Status: **ready-for-owner-stocking**. Both standalone candidates are complete and independently approved. Existing product/release IDs above refer to their prior versions. No new production release ID exists until GenStudio returns it. No new product, price, discount, purchase or grant is requested; publish the corrective versions under the existing product policy.

Official local `npm run content-pack:ship` completed with exit **0** from source commit `b9af3b16f5f9829d75989164e836970d09ceea50`. Each archive was built twice identically, passed the forbidden-mark scan, and passed `genstudio-store-receipt-v1` validation. No signing key or live Store call was used. The archive files and machine-readable `manifest.json` are retained here:

`<owner-home>/Developer/_handoffs/artifacts/topic-corrections-2026-09-08`

| File | Bytes | SHA-256 |
|---|---:|---|
| `topic-legends-across-every-civilisation-1.0.1.sspack` | 162,422 | `3899e6c525a7e5d81cd9c9103e95c1e7c957a8aa8134f0c817a0733b46cdd82a` |
| `topic-rulers-and-dynasties-1.0.1.sspack` | 195,397 | `7266f4d26d944f0a0fdbe56893a836ae1bd62093af24da4d8c218153892122f5` |

The archive byte counts and digests were re-read from disk and matched the manifest. No private key exists in this artifact directory. GenStudio’s owner can consume this directory with the established stocking tool after the source is integrated. This is a catalogue update handoff, not a claim that customer installations already use 1.0.1.
