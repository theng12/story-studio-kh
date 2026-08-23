# Task 5 Report: Symbolic Psychology Studio candidates and review handoff

**Status:** `DONE_WITH_CONCERNS`

**Source commit:** `e67a9bebfaaa01294857b71ca66901b90591fce9`

**External artifact root:** `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/`

## Initial outcome (superseded by Fix Round 1 below)

Three exact keyless `genstudio-store-receipt-v1` candidates were each built twice from the committed source, immediately validated after each build, byte/SHA-compared, and retained once as canonical external archives at `min_app_version: 1.0.843`:

| Candidate | SHA-256 | Bytes |
| --- | --- | ---: |
| Editorial Psychology Symbolic Split Recipe | `64e0ec9afcd86b18e9655999de84e5bc4b7f3410997d3731334cbe0a208a8ebb` | 738,042 |
| Pastel Surreal Psychological Collage Style | `d70083a8bddc67e032d465c63f91845d6178ae60c785d6aba9ce4e7db357a054` | 290,429 |
| Oil Painting Classical Style | `95f6271a0f56afd850c1548bfff703177ba9b5977584093fea833f1bbf02e3fc` | 403,483 |

The exact three-Style Symbolic Psychology Studio Kit is blocked before archive creation by the unchanged shared publisher/runtime contract:

```text
bundle-only coordination packs require exactly one Formula, at least one Topic Pack, exactly one Style, and exactly one Recipe component
```

The approved source remains unchanged with Formula, Topic, Recipe, Pastel, Impasto, and Oil. It was not silently downgraded to one Style. No Kit archive is retained. The authoritative failed build is recorded in `build-evidence/kit-current-contract-build-blocked.log`.

During root-cause diagnosis, a one-line temporary schema change proved that the unchanged source then builds twice to identical diagnostic bytes (`8bb5e87f1e295fcaefde2fb7fac0534b07253f3ef16c8ba268fb9b2d57ebb032`, 633 bytes). That diagnostic schema/version/changelog work was fully reverted at the controller's scope gate, its archive bytes were removed, and its logs are labeled `diagnostic-prohibited-schema-proof-*`. A separate reviewed publisher-contract extension task is required before the Kit can be rebuilt authoritatively.

## External evidence and handoff

- `evidence-ledger.json` records exact source commit/path, receipt revision/reference, Story identity, digest/bytes, version floor, delivery profile, validator evidence, per-file hashes, preview evidence, closure separately, and one v1 `component_summary` for each of Recipe, Pastel, Oil, and Kit.
- Historical Formula, Topic, and Impasto archive evidence is reference-only and contains no `component_summary` backfill.
- `candidate-handoffs.json` contains the exact component/coordinator handoff fields. The three leaf candidates are `candidate-built-review-pending`; the coordinator is `blocked` by the publisher contract.
- `review-requests.json` requests independent schema, originality/provenance, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, and commercial-boundary reviews. Thumbnail review is explicitly not applicable to Styles and the bundle-only Kit, with reasons.
- `receiver-handoff.json` remains `candidate-built-review-pending`, not `ready-for-owner-stocking`.
- Gothic Charcoal Animal Editorial remains blocked and excluded for missing original preview bytes, source/rightsholder provenance, rights/license basis, transformation record, and independent visual review. No Gothic identity, source, dependency, or archive exists.

All nine independent review categories remain pending. Controller-owned reviewers must return exact evidence before the receiver handoff can be reconsidered for owner stocking.

## Artifact audit

The fresh byte-level audit confirmed:

- exactly three retained archives totaling 1,431,954 bytes;
- exact receipt-issued pack/version/publisher identity and `min_app_version: 1.0.843`;
- all manifest file SHA-256/byte declarations match extracted bytes and the ledger;
- no `key_id`, `signature.ed25519`, PEM/private key, provider/model/wire field, executable entry, Kit archive, or Gothic archive;
- every retained archive is below 52,428,800 bytes;
- the Kit blocker log contains the exact authoritative publisher error;
- no `component_summary` appears in historical evidence entries.

## Verification

- RED: Wave 1 test failed on missing external ledger/handoffs before artifact creation.
- GREEN: Wave 1 test passes 4/4, including v1 summaries and review-pending/non-mutating handoff boundaries.
- `npm run content-pack:registry -- validate` — revision 16, 74 records.
- Requested Node matrix — 83/83 passed.
- Requested TypeScript matrix — 79/79 passed.
- `npm run typecheck:electron` — passed.
- `npm run check:security` — passed.
- `npm run check:model-drift` — passed; 602 source files, 32 annotated exceptions.
- `git diff --check` — passed.
- External byte-level archive/ledger audit — passed for all three retained candidates; Kit absence/blocker passed.

