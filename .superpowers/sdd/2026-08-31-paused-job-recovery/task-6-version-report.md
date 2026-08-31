# Task 6A release metadata report

## Result

Release metadata for the approved paused-job recovery branch was updated to
v1.4.90 in commit `ec123adb` (`chore: release v1.4.90`). The customer-facing
changelog entry is newest-first and covers safe recovery from temporary
connection/capacity holds, preserving completed and accepted work, retrying
only missing work through normal safeguards, scoped Paused filtering/rejoin,
immediate feedback, and compact-screen usability. It does not promise that
external failures can never occur and does not expose internal/provider terms.

## Verification

- `npm version 1.4.90 --no-git-tag-version` — completed; no tag created.
- Package, lockfile, lockfile root, and newest changelog entry all report
  `1.4.90`.
- `npm run check:changelog` — passed: package, lockfile, and newest What's New
  entry agree on v1.4.90.
- `git diff --check` — passed.
- Exact diff inspected: only `package.json`, `package-lock.json`, and
  `CHANGELOG.md` changed in the release commit.

No behavior, dependency, customer-data, build, tag, push, merge, package,
publish, deploy, upload, or install operation was performed.
