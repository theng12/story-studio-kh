# WIRE-01 — `font_pack` / `lettering-style` bridge (Gateway ask 1)

## Run identity and scope
- Date / session: 2026-09-22; owner-operated DeepSeek lead session. One writer, no spawned agents.
- Branch `codex/stabilization-takeover`; base `6f3c4e33`; no commits.
- Source: `_handoffs/2026-09-22_wire-kind-parity-lettering-and-metadata-formula.md` (gateway-kh request).
- Answer: **`font_pack` is the wire kind for `lettering-style`. Confirmed, and the missing bridge is implemented.** Minimum app version that accepts the kind end to end: **1.4.216** (pending release at the time of writing).
- Changed production:
  - `electron/server/services/lettering-catalogue.ts` — new `letteringPhraseMaps()`.
  - `electron/server/generators/image-prompts.ts` — resolves installed-pack phrases once per thumbnail run and hands them to the two synchronous prompt builders.
  - `frontend/content-store/product-kinds.ts` (new), `frontend/composables/useContentStore.ts`, `frontend/content-store/persisted-catalog.ts` — one runtime kind list for the wire kinds (see "Second defect found").
  - `frontend/composables/useContentStore.ts` also gained `metadata_formula` for WIRE-02.
- Changed tests:
  - `electron/server/__tests__/lettering-pack-bridge.test.ts` (new, 7 cases).
  - `electron/server/__tests__/genstudio-content-store-client.test.ts` (wire-kind coverage for all seven kinds + unknown-kind guard).
  - `frontend/__tests__/contentStorePersistedCatalog.test.ts`, `frontend/__tests__/contentStoreLibrary.test.ts`.

## Correction to the letter's diagnosis
The letter said "`font_pack` appears nowhere in `electron/server` outside that union and its parse set … nothing installs or activates one." Checked against current source, that is **not** the state of the chain, and the difference matters because it changes what the Gateway has to test:

| Layer | Letter's claim | Actual source |
|---|---|---|
| Wire parse | `font_pack` in the union/parse set | true — `PRODUCT_KINDS`, since **1.4.62** |
| Install / activate | "installs/activates nothing" | **false** — installation is archive-manifest driven and kind-agnostic (`installContentPackLocked`); a `lettering-style` archive installs and activates with no kind-specific code |
| Picker | (implied missing) | already working — `letteringCatalogue()` lists installed `lettering-style` packs since **1.4.57** |
| Prompt | not mentioned | **this was the real gap** — the thumbnail prompt builders resolved the chosen style id against the hardcoded `FONT_STYLES` / `TEXT_STYLES` maps only, so a pack style silently became the built-in serif |

So there is no wire-kind↔pack-kind map for *any* kind, and none is needed: the wire kind is a catalogue/Merch label and the signed manifest inside the archive names the pack kind. What was missing was the **runtime consumer**: `letteringPhrase()` existed, exported and unused, and the prompt path never called it.

## Reproduction and proof
- **RED.** `image-prompts.ts` restored from `HEAD` and the new bridge test run: **tests 7, pass 4, fail 3, exit 1** — precisely the three prompt assertions (directive, enforcement clause, recipe-default/auto path). The four catalogue/install/built-in cases pass at `HEAD`, which is what proves the picker chain already worked and isolates the defect to prompt resolution. `image-prompts.ts` restored byte-identically afterwards: sha256 `30070b817260d82cb303a3ddb59166b54d2593953f22afd82b0fcde400d4a41d` before and after.
- **GREEN.** Same file: exit **0**, 7/7.
- Behaviour proven by the test, end to end: a signed `lettering-style` archive (two axes, pack-owned swatches) is installed through Story's own installer → `letteringCatalogue()` lists both styles with `source: 'pack'`, the pack id and the pack swatch URL → `letteringPhraseMaps()` carries both phrases → `buildThumbnailDirective()` and `enforceThumbnailPromptElements()` emit the pack phrase and never the built-in serif.
- A read failure of the pack catalogue does not silently downgrade a paid style: the job records `Lettering catalogue unavailable, using built-in styles only: …` and built-in resolution still applies.
- Affected regression (22 files: all `lettering*`, `thumbnail*`, `image-*`, `prompt-char-cap`, `production-looks-signed-styles`, `route-registration-scope`, `character-prompt-blocks`, `completion-contract`, `explicit-chat-regeneration`, `genstudio-default-model*`, `output-contract-declarations`, `batch-contract-partial-tolerance`): exit **0**; tests 219, pass 219, fail 0.
- Wire contract: every kind (`series_formula`, `topic_pack`, `visual_style`, `thumbnail_recipe`, `font_pack`, `metadata_formula`, `niche_bundle`) parses and keeps its spelling; an unknown kind still fails the whole parse, which is the hazard the Gateway is right to respect.

