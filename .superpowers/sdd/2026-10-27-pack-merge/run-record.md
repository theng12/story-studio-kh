# Content Pack Merge Record (2026-10-27)

## Context & Owner Mandate
- **Owner decision 2026-10-27**: Duplicate Studio Library packs are merged into one, keeping one: *"make sure it's an informed merge so it's more detail not less."*
- **App-version floor decision**: The owner directed: *"raise the limit rather than drop content or split the pack. The owner says app-version floors are not a concern, since every running app is current."*
- **Application release**: Ships in Story 1.4.362 on branch `fix/topic-pack-caps-20261027`.
- **Ceiling raise**: `TopicPackDocumentSchema` array ceilings raised from 2,000 to 4,000 in `electron/server/content-packs/schemas.ts` (`episode_objects`, `time_place_scopes`, `mechanisms`, `evidence_lenses`).

---

## 1. Topic Pack: Wars, Treaties & World Order v1.0.1 (Full Union)

### Target Identities
- **Kept Pack ID**: `com.storystudio.pack.topic.wars-treaties-world-order-v2` (v1.0.0 archive `91b33314bdec...`)
- **Kept Item ID**: `com.storystudio.topic.wars-treaties-world-order-v2`
- **Folded-in Pack ID**: `com.storystudio.pack.topic.historical-wars-treaties-world-order-v2` (v1.0.0 archive `747e64a9531f...`)
- **Folded-in Item ID**: `com.storystudio.topic.archival-ledger.wars-treaties-world-order-v2`

### Published Release (v1.0.1)
- **Pack ID**: `com.storystudio.pack.topic.wars-treaties-world-order-v2`
- **Version**: `1.0.1`
- **Min App Version**: `1.4.362` (first app release supporting the raised 4,000 array ceiling)
- **Delivery Profile**: `genstudio-store-receipt-v1`
- **Artifact Path**: `dist/topic-wars-treaties-world-order-v2-1.0.1.sspack`
- **SHA-256**: `fb071ab2be22418dfea731f0340f081b3996774bfa7e79c00b68a456bda6e8ba`
- **Archive Size**: 498,704 bytes
- **Content Document Size**: 1,855,929 bytes (~1,812.4 KiB, 1.77 MiB; well within 4 MiB limit)

### Field-by-Field Before & After
| Field | Kept Pack (v1.0.0) | Folded-in Pack (v1.0.0) | Merged Pack (v1.0.1) | Ceiling | Notes |
|---|---|---|---|---|---|
| `compatible_formula_ids` | 1 (`archival-ledger-v2`) | 1 (`history-explained-v2`) | 2 | 200 | Deduplicated union |
| `exclusions` | 3 | 4 | 7 | 1,000 | Deduplicated union |
| `tags` | 5 | 5 | 5 | 80 | Identical in both |
| `subjects` | 100 | 50 (28 overlap, 22 new) | 122 | 1,000 | All 22 new subjects added |
| `coverage_profiles` | 100 | 50 (28 duplicate subjects) | 122 | 1,000 | Exactly 1 profile per subject (100 kept + 22 new) |
| `episode_objects` | 2,000 | 1,000 (1 overlap, 999 new) | 2,999 | 4,000 | Union of all distinct objects |
| `time_place_scopes` | 2,000 | 1,000 (0 overlap, 1,000 new) | 3,000 | 4,000 | Union of all distinct scopes |
| `mechanisms` | 2,000 | 1,000 (0 overlap, 1,000 new) | 3,000 | 4,000 | Union of all distinct mechanisms |
| `evidence_lenses` | 2,000 | 1,000 (0 overlap, 1,000 new) | 3,000 | 4,000 | Union of all distinct lenses |

### Audit Claim Verification & Corrections
1. **Audit Claim: "adds 50 coverage profiles" — FALSE**:
   28 of the 50 coverage profiles in the folded-in pack belong to subjects already present in the kept pack (e.g. Peloponnesian War, Punic Wars, Crusades, Thirty Years War). The schema strictly forbids multiple profiles per subject. The true addition is 22 coverage profiles for the 22 new subjects, yielding 122 total profiles.
2. **Audit Claim: "adds items under episode_objects, scopes, mechanisms, lenses"**:
   Correct in count (999 objects, 1000 scopes, 1000 mechanisms, 1000 lenses), but would have failed the prior schema cap (2,000). Raising the ceiling to 4,000 admitted all 2,999 objects and 3,000 scopes/mechanisms/lenses without content loss.

---

## 2. Visual Style: Academic Classical Oil v1.0.1

### Target Identities
- **Kept Pack ID**: `com.storystudio.pack.style.academic-classical-oil-v2` (v1.0.0 archive `014cf1f9df9b...`)
- **Kept Item ID**: `com.storystudio.style.academic-classical-oil-v2`
- **Folded-in Pack ID**: `com.storystudio.pack.style.oil-painting-classical-v2` (v1.0.0 archive `b08c693f...`)
- **Folded-in Item ID**: `com.storystudio.style.oil-painting-classical-v2`

### Published Release (v1.0.1)
- **Version**: `1.0.1`
- **Min App Version**: `1.0.843`
- **Delivery Profile**: `genstudio-store-receipt-v1`
- **Artifact Path**: `dist/style-academic-classical-oil-v2-1.0.1.sspack`
- **SHA-256**: `92515d80570a460d270aad9a0276191f36615281f9db0fbcff0ed5b2f86d678c`
- **Archive Size**: 840,611 bytes

### Field-by-Field Before & After
| Field | Before (Kept / Folded) | After (Merged v1.0.1) | Notes |
|---|---|---|---|
| `tags` | 10 / 5 | 15 | Deduplicated union, kept order preserved |
| `compatible_formula_ids` | 3 / 1 | 4 | Union: sleep-history-compilation-v2, sleep-story-v2, history-explained-v2, human-behavior-explained-v2 |
| `preview_assets` | 3 / 3 | 3 | Exactly the kept pack's 3 Qwen previews in contract order: hero, scene, face |
| `style_bible` | 2,467 chars / 264 chars | 2,752 chars | Enriched Medium/surface and Texture with concrete painting descriptors (`impasto`, `visible impasto brushwork`, `rich layered glazes`, `canvas texture`, `painterly edges`, `museum varnish tone`). Lighting preserved as soft late-day Mediterranean sunlight; theatrical spotlight, cold light, night, and dramatic chiaroscuro explicitly forbidden. Low-stimulation contract preserved. |
| `negative_prompt` | 48 tokens / 10 tokens | 56 tokens | Union: kept 48 tokens + `pixel art`, `neon colours`, `3D CGI render`, `hard digital edges`, `lowres`, `modern clip-art`, `text`, `watermark`. |

---

## 3. Deliberately Excluded Merges
- **Red lettering packs**: Glow Serif and Grunge remain separate products with distinct aesthetics.
- **Topic packs with 1–2 overlapping subjects**: Preserved as distinct domains.
