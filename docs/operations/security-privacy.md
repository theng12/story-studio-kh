# Production security and privacy boundary

Story Studio KH is an Electron desktop application with an embedded Express API. Gateway credentials and customer project material cross different trust boundaries and must not be treated as ordinary settings or diagnostics.

## Enforced application boundary

- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, no `<webview>` support, and no production DevTools.
- The preload exposes only `{ isElectron: true }`. It exposes no `ipcRenderer`, filesystem, shell, process, or secret capability. There are currently no renderer-to-main IPC channels; adding one requires an explicit channel allowlist and validation test.
- Main-window navigation is restricted to the exact loopback application origins. Credential-bearing URLs and unsafe schemes are rejected. Ordinary credential-free HTTP(S) links may open only in the operating-system browser.
- The embedded API enforces loopback Host headers in desktop mode. Server mode instead requires its authenticated session boundary before protected routes.
- CSP, framing, MIME-sniffing, referrer, permissions, and cross-origin isolation headers are applied before all API and static routes.

## Gateway credential handling

- The full Gateway API Key is accepted only by the protected main-process API and written to the per-machine `app-secrets.json` store with owner-only `0600` permissions.
- Reads exposed to the renderer return only `hasKey` and a masked identifier. The raw value is loaded only inside the embedded main-process service when making an authorized Gateway request.
- API keys are not part of project configuration, manifests, presets, `jobs.json`, exports, or generated assets. The job persistence/SSE boundary deep-redacts secret-bearing fields and strings as a final safeguard.
- Runtime-loaded keys are registered with the global redactor. Logs, crash messages, provider errors, URLs, and renderer-visible error details remove exact loaded credentials and defensive Bearer/Key/Gateway-key patterns.
- Automatic V8 heap snapshots are forbidden. Heap snapshots may contain live API keys, prompts, and asset buffers and are not acceptable support artifacts.

`app-secrets.json` is not bundled with the application and does not live inside a project directory. It holds plain values in one file with owner-only `0600` permissions, written atomically (temp file, fsync, rename). Story Studio does not use the macOS Keychain, Electron `safeStorage` or the `security` CLI on any credential read or write path (owner rule 2026-11-13). Chromium is started with `--use-mock-keychain`, so it keeps its own cookie key in the app's Local State instead of creating a Keychain item. A `{__encrypted: true}` file from an older build is moved aside once and its Keychain items are removed without prompting; its values cannot be read by a build that no longer uses the Keychain, so paste the key again. A hosted deployment must use its host secret manager instead of copying this file.

## Customer-content privacy

Story Studio does not initialize Sentry, Electron `crashReporter`, analytics, or another telemetry exporter. Prompts, scripts, images, audio, video, and project paths remain local except when the user explicitly submits generation work to Gateway or another selected service during migration.

Logs contain operational metadata and redacted errors, not request bodies. They are retained locally for seven days. Treat any manually collected support bundle as private even after redaction.

## URL policy

- Public Gateway endpoints must use HTTPS.
- Plain HTTP is accepted only for loopback, RFC1918/link-local addresses, Tailscale CGNAT addresses, `.local`, and `.ts.net` hosts.
- Userinfo credentials, query parameters, and fragments are rejected. API keys belong in the dedicated secret field, never in a URL.

## Release gate

Run:

```bash
npm run check:security
npm run build
```

The build runs the security check again against compiled Electron and generated frontend output. It fails when Electron protections disappear, IPC is added to the preload, unsafe CSP directives appear, packaging exclusions regress, a live-key-shaped value is embedded, or this Mac's absolute home path reaches packaged text assets.

The Electron Builder allowlist explicitly excludes `.env` files, databases, logs, source maps, tests, project jobs, secrets, preview caches, and generated local data.

## Remaining production gates

- Sign and notarize the macOS application before distributing it publicly.
- Run `npm run dist:public` in the protected Apple release environment; the
  command refuses to build without Developer ID signing and notarization
  credentials and validates the stapled app and DMG.
- Commission an independent penetration test for server mode before exposing it outside a private tailnet.
- Replace the remaining Nuxt-compatible CSP `'unsafe-inline'` allowance with per-response nonces when the renderer build supports nonce injection.
