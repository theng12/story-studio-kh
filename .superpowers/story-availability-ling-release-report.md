# Story Studio availability + Ling release report

## Scope and history

- Base: `0762a886` (`main`)
- Reviewed branch head before this release audit: `103ce3d7` (`feat/story-availability-reason`)
- Audited implementation head: `54f1afcf` (`feat/story-availability-reason`)
- Review-report checkpoint: `f45e41a8`
- Remediation implementation head: `61bf368d` (`Harden Ling truncation repair boundary`)
- Heading-boundary remediation head: `61ea5905` (`Preserve proven chapters at truncation heading boundary`)
- Normalized-grammar remediation head: `ad6d48a0` (`Unify normalized Ling truncation boundaries`)
- Application version: `1.4.100`
- Branch commits reviewed:
  - `e25fccdc` — Explain unavailable GenStudio chat models
  - `103ce3d7` — Repair truncated narrative chapters safely
  - `54f1afcf` — Keep narrative repair limited to truncation
  - `f45e41a8` — Document availability and Ling release audit
  - `61bf368d` — Harden Ling truncation repair boundary
  - `4fa96828` — Record Ling truncation remediation verification
  - `61ea5905` — Preserve proven chapters at truncation heading boundary
  - `71a8b502` — Document heading-boundary release verification
  - `ad6d48a0` — Unify normalized Ling truncation boundaries

This is an application release. `package.json`, `package-lock.json`, and the
newest `CHANGELOG.md` entry already agree on `1.4.100`; the release audit kept
that single unreleased patch version rather than introducing an unnecessary
second bump.

## Reviewed outcomes

1. **Unavailable GenStudio LLM models:** catalogue parsing allowlists only
   `daily_quota_depleted` and `temporary_backpressure`, normalizes only valid
   reported return times, and forwards both through `/api/models`. The picker
   displays a localized future return time only when present and in the future;
   stale, missing, malformed, unknown, and legacy metadata retains the existing
   generic disabled wording. Unavailable options remain visible, `aria-disabled`,
   excluded from keyboard selection, and guarded against click selection.
2. **Ling output truncation:** the durable
   `LANGUAGE_PROVIDER_INCOMPLETE` result and compatible truncation finish
   reasons become the typed incomplete signal. Only chapters terminated by a
   following chapter heading are retained from a truncated batch; the final
   parser-flushed block has no completion boundary and is never written or
   marked done. Missing or unproven chapter slots receive one separate repair
   request, each sized at the bounded 8,192-token workload budget. Completed
   slots are not overwritten.

## Finding fixed during this audit

`expandNarrativeSequential` previously caught every
`GenStudioChatIncompleteError`, including non-truncation finish reasons such as
`content_filter`. That could create a billable replacement request for a
provider/content outcome outside the approved Ling truncation path.

The repair guard now requires `error.truncated`. Non-truncation incomplete
results stay terminal and require explicit Retry; their partial customer-facing
chapter output is not written. The regression test was first run red, then
green, and verifies exactly one original expansion request with no repair.

## Independent-review remediation

The independent review correctly found that a typed truncation still passed its
entire partial response to `splitNarrationIntoChapters`. That parser rightly
flushes a final non-empty block for ordinary complete responses, but a provider
truncation supplies no boundary proving that final block complete. It could
therefore be written and added to `chapters_done`, excluding the slot from the
bounded repair path.

`61bf368d` adds a narrowly scoped `discardFinalParsedChapter` option used only
for the typed truncated-response call site. It discards the final parsed block
before any file or sidecar write; earlier blocks remain because their following
heading proves their boundary. The existing one-pass repair policy is unchanged:
the final/unproven slot and later missing slots each receive exactly one bounded
8,192-token request, while non-truncation provider failures remain terminal.

The TDD fixture has Chapter 1 complete, Chapter 2 cut mid-sentence, and Chapter
3 missing. It proves Chapter 1 stays byte-distinct and is never requested again;
Chapters 2 and 3 are each repaired once; the partial Chapter 2 text never lands
on disk. A second fixture forces the Chapter 2 repair empty, proves completion
reports Chapter 2 missing rather than accepting a partial file, then proves
resume requests only Chapter 2 and leaves Chapter 1 untouched. The picker test
now starts on a different selected ID and asserts zero disabled-row update
handler calls.

## Verification evidence

