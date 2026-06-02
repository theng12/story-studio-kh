# docs/

Documentation for Story Studio KH. Everything except `README.md` (install instructions) and `CHANGELOG.md` (release notes) lives in here.

## What goes where

| Folder | Use when you need… |
|---|---|
| [`architecture/`](architecture/) | …to understand how the system is built. Still-true specs: overview, format contract, server mode, offline behaviour. |
| [`operations/`](operations/) | …to *do* something. Checklists, runbooks, manual procedures. |
| [`planning/`](planning/) | …to see what's coming or in flight. Living backlogs with open/in-progress/done flags. |
| [`history/`](history/) | …to read a dated snapshot. Past audits, completed initiatives, pipeline reviews — not specs, not roadmaps, just records of what was true on a given date. |
| [`refactors/`](refactors/) | …to read an in-flight refactor plan. Bigger than a backlog item, narrower than an audit. |

Adjacent to this directory:

- [`../audit-reports/`](../audit-reports/) — the 12-part audit series from sessions 01–12. Lives at the project root because the test suite cites these paths by name; moving them would orphan the citations. See its own README.
- [`../_trash/`](../_trash/) — soft-delete quarantine for retired code/docs. See its own README.

## A few rules

- **Keep `CHANGELOG.md` at the project root** — npm and GitHub both look for it there.
- **History is immutable.** Files under `history/` are dated snapshots. Don't rewrite them when reality changes — write a new one or update the live spec in `architecture/`.
- **One folder per kind of thing.** If you're tempted to drop a new file at the project root, it almost certainly belongs in one of the subdirectories above.