## Second defect found while proving this (same class)
`frontend/content-store/persisted-catalog.ts` kept its **own** copy of the product-kind list and it had fallen behind the wire contract — it never learned `font_pack`. Its reader treats one unrecognised product as a corrupt document (`parsePersistedCatalog` returns `null`), so **the catalogue saved on this Mac was discarded on every load once a font pack was in it**. The two lists are now one leaf module (`frontend/content-store/product-kinds.ts`) whose array *defines* the type, so a kind cannot reach the type without reaching the runtime validator.
- RED: `persisted-catalog.ts` restored from `HEAD`, new round-trip case run → 16 pass / 1 fail, exit 1; file restored byte-identically (sha256 `5fc32713…`).
- GREEN: 31/31 across `contentStorePersistedCatalog` + `contentStoreLibrary`.

## Handoff
- **Full gates on the finished tree (1.4.216, uncommitted):**
  - Full backend `npm run test:backend` (`PATH="$PWD/bundled/ffmpeg:$PATH"`): exit **1** — **5,610 tests, 5,605 pass, 4 fail, 1 skip**, `513/513 file(s)`, 6,312 marks. **None of the 4 failures is in a file this work touched.** One is the already-recorded `NEW-08` ENOENT on the private Topic Pack source. The other three (`deep-time-cross-pack-overlap.test.ts`, `formula-substance-not-rebilled.test.ts` ×2) are caused by the **external** Content Pack re-authoring effort: `content-packs/rebuilt/` (untracked, created 01:24–02:09 today, while this session was running) now contains `<slug>-v2` re-authored packs, and the repo's cross-pack overlap guards correctly see e.g. `ancient-oceans-deep-sea` and `ancient-oceans-deep-sea-v2` writing the same subjects twice. All ten new tests passed inside that gate run.
  - Full frontend `npm run test:frontend`: exit **0** — **1,915 tests, 1,915 pass, 0 fail**, 203 suites, `213/213 file(s)`, 2,118 marks.
  - `npm run build`: exit **0** (changelog, typography, security, model-drift, release contract, frontend generate, electron compile, built security, built release).
  - `npm run lint`: exit **0**, 0 errors, 1,925 warnings (non-fatal baseline).
  - `npm run check:changelog`: exit **0**; `git diff --check`: exit **0**.
  - Frontend typecheck: exit **2**, the unchanged 11 pre-existing `NEW-04` `TS2558` errors, none in a changed file.
- Remaining gaps found, **not** fixed here (recorded so the Gateway's test plan is accurate):
  - The **free-form "custom" lettering option** is not plumbed: the Image Prompts page collects `thumb_font_style_custom` / `thumb_text_style_custom`, but the submit payload sends only the `custom` id and the backend never receives the text, so it falls back to the built-in serif. Recorded as a new candidate; it is independent of pack delivery (a pack ships a phrase, not free text).
  - The single-row prompt **regenerate** route calls the enforcement builder without a style, so a regenerated row keeps whatever style its own earlier prompt text already carries. Unchanged behaviour; noted rather than altered.
- No DMG for this packet — it accumulates into **1.4.216**, which is the version the Gateway must require (`min_app_version: "1.4.216"`).
- Blocker/decision needed: none.
- Commit/push/paid calls/uploads/deployments: **none**.
