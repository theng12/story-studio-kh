# Retired Claude Code worktrees — 2026-05-08

Three Claude Code spawn-task worktrees parked under `_trash/.claude/worktrees/`
on 2026-05-08. All three are git-prunable (the registry entries were cleaned
via `git worktree prune` after the move) and the branch refs that pointed at
them have been deleted (`git branch -d`).

The trees themselves are NOT in git — `_trash/.claude/worktrees/` is in
`.gitignore` because each tree is a full source checkout (frontend/,
electron/, audit-reports/, etc.) and committing three of them would balloon
the repo. They're on disk for a one-shot "did I miss anything?" pass, then
deletable with `rm -rf _trash/.claude/worktrees/<name>/`.

## What was in each

### `wizardly-mclean-406edb` — branch `claude/wizardly-mclean-406edb`

The audit-cleanup branch from this session. 7 commits closing HIGH/MEDIUM
findings from the outline-first refactor audit, all merged into main via
the merge commit `66197cb`:

- `0d8974d` harden PUT /outline + POST /expand-chapters validation
- `84d2b5f` enforce per-chapter word floor (120) on the override inputs
- `7c82e0a` OutlineReviewPanel: surface outline-vs-disk title drift
- `2e9f726` collapse /chapter-list + /chapters/:n/content to one mammoth parse
- `e5d7cad` UX papercut cluster — disable buttons through full job lifecycle
- `4af4b94` fix /generate/image-prompts hardcoded 10-chapter multiplier
- `6424a19` log diagnostics on /image-prompts/save folder resolution

Plus the audit plan file at
`/build/.claude/plans/audit-recent-outline-first-script-generic-rainbow.md`
(separate location, not in the worktree).

All commits are reachable from main's history. Recovery isn't really a
concern — the branch ref was the only thing unique here, and even that
can be re-created with `git branch <name> <commit>`.

### `loving-diffie-926c5e` — branch `claude/loving-diffie-926c5e`

Single commit `61e797d` "fix expand-chapters crash + persist
generation_params on v3 sidecar". Already in main's history (was merged
or cherry-picked before this cleanup). No unique work.

### `goofy-bassi-7f41d1` — no associated branch

Stale empty checkout (just .DS_Store + .claude/ subfolder). Wasn't even
registered in `git worktree list`. Inherited from an earlier session that
never produced any commits. Truly dead.

## Removing for real

Once the user has confirmed nothing's needed:

```bash
rm -rf _trash/.claude/worktrees/
```

This snippet can stay in git as the auditable record of what was deleted.
