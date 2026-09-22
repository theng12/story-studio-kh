# DS-17b — the small-fix list (NEW-01, NEW-02, NEW-03, NEW-04, NEW-10)

## Run identity and scope
- Date / session: 2026-09-22; owner-operated DeepSeek lead session (goal round 3). One writer, no agents.
- Branch `codex/stabilization-takeover`; no commits in this packet.
- Trigger: item 4 of the owner's list ("small fixes"), worked in severity order.
- Changed production:
  - `scripts/testing/run-backend-tests.mjs` — NEW-03.
  - 11 frontend files — NEW-04 (typing only).
  - `electron/server/services/job-queue.ts` — NEW-01 (`MISSING_KEY_RECONCILIATION_DETAIL`, the stale-reason clear).
  - `electron/server/boot/executors.ts` — NEW-02 (three auditors).
  - `electron/server/routes/image-prompts-edit.ts`, `frontend/components/PromptReviewPanel.vue`,
    `frontend/pages/projects/[slug]/image-prompts.vue` — NEW-10.
  - `electron/server/__tests__/audio-script-freshness-hash.test.ts` — a missing annotation on `dir`,
    which `typecheck:electron` caught once tests are included (it was my own round-2 slip).
- Changed tests: `text-job-completion-auditors.test.ts` (new, 4 cases), plus additions to
  `job-cancellation-missing-key.test.ts` (NEW-01) and `custom-lettering-text.test.ts` (NEW-10).
- **Both typechecks are now green for the first time this session** (`typecheck:electron` exit 0,
  `npm --prefix frontend run typecheck` exit 0).

## NEW-04 — the 11 frontend typecheck errors — fixed
The generated `.nuxt/fetch.d.ts` declares `$fetch` as `import('nitropack/types').$Fetch`, while
`.nuxt/types/imports.d.ts` resolves the auto-import through `typeof import('../fetch.mjs').$fetch` —
and Nuxt 4.5.2's generator never emits `fetch.mjs` (verified after a fresh `nuxi prepare`: only
`fetch.d.ts` appears, 62 bytes). The global therefore types as a function with no type parameters, and
`$fetch<T>(...)` is TS2558.

**Why not fix the generator:** `.nuxt/` is generated and wiped by prepare; the installed
`nitropack@2.13.4` does export a generic `$Fetch`, so the mismatch is inside Nuxt's template. The
smallest dependency-free, durable fix is at the call sites: the type argument became a trailing
assertion, preserving each call's result type exactly.

| File | Sites |
|---|---|
| `components/FileBrowserModal.vue` | 2 |
| `composables/useApi.ts` | 1 |
| `composables/usePathPicker.ts` | 3 |
| `composables/useServerMode.ts` | 1 |
| `pages/login.vue` | 1 |
| `pages/projects/[slug]/audio-merge.vue` | 1 |
| `pages/projects/[slug]/video-assembly.vue` | 2 |

`npm --prefix frontend run typecheck` → exit **0**. **Limitation recorded:** the root cause is Nuxt's
generated declaration, so a future Nuxt upgrade may make the assertions redundant (they remain valid);
no dependency was changed.

## NEW-03 — backend tests needed `bundled/ffmpeg` on PATH — fixed
`scripts/testing/run-backend-tests.mjs` now prepends this checkout's `bundled/ffmpeg` to the child
PATH when the binary is present. A gate that only passes when the operator remembers an undocumented
prefix is not a gate — the failures read as product defects.

- **RED:** the runner restored from `HEAD`, the same ffmpeg-dependent files run with no manual prefix
  → **3 fail / 22** with `spawn ffmpeg ENOENT` and `spawn ffprobe ENOENT`; runner restored
  byte-identically (`sha256 bd158227…`).
- **GREEN:** `--only ffmpeg-manager --only subtitle-preview-render --only scene-effect-preview-render
  --only scene-clip-media` with no prefix → exit **0**, 62/62.

