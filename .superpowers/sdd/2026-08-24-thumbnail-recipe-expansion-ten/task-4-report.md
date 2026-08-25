# Task 4 report — intake and qualification of built-in ChatGPT previews

## Status

PASS WITH EXPECTED RED SOURCE-MANIFEST TESTS. Accepted assets: 30. Blocked assets: 0. Eligible recipe sets: 10. Blocked recipe sets: 0. No quarantine source set was created because every current selected return passed independent qualification.

## Receipt and selection checks

- Base verified: `5ea7d740128f3e7c5e28f53f51c4c781e363f61e`.
- Immutable batch verified: SHA-256 `3c86a096c1956c627df0407167bd45b7ca768a59003029506ade5ac058357674`, exactly 30 jobs.
- Registry verified: revision 23, exactly ten reserved records, each matching the expected identity and receipt `authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378`.
- Current selection tree verified: 30 directory-matched `selected.png`/`selection.json` pairs, 30 unique selected hashes, and exact 1/2/3-line coverage per recipe.
- Prompt-hash validation verified: all 30 selection hashes recompute from their immutable prompt text; 20 records hash the raw prompt and 10 records hash the prompt with one terminating LF. The ledger records this exact per-row convention instead of normalizing or changing an existing selection hash.
- Current replacement selections verified: `9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07` and `b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8`.
- Independent review/diversity evidence verified: 30/30 eligible; no source set blocked. Ten originals were 1671×941 and converted deterministically to the required dimensions.

## Deterministic conversion

Each selected PNG was decoded with Sharp `failOn: 'error'`, rendered twice with `resize({ width: 1672, height: 941, fit: 'fill', kernel: 'lanczos3' })` then `webp({ lossless: true, effort: 6 })`, and compared byte-for-byte. All thirty pairs were byte-identical. Each chosen WebP then decoded successfully as 1672×941 WebP and exceeded 20,000 bytes. This was a full-frame format/dimension conversion only: no crop, overlay, title replacement, inpainting, region edit, compositing, or creative repair.

## Exact accepted original and converted identities

