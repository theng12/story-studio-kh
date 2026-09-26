# Independent audit — triage, first slice (2026-09-26)

**Source:** [`2026-09-23-independent-audit.md`](2026-09-23-independent-audit.md) — 341 lines, scoped to
`734ccd70` / v1.4.219. **This file is another effort's work; it is read only, never edited.**
**Triage owner:** lead session. **Method:** each claim read against the *current* source (1.4.224), not
against the line numbers the audit cites — positions have moved.

**Scope of this slice:** the three P0 items I could check in one pass. **12 P0 items exist**, plus a
Priority 1 section (§3) and a Priority 2 section (§4) that are untouched. Nothing here claims more.

## P0-5 — paid work goes to the wrong model: **CONFIRMED at source, two independent places**

- `electron/server/generators/images.ts:318` — `const modelName = req.model || 'grok-imagine'`.
  A **hardcoded retired paid model** as the fallback. AGENTS §1 forbids inventing a fallback, and §7's
  generator-default rule forbids a hardcoded paid model; the audit adds that Pipeline's `thumb_images`
  step can reach it.
- `electron/server/generators/music-generate.ts:197` — `models.find(m => m.id === params.model) || models[0]`.
  A retired/saved music model silently becomes **whatever is first in the catalogue** — the wrong model,
  silently, on a paid path.
- Also in the same finding, unverified by me: `services/genstudio-default-model.ts` matching raw `id`
  only (not handle/alias), and ~12 call sites comparing `id ===` instead of using
  `findGenStudioProduct`.

**Verdict:** real, reachable, and the ruling it breaks is the first rule in `AGENTS.md`. The fix shape is
the audit's own: resolve through `findGenStudioProduct`, and **throw** (`unavailableLegacyModelMessage`)
rather than substituting a different paid model.
**Next step:** fix the two fallbacks first (small, provable: an unknown id must produce zero POSTs), then
the identity-comparison sweep as its own change with its own test.

## P0-1 — Pause does not stop paid image renders: **partial**

- `electron/server/generators/images.ts:1569-1570` is exactly as described:
  `ownerStopped = isCancelled() || jq.isPauseRequested(job.job_id)`, used in the settle condition.
- **Not verified:** the audit's harmful consequence — that a worker sleeping in a retry backoff
  (`:1058`, `:1499`) wakes and submits a new **paid** request after the pause. That needs those two
  retry paths read end to end, and ideally the audit's own repro (it marked this `R`).
**Next step:** read both retry paths; if a sleep can complete into a submission with no pause check, the
fix is the audit's (`jq.isPauseRequested` after every retry sleep) plus a test that pauses with two
images in flight and asserts zero further submissions.

## P0-3 — a failed forced re-render reports success: **unverified**

- The audit points at `images.ts:1703-1711` and says the `requireJobCompletion` call omits
  `invalid: errors`. `requireJobCompletion` is imported (`:31`) and used in that region, but my grep did
  not capture the call's arguments, so I have **not** confirmed the omission.
**Next step:** read the call site; if `invalid` is genuinely absent, it is the one-line fix the audit
says, with `partial-failure.test.ts` extended (existing Thumb01 + force + provider failure ⇒ `error`).

## What this slice does not cover

P0-2, P0-4, P0-6, P0-7, P0-8, P0-9, P0-10, P0-11, P0-12 — including the ones marked **R**
(reproduced by the auditor): the settings-file wipe, the still-image disk blow-up, the research-triage
loss, and the server-mode login bypass. Also untouched: every item in Priority 1 (§3) and Priority 2
(§4), and the audit's own root-cause and fix-plan sections (§5, §6).

Two are worth naming now because of what they touch in this codebase's history: **P0-9** (presets
carrying one episode's title into another) is the §4 defect class this repo has hit six times, and
**P0-11** (research triage lost, the pipeline overwriting a human's decisions) asserts a §9 violation —
both are load-bearing rules, not preferences.
