# Symbolic Psychology Studio unblock — progress

## Task 1 evidence reconciliation

Task 1 is complete. The reviewed external evidence is internally consistent: the
overall disposition is `partial-review-complete-blocked`, Oil is individually
`ready-for-owner-stocking`, Recipe/Pastel/Kit remain blocked, all nine review
categories are complete, and the receiver has no pending reviews. This record is
documentation only; it does not authorize stocking or any external mutation.

### Plan and commit baseline

- Unblock-plan baseline: `7cf294adc6d6d7cbf4bcb30e9d40003a5da388af`
  (`docs: plan symbolic psychology studio unblock`).
- Prior plan commit at documentation-task start:
  `852f6411ba673488eb48d9e600f6aa8487d45649` (`docs: correct symbolic successor
  unblock plan`).
- Current plan commit: `f04d3726edc9002f9cf99774f8e0d9275595a7e0`
  (`docs: preserve legacy selection and summary evidence`). This coordinator
  commit is outside the Task 1 evidence-record commit.
- Task 1 audit commit consumed: `43aa024e3705354e54f1c2df9d5df43743eec38d`
  (`test(content-packs): audit completed review truth`).
- Documentation-task start HEAD: `852f6411ba673488eb48d9e600f6aa8487d45649`.

### External evidence after values

Observed at `/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23/`; external JSON was not modified in this task.

| File | SHA-256 after | Bytes |
| --- | --- | ---: |
| `candidate-handoffs.json` | `127d80aa7e33abf255cc7d12d12ef0da9587beb6ce7be94448779e09643251d5` | 26,035 |
| `review-requests.json` | `e7b2225228bfb7a3dd6bf315f586c62751e0abadbf9635b9bf42b2b678d69761` | 11,520 |
| `receiver-handoff.json` | `6bb9a9eeafef64406747c7390bd27987c5c183b3870404b4dc88f1cb1e9e360a` | 9,246 |
| `evidence-ledger.json` (preserved historical ledger) | `6fe1650aeca9d2cc76307ecbc3e7dc0893e1c886b20c702c10118cb6ed766a5e` | 22,039 |

The historical ledger remains byte-identical and its existing `component_summary`
entries remain grandfathered evidence. No source pack, registry, archive,
quarantine item, publisher code, or external JSON was changed.

### Preserved authority, quarantine, and Oil evidence

- Authority remains fail-closed: the structured Recipe request has
  `quote_approved: false`, `job_submission_authorized: false`, and
  `generation_authorized: false`; both replacement requests are capability-and-
  quote-only. The receiver explicitly records upload, drafts, pricing,
  purchase/grant, signing, publication, and GenStudio mutation as not done.
- Active archives contain only Oil:
  `archives/com.storystudio.pack.style.oil-painting-classical@1.0.0.sspack`,
  SHA-256 `95f6271a0f56afd850c1548bfff703177ba9b5977584093fea833f1bbf02e3fc`,
  403,483 bytes.
- Blocked diagnostic evidence remains quarantined: Pastel
  `d70083a8bddc67e032d465c63f91845d6178ae60c785d6aba9ce4e7db357a054`, blocked
  Recipe `559e82c35197f4f56dc929c8bfa49faaf64a74cf4c21407eb219cc706334e7e6`,
  superseded Recipe `64e0ec9afcd86b18e9655999de84e5bc4b7f3410997d3731334cbe0a208a8ebb`,
  and rejected preview #4 `fb5be086761b7effc5ae325ac8d2458f7da071c710c3e4dcfb5155fb523b1166`.
  Kit and Gothic have no retained archive.

### Verification

- `env -u STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
  — 2 passed, 0 failed, 2 intentional skips.
- `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT=/build/Developer/_handoffs/artifacts/story-symbolic-psychology-studio-wave-1-2026-08-23 node --test scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs`
  — 4 passed, 0 failed, 0 skipped.
- Independent read-only comparison and stale-string scan are recorded in
  `evidence-reconciliation-review.md`.

## Next task

Task 2: add and review the multi-Style bundle publisher/application support.
Preserve the exact ordered Formula → Topic → Recipe → Pastel → Impasto → Oil
closure, keep apply explicit and atomic, and retain project-pin-first,
fail-closed semantics. Do not begin successor authoring, stocking, publishing,
or any external mutation as part of that task.
