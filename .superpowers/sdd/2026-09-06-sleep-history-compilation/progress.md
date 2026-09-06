# Sleep History Compilation — authoring progress

## Completed (2026-09-06)

- Owner approved six standalone packs (no Channel Kit) and, later the same day, the pricing ruling: list 300 credits, standing 90% launch discount for 365 days (30 credits effective). The no-discount opt-out PR (genstudiokh #31) was withdrawn accordingly.
- Registry revision 143 reserved all six identities under receipt `authoring:6a7d2a107dacc5f4f3ba37f76913e0dcc7861459094d7eb7af7ebf0fcbb9a473`; every expected identity passed `verify-receipt` before source authoring.
- Sources authored under `content-packs/sleep-history/`; three topic packs at the house standard (50 subjects × 20 hand-authored tuples). Previews generated with GenStudio `gpt-image-2` through the app's Image Pool generator (owner-authorised, 160 credits), converted with the lossless house recipe; see `content-packs/sleep-history/PREVIEW-PROVENANCE.md`.
- Gates: runtime schema parse ×6; registry validate; `sleep-history-packs.test.mjs` 5/5; content-packs lane 201/201; `ship-pack --dry-run` all six; forbidden-mark scan; owner-home-path guard.
- Registry revisions 144–149 promoted all six to `authored` (transition refs in `lifecycle-results.txt`).
- Integrated through Story Studio PR #41, merge commit `33f86e0c13`. Companion app briefs merged through PR #39 (`docs/handoffs/PACING-PRESETS-SLEEP-2026-09-06.md`, `docs/handoffs/IMAGE-POOL-REACHABILITY-2026-09-06.md`); item (c) of the second brief shipped the same day via PR #42.
- Archives rebuilt from `33f86e0c13` with `ship-pack` into `<owner-home>/Developer/_handoffs/artifacts/sleep-history-2026-09-06-final/` and stocked with `python -m app.tools.stock_pack` on the control Mac (dry run, then live). All six consistent with manifest and policy.

| pack | archive sha256 | bytes | GenStudio product | release |
| --- | --- | ---: | --- | --- |
| formula.sleep-history-compilation | `85847d1cf200adbe1f1c0339005679058fca5b7249c8c3ab0da8e90dda75c8db` | 6377 | `cprod_5237d09c37ff40eebfdb2734f4b1e0d1` | `crel_cb53308a93fc43119e623da702a47205` |
| style.old-master-still-life | `890e491ae14adbcb40e7a0290e0c09aaec5c96911d7b515435f0fabc7fb02f91` | 1451798 | `cprod_2104018267814283aebb306023135571` | `crel_a371527d59314ba795ae07d7afeef84f` |
| thumbnail.period-portrait-serif-title | `a41fb66aabc20d689712b218c290a860d9f5491b535cb003da37e65c961de32e` | 7222347 | `cprod_2601dc625a944153a4dcbc56f95aa651` | `crel_dd9af3b3d5044246b2ebdd0656cef8ea` |
| topic.drinks-and-spices-histories | `7a661a5c451e12646f5aff77464ace87f9d13360df91306604e56db46ec9ac46` | 205131 | `cprod_1715c3a5df38495eac94a316df12399d` | `crel_c69422317913456a86062c3f61a1038e` |
| topic.everyday-object-histories | `7ea3d5c5a1dfabde83d6275c6ec86b9efa429052f11a1b70aa9ceb797971531e` | 177755 | `cprod_cac30fcc9a0d47758fa0b3e8ff67b5f2` | `crel_aac3410a79f243fa9e88f051993b3b3f` |
| topic.food-histories | `b108ba9ff32fbebe18dbb81b80f07e212ce6e456122abdb5ade30cd5c3102a2f` | 199819 | `cprod_4b50f80c4c224aab9cdefc1f7d9de936` | `crel_c987749d3a66431fa2e4394696ebef53` |

Each product: 300 credits, 90% discount to 2027-09-06 inclusive, shopper price 30 credits. Story Studio's Content Store lists all six.

## Closed and transferable

Nothing remains for these six. The exact archives are reproducible from merge commit `33f86e0c13` with the recorded build command and Store delivery profile; the artifact folder on the control Mac is a convenience copy only.
