# history/

Dated snapshots of what was true at a moment in time. **Read-only after the date in the filename.** Don't edit them when reality changes — that's what the live specs in [`../architecture/`](../architecture/) are for.

## Contents

| File | Date | What it is |
|---|---|---|
| [`audit-2026-04-23.md`](audit-2026-04-23.md) | 2026-04-23 | Precursor audit. Set the agenda that later split into the 12-part series under [`../../audit-reports/`](../../audit-reports/). |
| [`audit-2026-05-01.md`](audit-2026-05-01.md) | 2026-05-01 | AFK audit + fix session wrap-up. Listed the 5 commits made, what the audits found, and what was left needing human attention. |
| [`pipeline-audit.md`](pipeline-audit.md) | 2026-05-21 (last reviewed) | Living list of every place in the codebase that makes format/niche-specific decisions. Slightly different from the rest — this one *is* maintained, but the maintenance is "log new findings", not "rewrite past entries." |
| [`perf-overhaul-2026-05.md`](perf-overhaul-2026-05.md) | 2026-05 | Inventory of the episode/ideas load perf overhaul: ~1,600× faster on warm hit. Documents the `episode-status-cache` service and the `useEpisodes` SWR composable. |
| [`fal-model-audit-2026-04.md`](fal-model-audit-2026-04.md) | 2026-04-21 | fal.ai TTS slug audit (Delivery 5). Verified every slug against live fal.ai pages, dropped two non-existent ones (`v2`, `flash-v2.5`), added `eleven-v3`. Two minor follow-ups noted (non-fal provider audit, UI migration notice). |
| [`upload-backlog-2026-05-03.md`](upload-backlog-2026-05-03.md) | 2026-05-03 | Upload Center backlog from the upload-feature audit. All 12 items (P0–P2) shipped v1.0.35–v1.0.48; moved here from `planning/` once fully `[x]`. |

## When to add a file here

When you finish a discrete piece of work big enough that "what we did and why" deserves its own document instead of just a `CHANGELOG.md` entry. Date the filename (`YYYY-MM` or `YYYY-MM-DD`). Don't edit existing files in this directory — write a new one and link from it if needed.

## How this differs from `CHANGELOG.md`

`CHANGELOG.md` is per-version release notes: terse, version-tagged, user-facing. `history/` is the long-form report behind a specific initiative — audits, perf overhauls, architectural one-time decisions. The two complement each other.