- RED: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 14 pass, 1 expected failure (the new non-truncation retry test).
- Focused GREEN:
  `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke --only genstudio-chat-durable --only genstudio-relaxed-queue-catalogue`
  — 53/53 tests, 3/3 files; explicitly a partial iteration run, not a release gate.
- Release metadata: `npm run check:changelog` — passed for `v1.4.100`.
- Full official gate: `npm run verify` — passed after lint/typecheck, all test
  lanes, static frontend build, Electron build, built security, and built
  desktop-release checks:
  - backend: 4,183/4,183 tests; 382/382 files completed
  - frontend: 1,287/1,287 tests; 137/137 files completed
  - release: 36/36 tests; 4/4 files completed
  - content packs: 194 passed, 0 failed, 2 documented skips; 27/27 files completed
- Deterministic GenStudio qualification:
  `node scripts/qualify-genstudio-release.mjs` — 206/206 tests and the
  qualification TypeScript contract passed; the script confirms no provider
  calls, live jobs, or credits were used.

`npm run verify` retains the repository's existing lint warnings (1,772
warnings, 0 errors); this branch does not add or modify them.

### Remediation verification (fresh serial run)

- RED: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 14 pass, 2 expected failures: the unproven final Chapter 2 was counted as
  written (so it was not repaired), and completion accepted it.
- GREEN: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 16/16 tests, 2/2 suites, 1/1 file completed.
- GREEN: `cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/pickerDialogFocus.test.ts`
  — 7/7 tests, 1/1 suite.
- Fresh official release gate (serial, no competing test runs):
  `npm run verify > /tmp/story-availability-verify-remediation-20260904.log 2>&1`
  — recorded terminal exit code `0` in
  `/tmp/story-availability-verify-remediation-20260904.exit`.
  - backend: `4184` pass, `0` fail; `382/382` files completed
    (`4813` total marks including `629` suites)
  - frontend: `1287` pass, `0` fail; `137/137` files completed
    (`1460` total marks including `173` suites)
  - release: `36` pass, `0` fail; `4/4` files completed
    (`40` total marks including `4` suites)
  - content packs: `194` pass, `0` fail, `2` documented skips;
    `27/27` files completed (`196` marks)
  - static frontend and Electron builds, source and built production-security,
    and source and built desktop-release checks all passed.

### Renewed heading-boundary remediation

Renewed review correctly identified that the first remediation discarded the
last non-empty parsed chapter unconditionally. A provider can truncate exactly
after the next chapter heading: that empty heading closes the preceding chapter,
so the parser returns only the preceding, boundary-proven block. Dropping it
would trigger an unnecessary billable repair.

`61ea5905` uses the raw truncated text's final recognized chapter heading as
the smallest sufficient signal. The final parsed block is discarded only when
that same heading has non-empty trailing body text; an empty trailing heading
retains the preceding parsed chapter. No retry policy, output budget, or normal
provider-failure path changed.

- RED: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 16 pass, 1 expected failure: a heading-only Chapter 2 cutoff re-requested
  already-complete Chapter 1.
- GREEN: `node scripts/testing/run-backend-tests.mjs --only chunked-narration-smoke`
  — 17/17 tests, 2/2 suites, 1/1 file completed. The fixture proves Chapter 1
  is retained and never re-requested; the heading-only Chapter 2 and later
  missing Chapter 3 each receive exactly one bounded repair.
- Fresh official release gate (serial):
  `npm run verify > /tmp/story-availability-verify-heading-boundary-20260904.log 2>&1`
  — recorded terminal exit code `0` in
  `/tmp/story-availability-verify-heading-boundary-20260904.exit`.
  - backend: `4185` pass, `0` fail; `382/382` files completed
    (`4814` total marks including `629` suites)
  - frontend: `1287` pass, `0` fail; `137/137` files completed
    (`1460` total marks including `173` suites)
  - release: `36` pass, `0` fail; `4/4` files completed
    (`40` total marks including `4` suites)
  - content packs: `194` pass, `0` fail, `2` documented skips;
    `27/27` files completed (`196` marks)
  - static frontend and Electron builds, source and built production-security,
    and source and built desktop-release checks all passed.

### Normalized heading-grammar remediation

The third review found that the heading-boundary implementation had a raw regex
separate from `splitNarrationIntoChapters`. For an exact trailing
`## Chapter 02: ` line, the raw matcher could see whitespace that the parser
normalized away; the parser then retained the dangling heading as Chapter 1
prose. `ad6d48a0` removes that duplicate grammar. The shared normalized parser
now recognizes title-less supported heading prefixes as boundaries, excludes
them from prose, and returns whether its final parsed chapter is boundary-
proven. The truncation path consumes only that signal.

