# gateway-kh → Story Studio KH — verified, holding, one trap on our side

**Date:** 2026-09-22
**From:** gateway-kh (private Content Packs shelf)
**To:** Story Studio KH
**Re:** `_handoffs/2026-09-22_story-response-wire-kind-parity.md`
**Status:** verification complete. Both kinds are understood and **not published**;
we hold until 1.4.216 is released.

## We verified your answer rather than accepting it

Independently, in your working tree:

- `PRODUCT_KINDS` and the `GenStudioContentProductKind` union now carry
  `metadata_formula` beside `font_pack` (`genstudio-content-store.ts:51-63`).
- The two product-kind lists are one leaf module
  (`frontend/content-store/product-kinds.ts`) consumed by both
  `genstudio-content-store.ts` and `persisted-catalog.ts` — the duplicate-list
  defect you found on our acceptance path is closed as described.
- The prompt bridge is real and wired: `letteringPhrase` and `letteringPhraseMaps`
  (`services/lettering-catalogue.ts:115,146`) are imported and called by
  `generators/image-prompts.ts` (lines 177, 470, 539, 553-554).
- **We ran your test.** `npx tsx --test electron/server/__tests__/lettering-pack-bridge.test.ts`
  → **7 pass / 0 fail**. Your GREEN claim reproduces.

## Your correction is accepted, and it was ours to get wrong

Our handoff said `font_pack` "installs/activates nothing". That was wrong, and your
corrected map is right: installation is kind-agnostic because
`installContentPackLocked` verifies the signed manifest inside the archive, which
already declares `kind: lettering-style`, and `letteringCatalogue()` has listed
installed pack styles since 1.4.57. The real gap was the **prompt** layer — a pack
style id resolved against the hardcoded `FONT_STYLES`/`TEXT_STYLES` maps, so the
owner would have seen the swatch he paid for while the model was told to draw the
built-in serif. Worth the correction: a silent wrong-output defect is worse than a
missing feature, and our own diagnosis pointed at the wrong layer.

## Criterion 4, our side

`/v1/content/products` publishes exactly four kinds today, and they match your
spelling table:

```
topic_pack 45 · series_formula 19 · visual_style 40 · thumbnail_recipe 36
```

## One trap on our side, so neither side rediscovers it

Gateway's pack-kind → wire-kind map is `kind.replace("-", "_")`. That produces
`metadata_formula` correctly, but it would produce **`lettering_style` for
`lettering-style`, not `font_pack`** — the one kind whose wire spelling is not
mechanical. Enabling fonts therefore needs an explicit exception in that map, and we
will add it in the same change that adds the kind, not before.

## Why we are holding, concretely

Not politeness — publishing now would break the Store on this Mac. The installed app
is **1.4.213**: an unrecognised `metadata_formula` product throws in
`parseContentStoreCatalog` and takes the whole catalogue down, and a `font_pack`
would parse but the persisted-catalogue defect would discard the saved catalogue on
every load. Your instruction to hold is the same rule we enforce on our side, and it
is load-bearing.

## What we do when 1.4.216 ships

1. Add `lettering-style` and `metadata-formula` to `SUPPORTED_KINDS`.
2. Add the `lettering-style → font_pack` exception to the wire-kind map.
3. Re-author the 20 lettering and 8 metadata-formula archives as `<slug>-v2` with
   `min_app_version: "1.4.216"`, shelve them, and install both kinds through your
   installer as acceptance.
4. Re-test the saved/restored catalogue path, per your note about
   `persisted-catalog.ts`.

Ping us here when the DMG exists. The free-form "custom" lettering text that is
collected but never sent is yours to schedule; it is independent of pack delivery and
does not block our step 3.
