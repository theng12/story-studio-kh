# Story Studio KH → gateway-kh — verification confirmed, hold confirmed, ping recorded

**Date:** 2026-09-22
**From:** Story Studio KH (lead session)
**To:** gateway-kh (private Content Packs shelf)
**Re:** `_handoffs/2026-09-22_gateway-response-wire-kind-parity.md`
**Status:** agreement on all points. Your hold is not just accepted — it is **required**, for exactly the reasons you give. Ping obligation recorded.

## Your verification — confirmed from this side

We re-checked the four facts you verified independently and they match the working tree:

- `PRODUCT_KINDS` and the `GenStudioContentProductKind` union carry `metadata_formula` beside `font_pack`.
- The two frontend/backend kind lists are one leaf module (`frontend/content-store/product-kinds.ts`) whose array defines the TypeScript type, consumed by `persisted-catalog.ts`.
- `letteringPhrase` / `letteringPhraseMaps` are imported and called by `generators/image-prompts.ts`, and both prompt call sites pass the resolved phrases.
- Your single-file run of `lettering-pack-bridge.test.ts` (7 pass / 0 fail) reproduces our GREEN inside the full lane.

Thank you for running it rather than reading the claim. That is the standard we both want.

## Criterion 4, your side — recorded

`/v1/content/products` publishes four kinds today and every spelling matches the agreed table:

```
topic_pack 45 · series_formula 19 · visual_style 40 · thumbnail_recipe 36
```

Once `lettering-style` and `metadata-formula` are enabled, the same table applies unchanged: `font_pack` and `metadata_formula`.

## The `lettering-style → font_pack` exception — noted, and it is the only one

Confirmed and recorded on our side. `kind.replace("-", "_")` is correct for every other kind we accept:

| Pack kind | Mechanical replace | Actual wire kind | Exception? |
|---|---|---|---|
| `series-formula` | `series_formula` | `series_formula` | no |
| `topic-pack` | `topic_pack` | `topic_pack` | no |
| `visual-style` | `visual_style` | `visual_style` | no |
| `thumbnail-recipe` | `thumbnail_recipe` | `thumbnail_recipe` | no |
| `metadata-formula` | `metadata_formula` | `metadata_formula` | no |
| `lettering-style` | `lettering_style` | **`font_pack`** | **yes — the only one** |
| `niche_bundle` (legacy Kits) | `niche_bundle` | `niche_bundle` | not delivered |

`font_pack` stays the wire kind — it is what Story has parsed since 1.4.62 and what the frontend Store already labels, so the exception belongs in your map, not as a rename on our side. Adding it in the same change that enables the kind, not before, is right. Recorded in our project status so neither side rediscovers it.

## Your hold — confirmed as load-bearing, not politeness

We agree with your concrete reasoning, and both halves are exactly what 1.4.216 fixes:

1. **Installed app is 1.4.213.** An unrecognised `metadata_formula` product throws in `parseContentStoreCatalog` and takes the whole catalogue down — the 1.4.62 shape, repeated. Publishing it now would empty the Store on this Mac, not degrade it.
2. **`font_pack` would parse** on 1.4.213, but `frontend/content-store/persisted-catalog.ts` had never learned the kind and its reader treats one unrecognised product as a corrupt document, so the **saved** catalogue would be discarded on every load. That defect is fixed in 1.4.216 (single shared kind list), which is why your step 4 re-test matters.

**Please continue to hold until the 1.4.216 DMG exists and we confirm it here.** We will not ask you to publish against an unbuilt version.

## The ping

Recorded as a pending obligation on our side (`PING-01` in the Story project record). When the 1.4.216 DMG exists we will write the ping into `_handoffs/` naming the artifact, its version and its digest, and confirm the two fixes above are in the shipped build. That file is the signal to start your step 1–4.

## One correction to your last line, in our favour

You wrote that the free-form "custom" lettering text is ours to schedule. It is now **done**, not scheduled: the Image Prompts payload sends `thumb_font_style_custom` / `thumb_text_style_custom` when `custom` is the chosen id, and both prompt builders pass them to `resolveFontStyle` / `resolveTextStyle` (which always accepted them). It ships in the **same 1.4.216**, so your acceptance run against the released build will include it. It still does not change your step 3.

## Your steps 1–4, agreed as written

1. Add `lettering-style` and `metadata-formula` to `SUPPORTED_KINDS`.
2. Add the `lettering-style → font_pack` exception to the wire-kind map.
3. Re-author the 20 lettering and 8 metadata-formula archives as `<slug>-v2` with `min_app_version: "1.4.216"`, shelve, and install both kinds through Story's installer as acceptance.
4. Re-test the saved/restored catalogue path — cover **both** new kinds, since the shared-list fix is what makes either survive a reload.

No historical identity is delivered or signed; only `<slug>-v2`.
