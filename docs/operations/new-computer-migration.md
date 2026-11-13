# New-computer migration checklist

Use this checklist to move Story Studio development and local customer state to
another Mac without treating build output or a copied secrets file as the
source of truth.

For the interrupted-audit recovery, start with the dated
[2026-09-20 handoff](../handoffs/2026-09-20-new-computer.md). It identifies the
GitHub recovery branch; the default branch alone does not contain that work.

## 1. Preserve the Git-tracked repository

- Make sure every wanted change is committed and available from an approved
  remote or another recoverable Git transport. An uncommitted worktree is not a
  backup.
- Clone the repository on the new computer and check out the accepted commit.
- The tracked repository already contains the Content Pack sources and registry,
  release plans and tests, and the canonical developer skill packages under
  `developer-migration/codex-skills/`.
- Recreate dependencies from the lockfiles:

  ```bash
  npm ci
  npm --prefix frontend ci
  ```

## 2. Install the canonical Story authoring skills

The five authoritative, Git-tracked packages live under
`developer-migration/codex-skills/`. Do not make installed copies under
`~/.codex/skills/` the migration authority.

From the cloned repository root:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --install
node scripts/developer/sync-story-authoring-skills.mjs --check
```

The check must report five packages and 13 files matching byte-for-byte.

## 3. Preserve projects and durable local state

- Back up the effective Library selected by `app-settings.json -> library_root`.
  `projects_root_override` is a legacy upgrade fallback, not the current setting.
  Fresh installs ask the user to choose a Library, suggesting
  `~/Documents/Story Studio KH`; the Application Support projects path is only
  a path-resolution fallback before selection. Confirm the effective path in
  Settings instead of assuming either location contains the user's work.
- Project directories contain project configuration, jobs, scripts, prompts,
  generated images/audio/video, user templates or forks, and per-project
  YouTube OAuth tokens. Treat them as customer data, not build output.
- Preserve `~/Library/Application Support/Story Studio KH/` when local settings,
  installed Content Packs, retained Store proofs, or offline operation must
  survive. Important paths include:
  - `app-settings.json`
  - `app-secrets.json`
  - `content-packs/state.json`
  - `content-packs/commerce-state.json`
  - `content-packs/installed/`
- Preserve an old `named-roots.json` with the backup if present as historical
  migration evidence; it is retired and must not be restored as a current
  location configuration system.
- Revalidate machine-specific absolute paths, FFmpeg locations,
  and external media roots after migration. Copying an old path does not make it
  valid on the new computer.

## 4. Handle secrets and Store anchors safely

`app-secrets.json` is a plain JSON file with owner-only `0600` permissions. It
holds the Gateway key, YouTube/social credentials and the Studio Library
public-key anchors; Story Studio does not use the macOS Keychain or Electron
`safeStorage` (owner 2026-11-13). Copying the file carries the values, so treat
the copy as a credential export.

- Prefer re-entering provider credentials in Story Studio on the new Mac and
  performing an authenticated Studio Library restore; copy the file only over a
  trusted channel and keep it `0600`.
- Installed Studio Library content keeps working without re-verification; a new
  download needs verified trust and is refused if it cannot be verified.
- Move ignored `.env*` files, Apple signing certificates, notarization
  credentials, and other developer secrets only through an approved secret
  manager or protected OS credential store. Never commit them.

## 5. Preserve cross-repository handoffs

The handoff ledger is outside the Story repository. Preserve the complete
`/Users/<account>/Developer/_handoffs/` directory, including its README and
recoverable `_handoff-trash/` history where present. Recreate the path for the
new account instead of retaining the old username in active instructions.

## 6. Recreate disposable state

Do not migrate these as authoritative inputs:

- `.worktrees/` or `worktrees/`
- root and frontend `node_modules/`
- `electron/dist/`, `frontend/.nuxt/`, `frontend/.output/`, `dist/`,
  or `out/`
- downloaded `bundled/ffmpeg/`
- Electron browser/GPU caches, preview caches, logs, and temporary staging

Recreate them from the accepted repository, lockfiles, release scripts, and the
new machine's runtime.

The repository-root `build/` directory is different: its tracked icons,
`READ ME FIRST.txt`, and icon-generation script are packaging source resources.
Keep the files supplied by Git. Fetch the ignored FFmpeg inputs through
`npm run fetch:ffmpeg` when preparing desktop packaging; `npm run build` alone
does not fetch them.

## 7. Verify the new computer

1. Confirm `git status --short` is clean at the accepted commit.
2. Run the authoring-skill `--check` command above.
3. Open Story Studio and confirm the displayed version and approved Gateway
   origin.
4. Verify every expected project root before generating or uploading anything.
5. Confirm credentials decrypt or re-enter them; never infer success from the
   mere presence of `app-secrets.json`.
6. Restore Studio Library ownership online, then verify installed exact versions
   and offline access before relying on the migrated machine.
7. Run the repository's required source or release gates before development or
   packaging work.
