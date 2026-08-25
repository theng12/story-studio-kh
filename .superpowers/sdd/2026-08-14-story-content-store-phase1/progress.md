# Story Content Store Phase 1 — SDD Progress

## Source of truth

- Approved design: `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-14-story-content-store-phase1.md`
- GenStudio exact contract: `<owner-home>/Developer/genstudiokh/docs/product/api-contract-changes-1.4.0.md`
- GenStudio live release: 1.4.0, charging contract 0.21.0
- Starting Story Studio release: v1.0.834 at `94c6578cff6cb8bb19a0fea0b95173df3e87291d`
- Branch/worktree: `codex/content-pack-platform` at `<owner-home>/Developer/story-studio-kh/.worktrees/content-pack-platform`

## Execution rules

- Use a fresh implementation agent per task and a separate fresh reviewer after its focused GREEN checks.
- Every Critical/Important review correction gets a focused RED-to-GREEN regression before acceptance.
- Record exact commands and counts; never replace evidence with “tests pass.”
- Do not push, deploy, publish a product, issue a production quote, or make a live purchase.
- Phase 1 ends at commerce ownership plus an unverified receipt cache. It does not download, install, restore, or verify a purchased pack.

## Tasks

- [x] Task 1 — exact GenStudio 0.21 client, canonical payload preservation, generic app-version resolver, and safe `content:read` scope probe
- [x] Task 1 independent contract/security review — GO with zero Critical/Important findings
- [x] Task 2 — atomic commerce state, stable idempotency, interrupted-submit recovery, exact refusal cache, and unverified receipt bytes
- [x] Task 2 independent concurrency/security review — GO with zero Critical/Important findings
- [x] Task 3 — active-account orchestration and local read/quote/purchase routes with exact status semantics and no installer/Job Queue dependency
- [x] Task 3 independent financial/security review — GO with zero Critical/Important findings
- [x] Task 4 — Content Store UI, explicit confirmation, navigation, Settings scope UX, Impeccable pass, and desktop/narrow visual QA
- [x] Task 4 independent UX/contract review — GO with zero Critical/Important findings
- [x] Task 5 — whole-range review, v1.0.835 release, full verification/audits, unsigned package, and packaged QA

## Contract facts to re-check at every gate

- Account balance used for purchases: `content_spendable_credits`.
- Quote price: `quoted_credits` is a ceiling.
- Purchase truth: `credits_charged`, `balance_after`, and `replayed`.
- Purchase key: caller `Idempotency-Key`, 8–128 characters, same key for exact-request retries.
- Refusals: 402 `insufficient_credits`; 404 `product_unavailable|release_unavailable`; 409 `already_owned|quote_rejected`; 503 `signing_unavailable`.
- Ownership root: `account_id` / `content_account_id`, never API key.
- Empty `{ "products": [] }`: healthy and intentional.
- Receipt: cached, not verified in Phase 1.
- Downloads/install/restore/public key/portal: absent by contract.

## Task evidence

Add one section per task with:

- implementation commit(s);
- initial RED command and failure;
- focused GREEN command and count;
- typecheck/lint/build result;
- independent reviewer verdict and correction commits;
- any deliberate deferral that remains inside the approved Phase 1 boundary.

### Task 1