| Job | Original SHA-256 | Original bytes | Converted SHA-256 | Converted bytes |
| --- | --- | ---: | --- | ---: |
| before-after-proof-panel-01 | `28cf0c657abe429d2bb893b1276d673b6c682e9962894c5d69772f1acef31185` | 1973300 | `3d3c9ae8012bd4ead1b39263affb0812d51f2440bbe95914da05ed8cd26c97dc` | 1454390 |
| before-after-proof-panel-02 | `180c55e74dd66d76b880cd9a5b5a1f963c97060b51ed91cf0edcd0ee09efd226` | 1831804 | `8bbf609fe1f9197fb828bb4a907ff4eaf49e0ac814a9e367fa59a57b16bfa25a` | 1328912 |
| before-after-proof-panel-03 | `94e8792ebea5577505a8fcbafbdef427004d48e69891d3363eb0a207a08f8574` | 2169431 | `45200e51c5d2ae56f0ea2533c86604748238ee78317013d17acf4adeffc48710` | 1527708 |
| two-option-criteria-split-01 | `9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07` | 2408743 | `843922cfcc8af23640fb13b1377aaef4cd20f9ffd21957c638984483b7503c88` | 1673998 |
| two-option-criteria-split-02 | `a1bec8992db1196a3b5b6d583b1e1aef21c4b00803c9c52078bbc2e163e4d19a` | 2070413 | `0973d72df3972b9b83a708c2652d9e6bc82a661f045218b84b3d14e8f66dcdc7` | 1518140 |
| two-option-criteria-split-03 | `a943dc0be132d832e90c7ee86c24b8e0c93a72d35c2b5d479daec4ac35fdb5e3` | 1626936 | `b4ca3d8aa3e27eaa0ac9dbfe51f363d5accf6a7af0a318f2f883e9ceb4f279bc` | 1208114 |
| reaction-evidence-inset-01 | `0c98c5a4ea46a8480c7051e50ce7725830832a2c8e715e161fb58805673b3beb` | 2198154 | `c753af88415b5ff76875dfca653c7abba0a40e7abfdf5ee768a53b73a52955a2` | 1548674 |
| reaction-evidence-inset-02 | `def3c974fdd9daa6b8281d041c8d95e12525f92a1730e1c5d1b8044223429a8d` | 1991601 | `5a9e3f9242329ec2422cf2ff4c96331805689157cba04caa9732318c52501a55` | 1409264 |
| reaction-evidence-inset-03 | `b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8` | 3031047 | `d37b5687c12583d30eb446bd4e621fb01bee286ee488cce205bd8bb8633870ef` | 2131478 |
| cutaway-exploded-object-01 | `ed5c34f069a58483d59d9d14b31bd58cd4d3bb53c6422fa4b326ec16d1b7f728` | 2012012 | `c3ce800a9858c4248bb70c0fa83450f3e0afa32ef9175d504ed1c2f84aca2a15` | 1441708 |
| cutaway-exploded-object-02 | `7f6e89379c02397062bd86871b6b0d739bcd6bb11ac05563846ae9e75f6fdcf5` | 1986151 | `7f6039e524471a188e44506d65f2cd1ff8dc8dc8230435bb2416524aa4937705` | 1439994 |
| cutaway-exploded-object-03 | `f7363e63f841a87dc6539d9a722a7237f28fe019530c8feae48070afa24caf3f` | 2092324 | `d906f47b11b4d97ef3a320d2b430aaa384380f9dfb59a6ec4ad891c02ed91acc` | 1478404 |
| hero-payoff-companion-01 | `32061c1c2370fa15e48bfdccf4c98862d61b34eb6295455123cca7073244b99d` | 2274220 | `1d051308f1b7ce553f0c4ebddc4a3e850352d19c0d0acfd97d3f7958c41c430a` | 1616678 |
| hero-payoff-companion-02 | `0217ee0ddde2879c87e6fa7d60f9578c089a061b14adee2f61b9dc53e2e131d9` | 1884789 | `0d52d8c01a687965766b732ecda324341c9dd76019b3f1b289cdc5461071c57b` | 1380408 |
| hero-payoff-companion-03 | `12ec6a8e45ef0acf120f7e28662853d765c4f01974d5e4855dbffae09d2722a3` | 2169402 | `bf1e1e805ba5b9bf8240f8d6b365a035620a0edf6a869bb4952f23f236b1e4d3` | 1574720 |
| iconic-result-closeup-01 | `c0ae4932e4b66909829ee9d41745425f1b06c6f0fe5d372e3436b11a86736974` | 2471624 | `f2d72d26cfb386301ae74673e44497ca30ca89103c773e164ceefcca22236576` | 1801744 |
| iconic-result-closeup-02 | `8f38437b19b595082a7d8f479615e2e3af7975ae3690b2e2f1570fdeedb5babb` | 2841778 | `a639fa00693c45a06043df9a0a2cbe0cfd96fd7a4e0eda7e5865119c9a8c6a86` | 1993524 |
| iconic-result-closeup-03 | `970c5dd76116e6f68634de9aca7ff63dac4af9b411dff96c2f9916af266e7e90` | 1936323 | `e8b1bd981ca9744ac108eb93f1a43c2ad4135e65d6b9174e75f51f3e435c4ca6` | 1343932 |
| scale-journey-01 | `6948eb7ece83bec59406886b52c5f24f79d2aa0f2cd72ba7257372fa99043872` | 2306910 | `7d9086cefe9f7fce2ddb9a4e1d6a8c39b94e4b7086c6075d04d357cbe8c20deb` | 1820716 |
| scale-journey-02 | `4c62b241147a00df11aa2113774d82f408e1abb7cc129c6d3db54ceb50d56f4a` | 2056131 | `59b22f0e39725ee6e08bf9f865ceb46f1bbddcbd1c85c22d41b9a3396cc612e5` | 1482468 |
| scale-journey-03 | `cecce979f25df3f5c65fc05dc2be89b6e0ac74a8a265ba291e3371408a5be0c2` | 1940737 | `cdffb91a058b4a3570da92c444d36c35444774ae2e89a2211dc8d19d491e60d7` | 1405508 |
| numbered-lineup-01 | `948d1cbbf54885e41ab644a51a631657b53c946d732ca18e824939c215737d01` | 1909000 | `5695fada263f543f2dec229adb5a89e79412398c968882da2ccb995acd400c5a` | 1459370 |
| numbered-lineup-02 | `0f68466c8a42cb12858c731511be99c4ff726227ddee47c7a6ec566df64dfb29` | 3133201 | `07b3b1f969d36bc555a1b41e881d5c48a1c8525ed35765dc6b21417d4ea209d2` | 2262186 |
| numbered-lineup-03 | `986fdaf39fb3d07190df11fdb0e8f8482a308b6c09bd7e261362460607ce3b9d` | 2234339 | `1c481e52f1c39432f20926100e098bb8aad0497d6f0a8c6e56fd85ddb99f6bdc` | 1672988 |
| macro-mystery-detail-01 | `44a59d9fd7380f3fcf34d7455785f608e1289ad6168c3b69da93342469723dd1` | 2115087 | `e1113000e914850b44ac482baa8b90a9f759a3054d612d1eb0e863664a7d96fa` | 1511698 |
| macro-mystery-detail-02 | `33d68a3ddcbeb4e3fe4b9877d9704536107102d8ff7e486b1f6eada8f11ec067` | 2614781 | `da16f97615dcc545e45348f7573842ce0e706799aaeb66db35c3c1bf9f13b69f` | 1897020 |
| macro-mystery-detail-03 | `7fd46109544f1cba6c61173789ce915d14cde6bd41d6a0cc306baefea7a0bf51` | 2944718 | `7e7ca9d146bc60361cc2425b5cc0eb6abd3ea52cd8f70dc4fa535c991c86da6e` | 2184276 |
| hands-on-pov-moment-01 | `a0b163a21a56dc630329b5bd837b84f66c5fd8a70d86cfbff77f3cf8816c4590` | 2015758 | `de2974dd88ea35458309ec25fb01413040d1f7c4919a7b89406f450382a8f454` | 1446666 |
| hands-on-pov-moment-02 | `1e31ec8a480003e228f5b721290c045fc4601d4f8af2c729bbab7d1f2e38562b` | 2109711 | `ac208662b418dcfa9213d64545dd8117aa80829d0359aeab5baf9c57ed2de17b` | 1499292 |
| hands-on-pov-moment-03 | `e95c6f9f5fd44756a86fe9387649009cb13bb4a6c09a4d2a442605fa24dbd115` | 2065348 | `9d5872336d64a3bbb4e80fce1d828412fb68cf9dfae3322682b90ebad5e24891` | 1401886 |