## Explicit boundary

No image generation, paid request, upload, product draft, release draft, price or discount decision, purchase, grant, production signing, publication, or GenStudio mutation occurred. No runtime schema, version, or changelog change remains in this task.

## Concerns

1. Kit delivery is blocked until a separately reviewed publisher/runtime contract extension permits more than one Visual Style in a bundle-only coordinator, after which the exact source must be built and validated twice again.
2. Schema, originality/provenance, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, and commercial-boundary reviews are pending; therefore the batch is not ready for owner stocking.

## Fix Round 1 — reviewer findings applied

**Current status:** `DONE_WITH_CONCERNS`

**Corrected Recipe source commit:** `1b6bdac465e5880914335b4deaa5c04bf04c723b`

The Task 5 and visual review files were read in full. Their four findings were applied without generation, commerce, installed-schema, version, changelog, Formula-source, Oil-source, upload, signing, publication, or GenStudio mutation.

### Recipe correction and deterministic rebuild

The rejected `editorial-psychology-symbolic-split-4.webp` preview was removed from the Recipe document, source asset set, provenance row, and source tests. The remaining four reviewed previews still satisfy the approved 3–5-preview contract and vary across four episodes, left/center-left placement, subjects, palettes, settings, and two-/three-line headline arrangements. The rejected exact bytes remain recoverable only at:

```text
quarantine/recipe-preview-4/editorial-psychology-symbolic-split-4.webp
sha256=fb5be086761b7effc5ae325ac8d2458f7da071c710c3e4dcfb5155fb523b1166
bytes=420590
```

The superseded first-pass Recipe archive was also moved to `quarantine/superseded-candidates/` before the corrected canonical archive was written.

RED command and result:

```bash
npx tsx --test electron/server/__tests__/capi-psychology-components-source.test.ts electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts
```

Result before the source edit: `5/9 passed`, with all four failures proving the document/file/provenance still contained preview #4. After the source edit the same command passed `9/9`.

Authoritative build/validation commands:

```bash
npm run content-pack:build -- content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /tmp/story-task5-fix1.IqXCnO/recipe-run1.sspack
npm run content-pack:validate -- /tmp/story-task5-fix1.IqXCnO/recipe-run1.sspack --delivery-profile genstudio-store-receipt-v1
npm run content-pack:build -- content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.0.843 --output /tmp/story-task5-fix1.IqXCnO/recipe-run2.sspack
npm run content-pack:validate -- /tmp/story-task5-fix1.IqXCnO/recipe-run2.sspack --delivery-profile genstudio-store-receipt-v1
cmp -s /tmp/story-task5-fix1.IqXCnO/recipe-run1.sspack /tmp/story-task5-fix1.IqXCnO/recipe-run2.sspack
```

Both builds and validations reported:

```text
sha256=559e82c35197f4f56dc929c8bfa49faaf64a74cf4c21407eb219cc706334e7e6
bytes=317093
cmp_exit=0
```

One initial diagnostic validate invocation omitted `--delivery-profile genstudio-store-receipt-v1` and correctly failed with `local publisher validation requires key ID, publisher ID, and public key path`; it was not counted as either authoritative validation. The matching-profile commands above both passed.

### Pastel visual block and replacement request

The existing Pastel preview was not silently relabeled: independent visual review found a heavy-impasto forest/lantern image rather than the promised matte mixed-media collage. The owner-authorized search remained limited to Capi episode/scene assets.

Evidence commands/results:

```bash
find "/build/Documents/Story Studio KH/Story Studio Projects/Capi/episodes/Season 003/EP0050 - The Psychology of the Silent Descent/EP0050 - 05 Scene Images" -maxdepth 1 -type f
# 141 PNG scene assets; full contact sheet and plausible outliers visually inspected; all remained oil/impasto.

rg -n -i --glob '**/03 Scene Prompts/*.{json,md,txt}' 'mixed[- ]media|collage|torn paper|cut paper' "/build/Documents/Story Studio KH/Story Studio Projects/Capi/episodes"
# no matches
```

Season 2 contact sheets and the closest palette outliers were inspected at original resolution. They remained impasto, glossy fluid-marbling, or ordinary watercolor rather than a truthful matte mixed-media collage. No image was generated or transformed. The prior archive is diagnostic-only at:

