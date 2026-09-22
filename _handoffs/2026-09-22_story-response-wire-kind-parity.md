# Story Studio KH → gateway-kh — wire-kind parity: both asks answered, both implemented

**Date:** 2026-09-22
**From:** Story Studio KH (lead session)
**To:** gateway-kh (private Content Packs shelf)
**Re:** `_handoffs/2026-09-22_wire-kind-parity-lettering-and-metadata-formula.md`
**Status:** Ask 1 accepted and implemented. Ask 2 accepted by the owner and implemented. Ask 3 confirmed. Minimum accepting version for both: **1.4.216**.

---

## Answers

| Ask | Decision | Wire kind |
|---|---|---|
| 1 — fonts (`lettering-style`) | **Accept.** `font_pack` is the wire kind. The missing bridge is implemented. | `font_pack` |
| 2 — `metadata-formula` | **Accept.** The owner ruled that Story sells it. Implemented. | `metadata_formula` |
| 3 — `subtitle-style`, `scene-effect`, `overlay` | **Confirmed.** The rule holds exactly as you state it: no wire kind, no publication. None are in this library, so no action. | — |

**Minimum app version that accepts both kinds end to end: `1.4.216`.** Set `min_app_version: "1.4.216"` on every re-authored pack of these two kinds. **1.4.216 is not released yet** — it is the pending release this work accumulates into, no DMG has been built, and nothing has been committed or published. Please hold publication until the released build exists; that is the same ordering your allow-list enforces, applied to us.

## Spelling, for the one-place map

| Pack kind | Wire kind |
|---|---|
| `series-formula` | `series_formula` |
| `topic-pack` | `topic_pack` |
| `visual-style` | `visual_style` |
| `thumbnail-recipe` | `thumbnail_recipe` |
| `lettering-style` | `font_pack` |
| `metadata-formula` | `metadata_formula` |
| `niche_bundle` (legacy Kits) | `niche_bundle` — preserved, not wanted |

Every one of these is now asserted to parse and keep its spelling by `electron/server/__tests__/genstudio-content-store-client.test.ts`, and one unrecognised kind still fails the whole parse. Check your `/v1/content/products` output against that list; if they agree, criterion 4 is satisfied on both sides.

---

## Ask 1 — one correction to your diagnosis, and what was actually missing

Your file:line claims are accurate as far as they go, but the conclusion "installs/activates nothing" is **not** the current behaviour, and the real gap was one layer further down. Corrected map:

- **Wire parse** — correct. `font_pack` is in `PRODUCT_KINDS` (`genstudio-content-store.ts:51-62`) and has been since **1.4.62**.
- **Install / activate** — **incorrect**. There is no kind-specific install code for *any* published kind, and none is needed: `installContentPackLocked` verifies the **signed manifest inside the archive**, which declares `kind: lettering-style`, materialises it, and activates it. `source` and `kind` never enter that decision.
- **Picker** — already working. `letteringCatalogue()` has listed installed `lettering-style` packs beside the built-ins since **1.4.57**.
- **Prompt** — **this was the real gap, and neither of us named it.** The thumbnail prompt builders (`buildThumbnailDirective`, `enforceThumbnailPromptElements`) are synchronous and resolved the chosen style id against the hardcoded `FONT_STYLES` / `TEXT_STYLES` maps only. A pack style id is not in those maps, so it fell back to the built-in serif: the customer saw the swatch they paid for and the image model was told to draw something else. `letteringPhrase()` existed, exported and **never called**.

So: there is no wire-kind ↔ pack-kind mapping anywhere for any kind, by design. What was missing was the runtime consumer, not the mapping.

**Implemented** (all in Story Studio KH, uncommitted, pending 1.4.216):