## Rights and provenance limitations

Tool provenance is built-in ChatGPT image generation. The built-in route does not expose backend provider/model, provider job/request ID, or seed; this Mac was not a fleet worker. No Studio Hub credits were charged and no external paid API/CLI call was made, so a per-output price/cost receipt is not applicable. The only correlation keys are the local draft job ID and prompt SHA-256. All inputs were text-only with `reference_images: []`, and each row retains the no-reference/no-compositing attestation.

Rights basis: `OpenAI output terms basis; owner responsible for use; non-exclusive/similarity caveat applies`. OpenAI’s Terms say Output may not be unique and the user remains responsible for use and appropriateness. The C2PA/OpenAI strings on the preserved original PNGs support route provenance; C2PA/SynthID do not independently establish accuracy, ownership, or context. No exclusive-copyright claim, model-specific license, or infringement warranty is made.

## Tests and checks

- `npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`: 12 tests, 2 passed and 10 failed exactly as expected. The passing asset test pins each selected WebP’s SHA-256, bytes, WebP decode, 1672×941 dimensions, and the fixture’s expected title-line count. Actual in-image title transcription and line arrangement are supported by the selection ledger and independent visual review, not OCR in the asset test. The passing evidence test pins the exact ten registry pack IDs/receipt/reserved status and, for every accepted ledger row, the selected-original path/hash/bytes/decode/dimensions/canonical format, selection-linked timestamp/title/prompt/line/invariant values, source/converted target facts, route unavailable/not-applicable reasons, text-only attestation, C2PA/OpenAI-string check, rights sources/basis, review-reference list/30-of-30 summary, and conversion settings/paired-output proof. It checks each provenance row for the asset name plus converted/original/prompt hashes; it does not parse every human-readable provenance-table cell field-for-field. The visual qualification, title-safe-area, diversity, and rights/provenance interpretations remain supported by the separate independent-review, final-diversity, route-ruling, and provenance records. Each of the ten failures is an `ENOENT` for that reserved recipe’s absent `pack.json`; no unrelated failures occurred. Tasks 5–9 own these pack/content manifests.
- Focused Sharp decode/dimension/hash check: 30/30 PASS.
- `git diff --check`: recorded after the task’s tracked files were complete.

## Files changed

- `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/returned-evidence.json` (ignored fail-closed returned evidence ledger)
- `content-packs/thumbnail-recipe-expansion-ten/PREVIEW-PROVENANCE.md`
- 30 selected WebPs at the exact receipt-authorized target paths
- `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

## Self-review and concerns

The initial shell construction attempted to interpolate Markdown backticks and was rejected as suspect before acceptance. The provenance file was regenerated through this quoted script, then inspected and test-validated. The only remaining RED state is deliberate: source pack and content manifests must be authored by Tasks 5–9. No registry transition, pack/content manifest, archive, stock, publish, push, or commit was made.

## Fix Round 1 — evidence contract hardening

The passing evidence test now pins the exact ordered ten registry pack IDs as well as revision, receipt, count, and reserved status. For each of the thirty accepted records it independently reads the untouched selected PNG and adjacent selection metadata, recomputes original SHA-256/bytes/decode/dimensions, verifies canonical `png`, exact route-unavailability/not-applicable reasons, text-only inputs and attestation, C2PA/OpenAI-string evidence, title/prompt/line/invariant facts, rights sources, review references and 30/30 summary, full conversion settings plus paired-byte proof, and converted format/dimensions/decode. A mutation to any of these binding ledger facts now fails the passing evidence test.

All `original_format` ledger values were normalized to canonical lowercase `png`; no source or converted creative byte changed. Command rerun: `npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts` produced exactly 12 tests: 2 passing evidence/asset tests and 10 expected `ENOENT` failures for missing reserved `pack.json` manifests, with no unrelated errors. `git diff --check` passed.

## Fix Round 2 — report-scope correction

The prior phrase “every ledger/provenance entry” overstated the passing test’s coverage. The Tests and checks claim now names the exact field-level assertions and distinguishes them from the human-review and provenance-record evidence that the test deliberately does not parse exhaustively.