- Implementation commits: `3002c862` (`feat: read GenStudio content store contract`) and `90becfb5` (`fix: bound content store refusal evidence`).
- Initial RED: `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/genstudio-content-store-client.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `genstudio-content-store.js`.
- Focused GREEN before independent review: 95/95 across the Content Store client, Content Pack installer, app-settings isolation, GenStudio boundary, and GenStudio route suites; Electron typecheck, lint `--quiet`, and `git diff --check` exited 0.
- Independent review initially rejected one Critical and one Important: JavaScript number reserialization could diverge from Python signed canonical bytes, and response buffering/body failures were not bounded/classified safely.
- Review corrections used focused RED then GREEN and landed in `af7f9705` (`fix: preserve signed store response bytes`): raw JSON number lexemes are retained, purchase bodies embed persisted canonical quote bytes without JavaScript reserialization, response streaming stops at 1 MiB, and successful purchase response read/parse failures become typed `uncertain` outcomes.
- A second review found one Important: successful oversized or schema-invalid purchase responses still escaped as generic errors after a possible debit. Focused REDs were added, then `29c0e6ca` (`fix: mark unreadable purchase results uncertain`) mapped all successful post-submit body/decode/JSON/schema failures to typed `uncertain` while preserving non-OK refusal semantics.
- Final independent scoped re-review: GO, zero Critical/Important findings. Reviewer independently verified the 200 oversized and schema-invalid outcomes and reran the 19/19 client suite.
- Final focused evidence for Task 1: all 99 tests passed across the five named suites (19 client + 17 installer + 5 app-settings isolation + 37 GenStudio boundary + 21 route); Electron typecheck, lint `--quiet`, and `git diff --check` exited 0.

### Task 2

- Implementation and correction commits: `991b67e8` (`feat: persist content store purchase evidence`), `d4e354f2` (`fix: harden content purchase recovery`), and `aaf329a5` (`fix: enforce commerce journal byte budget`).
- Initial RED: `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-store-commerce-state.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `content-store/commerce-state.js`.
- The initial implementation added a strict 0600 atomic journal, one stable `story-content-<uuid>` idempotency key, exact quote identity checks, bounded refusal evidence, explicit state transitions, account and entitlement-family checks, immutable unverified receipt bytes, safe record pruning, cross-process locking, malformed-state quarantine, and secret/path/symlink rejection.
- Before independent review, a focused concurrency RED proved 12 concurrent callers could all treat one `submitting` attempt as their own. The correction made durable submission claiming exclusive so exactly one caller may own the POST transition.
- Independent review initially returned NO-GO with three Important findings: a second process could recover a live submitter, valid large completed evidence could wedge the journal before count-based pruning, and oversized state recovery allocated the whole file. Each received a focused RED, then `d4e354f2` added durable host/PID/process-incarnation submission ownership with dead-owner-only recovery, exact byte-budget pruning that protects current/in-flight evidence, and 64 KiB streaming hash plus same-volume rename quarantine. A two-process test proves live owners remain `submitting` and dead owners become `uncertain`; a 256 MiB sparse journal stays bounded.
- Re-review found one final Important: the budget measured compact JSON while `writeJsonAtomic` persists indented JSON. A near-boundary RED reproduced a compact-valid journal whose actual persisted bytes exceeded 16 MiB; `aaf329a5` now measures exactly ```${JSON.stringify(state, null, 2)}\n``` for both pruning and the pre-write guard.
- Final independent review: GO, zero Critical/Important findings. Reviewer reran the 22/22 focused commerce-state suite and confirmed all original and follow-up findings closed.
- Final Task 2 evidence: 46/46 passed across commerce state (22), Content Pack state (21), and atomic-store crash (3); Electron typecheck, lint `--quiet`, and `git diff --check` exited 0.

### Task 3

