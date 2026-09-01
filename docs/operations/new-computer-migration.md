# New-computer migration checklist

Use this checklist to move Story Studio development and local customer state to
another Mac without treating build output or an encrypted secret file as the
source of truth.

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

- Back up the effective projects root selected by
  `app-settings.json -> projects_root_override`. Its default is
  `~/Library/Application Support/Story Studio KH/projects/`.
- Project directories contain project configuration, jobs, scripts, prompts,
  generated images/audio/video, user templates or forks, and per-project
  YouTube OAuth tokens. Treat them as customer data, not build output.
- Preserve `~/Library/Application Support/Story Studio KH/` when local settings,
  installed Content Packs, retained Store proofs, or offline operation must
  survive. Important paths include:
  - `app-settings.json`
  - `app-secrets.json`
  - `named-roots.json`
  - `content-packs/state.json`
  - `content-packs/commerce-state.json`
  - `content-packs/installed/`
- Revalidate machine-specific absolute paths, named roots, FFmpeg locations,
  and external media roots after migration. Copying an old path does not make it
  valid on the new computer.

## 4. Handle secrets and Store anchors safely

`app-secrets.json` is encrypted with Electron `safeStorage` and contains both
provider credentials and OS-protected Content Store public-key anchors. Copying
that file alone is not a portable credential export.

- Prefer a macOS Migration Assistant/Keychain transfer that preserves the
  operating-system encryption identity.
- Otherwise, re-enter provider credentials in Story Studio and perform an
  authenticated Content Store restore/revalidation on the new Mac.
- A copied Store journal or installed archive without a decryptable matching
  anchor must fail closed offline. Do not disable keychain protection or edit
  the journal to bypass revalidation.
- Move ignored `.env*` files, Apple signing certificates, notarization
  credentials, and other developer secrets only through an approved secret
  manager or protected OS credential migration. Never commit them.

## 5. Preserve cross-repository handoffs

The handoff ledger is outside the Story repository. Preserve the complete
`/Users/<account>/Developer/_handoffs/` directory, including its README and
recoverable `_handoff-trash/` history where present. Recreate the path for the
new account instead of retaining the old username in active instructions.

## 6. Recreate disposable state

Do not migrate these as authoritative inputs:

- `.worktrees/` or `worktrees/`
- root and frontend `node_modules/`
- `electron/dist/`, `frontend/.nuxt/`, `frontend/.output/`, `build/`, `dist/`,
  or `out/`
- downloaded `bundled/ffmpeg/`
- Electron browser/GPU caches, preview caches, logs, and temporary staging

Recreate them from the accepted repository, lockfiles, release scripts, and the
new machine's runtime.

## 7. Verify the new computer

1. Confirm `git status --short` is clean at the accepted commit.
2. Run the authoring-skill `--check` command above.
3. Open Story Studio and confirm the displayed version and approved GenStudio
   origin.
4. Verify every expected project root before generating or uploading anything.
5. Confirm credentials decrypt or re-enter them; never infer success from the
   mere presence of `app-secrets.json`.
6. Restore Content Store ownership online, then verify installed exact versions
   and offline access before relying on the migrated machine.
7. Run the repository's required source or release gates before development or
   packaging work.
