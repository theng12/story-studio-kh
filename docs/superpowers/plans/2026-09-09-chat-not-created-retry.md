# Resume verified uncreated language requests

Owner direction: fix the SS0175 chapter expansion Retry loop; implement, locally verify, independently review, integrate, and build the app. Base `773dc6f6`, version 1.4.133. No production jobs or paid calls are part of verification.

## Evidence and boundaries

SS0175 has twenty saved chapter files. Its next batch is chapters 21–23. The persisted job carries a pending chat key, retained request preview, recovery-only markers, and `not_created` reconciliation with zero recorded settlement. Retry uses that same key only for read-only lookup, which returns 404 indefinitely. The original interruption is not established. Version 1.4.133 fixes a similar image case, not this language path.

Applicable rules: preserve accepted/uncertain paid-work recovery and exact identities; live catalogue limits; preserve completed chapter assets and account evidence; never change customer data to hide a bug; isolated worktree, one test suite at a time, full local verification, no GitHub compute, version/changelog/DMG release integrity. No launcher files are in scope.

## Implementation

1. Reproduce the missing-request Retry behavior with focused tests before changing production logic.
2. Add the smallest verified prepared/uncreated language-request resumption path. Require exact identity and matching retained request evidence, reject accepted/conflicting/unproven evidence, and resume the same key only after authoritative absence. Keep ordinary unknown/accepted 404 and transport/5xx recovery non-submitting.
3. Exercise queue-level chapter Retry and continued later batches so recovery markers do not block never-started remaining work. Preserve completed chapters. Keep explicit regeneration semantics separate.
4. Review misleading queue/settlement feedback only where this path needs correction; avoid unrelated UI redesign.
5. Run focused regressions, independent review, full `npm run verify`, release 1.4.134/version/changelog checks; confirm Actions disabled, commit/push/PR/merge, sync main, build `npm run dist:smoke`, and record actual outcomes.

## Delegation

- `plan_contract`: initial partial implementation preserved, then handed off. Its first red test failed but modeled narrative repair rather than the reported normal batch; it is not completion evidence.
- `chat_retry_fix`: same feature worktree/base; complete and simplify client/queue/generator correction against the actual normal batch, with red/green focused regression evidence. No version/docs/commit work. Completion proof: focused backend runner with named affected files, exit status and test totals.
- Root: inspect cross-layer evidence and later-batch behavior, maintain scope/release documentation, run final gates and integration.
- `plan_review`: independent diff and safety review after implementation; no competing tests. Completion proof: concrete findings or approval against frozen diff.

## Verification cases

- Verified uncreated request: by-key 404 then same key and identical request dispatch; no duplicate distinct provider submission.
- Accepted ID, uncertain outcome, unavailable lookup, changed model/prompt/budget, or incomplete preview: no new paid submission.
- Completed earlier chapters remain untouched; subsequent never-started chapter batches can proceed.
- Lost response after resumed submission reconnects by identity; cancellation and repeated Retry remain safe.

## Review decisions

- This is an explicit manual Retry of work recorded as never created, on the currently configured GenStudio connection. It is not an automatic replacement or permission to bypass accepted/unknown task recovery. Historical request previews do not retain account provenance; requiring an unavailable historical identity would strand existing affected jobs. The API key is captured for an execution; the retry must also keep lookup and submission on one server URL.
- Reject a pending not-created row when accepted evidence shares its request key. Require any recorded settlement fields to be finite zero. Match the retained full request against live prepared model, messages, output budget, format and sampling fields before reusing the key.
- Regression fixtures must represent normal narrative batches and actual conflicting persisted rows, rather than coalesced evidence or repair-only prompts.

## Verification progress

- Independent review approved the final chapter-only patch. A broader evidence-merge change was removed after it interfered with existing audio/subtitle retry behavior; the conflicting-evidence test now loads a historical disk fixture without modifying production merging.
- Final focused run: 105 tests and 16 suites passed across chat retry, durable recovery wiring, narrative continuation, Pipeline policies, job queue, and audio/subtitle explicit regeneration. TypeScript and diff checks passed.
- The initial full run found the audio/subtitle regression and was intentionally stopped; it is incomplete and is not release evidence. The final `npm run verify` passed (exit 0): backend 5,005 across all 441 files, frontend 1,565, release 36, content packs 366 passed and 2 optional external-evidence checks skipped. Total 6,972 passed. Lint had no errors (existing warnings remain); type checks, source/built security, model drift, release checks and production builds passed. Log: `/tmp/story-chat-retry-final-verify.log`. The optional rendered-pixel suite lacked FFmpeg in the isolated worktree; it will be checked with the main checkout release tools.

Status: implementation, independent review and full verification complete. Integration and canonical installer/launch verification follow under the standing repository authorization. No paid calls or customer jobs were changed; all 20 original SS0175 chapter hashes remain unchanged.
