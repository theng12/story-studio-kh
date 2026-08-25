# Task 1 — Atomic ten-thumbnail-recipe reservation

## Status

DONE_WITH_CONCERNS

## Files changed

- `content-packs/authoring-registry.json` — revision 23 batch and ten `reserved` records.
- `scripts/content-packs/__tests__/authoring-registry.test.mjs` — exact durable assertions for this batch; made the older later-revision fixture relative rather than hard-coded to revision 22.
- Ignored working evidence: `reservation-request.json`, `reservation-result.json`, and ten `expected-identities/*.json` files under this SDD directory.

## Reservation revision and receipt

- Revision: `23`
- Receipt: `authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378`
- Persisted receipt cardinality: exactly 10 records; no collision was found across pack ID, item ID, source path, family, or SKU before reservation.

## Exact verification evidence

- Parsed request checks: `expected_revision: 22`, `records: 10`, ten unique slugs, and every required value present.
- Persisted-record check: revision 23, 10 records carrying the receipt, 10 expected identities, all exact after removing only `receipt_ref`.
- `verify-receipt` was invoked separately for each slug and returned revision 23, the receipt above, and the field-exact identity for all 10/10:
  `before-after-proof-panel`, `two-option-criteria-split`, `reaction-evidence-inset`, `cutaway-exploded-object`, `hero-payoff-companion`, `iconic-result-closeup`, `scale-journey`, `numbered-lineup`, `macro-mystery-detail`, and `hands-on-pov-moment`.
- Durable assertion check: batch revision 23 has exactly ten source paths, one receipt, all records `reserved`, empty dependencies, and `proposed` family/SKU states.

## Commands and summarized outputs

- `git status --short --branch` — clean `codex/content-expansion-portfolio` baseline.
- `npm run content-pack:registry -- validate` — baseline revision 22 / 82 records; post-reservation revision 23 / 92 records.
- `test ! -e content-packs/authoring-registry.json.lock` — no lock.
- Collision scan — zero proposed-slug hits in all five required identity dimensions.
- `node --test scripts/content-packs/__tests__/authoring-registry.test.mjs` — 35/35 passing after the reservation.
- `npm run content-pack:registry -- validate` — revision 23 / 92 records.
- `git diff --check` and cached diff check — clean.

## Commit

`c1479321792dafc672af5458d44641d19baa887b` — `chore(content-packs): reserve ten thumbnail recipes`

## Self-review

- Confirmed one and only one reservation batch was submitted against the live valid revision.
- Confirmed all ten registry identities match the matrix verbatim and no source pack, preview prompt, media, handoff, or external mutation was authored.
- Confirmed the committed test uses committed registry data only; ignored SDD evidence is not read by it.

## Concerns

The required `npm run ... > reservation-result.json` command redirects npm's informational banner together with JSON. The reservation itself succeeded exactly once; the ignored evidence file was normalized to the returned JSON object before verification. No registry, receipt, or identity mismatch resulted.

## Fix Round 1

### Status

Original raw redirected output recovered locally; no second reservation was submitted.

### Files changed

- `scripts/content-packs/__tests__/authoring-registry.test.mjs` — the durable assertion now deep-compares the full persisted batch request, including `expected_revision: 22`, exact coordinator task and branch, exact `proposal_ref`, and all ten exact records.
- `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.raw.txt` — recovered untouched raw redirected bytes.
- This report — appended recovery and verification evidence.

### Raw-output recovery

The original raw bytes were recovered from the plausible local Codex execution transcript:

`<owner-home>/.codex/sessions/2026/08/24/rollout-2026-08-24T18-44-32-01a03396-233f-7ad1-87b9-579d0a6c2bbd.jsonl`

The transcript contains the command's later `tail` output with the raw five-line redirected file (leading blank line, two npm banner lines, blank line, then result JSON). A read-only `jq`/`perl` extraction was byte-compared against the preserved evidence file:

- recovered evidence: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.raw.txt`
- recovered raw SHA-256: `88468b704e73f07f25cde7aa467f32c7b7324bf3ca6dd88e1d01aaa6d564c742`
- source transcript SHA-256 at recovery: `c876413cda9d0612b4b227ddff86368814464e0f819a866f0c55eabe6416b354`
- byte comparison: `transcript_raw_match=0`

`reservation-result.json` remains the normalized machine-readable projection used by the ten receipt checks; the raw file above preserves the historical stdout exactly rather than presenting that projection as the original transcript.

### Commands and outputs

- Targeted transcript search in `.superpowers`, the worktree logs path when present, and `<owner-home>/.codex` — located the one active-session transcript above; no external or unrelated search was performed.
- Read-only extraction and `cmp` — recovered raw SHA-256 matched the saved ignored raw evidence byte-for-byte.
- `node --test scripts/content-packs/__tests__/authoring-registry.test.mjs` — 35 passed, 0 failed.
- `npm run content-pack:registry -- validate` — `authoring registry revision 23: 92 records`.
- `git diff --check` — exited cleanly.

### Remaining concern

The original raw file had already been normalized before this review round, so its recovery relies on the local Codex transcript rather than the initially retained file itself. The recovered bytes, transcript path and both hashes are now recorded; registry batch integrity and all ten targeted receipt verifications remain the stronger authoritative evidence.
