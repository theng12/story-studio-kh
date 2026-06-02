# Offline-first notes

**Supported platform:** macOS only (arm64 + x64). Windows and Linux targets
were removed from `electron-builder.json` on 2026-04-24 — the FFmpeg bundle
is fused with `lipo` and ships as a macOS universal2 binary, and the runtime
auto-download fallback (`ffmpeg-manager.ts::DOWNLOAD_URLS`) only has darwin
sources. Re-enabling a non-Mac target requires bundling per-platform FFmpeg
builds (gyan.dev for Windows, johnvansickle.com for Linux) with matching
SHA-256 pins in both `scripts/fetch-ffmpeg.mjs` and `ffmpeg-manager.ts`.

Story Studio is a desktop Electron app. We bundle static resources
locally so the UI renders correctly on a plane, in a café with flaky
wifi, or in any environment where the public internet is flaky or
blocked. This doc lists **what ships locally**, **what stays remote**
(and why), and **how to regenerate the bundled data**.

## Bundled locally — no network required

| Resource | Path | Why bundled |
|---|---|---|
| Inter typeface (latin subset, variable weight) | `frontend/public/fonts/inter/inter-latin.woff2` + `frontend/assets/css/fonts.css` | Previously loaded from `fonts.googleapis.com` on every startup. Now shipped; zero network on cold boot. ~48 KB. |
| IANA timezone database (419 zones, 10 regions, offsets for Jan + Jul) | `frontend/data/timezones.json` | Used by the Plans editor's timezone picker. Generated once from Node's `Intl.supportedValuesOf('timeZone')`; renders as a fast grouped `<select>` instead of a 400+ option datalist. ~68 KB raw, ~10 KB gzipped. |
| ElevenLabs voice snapshot fallback | `electron/server/data/voices-snapshot.json` | Shown on first run or when the ElevenLabs API is unreachable. Refreshed 24h-TTL from the live API when online. |
| FFmpeg binary | `electron/vendor/ffmpeg/` (fetched once by `scripts/fetch-ffmpeg.mjs` during install) | Audio/video assembly works without a system install. |

## Must remain remote

These are genuinely user-specific or per-request and can't be bundled:

- **YouTube Data API** — OAuth token refresh, video upload, playlist read/write, reconcile. Per-account, per-channel, quota-tracked locally.
- **ElevenLabs TTS + subscription** — user's keyed account, per-synthesis charge; character cap lookups are user-specific.
- **GenAIPro TTS / kie.ai image generation / Claude completions** — all generator jobs that produce new content.

## Regenerating bundled data

**Timezones** — run once after a Node upgrade or when IANA publishes a tzdata revision (rare; typically twice a year):

```
node scripts/build-tz-db.mjs
```

Output: `frontend/data/timezones.json`. Commit the result.

**Inter font** — the WOFF2 file under `frontend/public/fonts/inter/` is a direct copy of the `inter/v20` latin subset from Google's CDN. It only needs to change if we upgrade to a newer Inter release, which is infrequent and manual — re-download the URL referenced in the comment at the top of `frontend/assets/css/fonts.css`.

**Voice snapshot** — regenerated automatically on any successful ElevenLabs voice fetch. The bundled fallback doesn't need manual maintenance.

## Audit trail

The audit that led to this setup is captured in `new-ideas-for-storystudio-giggly-manatee.md` under the Round 5 section. The short version: only Google Fonts was truly wasted bandwidth. The timezone list felt like a network fetch to users because rendering 418 datalist options stalled the plan editor, but the list had always come from the JS runtime's bundled tzdata. Both are now eliminated.
