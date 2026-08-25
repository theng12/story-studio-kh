# ChatGPT Wave A Preview Report

Status: DONE_WITH_CONCERNS

Tool provenance: built-in ChatGPT image generation. Each selected asset was generated without reference images, visually inspected, copied byte-for-byte without any resize, crop, conversion, overlay, or compositing, then decoded with `sips` as PNG RGB.

| Job | Status | Selected asset | SHA-256 | Dimensions | Attempts | Rejections |
| --- | --- | --- | --- | --- | ---: | --- |
| before-after-proof-panel-01 | PASS | `chatgpt-originals/before-after-proof-panel-01/selected.png` | `28cf0c657abe429d2bb893b1276d673b6c682e9962894c5d69772f1acef31185` | 1671x941 PNG | 1 | — |
| before-after-proof-panel-02 | PASS | `chatgpt-originals/before-after-proof-panel-02/selected.png` | `180c55e74dd66d76b880cd9a5b5a1f963c97060b51ed91cf0edcd0ee09efd226` | 1672x941 PNG | 1 | — |
| before-after-proof-panel-03 | PASS | `chatgpt-originals/before-after-proof-panel-03/selected.png` | `94e8792ebea5577505a8fcbafbdef427004d48e69891d3363eb0a207a08f8574` | 1671x941 PNG | 1 | — |
| two-option-criteria-split-01 | PASS | `chatgpt-originals/two-option-criteria-split-01/selected.png` | `ee3f972099f6f83cdf2968780c6741cc8a032e3403000a2217fce6b5f76f55e1` | 1672x941 PNG | 2 | Attempt 1 had incidental legible planning-sheet words. |
| two-option-criteria-split-02 | PASS | `chatgpt-originals/two-option-criteria-split-02/selected.png` | `a1bec8992db1196a3b5b6d583b1e1aef21c4b00803c9c52078bbc2e163e4d19a` | 1672x941 PNG | 2 | Attempt 1 used a rounded title plate. |
| two-option-criteria-split-03 | PASS | `chatgpt-originals/two-option-criteria-split-03/selected.png` | `a943dc0be132d832e90c7ee86c24b8e0c93a72d35c2b5d479daec4ac35fdb5e3` | 1671x941 PNG | 2 | Attempt 1 used a black title-panel treatment. |
| reaction-evidence-inset-01 | PASS | `chatgpt-originals/reaction-evidence-inset-01/selected.png` | `0c98c5a4ea46a8480c7051e50ce7725830832a2c8e715e161fb58805673b3beb` | 1672x941 PNG | 2 | Attempt 1 used a black bottom-strip title treatment and unsafe edge margin. |
| reaction-evidence-inset-02 | PASS | `chatgpt-originals/reaction-evidence-inset-02/selected.png` | `def3c974fdd9daa6b8281d041c8d95e12525f92a1730e1c5d1b8044223429a8d` | 1671x941 PNG | 1 | — |
| reaction-evidence-inset-03 | PASS | `chatgpt-originals/reaction-evidence-inset-03/selected.png` | `1e0f5e611b7d6c235371b7712851780a081e5991a989108ccb9256400a7eeae6` | 1672x941 PNG | 2 | Attempt 1 placed a logo-like mark on the chain detail. |
| cutaway-exploded-object-01 | PASS | `chatgpt-originals/cutaway-exploded-object-01/selected.png` | `ed5c34f069a58483d59d9d14b31bd58cd4d3bb53c6422fa4b326ec16d1b7f728` | 1672x941 PNG | 1 | — |

Totals: 10 PASS, 0 BLOCKED, 15 total generation attempts, 5 rejected attempts.

Concern: the built-in generator emitted four selected images at 1671x941 rather than the requested 1672x941. The original bytes were deliberately retained untouched, as required; no resizing or conversion was applied. The affected IDs are `before-after-proof-panel-01`, `before-after-proof-panel-03`, `two-option-criteria-split-03`, and `reaction-evidence-inset-02`.

## Fix Round 1

Two independently reviewed blockers were regenerated only with built-in ChatGPT image generation and no reference images. Their prior selected bytes were retained non-destructively as `rejected-review-round-1.png`. No tracked files, source packs, or other jobs were changed.

| Job | Status | Rejected SHA-256 | Replacement SHA-256 | Replacement dimensions | Exact title / line count | Visual verdict |
| --- | --- | --- | --- | --- | --- | --- |
| two-option-criteria-split-01 | PASS | `ee3f972099f6f83cdf2968780c6741cc8a032e3403000a2217fce6b5f76f55e1` | `9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07` | 1672x941 PNG RGB | `PAPER OR DIGITAL?` / 1 line | Direct upper-scene title; no rectangle, panel, card, banner, or title plate; digital object is plain, unbranded, and blank with no UI, icons, menus, UI chrome, or extra text. |
| reaction-evidence-inset-03 | PASS | `1e0f5e611b7d6c235371b7712851780a081e5991a989108ccb9256400a7eeae6` | `b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8` | 1672x941 PNG RGBA | `ONE SMALL` / `SIGN TELLS` / `THE STORY` / 3 lines | Direct upper-scene title without an opaque title block; one native full-frame workshop scene and one rounded in-scene, unbranded worn-chain-link evidence window connected by the mechanic's gesture. |

Fix Round 1 totals: 2 PASS, 0 BLOCKED, 3 new attempts, 1 rejected new attempt.
