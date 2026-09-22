# WIRE-02 — `metadata_formula` wire kind (Gateway ask 2, owner-accepted)

## Run identity and scope
- Date / session: 2026-09-22; owner-operated DeepSeek lead session. One writer, no spawned agents.
- Branch `codex/stabilization-takeover`; base `6f3c4e33`; no commits.
- Source: `_handoffs/2026-09-22_wire-kind-parity-lettering-and-metadata-formula.md` (gateway-kh request).
- **Owner decision, 2026-09-22: accept.** Story sells metadata-formula as a Content Store product. Wire kind: **`metadata_formula`** (the Gateway's proposal; the pack kind stays `metadata-formula`).
- Minimum app version: **1.4.216** (pending release at the time of writing).
- Changed production:
  - `electron/server/lib/genstudio-content-store.ts` — `metadata_formula` added to `PRODUCT_KINDS` and `GenStudioContentProductKind`.
  - `frontend/content-store/product-kinds.ts` — the shared frontend kind list.
  - `frontend/content-store/catalog-presentation.ts`, `frontend/content-store/library-organisation.ts`, `frontend/components/content-store/ContentStoreFilters.vue` — label, shelf order and filter label.
- Changed tests:
  - `electron/server/__tests__/metadata-formula-pack-bridge.test.ts` (new, 3 cases).
  - `electron/server/__tests__/genstudio-content-store-client.test.ts` (all seven wire kinds + unknown-kind guard).
  - `frontend/__tests__/contentStoreLibrary.test.ts`, `frontend/__tests__/contentStorePersistedCatalog.test.ts`.

## Why accept
The decision is the owner's, and the source already recorded his instruction — quoted at the top of `metadata-formula-catalogue.ts`: *"there's no meta data formulas that we can pick from … can we have like 5 built in options and then we can sell them in packs of 6 for 300 credits each"*. Five ship free; more were always meant to be sold. The runtime was already built and only the wire kind blocked delivery:

| Layer | State before this packet |
|---|---|
| Pack schema | supported — `MetadataFormulaDocumentSchema` |
| Runtime catalogue | built — `metadataFormulaCatalogue()` reads installed `metadata-formula` packs beside the built-ins |
| Consumer | built — `metadataFormulaPlan()` → `buildDescriptionPrompt()`, used by the metadata generator |
| Project pinning | built — `project-pins.ts` `CONSUMERS` entry |
| Install path | kind-agnostic — nothing needed |
| **Wire kind** | **absent — a delivered product could not be parsed at all** |

## Reproduction and proof
- **Wire contract.** Every published kind now parses and keeps its wire spelling, and an unknown kind still fails the whole parse. The list is asserted once, so the Gateway's `SUPPORTED_KINDS` and this parse can be checked against the same spelling.
- **Delivery → installable → usable**, proven by installing a signed `metadata-formula` archive through Story's own installer:
  - the installed formula lists beside the five built-ins with `source: 'pack'` and its pack id;
  - `resolveActiveMetadataFormula()` resolves the chosen id;
  - `metadataFormulaPlan()` carries the pack's own section instruction and `max_chars`;
  - `buildDescriptionPrompt()` emits that instruction and the pack's stated architecture;
  - a channel that picks nothing resolves to `null` — the default path is untouched.
- Focused: `metadata-formula-pack-bridge` exit **0**, tests 3, pass 3, fail 0.
- Library/Store presentation: the new kind sorts beside the other formula, before anything visual (`Series Formula → Topic Pack → Metadata Formula → Visual Style → Thumbnail Recipe → Font Pack → Channel Kit`), and carries the label **Metadata Formula**. Frontend focused: `contentStorePersistedCatalog` + `contentStoreLibrary` exit **0**, 31/31.
- The frontend catalogue reader (`persisted-catalog.ts`) validates against the same shared kind list, so a delivered metadata formula also survives a save/restore of the cached catalogue. RED for that shared-list fix: 16 pass / 1 fail at `HEAD`, file restored byte-identically; GREEN 31/31. See `WIRE-01-font-pack-bridge.md` for the full account.

## Handoff
- **Full gates on the finished tree:** identical to WIRE-01's, since both asks shipped together in one change set — backend **5,605 / 5,610 pass** with the 4 failures all external to this work (one `NEW-08`, three caused by the external effort's untracked `content-packs/rebuilt/` `<slug>-v2` packs tripping the repo's cross-pack overlap guards), frontend **1,915 / 1,915 pass**, `213/213 file(s)`, `npm run build` exit 0, lint 0 errors, `check:changelog` and `git diff --check` exit 0, typecheck unchanged at the 11 pre-existing `NEW-04` errors.
- The Gateway can add `metadata-formula → metadata_formula` to `SUPPORTED_KINDS` and re-author the **8** preserved archives under new `<slug>-v2` identities. Nothing else is required on the Story side.
- The Gateway should set `min_app_version: "1.4.216"` for any pack of this kind. A pack delivered to an older build cannot be parsed at all (the wire kind did not exist), which is exactly the ordering the Gateway's allow-list exists to enforce.
- No DMG yet — this accumulates into **1.4.216**.
- Blocker/decision needed: none.
- Commit/push/paid calls/uploads/deployments: **none**.
