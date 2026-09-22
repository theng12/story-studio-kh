# Wire-kind parity: `lettering-style` (fonts) and `metadata-formula`

**Date:** 2026-09-22
**From:** gateway-kh (private Content Packs shelf)
**To:** Story Studio KH
**Status:** request for a Story-side decision and, for fonts, a small bridge
**Related:** `_handoffs/2026-09-07_historical-wars-1.0.2-and-archival-ledger-delivery.md`

## Why this exists

The Gateway's private shelf can re-home the owner's historical Content Pack
library under new identities, but it refuses to publish any pack whose kind
Story's **wire contract** does not already accept. Four kinds work today
(`series-formula`, `topic-pack`, `visual-style`, `thumbnail-recipe`); 63 packs of
those kinds are re-authored and shelved. Two further kinds cannot be delivered:

| Pack kind | Preserved archives waiting | Story pack schema | Story wire contract |
|---|---|---|---|
| `lettering-style` (fonts) | **20** | ✅ supported | ⚠️ has `font_pack`, **no bridge** |
| `metadata-formula` | **8** | ✅ supported | ❌ absent |
| `subtitle-style`, `scene-effect`, `overlay` | 0 in this library | ✅ listed in schemas | ❌ absent |
| Channel Kit (`niche_bundle`) | 11 | legacy, read-only | ✅ present, **not wanted** |

The Gateway's allow-list is `gateway/content_delivery.py` `SUPPORTED_KINDS`
(lines 21–26). It is deliberately the narrower side: it may only publish what
Story can parse.

## The hazard that sets the ordering

`electron/server/lib/genstudio-content-store.ts:45-53` records it in your own
words: the `PRODUCT_KINDS` set **is** the wire contract, and *"one unknown kind
kills the whole parse"* — the 1.4.62 `font_pack` incident took all 82 products
down because the frontend learned the kind and this set did not.

Therefore: **Story must accept a wire kind before the Gateway ever publishes a
pack of that kind.** Publishing first is not a degraded catalogue; it is no
catalogue. We will not publish a new kind until the accepting Story release is
named here.

## Ask 1 — fonts (`lettering-style` ↔ `font_pack`): a small bridge, high value

Story already has almost everything for fonts:

- the wire kind `font_pack` (`genstudio-content-store.ts:56-62`, `:52`);
- the frontend representation (4 files learned it in 1.4.62:
  `frontend/content-store/library-organisation.ts`,
  `catalog-presentation.ts`, `composables/useContentStore.ts`,
  `components/content-store/ContentStoreFilters.vue`);
- archive preview handling, `case 'lettering-style':` in
  `electron/server/content-packs/archive.ts:325`;
- a runtime catalogue, `letteringCatalogue()` in
  `electron/server/services/lettering-catalogue.ts:80`, which already reads
  `lettering-style` catalog entries beside built-ins.

What is missing: **`font_pack` appears nowhere in `electron/server` outside that
union and its parse set.** Nothing maps a delivered `font_pack` product to a
`lettering-style` archive, and nothing installs or activates one. So the pack
kind and the wire kind have no bridge in either direction.

Please either:

1. confirm `font_pack` is the wire kind for `lettering-style`, implement the
   delivery → install → `letteringCatalogue()` path, and name the released
   minimum version; or
2. tell us the wire kind you want instead, and we will emit that.

Gateway side, on your confirmation: add `lettering-style` to `SUPPORTED_KINDS`
and map it to the agreed wire kind.

## Ask 2 — `metadata-formula`: a wire kind decision

Story's pack layer supports `metadata-formula`
(`content-packs/schemas.ts`, `project-pins.ts`,
`__tests__/metadata-formula-catalogue.test.ts`), but the wire contract has no
such kind, so a delivered metadata-formula product cannot be parsed at all.

Please decide whether Story will sell it, and if so add the wire kind (we
propose `metadata_formula`), the frontend representation, the runtime consumer,
and the install path — then name the released minimum version. If the answer is
"not a Store product", say so plainly and we will leave its 8 archives
preserved and undelivered rather than push a kind that cannot land.

## Ask 3 — `subtitle-style`, `scene-effect`, `overlay` (no action needed yet)

These are in the pack schemas but not in the wire contract, and this library has
none of them. We are not asking for them now — only confirming that the same
rule holds: a wire kind must exist before Gateway publishes one.

## What Gateway commits to (our side, unchanged either way)

- Never reissue, re-sign or renumber a historical Store identity. Every
  re-homed pack is a **new** identity (`<slug>-v2`, new family and SKU), which is
  why the shelf can serve it at all.
- Keep `SUPPORTED_KINDS` authoritative and add a kind only after Story's wire
  contract accepts it.
- Map pack kind → wire kind explicitly, in one place, and publish the mapping.
- Leave the 11 legacy Channel Kits preserved and undelivered; the authoring
  skills forbid new Kits, and `niche_bundle` exists only for historical reads.

## Acceptance criteria (joint)

1. A catalogue containing a `font_pack` product parses without throwing, lists
   in the Store UI, installs, and the installed style appears in
   `letteringCatalogue()`.
2. The same for a `metadata-formula` product once its wire kind exists.
3. No historical identity is delivered or signed; only `<slug>-v2`.
4. Gateway's `/v1/content/products` and Story's parse agree on the kind
   spelling for every published pack.

## Evidence

- 272 historical archives → 266 distinct bytes → 180 packs; 141 deliverable
  today, 39 blocked (20 `lettering-style`, 8 `metadata-formula`, 11 Kits).
- Shelf state: 66 release rows / 64 current products, all four accepted kinds.
  Both a re-authored `series-formula` and `topic-pack` were installed through
  Story's own installer (`activated: true`).
- Inventory and the old→new identity map:
  `gateway-kh/store-analysis/INVENTORY.md`,
  `gateway-kh/store-analysis/reauthor/mapping.json`.
- Reference for the failure mode this ordering avoids:
  `genstudio-content-store.ts:45-53`.
