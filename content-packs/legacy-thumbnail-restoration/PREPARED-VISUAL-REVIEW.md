# Prepared visual review — legacy thumbnail restoration

**Reviewer date:** 2026-09-01
**Scope:** Independent read-only review before a `reserved -> authored` promotion. This review created this record only; it did not alter product assets, manifests, registry records, provenance, or tests.

## Review basis

Read and reconciled:

- `AGENTS.md`
- `docs/superpowers/specs/2026-09-01-legacy-content-closure-design.md` (especially the retained decoded-preview, provenance, license, checksum, independent-review, three-to-five varied 16:9 preview, and exact in-image-title requirements)
- `content-packs/legacy-thumbnail-restoration/PREVIEW-PROVENANCE.md`
- The `pack.json` and `content/{thumbnail-recipe,visual-style}.json` manifest for every leaf below
- The original-generation receipts named in the provenance ledger for both Thumbnail Recipe leaves:
  - `.superpowers/sdd/2026-08-23-legacy-thumbnail-restoration/generated-original-previews/nature-prehistoric/receipt.json`
  - `.superpowers/sdd/2026-08-23-legacy-thumbnail-restoration/generated-original-previews/sleep-formats/receipt.json`

Every retained WebP listed below was decoded locally with `sips` and `webpinfo`; all reported `1672 x 941` (16:9), no alpha/animation, and `webpinfo` reported `No error detected.` SHA-256 and byte counts were independently recomputed and matched the output values recorded in `PREVIEW-PROVENANCE.md`.

## Leaf findings

### PASS — `com.storystudio.pack.thumbnail.prehistoric-survival-title-card@1.0.0`

**Inspected source:** `content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card`

| Preview file | SHA-256 / bytes | Visual evidence |
| --- | --- | --- |
| `assets/prehistoric-survival-title-card-1.webp` | `d2b6f0eb1eeb877560bc8ae0643d912d48f7dbc0fec9ced359fa136c352d5459` / 1,755,858 | Ashfall cave shelter: a single ancient human, face covering, food bundle, and ember fire read as one survival problem. The full three-line title is exact, complete, in-image, and clearly readable in a quiet right-side pale-ash field. |
| `assets/prehistoric-survival-title-card-2.webp` | `b14384b2bc602075a24e8a59f957602333fbb6e10a0bf7dc3c2b02ca725b169e` / 2,056,622 | Dry-season water collection: the kneeling human, gourd, basin, dry channel, and acacia are materially connected. The complete two-line title is readable in the uncluttered upper band. |
| `assets/prehistoric-survival-title-card-3.webp` | `a84a6f31897a0ec60a1324af9e09e85e322966790b20fa2063f5b00473222e41` / 1,647,746 | Snow-and-windbreak warmth scene: the human, branches, shelter, snow, and firelight are coherent. The complete one-line title is directly rendered in the upper-left sky and remains legible; its black-on-blue contrast is lower than the other two but sufficient at the inspected size. |

The three previews are meaningfully varied by challenge, setting, palette, and title-safe placement (right, upper, upper-left). No pasted panel, watermark, logo, malformed anatomy, malformed text, or compositing artifact was observed. Ledger output hashes, bytes, dimensions, source-PNG receipt IDs/hashes, and receipt QA all link exactly. Rights basis is the recorded publisher-created, text-only original under `owner-approved-2026-08-23-thumbnail-regeneration`; no separate license token is claimed.

**Decision:** Pass; eligible to proceed through the remaining non-visual promotion gates.

### PASS — `com.storystudio.pack.thumbnail.dreamlike-story-title-card@1.0.0`

**Inspected source:** `content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card`

| Preview file | SHA-256 / bytes | Visual evidence |
| --- | --- | --- |
| `assets/dreamlike-story-title-card-1.webp` | `cd0fcd9076e9c16468fee9384ebf3a77feba8bd4e0d9218b2ca44b024d978ccd` / 2,122,918 | Moonlit hedgehog-and-lantern garden: the animal, lantern, path, foxgloves, and gold-serif two-line title form a calm readable composition with a generous upper-right title field. |
| `assets/dreamlike-story-title-card-2.webp` | `17c433e6676d94919e01a785856364c8e2a16a39295b1bfbd83806775924d411` / 2,044,270 | High-overhead boat, folded blanket, moon reflection, and reeds: a distinct quiet-setting composition. The exact three-line gold-serif title is legible in uncluttered lower-left water. |
| `assets/dreamlike-story-title-card-3.webp` | `73d8a321ce8df9c83ff25cfaeb20d69cb6ffef698da843c7363116aacdfdfe3b` / 1,763,916 | Sleeping cat, rain-speckled skylight, lamp, and cushion: a third distinct restful setting. The exact two-line gold-serif title is clearly readable in the open right wall field. |

The gallery has three meaningfully varied subjects/settings and compositions, while consistently demonstrating low arousal, title-safe negative space, direct full-title rendering, and watercolor/gouache atmosphere. No visible malformed text, anatomy/object failure, watermark, logo, pasted title plate, or other artifact was observed. Ledger output hashes, bytes, dimensions, source-PNG receipt IDs/hashes, and receipt QA all link exactly. Rights basis is the recorded publisher-created, text-only original under `owner-approved-2026-08-23-thumbnail-regeneration`; no separate license token is claimed.

**Decision:** Pass; eligible to proceed through the remaining non-visual promotion gates.

### REJECT — `com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0`

**Inspected source:** `content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon`

