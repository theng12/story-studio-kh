# docs/

Documentation for Story Studio KH. Everything except `README.md` (install instructions) and `CHANGELOG.md` (release notes) lives in here.

## What goes where

| Folder | Use when you need… |
|---|---|
| [`architecture/`](architecture/) | …to understand how the system is built. Still-true specs: overview, format contract, server mode, offline behaviour. |
| [`operations/`](operations/) | …to *do* something. Checklists, runbooks, manual procedures — including [test and release procedure](operations/test-and-release-procedure.md) (how to run the checks and land a release; the rules it serves are in `AGENTS.md`). |
| [`planning/`](planning/) | …to see what's coming or in flight. Living backlogs with open/in-progress/done flags. |
| [`refactors/`](refactors/) | …to read an in-flight refactor plan. Bigger than a backlog item, narrower than an audit. |

Adjacent to this directory, [`../_trash/`](../_trash/) is the soft-delete quarantine for retired code/docs.

## A few rules

- **Keep `CHANGELOG.md` at the project root** — npm and GitHub both look for it there.
- **One folder per kind of thing.** If you're tempted to drop a new file at the project root, it almost certainly belongs in one of the subdirectories above.
