# audit-reports/

The 12-part audit series from sessions 01–12. Treat these as **read-only specifications** for the bugs and findings the test suite regression-tests against.

## Contents

| # | File | Topic |
|---|---|---|
| 01 | [`01-threat-model.md`](01-threat-model.md) | Threat model — what we're defending against |
| 02 | [`02-secrets.md`](02-secrets.md) | Secret management |
| 03 | [`03-license.md`](03-license.md) | Licensing posture |
| 04 | [`04-threat-model-personal.md`](04-threat-model-personal.md) | Personal-use threat model refinement |
| 05 | [`05-portability.md`](05-portability.md) | Project transfer between machines |
| 06 | [`06-providers.md`](06-providers.md) | AI provider integrations |
| 07 | [`07-ffmpeg.md`](07-ffmpeg.md) | FFmpeg invocation safety |
| 08 | [`08-persistence.md`](08-persistence.md) | On-disk state durability |
| 09 | [`09-jobs.md`](09-jobs.md) | Job queue + execution |
| 10 | [`10-uploads.md`](10-uploads.md) | YouTube upload pipeline |
| 11 | [`11-operator-ux.md`](11-operator-ux.md) | Operator UX |
| 12 | [`12-quality-and-summary.md`](12-quality-and-summary.md) | Overall quality + summary |

## Why this directory stays at the project root

It looks like it belongs in [`../docs/history/`](../docs/history/) — it's dated, the work is done, the format is "audit." But moving it would break ~10 backend test files that cite paths like `audit-reports/10-uploads.md M4` in their leading comments to document the bug they regression-test for.

The tests use those citations as the spec they pin behaviour against. The audit prose is the source of truth for *why* a given test exists. Moving the directory orphans those citations — re-pathing them across all tests is doable but high-risk and provides no benefit beyond aesthetic tidiness.

So the rule is: **`audit-reports/` stays at the project root.** Future audits go under [`../docs/history/`](../docs/history/).

## When to edit

Almost never. These are dated snapshots. If a finding has been fixed and you want to mark it, append a one-line note at the top of the section ("**Fixed in v1.0.X — see CHANGELOG entry.**") rather than rewriting the section.