```text
quarantine/blocked-candidates/com.storystudio.pack.style.pastel-surreal-psychological-collage@1.0.0.sspack
sha256=d70083a8bddc67e032d465c63f91845d6178ae60c785d6aba9ce4e7db357a054
bytes=290429
```

Its stockable archive path/digest is null in the receiver handoff. The exact capability-and-quote-only Studio Hub request is `/build/Developer/_handoffs/2026-08-23_to-gpt-studiofleet_from-gpt-storystudio_symbolic-psychology-pastel-preview-replacement.md`. It authorizes no job or generation; any charged route requires an exact returned quote and explicit owner authority before submission.

### Kit commercial and safety blockers

The Kit intent now states only that commerce terms are undecided and not supplied by Story; it contains no free/paid/price claim. In addition to the unchanged publisher blocker, the ledger, candidate handoff, review request, and receiver state now record this exact safety blocker:

```text
Human Behavior Formula 1.0.0 permits diagnostic-but-warm tone, conflicting with the Kit's non-diagnostic acceptance criterion.
```

The incompatible value is verified at `content-packs/free-starters/formula/human-behavior-explained/content/series-formula.json`. Task 5 did not edit or reissue that already-issued Formula source/version. No Kit archive exists.

### Current receiver and immutable evidence

Only two canonical stockable archives remain under `archives/`:

| Candidate | SHA-256 | Bytes | State |
| --- | --- | ---: | --- |
| Editorial Psychology Symbolic Split Recipe | `559e82c35197f4f56dc929c8bfa49faaf64a74cf4c21407eb219cc706334e7e6` | 317,093 | `candidate-built-review-pending` |
| Oil Painting Classical Style | `95f6271a0f56afd850c1548bfff703177ba9b5977584093fea833f1bbf02e3fc` | 403,483 | `candidate-built-review-pending` |
| Pastel Surreal Psychological Collage Style | — | — | `blocked`; diagnostic archive quarantined |
| Symbolic Psychology Studio Kit | — | — | `blocked`; no archive |

The external byte-level audit passed with `archives=2 blocked=2 keyless=true file_hashes=true quarantine=true`. Current handoff hashes are:

| File | SHA-256 |
| --- | --- |
| `evidence-ledger.json` | `56fa84f3cc3e29dda8139e072b373394b793662d0fe6ffc4aa28ceca7e5db61e` |
| `candidate-handoffs.json` | `9ebe62122540c17d39f34a080221a918318c51e7581c3b541a015651bc46371a` |
| `review-requests.json` | `72def8aeceaebd6dd87055f8f614c42dd0c9725c2fb5cb4fc8b9924bc8e8662a` |
| `receiver-handoff.json` | `7fcad2f7582a6a1a61c4cb8ee2148fe172526019db9f7870b567a1ce75efa661` |
| Studio Hub replacement request | `fd34be79ee26d539ac0b8204d50467f11615d8e05a113f217de210ee617d8167` |

### Fix Round 1 final verification

- `npm run content-pack:registry -- validate` — revision 16, 74 records.
- Requested Node matrix — `83/83` passed.
- Requested TypeScript matrix — first run `78/79`, exposing the stale legacy-restoration expectation for Recipe #4; the root-cause-only test update then passed alone `11/11` and the complete matrix passed `79/79`.
- `npm run typecheck:electron` — passed.
- `npm run check:security` — passed.
- `npm run check:model-drift` — passed; 602 source files, 32 annotated exceptions.
- `git diff --check` — passed.
- External JSON parse, archive inventory, exact receipt/profile/version, manifest file hashes/bytes, keyless/no-executable checks, quarantine hashes, null Pastel receiver archive identity, exact Kit blockers, and byte-level handoff hashes — passed.

### Remaining blockers

1. Pastel needs a truthful owner-authorized matte mixed-media replacement preview, two fresh deterministic builds/validations, and independent visual re-review.
2. Kit needs the separately reviewed publisher-contract extension for its approved three-Style closure.
3. Kit also needs a reviewed resolution of the Formula 1.0.0 `diagnostic-but-warm` compatibility conflict; Task 5 cannot silently edit that issued source/version.
4. Independent re-review remains pending for corrected Recipe evidence and every other category not explicitly blocked above. The receiver stays `candidate-built-review-pending`/blocked and is not ready for owner stocking.
