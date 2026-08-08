# Dependency maintenance — August 2026

Snapshot from 2026-08-08: `npm audit --omit=dev` reports zero production
vulnerabilities. The full audit reports 12 vulnerable development/build
dependency entries (10 high, 2 moderate) across 11 distinct advisories.

The 10 high entries are `app-builder-lib`, `brace-expansion`, `builder-util`,
`builder-util-runtime`, `dmg-builder`, `electron-builder`,
`electron-builder-squirrel-windows`, `electron-publish`, `js-yaml`, and
`nanoid`. The two moderate entries are `tar` and `undici`.

## Advisory groups

- Electron packaging: AppImage search-path control
  ([GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g))
  and redirect credential leakage
  ([GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797)).
- `brace-expansion`: exponential expansion, memory exhaustion, and the
  follow-up intermediate-array bypass
  ([GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp),
  [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg),
  [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895)).
- `js-yaml`: quadratic CPU use while resolving `!!omap`
  ([GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj)).
- `nanoid`: non-secure generators can loop for a negative size
  ([GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)).
- `tar`: stack-overflow denial of service from crafted long paths
  ([GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m)).
- `undici`: response desynchronization, CRLF injection, and cookie-attribute
  injection
  ([GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524),
  [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5),
  [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm)).

## Work to do

- [ ] Upgrade `electron-builder` from 26.9.0 to 26.15.3. Confirm the update
  resolves the affected `app-builder-lib`, `builder-util`,
  `builder-util-runtime`, `dmg-builder`, `electron-builder-squirrel-windows`,
  and `electron-publish` entries.
- [ ] Refresh vulnerable transitive packages to patched versions:
  `brace-expansion` 1.1.18 / 2.1.4 / 5.0.9, `js-yaml` 4.3.1,
  `nanoid` 5.1.16, `tar` 7.5.22, and `undici` 6.28.0 or newer compatible
  releases. Prefer normal dependency resolution; add `overrides` only if a
  parent package cannot resolve a patched version.
- [ ] Run `npm audit` and `npm audit --omit=dev`; require both to report zero
  before closing this backlog.
- [ ] Run the full verification suite and exercise macOS packaging. Inspect
  Windows/Linux packaging configuration even when those artifacts cannot be
  built on this Mac.
- [ ] Ship the dependency-only release with the required version and changelog
  update, then move this completed backlog to `docs/history/`.

## Boundaries

- Keep this separate from the UX modernization release so package regressions
  and interface regressions are independently reviewable.
- Do not use `npm audit fix --force` or accept a major upgrade implicitly.
- Do not upgrade unrelated major dependencies as part of this security pass.
