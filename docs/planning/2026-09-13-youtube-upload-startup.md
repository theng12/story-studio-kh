# YouTube upload startup recovery — 2026-09-13

## Scope and instruction snapshot

Reported: five KH Boundless uploads failed with only `fetch failed` on 1.4.157.
Apply AGENTS: logs before edits, isolated worktree, protect source/metadata/session identity and verified completion, minimal shared fix, one test suite at a time, independent review, local full verification, version/changelog, GitHub Actions disabled, standing PR integration and main-only unsigned DMG. No live uploads, account writes, app restart, customer file changes, or launcher changes.

Start: main 8dcf202b; worktree `.worktrees/youtube-upload-startup`.
Read-only inspector: `/root/shared_lookup_fix`, same start commit, deliver call-path/retry hazards and test cases. Root owns durable evidence, implementation/integration. Completion proof: focused regression tests, independent review, `npm run verify`, main `npm run dist:smoke`.

## Evidence

- Five upload admission POSTs returned 200. EP0075–EP0079 then failed sequentially on 2026-09-13 between 05:37 and 05:40 UTC.
- All five durable operations are failed, without resumable-session fields or accepted video IDs; job byte progress absent. Logs stop at starting resumable upload and AI disclosure.
- OAuth refresh errors have a separate prefix, while the metadata POST's transport error passes through unlabelled. No network retry exists for that startup POST (401 alone gets an auth retry). Chunk upload has separate recovery.
- The original network cause was not persisted, so DNS, timeout, reset, or temporary outage cannot be distinguished retrospectively.
- An unauthenticated GET to Google's API host currently responds in 466 ms. This is present connectivity evidence only, not proof of historical cause or upload success.
- Protocol: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol — metadata POST opens a session; video bytes are sent separately only after its Location is received.

## Plan

1. Reproduce startup transport failure through the existing fake transport; retain quota and auth tests as baseline.
2. Add a bounded retry only to session startup for transient connection failures, with backoff and visible retry progress. Label exhausted errors with the phase and safe network cause codes; never copy credentials, session URLs or raw network messages.
3. Keep accepted/resumable operations on existing recovery paths; never replay the whole upload or metadata publishing action automatically.
4. Verify no duplicate byte uploads, correct per-attempt quota accounting, cancellation, permanent errors, exhaustion and preserved session recovery. Independently review, full local verification, versioned release.

## Result

Implemented in the existing `uploadVideo` fresh-session path, with three startup cycles and existing 401 refresh semantics preserved. Transient HTTP responses honor Retry-After up to 30 seconds; a longer requested wait stops rather than retrying early. No new dependencies or UI surfaces. Resume-probe recovery is unchanged and remains a separate possible improvement.

A metadata POST whose response is lost may leave an unused remote session and consume another YouTube upload-quota attempt when retried. No video bytes can be sent until a Location is received, so this retry never repeats an accepted video upload. Every request is counted by the existing quota ledger.

Baseline: 23 tests across 3 focused files, exit 0. Focused final: 32 tests across 4 files, exit 0, including 9 new real-client startup tests. Customer projects remained byte-identical according to the test harness. Read-only independent reviewer `/root/shared_lookup_fix` approved runtime and final tests without blockers. Test contributor `/root/read_path_inspector` authored only the new regression file and finished without child processes. Full `npm run verify` exited 0: backend 5,221; frontend 1,792; release 36; content-packs 366 passed with 2 skipped. Total 7,415 passed, 2 skipped, no failures. Typechecks, production security, model-drift, typography, changelog and production builds passed. Final artifact pending integration.
