# Local release acceptance — 2026-09-21

## Current state

Source **1.4.213** is integrated into `main` by
[PR #123](https://github.com/theng12/story-studio-kh/pull/123).
Reviewed repair commit: `8453e1480d7233e7579cab4537b8e3f1310eb319`;
main merge: `d51849be32ece2dbde9176ca7928c5889e583e0e`.
The merged Git tree exactly matches the reviewed/tested recovery tree. The
official main-built arm64 DMG passed artifact, dependency and isolated launch
verification. **The local unsigned release is complete and installed.** This is
not a signed/notarized public release or an exhaustive historical-bug sign-off.

The owner selected **fresh setup on this Mac**. No old Library restoration is
required. GenStudio, Content Store and optional YouTube access must use normal
authentication; no credentials, purchased ownership or old media were invented.

## Use on this Mac

`/Applications/Story Studio KH.app` is installed and open at `/welcome`.
Its native first-run screen was inspected through accessibility and a screenshot:
the Library field, Browse and Use this folder controls are visible and reachable.
The user can accept the suggested Documents Library or choose another location,
then configure normal GenStudio/Store access and optional YouTube authentication.
No Library location was selected on the user's behalf.

Installer: `dist/Story Studio KH 1.4.213-arm64.dmg`, **241,994,638 bytes**.
SHA-256: `addf94fb8fe727356043cdb43afffb5f1b1cfcbba5b50ac27b63935f6297dcc8`.
The installed `app.asar` is byte-identical to the main-built bundle; main package,
bundle Info.plist and bundled package.json all report **1.4.213**.

## Accepted repair scope

- Published model limits/options remain live; unpublished output ceilings are
  omitted, malformed ceilings refused, and explicit allowances disclosed.
- Preview/fingerprint containment, Content Pack recovery evidence and visible
  notices, runtime version reporting, and compatible dependency updates.
- Authoritative audio/readiness and failed-measurement reporting; deliberate
  no-op completion preserved while missing explicitly requested items fail.
- Scene Plan continuation, outline headroom, current whole-track transcription,
  full selected TTS activation, and paid provider-identity recovery.
- Exact/durable external-media copy before deletion, scheduling compensation,
  current upload metadata, exact Content Pack identity, and damaged reinstall.
- Live Images/Motion choices, stale-confirmation refusal, busy-label binding,
  safe older Research records, and deliberate disclosure/default restoration.
- B-Roll requires measured audio and video coverage of its authoritative
  narration; ambiguous raw narration and invalid staged output cannot be promoted.

The orchestrator reviewed the surviving inherited diff groups and the current
repairs. Independent reviewers closed the scoped containment, quarantine,
storage, B-Roll and TTS findings. Review is not exhaustive defect discovery.

## Verification checkpoint

| Check | Actual result |
|---|---|
| Corrected full frontend | Exit 0; 1,875 passed, 203 suites, 209/209 files, 2,078 marks; no failures/skips |
| Final TTS/whole-track/strict-I/O selection | Exit 0; 15/15 tests, 0 suites, 4/4 files, 15 marks; 505 files excluded; configured-projects sentinel unchanged |
| B-Roll affected selection | Exit 0; 41/41 tests, 6 suites, 6/6 files, 47 marks; 503 files excluded; sentinel unchanged |
| Four dependency audits | Exit 0 each; root/frontend, production/all each report zero vulnerabilities |
| Full release lane | Exit 0; 36/36 tests, 4 suites, 4/4 files, 40 marks |
| Full Content Pack lane | Exit 0; 368 tests, 366 pass, 2 external-evidence skips, 0 suites, 38/38 files, 368 marks |
| Initial final full verification | Exit 1 in backend: 5,579 tests, 5,569 pass, 9 fail, 1 skip, 695 suites, 509/509 files, 6,274 marks; sentinel unchanged. All nine failures corrected in test fixtures/contract assertions; focused groups passed 16/16, 25/25 and 6/6 |
| Second full backend attempt | Exit 1; 5,579 tests, 5,577 pass, 1 fail, 1 skip, 695 suites, 509/509 files, 6,274 marks. Only the five-part TTS fixture exceeded its inherently insufficient four-second wait; no production Resume defect was established |
| Corrected TTS lifecycle fixture | Three consecutive exits 0; each 6/6 tests, 0 suites, 2/2 files, 6 marks, 507 excluded, sentinel unchanged. Exact two-part workload plus exact-job worker-release cleanup; independent source approval |
| Final full backend | Exit 0; 5,579 tests, 5,578 pass, 0 fail, 1 platform-alias skip, 695 suites, 509/509 files, 6,274 marks; configured-projects sentinel unchanged. TTS pause/resume also passed in this full run |
| Final lint/typechecks | Exit 0; lint has 0 errors and 1,925 warnings; Electron and frontend typechecks passed |
| Corrected production build | Exit 0; changelog, typography, source/built security, model-drift (707 files, 38 justified annotations), release contract, frontend generation and Electron compilation passed. The prior chain exited 1 on two fixed Store-source discriminator annotations; only comments changed afterward, not behavior or the checker |
| Main-built official `dist:smoke` | Exit 0 from clean main `d51849be`; arm64 v1.4.213, ad-hoc signature/no Developer ID, DMG mounted read-only, 98 packaged dependencies, isolated health + Upload Center route smoke passed |
| Explicit `verify:deps` and `verify:launch` | Exit 0 each; 98-package closure; health reports v1.4.213 and boot_complete true; fresh unconfigured Upload Center response verified; booted/served in 1,142 ms then quit cleanly |
| Installed-app first run | Installed to previously absent Applications path; version and app.asar comparison passed; native welcome screen visually verified and left open |

Filtered selections are not the backend release gate. The completed full gate
must cover every backend file. Failed attempts are retained in the workflow
ledger rather than re-labelled as passes.

Across the four complete test lanes: **7,858 tests, 7,855 passed, 0 failed,
3 explicit skips**. The original combined `npm run verify` failed; the corrected
lanes and build were verified separately and are not relabelled as one green
combined invocation. Lint and Nuxt retain non-fatal warnings.

The first main packaging attempt encountered an interrupted Electron download
and was stopped (exit 1) before packaging. The partial official v43.4.0 arm64
archive was resumed over HTTP/1.1, then matched the package's pinned SHA-256
`827f9f182566f46846377575b51c547b9926b111637313a373b6f717462aebac`.
Electron's own installer consumed the verified cache. The unchanged official
`dist:smoke` command then completed successfully; no worktree DMG was used.

## Evidence boundaries and remaining work

- [The 89-candidate ledger](../audit/2026-09-20-candidate-status.md) contains
  25 source-confirmed, 24 focused-green, 30 open, 2 partial, 1 duplicate,
  3 dormant and 4 retracted rows. These are evidence categories, not 89 bugs
  fixed or 30 confirmed defects. Unverified historical claims remain follow-up.
- Rendered disposable-browser checks covered first-run setup/recovery, audit
  uncertainty, live model choices and narrow-layout reachability. They are not
  proof of live GenStudio generation or real YouTube uploads.
- No paid generation, real upload, public signing/notarization, publication,
  deployment or GitHub-hosted Actions were used. Actions must stay disabled.
- Two Symbolic Psychology external-evidence checks need the unavailable
  `STORY_SYMBOLIC_PSYCHOLOGY_EVIDENCE_ROOT`; do not describe them as passed.
- The storage `/var` alias case is platform-conditional. Node's path-based
  removal still has a final external check-to-unlink race; physical power-loss
  recovery is not proven. TTS activation is not claimed to be a universal
  multi-file crash transaction. Its disposable queue fixture now waits for
  the exact worker's slot release before deleting temporary data.
- Active audio-file selection is distinct from current-script freshness.
  Raw-versus-transformed script hashing/no-selector quality coverage remains a
  separate investigation. Reusable Scene Plan guidance awaits a persistence
  choice and was not speculatively implemented.
- Final code-only Graphify: 22,589 nodes/54,449 edges, ignored by Git, no paid calls.
  `useInstallQueue.ts` has a known partial AST extraction warning; graph leads
  were checked against source.
- Verification host: arm64, Node 26.8.2/npm 11.19.1, not an exact reproduction
  of the old computer's Node 24.15.0/npm 11.12.1 environment.

Detailed chronology: [workflow progress](../audit/2026-09-20-workflow-progress.md).
