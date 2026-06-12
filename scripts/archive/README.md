# scripts/archive

One-off migration scripts that have already been executed against the real
projects. Kept for reference (they document how a migration was done), but
they are NOT part of the build and should not be run again.

- `normalize-icloud-project.ts` — 2026-05-04 one-shot normalization of the
  iCloud project folder structure. Executed successfully; superseded by the
  in-app folder-migration service.
