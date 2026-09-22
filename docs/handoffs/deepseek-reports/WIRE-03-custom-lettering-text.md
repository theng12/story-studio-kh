# WIRE-03 — the free-form "custom" lettering text reaches the prompt

## Run identity and scope
- Date / session: 2026-09-22; owner-operated DeepSeek lead session. One writer, no spawned agents.
- Branch `codex/stabilization-takeover`; base `6f3c4e33`; no commits. Fifth change set in the pending **1.4.216** release.
- Trigger: found while bridging pack lettering styles (`WIRE-01`), listed as a loose end, and named by gateway-kh's response letter as ours to schedule. The owner said to do it.
- Changed production:
  - `frontend/pages/projects/[slug]/image-prompts.vue` — the run payload sends the typed text.
  - `electron/server/generators/image-prompts.ts` — request type declares the two fields; both prompt builders pass them to the resolvers.
- Changed tests:
  - `electron/server/__tests__/custom-lettering-text.test.ts` (new, 8 cases).
  - `frontend/__tests__/imageWorkflowSelectionSafety.test.ts` (+1 wiring case).

## The defect
The Image Prompts page offers **Custom…** for both lettering axes and collects a free-form description (`thumb_font_style_custom`, `thumb_text_style_custom`). The backend resolvers have always accepted one — `resolveFontStyle(id, customText)` and `resolveTextStyle(id, customText)` — but:

- the run payload sent **only** the `custom` id, never the text;
- `buildThumbnailDirective` and `enforceThumbnailPromptElements` called the resolvers without the second argument.

So choosing Custom…, typing a description and generating produced a prompt that used the built-in **serif** (font) or **gold** (text) while the form still displayed what the customer typed. A silent wrong-output defect of the same shape as the pack-style one: the UI showed the choice, the model was told something else.

## Change and proof
- The payload now sends each custom description **only when `custom` is the chosen id** (`undefined` otherwise), so the fresh-generation fingerprint changes exactly when the text actually matters.
- Both builders accept `fontCustomText` / `textCustomText` and pass them to the resolvers. Everything else is unchanged: an empty custom description still falls back to serif/gold, and a built-in id ignores stray text rather than letting it override a deliberate choice.
- No route change was needed — `prepareExplicitScriptAction` passes the request body through into `job.params`, which the generator already reads.
- **RED.** `image-prompts.ts` restored from `HEAD`, new test run: **tests 8, pass 2, fail 6, exit 1** — the four custom-resolution cases, the call-site wiring and the request-type assertion. The two passes are the deliberate back-compat cases (blank custom still falls back; a built-in id ignores stray text), which is exactly why they were written. File restored byte-identically (sha256 `1253b324…`). Frontend: `image-prompts.vue` restored from `HEAD` → the new wiring case fails (7 pass / 1 fail, exit 1); file restored byte-identically (sha256 `29623c25…`).
- **GREEN.** Backend focused **8/8**, exit 0. Frontend `imageWorkflowSelectionSafety` **8/8**, exit 0.
- **Full gates on the finished tree (1.4.216):**
  - Full backend: exit **1** — **5,618 tests, 5,613 pass, 4 fail, 1 skip**, `514/514 file(s)`, 6,323 marks. All 4 failures are **external** to Story's code: `NEW-08` plus three cross-pack-overlap/registry guards tripped by the concurrent Content Pack re-authoring effort's untracked `content-packs/rebuilt/` (which changed *during* the run — one failure names a `-v2` pack whose `content/` directory did not exist a moment later). All eight new tests passed inside that run.
  - Full frontend: exit **0** — **1,916 tests, 1,916 pass, 0 fail**, 203 suites, `213/213 file(s)`, 2,119 marks.
  - `npm run build`: exit **0**. `npm run lint`: exit 0, 0 errors. `check:changelog` and `git diff --check`: exit 0. Frontend typecheck unchanged at the 11 pre-existing `NEW-04` errors; `typecheck:electron` exit 0.

## Handoff
- Recorded, **not** fixed (different defect, wider cone): the single-row **regenerate** route calls `enforceThumbnailPromptElements` with no style at all, so a regenerated row's appended clause says "a font chosen to suit the concept" even when a style was chosen. The regenerated prompt usually keeps its style because the LLM is asked to preserve the existing prompt text, but the clause contradicts it. Fixing it means plumbing the style ids and custom text through `PromptReviewPanel` props to the route. Recorded as `NEW-10` rather than expanded into this packet.
- Presets already carry the custom text (`snapshot: () => ({ form: { ...form.thumbnail } })`), so no preset change was needed.
- No DMG yet — accumulates into **1.4.216**, whose release is also the signal gateway-kh is waiting on (`PING-01`).
- Blocker/decision needed: none.
- Commit/push/paid calls/uploads/deployments: **none**.
