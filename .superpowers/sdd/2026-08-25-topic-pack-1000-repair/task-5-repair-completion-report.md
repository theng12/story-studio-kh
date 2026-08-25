# Task 5 repair completion — Habits & Momentum

## Scope

- Isolated worktree: `codex/content-expansion-portfolio`.
- Tracked change: `content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json` only.
- The predecessor, manifest, registry, harness, Formula, version, changelog, and unrelated Task 18 inventory assertion were preserved.

## Root-cause repair

The reviewed successor repeated a single 20-ordinal intervention/evidence frame across all 50 subjects and interpolated clause-valued completions into noun slots. The repaired source keeps 50 profiles × 20 atomic tuples, but assigns routines to ten fitting five-profile material workflow families (departure, planning, time, access, household, practice, maintenance, communication, closure, recovery), rotates ordinal order, and gives every tuple its own object, mechanism, evidence variable, observation window, and comparison.

The source is `995,380` bytes (under 1 MiB) with SHA-256 `8790c8f9be2df475e7737c083b6b0123a0253546fc07906160b94cef4860598e`.

## Semantic guardrail proof

`task-5-semantic-audit.mjs` now rejects malformed clause slots and verb-object interpolation, requires an observable evidence variable, requires 20 independently distinct mechanisms per profile, strips evidence qualifiers and scope language before checking cross-profile mechanism-frame reuse, and checks all 499,500 unordered pairs.

- `node .../task-5-semantic-audit.mjs --reject-reviewed-template` → `template_fixture_rejected: true` for reviewed commit `19df47b5d702cf41e1d7ced75e609a0761058440`.
- `node .../task-5-semantic-audit.mjs` → 50 subjects, 1,000 tuples, 499,500 pairs, 0 generic mechanism frames, 50 review rows, and 1,000 review verdicts.

## Fresh verification

- Receipt replay: revision 34, `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3` — PASS.
- Registry validation: revision 34 / 108 records — PASS.
- Named capacity harness — 1/1 PASS.
- Full successor harness — 5/5 PASS.
- Signed-source golden suite — 8/8 PASS.
- Electron typecheck — PASS.
- `git diff --check` — clean.
