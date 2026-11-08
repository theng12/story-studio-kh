# Story release proof and publisher (schema 1 + schema 2 composite)

`story_gate_proof.verify()` is the fail-closed check `ship-story.py` runs before it stages,
publishes, or asks the mini to update. It is offline: it reads evidence and never writes it.

- **Schema 1** is the original contract and is unchanged: one ten-step gate that exited 0 on
  the exact checkout being shipped.
- **Schema 2** is the composite contract for a gate that stopped on **one failing test lane**.
  It re-reads that original proof unchanged, verifies the three other lanes as separate runs,
  and reconciles the failed lane file by file against a focused rerun. It is not a bypass:
  every cited log and coverage file is re-hashed, every expected test file is recomputed from
  the candidate git tree, and every test file's bytes must match the candidate commit.

There is no second test runner and no bypass flag.

## Files

| File | Purpose |
| --- | --- |
| `story_gate_proof.py` | Schema-1 verifier and the schema dispatcher. |
| `story_composite_proof.py` | Schema-2 verifier. |
| `ship-story.py` | Publisher. Calls `verify(..., repo=P)` with its actual publishing checkout. |
| `test_story_gate_proof.py` | The original 21 schema-1 tests, unchanged. |
| `test_story_composite_proof.py` | Offline schema-2 accept/reject tests. |
| `../__tests__/composite-proof.test.mjs` | Release-lane contract: runs both Python suites offline and asserts exit 0 plus their expected summaries. |

## API

```python
import story_gate_proof

summary = story_gate_proof.verify(
    proof_dir,      # directory holding gate-result.json
    head,           # candidate commit about to be shipped
    tree,           # candidate tree
    diff_sha,       # sha256(git diff --binary HEAD); must be EMPTY_DIFF
    version,        # package.json version (required for schema 2)
    repo=P,         # the publishing checkout; ignored by schema 1, required by schema 2
)
```

`verify()` reads `gate-result.json` and dispatches on `schema`. `ProofError` is the only
rejection type. `ship-story.py` catches it and prints `STOP: full-gate proof rejected: ...`.

## Schema 1 (unchanged)

The existing `gate-result.json` contract is untouched. All ten canonical steps must be
present once, exit 0, logs re-hashed, suite lanes at their exact discovered coverage floor,
no `PARTIAL RUN`, identity before/after bound to the shipped HEAD/tree/empty diff.

## Schema 2 proof

`proof_dir/gate-result.json`:

```json
{
  "schema": 2,
  "kind": "story-composite-gate-proof",
  "gate": "story-final-gate-composite",
  "version": "1.4.389",
  "head": "<candidate commit>",
  "tree": "<candidate tree>",
  "diff_sha256": "<sha256 of empty diff>",
  "source_identity_unchanged": true,
  "overall_exit": 0,
  "partial_run": false,
  "steps_expected": 10,
  "steps_completed": 10,
  "identity_before": "<proof_dir>/identity-before.txt",
  "identity_after": "<proof_dir>/identity-after.txt",
  "original_gate": {
    "proof_dir": "<schema-1 proof directory>",
    "gate_result_sha256": "<sha256 of that gate-result.json>",
    "manifest_sha256": "<sha256 of that manifest.jsonl>",
    "head": "<original gate commit>",
    "tree": "<original gate tree>",
    "version": "1.4.389",
    "diff_sha256": "<sha256 of empty diff>",
    "overall_exit": 1,
    "failed_step": "07-test-backend",
    "steps_completed": 7
  },
  "lanes": {
    "07-test-backend": {
      "status": "reconciled",
      "source_commit": "<original gate commit>",
      "exit": 1,
      "log": {"path": "<absolute>", "sha256": "<sha256>"},
      "exit_receipt": {"path": "<absolute>", "sha256": "<sha256>"},
      "coverage": [{"path": "<absolute coverage .jsonl>", "sha256": "<sha256>"}],
      "replacement": {
        "source_commit": "<focused run commit>",
        "files": [
          "electron/server/__tests__/final-video-check.test.ts",
          "electron/server/__tests__/outro-closing-music.test.ts"
        ],
        "exit": 0,
        "review": "why each file is re-run; required when a file beyond the failed set is included",
        "log": {"path": "<absolute>", "sha256": "<sha256>"},
        "exit_receipt": {"path": "<absolute>", "sha256": "<sha256>"},
        "coverage": [{"path": "<absolute coverage .jsonl>", "sha256": "<sha256>"}]
      }
    },
    "08-test-frontend": {
      "status": "ran",
      "source_commit": "<run commit>",
      "exit": 0,
      "log": {"path": "<absolute>", "sha256": "<sha256>"},
      "exit_receipt": {"path": "<absolute>", "sha256": "<sha256>"},
      "coverage": [{"path": "<absolute coverage .jsonl>", "sha256": "<sha256>"}]
    },
    "09-test-release": { "status": "ran", "...": "same shape" },
    "10-test-content-packs": { "status": "ran", "...": "same shape" }
  },
  "reviewed_changes": {
    "docs/tasks/HANDOFF.md": {"review": "docs only", "covered_by": []},
    "electron/server/__tests__/final-video-check.test.ts": {
      "review": "focused replacement covers the changed diagnostic",
      "covered_by": ["electron/server/__tests__/final-video-check.test.ts"]
    },
    "electron/server/lib/final-video-check.ts": {
      "review": "runtime diagnostic; caller tests named",
      "covered_by": [
        "electron/server/__tests__/final-video-check.test.ts",
        "electron/server/__tests__/outro-closing-music.test.ts"
      ]
    }
  },
  "limits": [
    "Not a successful rerun of the original full backend gate.",
    "Caller coverage is a human review mapping; test-byte identity alone does not prove behaviour."
  ]
}
```

