# operations/

How to *do* things. Manual procedures, pre-flight checklists, runbooks. Anything you'd want in front of you while operating the app rather than while reading the code.

## Contents

| File | Purpose |
|---|---|
| [`qa-checklist.md`](qa-checklist.md) | Manual QA pass before cutting a release. Disk-space rule, smoke tests across the pipeline, things that automated tests don't cover. |
| [`security-privacy.md`](security-privacy.md) | Electron trust boundary, GenStudio-key handling, privacy guarantees, packaging checks, and unresolved production gates. |
| [`desktop-release.md`](desktop-release.md) | Deterministic arm64 build/DMG smoke procedure, clean-install and upgrade gates, and external signing/notarization requirements. |

## When to add a file here

If you find yourself writing the same sequence of clicks/commands in three different sessions — operator runbook, recovery procedure, release ritual — it belongs here. Anything tied to a specific past incident is better suited to [`../history/`](../history/).