## NEW-01 — the cancellation control now names the missing key — fixed
While no GenStudio key exists, `reconcileCancellationJob` only wrote a line to `output_lines`, but the
control the customer presses is derived from `reconciliation_error` — so the button read "Checking
cancellation" and gave no reason. The missing-key pass now records
`MISSING_KEY_RECONCILIATION_DETAIL` too, writing only when the value actually changes (the DS-01
bounded-log-growth guarantee is preserved).

**A regression this introduced, caught by the affected regression run.** The reason is *stale* once a
key is configured, and `classifyJobControl` treats any `reconciliation_error` as return-later — so a
cancellation the customer could now legitimately request was refused with a message claiming the key
was still missing (`job-cancel.test.ts`, "restored queued work with an accepted provider ID cannot be
cancelled as unsubmitted", 409 `CANCELLATION_STATUS_UNKNOWN`). Fixed in `requestJobCancellation`:
drop exactly that reason, and only when a key now exists.

- **Proof:** new case in `job-cancellation-missing-key.test.ts` asserts the control copy names the key,
  says where to fix it, and does not claim progress. RED with `job-queue.ts` at `HEAD` → **1 fail**,
  restored byte-identically (`sha256 90398cf8…`). GREEN: `job-cancel` + `job-cancellation-missing-key`
  → exit **0**, **81/81**.

## NEW-02 — completion auditors for the text job types — fixed
DS-02 made a settled-but-unverifiable restart fail loudly, but `metadata`, `image_prompts` and
`research_run` had no auditor at all, so a restart of those types became an error even over complete
output. Each now registers an auditor that reuses its generator's own proof:

| Type | Proof reused |
|---|---|
| `image_prompts` | `inspectPromptCompletion(thumb_prompts_dir, code, 'thumbnail')` |
| `metadata` | `inspectMetadataCompletion(metadata_dir, code)` |
| `research_run` | `resolveResearchPaths()` + `isResearchComplete()` (AGENTS §9, artifact-based) |

Each returns `complete` only when the proof is **authoritative and complete**; an unreadable or partial
artifact stays `repair-required`.

- **Proof:** `text-job-completion-auditors.test.ts` asserts all three register, and pins **both**
  directions per type (an auditor that always answered `repair-required` would otherwise pass every
  "not complete" assertion). Fixtures are written into the **real resolved episode paths**, because the
  auditors resolve from the job. RED with `boot/executors.ts` at `HEAD` → **4 fail**, restored
  byte-identically. GREEN 4/4.
- The DS-02 test's own doc comment was corrected (it said these types "register none").

## NEW-10 — a regenerated row names the chosen style — fixed
The single-row regenerate route called `enforceThumbnailPromptElements` with no lettering, so the
clause it appends said "a font chosen to suit the concept" to a customer who had chosen one. The
workspace now sends its four lettering fields (`thumb_font_style`, `thumb_text_style`, and both
`*_custom`), the request schema accepts them, and the route passes them into the clause. Omitted means
exactly what it meant before.

- **Proof:** three cases in `custom-lettering-text.test.ts` (schema accepts the fields; the route
  passes all four into the clause; the panel sends them and the page supplies them). RED with
  `image-prompts-edit.ts` at `HEAD` → **2 fail**, restored byte-identically. GREEN 11/11.

## Gates
- `typecheck:electron` exit **0**; `npm --prefix frontend run typecheck` exit **0**.
- Full backend gate and full frontend lane re-run on the finished tree (recorded below / in the log).
- `check:changelog` and `git diff --check` re-verified after the record update.

## Handoff
- NEW-04's root cause (Nuxt's generated `fetch.mjs` reference) is recorded, not hidden; a Nuxt upgrade
  may make the assertions redundant.
- NEW-03 changes only the test harness; production ffmpeg resolution is untouched.
- No new bounded packet was created; the five items are closed.
- Blocker/decision needed: none. Commit/push/paid calls: **none in this packet**.