### Lane statuses

- `original` — the lane ran inside the original gate before the failure and exited 0. Its
  `log` and `exit_receipt` must be the original gate's own log and exit file.
- `ran` — a separate full run of the lane at `source_commit`, exit 0.
- `reconciled` — exactly the original `failed_step`. Its primary `log`/`exit_receipt` must be
  the original gate's failing log and exit file. `replacement` carries the focused rerun.

Exactly the four suite steps must appear. The original `steps_completed` plus the number of
`ran` lanes must equal 10.

### What the verifier recomputes

- **Expected files**: the candidate tree is read with `git ls-tree`, non-recursively, exactly
  as the runners discover:
  - `electron/server/__tests__/*.test.ts`
  - `frontend/__tests__/*.test.ts`
  - `scripts/release/__tests__/*.test.mjs` (the release lane now discovers 13 files,
    including `composite-proof.test.mjs`)
  - `scripts/content-packs/__tests__/*.test.mjs`

  Missing, extra, duplicate or non-exact file sets are rejected.
- **Coverage**: every cited coverage JSONL is re-hashed. Each record must be an absolute path
  ending with one expected file, have `success`/`tests`/`suites`/`failed` types, and reach at
  least one test. The records must cover the expected set exactly once.
- **Logs**: every cited log is re-hashed. The raw node summaries must add up, report
  `fail=0`/`cancelled=0` for a passing run, and their tests/suites must equal both the log's
  coverage line and the cited coverage records. The coverage floor must equal the exact file
  count, and the backend sentinel must be present. A full lane carrying `PARTIAL RUN` is
  rejected.
- **Focused rerun**: `PARTIAL RUN` is expected. Its `--only ... N file(s) SELECTED` count must
  equal the replacement file count, and every replacement basename must be listed. Its exit
  must be 0, its summaries clean, and its coverage exactly the replacement files.
- **Failed set**: derived from the original coverage, never declared. Every failed file must
  be in `replacement.files`. Every non-replaced file must have `success=true` and `failed=0`.
  A replacement file beyond the failed set needs `replacement.review`.
- **Test bytes**: for every expected file, `git rev-parse <source_commit>:<file>` must equal
  the candidate blob. A test changed after its lane ran cannot be reused; it must be re-run.
- **Source association**: `original` and `reconciled` lanes must cite the original gate head
  as `source_commit`. A later descendant cannot be cited to make changed test bytes look
  unchanged. Only a `ran` lane may cite a descendant.
- **Failed counts**: the sum of `failed` in the cited coverage must equal the raw summary's
  total `fail` count.
- **Source ancestry**: every `source_commit` must be an exact commit and an ancestor of the
  candidate. The candidate checkout must be clean, on the exact HEAD/tree, with an empty
  `git diff --binary HEAD`; the proof identity before/after must agree.
- **Original proof**: `gate-result.json` and `manifest.jsonl` hashes are re-derived, every
  step log and exit file is re-checked, the canonical step prefix and order are enforced,
  and the original nonzero exit is preserved. It is never relabelled as a pass.
- **Reviewed changes**: `git diff --name-only <base> <candidate>` is recomputed for the
  original gate commit and every lane/replacement source commit. `reviewed_changes` must be
  the exact union. A changed test file must name itself in `covered_by`; a changed product
  path must name at least one certified test file; docs may have an empty list.

