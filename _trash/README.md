# _trash

Soft-delete area for code, scripts, or docs we *think* we don't need but
want recoverable for a few months "just in case". Tracked in git so the
move is auditable and restoration is a simple `git mv` away.

## Convention

- **Preserve the original path under `_trash/`.** A file originally at
  `electron/scripts/migrate-narration.ts` becomes
  `_trash/electron/scripts/migrate-narration.ts`. That way restoration
  is unambiguous — just `git mv` it back.
- **Log every move in the table below.** One row per file. Include the
  date, why we moved it, and the version the move shipped in.
- **Group related moves into one commit** with a clear message
  (`chore(trash): retire X — Y reason`).

## Restoring

```bash
git mv _trash/electron/scripts/migrate-narration.ts electron/scripts/migrate-narration.ts
```

…then remove the row from the table below.

## Permanent deletion

When we're confident something is gone for good (typically after one or
two release cycles of soak time with no regressions), delete it from
`_trash/` in a normal commit. The git history still has it, so true
recovery is always possible via `git log --diff-filter=D --follow`.

## Trash log

| Date | Original path | Reason | Shipped in |
|------|---------------|--------|------------|
| 2026-05-03 | `electron/scripts/migrate-narration.ts` | One-shot M1 migration helper. Idempotent, never wired into `package.json`, served its purpose. Moved whole-file. | v1.0.40 |
| 2026-05-03 | `electron/server/models/types.ts` (`ken_burns?: boolean` field) + `electron/server/generators/video.ts:776-781` (read-side fallback) | Replaced by structured `scene_animation` request field in v1.0.38. Frontend stopped sending `ken_burns` then; only the dead read remained. Snippet: `_trash/snippets/ken_burns-field-removal.md`. | v1.0.40 |
| 2026-05-03 | `frontend/pages/index.vue` (`maybeRestoreLastSession` + auto-restore block) | Auto-restore was kept "for a future opt-in chip" that never shipped. `/last-session` infrastructure stays — it's still load-bearing for the unclean-shutdown banner. Snippet: `_trash/snippets/maybeRestoreLastSession-removal.md`. | v1.0.40 |
| 2026-05-08 | `.claude/worktrees/wizardly-mclean-406edb/`, `.claude/worktrees/loving-diffie-926c5e/`, `.claude/worktrees/goofy-bassi-7f41d1/` | Three Claude Code spawn-task worktrees retired after the audit branch landed in main (merge `66197cb`). All branches deleted, registry pruned. The on-disk trees themselves are gitignored under `_trash/.claude/worktrees/` because each is a full source checkout (50+ MB) — keeping them committed would bloat the repo. Snippet: `_trash/snippets/claude-code-worktrees-removal.md`. | v1.0.72 |
