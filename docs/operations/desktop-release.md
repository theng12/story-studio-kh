# Desktop release owner checklist

This is the release gate for the macOS desktop build. The checked target is an
Apple Silicon (`arm64`) DMG named:

```text
Story Studio KH <version>-arm64.dmg
```

The bundle identity is `com.storystudio.kh`, the app name is `Story Studio KH`,
and Electron therefore keeps upgrade data in
`~/Library/Application Support/Story Studio KH`. These values are pinned in
`release/desktop-release-contract.json`; changing any of them is a data-migration
decision, not release housekeeping.

## Automated gate

From the repository root, with dependencies installed from both lockfiles:

```bash
npm ci
npm --prefix frontend ci
npm run verify
npm run check:release -- --built --package-input
```

`npm run verify` covers lint, Electron/frontend typechecks, backend/frontend/
release tests, changelog integrity, production security checks, the Nuxt static
build, and the production Electron compile. The release check additionally
proves that the renderer's startup document has no remote script, stylesheet,
or font dependency and that every referenced startup asset is present locally.

For the normal locally signed package and isolated launch verification (no installation):

```bash
npm run dist:smoke
```

That command:

1. validates or fetches the pinned universal FFmpeg inputs;
2. rebuilds from source;
3. validates recovery storage before the build and stages output in a fresh
   `dist/.dmg-build-*` folder; existing installers stay untouched on failure;
4. uses the configured stable local signing identity, disables notarization,
   and publishes nothing;
5. creates the arm64 app and DMG;
6. mounts the DMG read-only, checks its layout, then detaches it;
7. inspects `app.asar`, unpacked native modules, bundle metadata, architecture,
   offline assets, packaged What's New entry, and forbidden file names; and
8. prints the DMG byte size and SHA-256, proves signing and isolated launch, then
   exposes the verified candidate in `dist/`, backing replaced outputs up
   recoverably. Released-pair rotation waits for installed functional acceptance
   and the shared retention helper; see `scripts/release/orchestration/README.md`.

Re-run artifact verification without rebuilding:

```bash
npm run verify:artifact -- \
  --app "dist/mac-arm64/Story Studio KH.app" \
  --dmg "dist/Story Studio KH <version>-arm64.dmg"
```

The smoke artifact is not a distributable release.

For a customer-facing candidate, use the protected Apple release environment:

```bash
npm run dist:public
```

This command fails before packaging unless Developer ID signing is configured
with `CSC_LINK` (or `CSC_NAME`) and notarization uses either App Store Connect
API-key credentials (`APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`) or Apple-ID credentials (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). It signs and notarizes the
app, submits and staples the finished DMG separately, then verifies both
artifacts. Credential values are never printed.

## Release owner sign-off

- [ ] Start from a known commit and record any intentional uncommitted files.
- [ ] Use `npm ci` for both lockfiles; do not use an unlocked install to cut a release.
- [ ] Bump the version in `package.json` and both root version fields in
      `package-lock.json` only when the release is actually being cut.
- [ ] Add the matching newest-first `## vX.Y.Z — YYYY-MM-DD` entry to
      `CHANGELOG.md`. `npm run check:changelog` must prove the package, lockfile,
      first What's New entry, and non-empty details agree.
- [ ] Confirm the release contract still intentionally targets arm64 only. The
      bundled FFmpeg helper is universal2, but that does not make the Electron
      app universal.
- [ ] Confirm a clean-install test uses a fresh macOS user or disposable Mac and
      creates no state inside the app bundle.
- [ ] Confirm an upgrade test replaces an older `/Applications/Story Studio KH.app`
      while preserving projects, settings, secrets, jobs, and What's New state in
      the existing Application Support directory.
- [ ] Launch the packaged app with Wi-Fi disabled. The window, local project list,
      bundled fonts, templates, niches, formats, and FFmpeg status must load;
      provider-backed generation may report offline/unavailable without blocking
      the rest of the UI.
- [ ] Confirm the GenStudio base URL saved under the per-machine
      `genstudio_url` setting is the approved deployment origin. Public endpoints
      must use HTTPS; loopback HTTP is accepted only for a same-machine service.
      Never place API keys, userinfo, query strings, filesystem paths, Pinokio
      paths, or developer home paths in the URL.
- [ ] If a public GenStudio endpoint should work on a completely fresh install,
      have the GenStudio migration owner approve its production default before
      release. The current loopback default is safe and offline-friendly but does
      not provision a remote service.
- [ ] Inspect the generated package report: no `.env` files, secrets, databases,
      jobs, logs, tests, source maps, generated caches/assets, or developer-only
      absolute paths.
- [ ] Run the manual desktop phases in `qa-checklist.md` on the exact candidate.
- [ ] Archive the final checksums and command output with the release record.

## External signing and notarization requirements

Public distribution requires infrastructure and credentials that are deliberately
absent from the unsigned smoke flow:

- Apple Developer Program membership and a `Developer ID Application` certificate
  for the release team;
- the stable `com.storystudio.kh` identifier registered to that team;
- hardened-runtime-compatible entitlements reviewed for the app's actual needs;
- App Store Connect API-key or Apple-ID notary credentials supplied only in the
  protected release environment;
- Electron Builder signing of the app and all nested executables/frameworks;
- Apple notarization, successful ticket stapling, and Gatekeeper validation.

Story Studio keeps no secrets in the macOS Keychain (owner rule 2026-11-13): secrets
live in `app-secrets.json` in the app's data folder with `0600` permissions, so a
signed release needs no Keychain entitlement or access prompt. The one-time migration
from an older encrypted file never asks for Keychain access; when macOS would need to
ask, it skips and leaves the old state untouched.

After creating the signed/notarized candidate, verify it with Apple's tools:

```bash
codesign --verify --deep --strict --verbose=2 "/path/to/Story Studio KH.app"
spctl --assess --type execute --verbose=4 "/path/to/Story Studio KH.app"
xcrun stapler validate "/path/to/Story Studio KH.app"
xcrun stapler validate "/path/to/Story Studio KH <version>-arm64.dmg"
```

Do not publish, upload, or install a candidate merely because the local unsigned
smoke check passed.
