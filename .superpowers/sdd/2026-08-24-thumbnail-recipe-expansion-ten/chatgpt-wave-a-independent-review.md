# ChatGPT Wave A independent review

Scope: the ten requested selected originals only. I read approved Design sections
5.1--5.4, the matching `preview-batch.json` jobs, and each corresponding
`selection.json`. I independently decoded and inspected every `selected.png` at
original detail. This review does not rely on the generation-agent report.

## Mechanical evidence

All ten files decode as RGB PNGs. `file`, `sips`, `stat`, and SHA-256 agree with
the corresponding selection record in every case. PNG is the returned original
format (not the eventual required WebP); a documented deterministic whole-image
conversion to WebP is consequently required for every otherwise eligible file.
The following four need a one-pixel width conversion as part of that operation:

- `before-after-proof-panel-01` — 1671x941, 1,973,300 bytes,
  `28cf0c657abe429d2bb893b1276d673b6c682e9962894c5d69772f1acef31185`
- `before-after-proof-panel-03` — 1671x941, 2,169,431 bytes,
  `94e8792ebea5577505a8fcbafbdef427004d48e69891d3363eb0a207a08f8574`
- `two-option-criteria-split-03` — 1671x941, 1,626,936 bytes,
  `a943dc0be132d832e90c7ee86c24b8e0c93a72d35c2b5d479daec4ac35fdb5e3`
- `reaction-evidence-inset-02` — 1671x941, 1,991,601 bytes,
  `def3c974fdd9daa6b8281d041c8d95e12525f92a1730e1c5d1b8044223429a8d`

The other six are 1672x941. Every original includes C2PA/OpenAI strings; that is
supporting provenance evidence, not a substitute for the visual review below.

## Per-job verdicts

| Job | Verdict | Independent evidence |
| --- | --- | --- |
| `before-after-proof-panel-01` | PASS | Actual metadata matches selection: PNG, 1671x941, 1,973,300 bytes and stated SHA. Exact one-line `FROM SEED TO SPROUT` is complete, readable, and has no extra legible text. It is native-looking text over the continuous greenhouse render, not a separate plate. The seed tray makes a clear bare-soil-to-sprout left/right temporal seam; greenhouse and earth-to-green brief match. No observable logo, UI, likeness, watermark, or copied material. One-pixel width conversion needed. |
| `before-after-proof-panel-02` | PASS | Actual metadata matches: PNG, 1672x941, 1,831,804 bytes, `180c55e74dd66d76b880cd9a5b5a1f963c97060b51ed91cf0edcd0ee09efd226`. The exact two lines `A DULL ROOM` / `BECOMES CALM` are complete and unclipped with no other legible text. A matched frontal room moves cleanly from dim/cluttered to tidy/daylit across the seam; slate-to-sage/sand treatment and one native full-frame render match the brief. No observable prohibited material. |
| `before-after-proof-panel-03` | PASS | Actual metadata matches: PNG, 1671x941, 2,169,431 bytes, `94e8792ebea5577505a8fcbafbdef427004d48e69891d3363eb0a207a08f8574`. The exact three lines `FROM ROUGH` / `TO READY` / `TO USE` are clean and complete. Matched unfinished and finished stool states share a believable workshop/tabletop transition, raw-to-honey wood palette, and native open title-safe space; no extra legible text or prohibited material is visible. One-pixel width conversion needed. |
| `two-option-criteria-split-01` | BLOCKED | Actual metadata matches: PNG, 1672x941, 2,541,534 bytes, `ee3f972099f6f83cdf2968780c6741cc8a032e3403000a2217fce6b5f76f55e1`. Headline spelling and one-line layout are correct and the alternatives have broadly equal weight, but the headline sits on a conspicuous rough-edged opaque beige banner/title plate. This violates the native full-frame/no pasted title plate or block gate. The e-ink device also visibly displays a diagrammatic interface-like screen, contrary to the explicit no-UI visual constraint. Do not qualify this asset. |
| `two-option-criteria-split-02` | PASS | Actual metadata matches: PNG, 1672x941, 2,070,413 bytes, `a1bec8992db1196a3b5b6d583b1e1aef21c4b00803c9c52078bbc2e163e4d19a`. Exact two lines `QUIET SPACE` / `OR BUSY SPACE?` are readable, complete, and unplated. The same chair silhouette receives equal present-time treatment in a minimal versus object-dense reading nook separated by a central divide, without a winner. The full-frame interior is visually native; book-spine marks are not legible words. No observable logo, UI, likeness, watermark, or copied material. |
| `two-option-criteria-split-03` | PASS | Actual metadata matches: PNG, 1671x941, 1,626,936 bytes and stated SHA. Exact three lines `LIGHT OR` / `DARK FOR` / `FOCUS?` are clean and unclipped over the continuous split light/dark desk scene, with no title plate. Same-angle lamp conditions receive equal treatment around a neutral central object; the light/amber contrast matches the brief. No observable prohibited material. One-pixel width conversion needed. |
| `reaction-evidence-inset-01` | PASS | Actual metadata matches: PNG, 1672x941, 2,198,154 bytes, `0c98c5a4ea46a8480c7051e50ce7725830832a2c8e715e161fb58805673b3beb`. Exact one-line `THAT'S THE CLUE` is complete and readable. A generic profile researcher both looks and points toward one rounded leaf-vein evidence window in the same forest-trail scene; the connector dots support that relation. The headline is rendered directly into the open scene, with no plate, and no observable forbidden material. |
| `reaction-evidence-inset-02` | PASS | Actual metadata matches: PNG, 1671x941, 1,991,601 bytes and stated SHA. Exact two lines `THE TINY DETAIL` / `CHANGES EVERYTHING` are readable and complete, with no other legible wording. The generic baker's gesture targets one rounded native dough-texture evidence window; warm cream/terracotta kitchen brief is materially met. No title plate or observable logo, UI, likeness, watermark, or copied material. One-pixel width conversion needed. |
| `reaction-evidence-inset-03` | BLOCKED | Actual metadata matches: PNG, 1672x941, 2,131,725 bytes, `1e0f5e611b7d6c235371b7712851780a081e5991a989108ccb9256400a7eeae6`. Headline text and three-line arrangement are correct, and the mechanic gesture reaches the chain detail, but the image is arranged as a hard left photo column plus a large opaque black right-side title block containing the headline and outlined inset. That visibly reads as a pasted/composited title-panel layout rather than one native full-frame scene, violating the no title plate/block/overlay gate. Do not qualify this asset. |
| `cutaway-exploded-object-01` | PASS | Actual metadata matches: PNG, 1672x941, 2,012,012 bytes, `ed5c34f069a58483d59d9d14b31bd58cd4d3bb53c6422fa4b326ec16d1b7f728`. Exact one-line `INSIDE A SEED` is complete, clean, and directly rendered in the upper-left open field. A single seed is separated in ordered depth into shell, stored food, and embryo, with no labels or callout board; moss/cream/clay brief is met. No observable logo, UI, likeness, watermark, or copied material. |