| Preview file | SHA-256 / bytes | Visual evidence |
| --- | --- | --- |
| `assets/hand-drawn-hardship-cartoon.webp` | `07f8fc09f8f5f5e87f8d98a5463cf03d476dc5627d20e56efdaf496241c20b6a` / 80,798 | The image is a clean, sparse ink-and-flat-color crop of a mayfly/dragonfly head and wing, with a large unlabeled arrow. It shows ink treatment and wing detail, but the animal is cut off at the lower-left edge and lacks the complete body, limbs, and posture needed to demonstrate the manifest’s stated “one readable focal animal” with coherent anatomy. |

Decoded dimensions and output checksum agree with the provenance ledger. The recorded operation is an owner-authorized deterministic crop of a legacy project output (not an asserted third-party license), and no watermark, readable title, or malformed wing geometry was observed. However, the preview itself is materially too cropped to establish the product’s promised complete, expressive focal-animal composition. The standalone arrow has no visible explanatory target/label in the retained crop, reinforcing that this is an incomplete thumbnail fragment rather than a satisfactory Style preview.

**Decision:** Reject pending replacement or re-cropping with a complete, readable animal composition. Do not promote this leaf on the present preview evidence.

#### Corrective review — conditional PASS for the exact approved replacement

The current Style-path byte above remains rejected. The following exact corrective replacement was independently inspected and resolves the visual defect without a new generation:

| Replacement source and required Style-path byte | SHA-256 / bytes / decode | Visual and provenance evidence |
| --- | --- | --- |
| `thumbnail/animal-hardship-annotation/assets/animal-hardship-annotation-1.webp`, copied byte-for-byte to `style/hand-drawn-hardship-cartoon/assets/hand-drawn-hardship-cartoon.webp` | `75a392a4c5be8786dbdc468ee6f691a15e5cf027aa98988b27d075cb043d3c59` / 2,181,090 / 1672×941 WebP, lossless, no alpha/animation, clean decode | Complete anatomically coherent sea turtle with readable eye, flippers, posture, and species detail; uneven black ink, muted sea-green/cream/faded-gold palette, sparse paper-like space, and a single integrated hand-drawn arrow and annotation. The in-image title and annotation are clean, legible, single-instance, and free of watermark/logo or malformed content. |

The source byte is already committed and ledgered in `PREVIEW-PROVENANCE.md` as `thumbnail/animal-hardship-annotation/assets/animal-hardship-annotation-1.webp`. Its existing receipt link is `.superpowers/sdd/2026-08-23-legacy-thumbnail-restoration/generated-original-previews/nature-prehistoric/receipt.json#animal-hardship-annotation-1.png`; source PNG SHA-256 is `e7053b3cd0df7a7aebf1419de7a651b90854242ea4583721e78273ea946b18bd`; the recorded operation is an untouched full-image lossless WebP conversion. The recorded rights basis is publisher-created tool-generated original under the recorded workspace-owner authorization. No separate license token is claimed.

**Conditional decision:** Pass only after Task 2 verifies that the copied Style-path byte has the exact SHA-256 and decoded dimensions above, and that the updated Style provenance row retains this exact receipt/source-hash/rights linkage after the Recipe source is withdrawn. No new generation is required for this correction.

### PASS — `com.storystudio.pack.style.dreamlike-luminous-sleep-illustration@1.0.0`

**Inspected source:** `content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration`

| Preview file | SHA-256 / bytes | Visual evidence |
| --- | --- | --- |
| `assets/dreamlike-luminous-sleep-illustration.webp` | `106dc93ef71201fcc13e8253435cde344494cb3dc70eafaa0ba2df830231c8a7` / 286,138 | A quiet blue night town with floating candle-gold lanterns over reflective water. The watercolor/gouache washes, diffuse blue shadow, warm glow, feathered/paper-like texture, and calm story-world are visually distinct and match the style bible. The many lanterns remain coherent; no malformed object, watermark, or title artifact was observed. |

Title readability/safe area is not a Style-preview requirement and the preview contains no title. Decoded dimensions and output checksum agree with the provenance ledger. The ledger records a text-free, owner-supplied legacy project output, deterministically center-cover resized and WebP-encoded under the workspace owner’s restoration authorization; no license beyond that recorded authorization is claimed.

**Decision:** Pass; eligible to proceed through the remaining non-visual promotion gates.

## Promotion recommendation

All four leaves may proceed to promotion only after their independent schema, registry-receipt, deterministic-build, and remaining required gates are satisfied, and Task 2 completes the specific corrective verification below:

1. `com.storystudio.pack.thumbnail.prehistoric-survival-title-card@1.0.0`
2. `com.storystudio.pack.thumbnail.dreamlike-story-title-card@1.0.0`
3. `com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0`
4. `com.storystudio.pack.style.dreamlike-luminous-sleep-illustration@1.0.0`

For `com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0`, Task 2 must verify the copied byte at `style/hand-drawn-hardship-cartoon/assets/hand-drawn-hardship-cartoon.webp` is exactly SHA-256 `75a392a4c5be8786dbdc468ee6f691a15e5cf027aa98988b27d075cb043d3c59`, decodes at 1672×941, and is represented by an updated Style provenance row that preserves the exact generation receipt, source PNG hash, conversion description, and recorded owner-authorized rights basis. The existing rejected byte must not be treated as passed. This review does not decide or imply any license beyond the owner-authorized rights bases recorded in `PREVIEW-PROVENANCE.md`.