### Provenance note

Schema 2 does **not** invent a historical toolchain fingerprint. The original schema-1 proof
is cited by path and hashes; if the old gate recorded no toolchain fingerprint, none is
required.

## Assembling the 1.4.389 proof (no new runner)

The reviewed record
`/build/Developer/_orchestra/story-lead/release-389-qualification-20261108/reconciliation-r2.json`
is input, not a proof. Map it as follows, writing the new `gate-result.json` and identity
files into a fresh proof directory:

| Proof field | Source |
| --- | --- |
| `original_gate` | `gate-r1/gate-result.json` + `gate-r1/manifest.jsonl` in the qualification directory; `head` = `e9dceed0...`, `failed_step` = `07-test-backend`, `overall_exit` = 1, `steps_completed` = 7. |
| backend lane `coverage`, `log`, `exit_receipt` | `reconciliation-r2.json` `original_coverage_evidence`, `focused_log` (use the gate's `gate-r1/07-test-backend.log` for the primary log), and the gate's exit file. |
| backend `replacement` | `source_commit` = `ec6b48e...`; `files` = `electron/server/__tests__/final-video-check.test.ts`, `electron/server/__tests__/outro-closing-music.test.ts`; `coverage` = `focused_coverage_evidence`; `log`/`exit_receipt` = `focused_log`/`focused_exit`; `exit` = 0; `review` explains the outro caller rerun. |
| frontend / release / content-packs lanes | `remaining_lanes[]`: `source_commit`, `exit`, `log`, `exit_receipt`. The release lane must be **re-run after the new contract file is committed**, so it discovers 13 files; use its post-commit `log`/`exit_receipt`. For each `coverage`, use the `coveragePath` entries in that log's `aggregate suite coverage: ... inputs=[...]` line and hash those files. |
| `reviewed_changes` | `scope_review.changed_paths` from `reconciliation-r2.json`, plus the integration-source diff (`docs/tasks/HANDOFF.md` from `ec6b48e...` to the candidate), plus the proof-tooling paths added by this change. Map each test path to itself; map the Python helper/publisher/README paths to `scripts/release/__tests__/composite-proof.test.mjs`; map the product path to the focused caller tests. |
| candidate `head` / `tree` / `version` | The shipped main commit (`d5756e482...`), its tree, and `1.4.389`. |
| identity files | Capture `head`, `head_tree`, `diff_sha256` (empty), and clean `status_porcelain` for the candidate before and after assembling the proof. |

Do not copy `backend_files` from `reconciliation-r2.json` into the proof: the verifier derives
every per-file result from the cited coverage and checks its bytes against the candidate. Do
not edit the original gate's `gate-result.json`, logs, exits, or coverage files.

## Publisher

`ship-story.py` still checks, independently of the proof:

- clean `main`, `HEAD == origin/main`, and the exact `package.json` version;
- exactly one matching `dist/*<version>*arm64*.dmg`, hashed from disk;
- exclusive fsynced intents, one publish, one normal mini check-in, and readback.

The proof is required before the first publish or mini-update mutation. `--observe` remains
GET-only and needs no proof. `ship-story.py` passes `repo=P`, its actual publishing checkout;
the schema-2 verifier never guesses the repo.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -I -B scripts/release/orchestration/test_story_gate_proof.py
PYTHONDONTWRITEBYTECODE=1 python3 -I -B scripts/release/orchestration/test_story_composite_proof.py
node --test scripts/release/__tests__/composite-proof.test.mjs
```

`-I` ignores `PYTHON*` environment variables, so `-B` (and `sys.dont_write_bytecode`
inside each suite) keeps the checkout free of `__pycache__`. The Node contract spawns the same
two commands with `PYTHONDONTWRITEBYTECODE=1`, asserts exit 0 and the expected 21/24 test
summaries, and imports no publisher module. Both Python suites use only the standard library,
temporary git repos, and synthetic logs. They do not run a Story suite, and the Node contract
is discovered by the release lane as a normal 13th release test file.

## Limits

- `covered_by` is a human caller-review mapping. The verifier proves the named test bytes are
  the candidate bytes and that the file sets and logs are internally consistent; it cannot
  prove that a product change is behaviourally safe.
- The proof does not check the DMG. The publisher still does, as above.
- A schema-2 proof requires the candidate version to equal the original gate version, so a
  version bump after the gate forces a fresh cheap-step run.