- Implementation and correction commits: `02b2e7be` (`feat: orchestrate GenStudio content purchases`), `af2d7af6` (`fix: settle every content purchase attempt`), and `1da16c04` (`fix: report exact content store scope boundary`).
- Initial RED: `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-store-routes.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `routes/content-store.js`.
- The implementation adds active-account overview/catalog orchestration, strict quote validation and evidence persistence, one durable purchase claim/POST, same-account key rotation, different-account refusal, exact known refusal settlement, uncertain replay, a renderer-safe DTO, bounded local routes, and a controlled GenStudio 0.21 commerce mock. It does not download, install, enqueue, or verify receipts.
- Independent review initially found four Important issues: unclassified post-claim exits could retain `submitting`, a true claim race could return 500, raw refusal dictionaries could reach the renderer, and the mock's scope copy did not match live generic 401s. Focused REDs reproduced each; `af2d7af6` now settles every exit, atomically returns claim followers, whitelists refusal fields, and adds neutral route-specific scope guidance.
- Re-review found one final Important: the purchase route's account preflight needs `content:read`, but generic route mapping labelled its 401 as `content:purchase`. A purchase-only key RED reproduced the false guidance; `1da16c04` preserves the exact call boundary, performs no claim/POST, and leaves the quote retryable.
- Final independent review: GO, zero Critical/Important findings. Reviewer verified account-preflight `content:read` versus purchase-POST `content:purchase`, no claim/debit for the purchase-only key, and a retained `quoted` attempt.
- Final Task 3 evidence: 81/81 passed across the route (22), client (19), commerce-state (23), local Content Pack route (10), and error-boundary (7) suites; Electron typecheck, lint `--quiet`, Electron build, and `git diff --check` exited 0.

### Task 4

- Implementation and correction commits: `8bf9f4b3` (`feat: add Content Store commerce UI`) and `5127e7e5` (`fix: describe content ownership truthfully`).
- Initial RED: `cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/contentStore.test.ts __tests__/settingsWorkspace.test.ts __tests__/genstudioOnboardingBoundary.test.ts` failed because `useContentStore.js` and the Content Store renderer/navigation did not exist.
- The implementation adds explicit-only catalog refresh, quote, confirm, and same-attempt uncertain replay; Discover/Owned views; exact content-spendable versus total balances; all five product kinds; free, paid, bundle discount, incompatible, empty, signing-unavailable, insufficient-credit, refusal, uncertain, and owned-not-installed states; global/project navigation; and truthful `content:read`/`content:purchase` Settings guidance. It adds no polling, automatic purchase retry, download, install, restore, gallery, license, or portal behavior.
- Rendered QA used only a controlled local commerce mock and made no production purchase. Captures covered populated and empty 1440×900, true 390×844 Discover/Owned, sufficient and insufficient dialogs, completed ownership, signing unavailable, uncertain replay, Settings scope results, and an effective 200% viewport. Measured page/card/dialog widths had no horizontal overflow; long titles wrapped; list tails remained reachable; dialog initial focus and visible focus ring stayed on Close; Escape closed and restored the quote trigger. A visual reproduction caught a disabled quote trigger losing focus; a focused RED then kept the guarded in-flight trigger focusable and the rendered Escape check passed.
- Impeccable context was loaded once before frontend work. Its detector ran exactly once after the UI stabilized and returned `[]`.
- Independent review initially returned NO-GO with one Important copy mismatch: the header promised packs were “delivered by GenStudio” despite Phase 1 deliberately providing ownership without download/install/restore. A source-visible RED reproduced the promise; the correction now says packs are priced by GenStudio and permanently owned by the customer’s GenStudio account. Final scoped re-review: GO, zero Critical/Important findings; the reviewer independently reran the 12/12 Content Store suite.
- Final focused GREEN: 25/25 across the Content Store, Settings workspace, and GenStudio onboarding suites. The complete frontend suite passed 568/568; frontend typecheck, production static build (including `/content-store` prerender), and `git diff --check` exited 0.

### Task 5

- Whole-range review covered `94c6578cff6cb8bb19a0fea0b95173df3e87291d..HEAD` against the approved Phase 1 design, GenStudio 1.4.0 source, charging contract 0.21.0, and all Content Store handoffs. The reviewer initially found two Important issues: completed UI projected quote-time balances, and definitive 402/503 refusals had no explicit same-attempt retry. Focused REDs reproduced both; `0c5cb968` (`fix: reconcile Content Store purchase outcomes`) now projects final settlement balances, performs one best-effort post-purchase account GET without another purchase POST, preserves success if that GET fails, and exposes explicit refused/uncertain retry with the existing durable identity and one POST per click.
- Re-review found one final Important: completed attempts still projected quote-time `discount_credits`. A focused settled-below-ceiling RED proved a 400-credit ceiling / 100-credit final discount / 300-credit charge / 3,700-credit final balance; `ff7fc4f0` (`fix: project settled Content Store discount`) projects the final GenStudio discount while retaining the historical quote ceiling. Final independent review: GO, zero Critical/Important findings; the reviewer independently reran 25/25 Content Store route tests.
- A whole-range 256 MiB sparse-journal memory regression initially exceeded the strict 64 MiB RSS budget. The unchanged RED passed 23/23 after replacing read-stream churn with one reusable 64 KiB read buffer; `70345767` (`fix: bound oversized commerce quarantine memory`) records the bounded implementation.
- The first release-version `npm run verify` passed 2,562/2,565 backend tests and exposed three exact release-fixture failures: two hardcoded v1.0.834 expectations and one compiled-layout app-version resolver failure. The focused RED was retained; `78e9fb3d` (`fix: resolve release version from compiled layout`) checks only the verified source/compiled package roots, requires the `story-studio-kh` package identity, and makes tests derive the current package version. Electron build plus the two focused suites then passed 36/36.
- Final full `npm run verify` exited 0: lint had zero errors and 1,722 pre-existing warnings; Electron/frontend typechecks passed; backend 2,565/2,565, frontend 572/572, and release 9/9 tests passed; changelog, typography, source and built security, model-drift, source and built desktop-release, frontend production generation, and Electron build gates passed. `git diff --check` exited 0.
- Production dependency audits are clean: root `npm audit --omit=dev --audit-level=low` and frontend equivalent each reported zero vulnerabilities. The complete frontend audit also reported zero. The complete root development audit reports two high-severity findings through Electron's development-only `extract-zip`; npm's offered remediation is a breaking Electron 43 upgrade, so Phase 1 preserves the lockfile and discloses rather than forcing an unrelated major runtime migration.
- `npm run dist:smoke` exited 0 and independently ran the changelog, typography, security, model-drift, release, build, package-input, artifact-content, and read-only mount checks. Artifact: `<owner-home>/Developer/story-studio-kh/.worktrees/content-pack-platform/dist/Story Studio KH 1.0.835-arm64.dmg`; 228,474,324 bytes; SHA-256 `f3f2fb773990988529939ea8cc23d3b90a2278e54a6f6057d15025e0849eb3ca`; ad-hoc signature with no Developer ID; read-only DMG mount verified.
- Packaged fresh-data QA launched the packaged app with an isolated data directory. `/api/health` returned 200 with `boot_complete: true`; `/api/content-packs` returned the verified bundled recovery pack; `/api/content-store` returned the truthful missing-`content:read` 400. A controlled local GET-only GenStudio mock returned a healthy empty catalog and 5,000-credit account; no live quote or purchase route was called. Rendered QA at 1,440×900 and 390×844 verified the empty and missing-key states, responsive balance layout, no horizontal overflow, and no console errors.
- Phase 1 remains bounded to catalog, permanent account ownership, durable one-attempt purchase evidence, and an unverified receipt cache. Downloads, restore, purchased-pack installation, receipt verification, gallery/license/portal behavior, catalog stocking, and every live credit mutation remain deferred to their published later-phase contracts.