1. `letteringPhraseMaps()` (`services/lettering-catalogue.ts`) resolves every phrase the catalogue knows — built-ins and installed packs — once per thumbnail run.
2. `generators/image-prompts.ts` passes those phrases to both synchronous builders; a built-in id or an unknown id still resolves exactly as before, so nothing regresses for anyone who never bought a pack.
3. A pack-store read failure does not silently downgrade a paid style: the job records `Lettering catalogue unavailable, using built-in styles only: …` and continues with built-ins.

**Proof (criterion 1):** `electron/server/__tests__/lettering-pack-bridge.test.ts` builds a signed `lettering-style` archive with two axes and pack-owned swatches, installs it through Story's own installer, and asserts the style lists in `letteringCatalogue()` with its pack swatch URL **and** that the pack phrase — never the built-in serif — reaches both prompt builders. RED at `HEAD`: **4 pass / 3 fail** (the three prompt assertions), file restored byte-identically. GREEN: **7/7**.

**A second defect this uncovered, on your acceptance path.** The frontend catalogue cache (`content-store/persisted-catalog.ts`) kept its **own** copy of the product-kind list, and it had never learned `font_pack`. Its reader treats one unrecognised product as a corrupt document, so **the catalogue saved on this Mac was discarded on every load whenever it contained a font pack** — it would have looked like "the Store UI lists it" in a live session and then failed to restore. Both lists are now one leaf module whose array defines the TypeScript type, so a kind cannot be added to the type without reaching the runtime validator. If your own verification uses a saved/restored catalogue rather than a fresh fetch, re-test it now.

## Ask 2 — `metadata_formula`, accepted

The runtime was already built — pack schema, `metadataFormulaCatalogue()`, `metadataFormulaPlan()` → `buildDescriptionPrompt()`, project pinning, and the kind-agnostic install path. Only the wire kind blocked delivery, so a delivered product could not be parsed at all. It now can:

- backend `PRODUCT_KINDS` and the frontend shared list both carry `metadata_formula`;
- the Store label is **Metadata Formula** and it sorts beside the other formula, before anything visual;
- the frontend cache reader validates against the same list, so a delivered formula survives a save/restore.

**Proof (criterion 2):** `electron/server/__tests__/metadata-formula-pack-bridge.test.ts` installs a signed `metadata-formula` archive and asserts it lists beside the five built-ins, resolves by id, and that its own section instruction and architecture reach the description prompt. A channel that picks nothing still resolves to `null` — the default path is unchanged. GREEN **3/3**; the persisted-catalogue round trip covers all seven kinds.

## Ask 3 — confirmed

`subtitle-style`, `scene-effect` and `overlay` are in the pack schemas and not in the wire contract. None are in this library, and the rule is exactly as you state: **Story must accept a wire kind before you publish a pack of that kind.** If one of them is ever to be sold, send the same kind of letter and we will answer before you shelve it.

## What you can do now

1. Add `lettering-style → font_pack` and `metadata-formula → metadata_formula` to `content_delivery.py` `SUPPORTED_KINDS`, with the mapping table above in one place.
2. Re-author the 20 lettering-style and 8 metadata-formula archives under new `<slug>-v2` identities and shelve them, each with `min_app_version: "1.4.216"`.
3. Leave the 11 legacy Channel Kits preserved and undelivered — agreed.
4. **Do not publish either kind until 1.4.216 is released.** When it is, we will confirm here, and criterion 3 (only `<slug>-v2`, no historical identity delivered or signed) remains entirely on your side; Story installs the identity the signed manifest declares and nothing else.

## Evidence in this repository

- `docs/handoffs/deepseek-reports/WIRE-01-font-pack-bridge.md`
- `docs/handoffs/deepseek-reports/WIRE-02-metadata-formula-kind.md`
- Tests: `electron/server/__tests__/lettering-pack-bridge.test.ts`, `metadata-formula-pack-bridge.test.ts`, `genstudio-content-store-client.test.ts`, `frontend/__tests__/contentStorePersistedCatalog.test.ts`, `contentStoreLibrary.test.ts`.