## Three-image recipe diversity

| Recipe set | Diversity verdict | Evidence / release implication |
| --- | --- | --- |
| `before-after-proof-panel` | PASS | Seed-tray side view/greenhouse/earth-green, frontal room/interior/slate-sage, and three-quarter stool/workshop/raw-honey differ materially in subject, angle/distance, setting, and palette while retaining the temporal seam. All three requested jobs pass. |
| `two-option-criteria-split` | PASS for diversity; BLOCKED for recipe qualification | Overhead paper/e-ink desk, eye-level chair interiors, and same-angle lamp conditions are materially distinct across all requested diversity axes. However, job `-01` is blocked for the visible title plate and interface-like device display, so the three-image recipe set is not eligible. |
| `reaction-evidence-inset` | PASS for diversity; BLOCKED for recipe qualification | Forest researcher/leaf, kitchen baker/dough, and workshop mechanic/chain differ materially in subject, angle/distance, setting, and palette while retaining subject-to-one-inset connection. However, job `-03` is blocked for the large title-panel/composited layout, so the three-image recipe set is not eligible. |
| `cutaway-exploded-object` | NOT ASSESSED | Only `-01` was in the explicitly requested review scope. I did not inspect `-02` or `-03`, so a three-image diversity verdict cannot be made here. |

## Overall

Eligible job IDs: `before-after-proof-panel-01`, `before-after-proof-panel-02`,
`before-after-proof-panel-03`, `two-option-criteria-split-02`,
`two-option-criteria-split-03`, `reaction-evidence-inset-01`,
`reaction-evidence-inset-02`, and `cutaway-exploded-object-01` (8 total).

Blocked IDs: `two-option-criteria-split-01` (opaque rough-edged title plate;
interface-like screen) and `reaction-evidence-inset-03` (large opaque right-side
title block/composited-layout appearance). One-pixel conversion count: 4.

## Fix Round 1 re-review

Scope: only the two replacement `selected.png` files. I read their updated
selection records, independently recalculated the bytes, type, dimensions, and
SHA-256, and inspected both replacements at original detail.

| Job | Prior blocker | Fix Round 1 verdict | Evidence / new breakage |
| --- | --- | --- | --- |
| `two-option-criteria-split-01` | Beige title plate; interface-like device display | ADDRESSED — eligible | Actual RGB PNG is 1672x941 and 2,408,743 bytes; SHA-256 is exactly `9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07`. `PAPER OR DIGITAL?` is exact, one line, full and unclipped, with no other legible words. It is direct typography against the continuous light wall, not a panel/card/banner/title plate. The hand-drawn paper and blank unbranded e-ink-like object remain equal-weight present-time alternatives around the central divide; no recognizable UI, logo, watermark, likeness, or other visual breakage is visible. |
| `reaction-evidence-inset-03` | Large opaque title-block/composited layout | ADDRESSED — eligible | Actual RGBA PNG is 1672x941 and 3,031,047 bytes; SHA-256 is exactly `b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8`. `ONE SMALL` / `SIGN TELLS` / `THE STORY` is exact, three lines, complete, and directly rendered over open dark workshop wall; it has no separate title panel/card/banner. The generic mechanic's gesture and native rounded, unbranded chain-link detail window read as one full-frame workshop scene; the yellow connector is the required gesture/evidence relation, not a title overlay. No extra text, clipping, logo, watermark, recognizable likeness, copied/UI material, or new visual breakage is visible. |

Both previous blockers are addressed. The final eligible job count is now 10 of
the ten requested Wave A jobs. The four one-pixel-width conversions recorded
above are unchanged; neither replacement needs one.