The new exact-space parser regression proves Chapter 1 closes without retaining
the dangling Chapter 2 prefix. Existing heading-only and mid-body fixtures
remain: the former retains Chapter 1 and repairs only Chapters 2/3; the latter
discards partial Chapter 2 and repairs it once.

- RED: `node scripts/testing/run-backend-tests.mjs --only narration-assembly --only chunked-narration-smoke`
  — 33 pass, 1 expected failure: the normalized title-less heading remained in
  Chapter 1 prose.
- GREEN: same command — 34/34 tests, 5/5 suites, 2/2 files completed.
- Fresh official release gate (serial):
  `npm run verify > /tmp/story-availability-verify-normalized-heading-20260904.log 2>&1`
  — recorded terminal exit code `0` in
  `/tmp/story-availability-verify-normalized-heading-20260904.exit`.
  - backend: `4187` pass, `0` fail; `382/382` files completed
    (`4816` total marks including `629` suites)
  - frontend: `1287` pass, `0` fail; `137/137` files completed
    (`1460` total marks including `173` suites)
  - release: `36` pass, `0` fail; `4/4` files completed
    (`40` total marks including `4` suites)
  - content packs: `194` pass, `0` fail, `2` documented skips;
    `27/27` files completed (`196` marks)
  - static frontend and Electron builds, source and built production-security,
    and source and built desktop-release checks all passed.

## Final review and release state

- `git diff --check` passed.
- The final diff is limited to the approved availability/Ling behavior,
  assertions, required v1.4.100 metadata, and this audit report.
- No deployment, publish, push, signing, notarization, or live-data operation
  was performed.
- After the local remediation and report commits, the worktree is clean.

**Ready for independent review: yes.** The earlier independent-review blocker is
fixed and covered by RED/GREEN and a fresh full release gate. The outstanding
step is renewed independent review/integration only; no known release blocker
remains.

## Post-merge main closeout (2026-09-04)

- Integrated `main`: `5c947566e783afa570d170692fdc8fb15567688d`; it matched
  both `origin/main` and the reviewed head `2b5aefa4` exactly
  (`git diff --quiet 2b5aefa4 5c947566e783afa570d170692fdc8fb15567688d`).
- The main checkout was clean before this documentation-only closeout. The
  source `package.json` version is `1.4.100`.
- Fresh serial official gate:
  `npm run verify > /tmp/story-main-5c947566-verify.log 2>&1` exited `0`
  (recorded in `/tmp/story-main-5c947566-verify.exit`). Its exact completion
  lines were:
  - backend: `4273` pass, `0` fail, `0` skipped; `382/382` files;
    `4902` marks including `629` suites.
  - frontend: `1287` pass, `0` fail, `0` skipped; `137/137` files;
    `1460` marks including `173` suites.
  - release: `36` pass, `0` fail, `0` skipped; `4/4` files; `40` marks
    including `4` suites.
  - content packs: `194` pass, `0` fail, `2` documented skips; `27/27`
    files; `196` marks.
  Static frontend/Electron builds and built production-security and
  desktop-release checks also passed.
- Fresh unsigned main packaging smoke:
  `npm run dist:smoke > /tmp/story-main-5c947566-dist-smoke.log 2>&1`
  exited `0` (recorded in `/tmp/story-main-5c947566-dist-smoke.exit`). It
  produced and verified the repository-root artifact
  `dist/Story Studio KH 1.4.100-arm64.dmg`:
  - bytes: `241525332`
  - SHA-256: `d27942915fe01544a14474dd0f1e04cd39f10a079be8427ebf406e5710901db3`
  - mounted read-only; launch smoke served `/api/health` in `5858ms`.
- Bundle metadata independently agrees with main: the app at
  `dist/mac-arm64/Story Studio KH.app` has
  `com.storystudio.kh`, `CFBundleShortVersionString=1.4.100`, and
  `CFBundleVersion=1.4.100`; its
  `Contents/Resources/app.asar` `package.json` is
  `story-studio-kh@1.4.100`.
- This is an ad-hoc unsigned smoke artifact (no Developer ID), as required by
  `dist:smoke`. No signing, notarization, publish, deploy, tag, or live-data
  operation was performed.

**Post-merge release smoke: GO.** The artifact is valid for the requested
unsigned main-checkout smoke closeout; a public distribution would still need
the separately authorized signed/notarized public-release path.
