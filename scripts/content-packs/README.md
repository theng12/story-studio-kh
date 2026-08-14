# Story Studio Content Pack publisher tools

These first-party tools build and validate immutable `.sspack` archives through the same strict
schemas, signature policy, ZIP checks, and raster decoding used by Story Studio. They do not
contact GenStudio, purchase content, activate a pack, or modify customer content.

## Source layout

```text
my-pack/
├── pack.json
├── content/
│   └── visual-style.json
└── assets/
    └── preview.png
```

The source root may contain only `pack.json`, `content/`, and `assets/`. `content/` contains
strict JSON documents for the four supported item kinds; `assets/` contains only PNG, JPEG, or
WebP files. Symlinks, scripts, SVG, HTML, CSS, fonts, and extra files are rejected.

`pack.json` contains the shared manifest metadata, but **must omit** the derived `items` and
`files` arrays. The builder derives them from the files on disk, hashes every file, validates the
complete manifest, and signs its canonical JSON bytes. The pack, key, entitlement, bundle, and
document IDs must fall within the stated publisher namespace; in-pack paths are not namespace IDs.

## Bundle-only coordination packs

A Channel Kit may coordinate exactly one Formula, Topic Pack, Style, and Thumbnail Recipe from
exact external dependencies. This is the only source shape permitted without `content/`:
it must contain just `pack.json`, derive empty `items` and `files`, declare one Channel Kit, and
carry no in-pack content or assets. Every component must be external and every dependency must
be used by an exact component reference.

For a release build, the two whole-value placeholders below may be resolved only with explicit
`buildContentPack()` arguments. The builder does not expand templates in any other field.

```json
{
  "key_id": "{{KEY_ID}}",
  "min_app_version": "{{MIN_APP_VERSION}}"
}
```

```js
await buildContentPack({
  sourceDirectory: './free-starter-kit',
  privateKeyPath: './keys/publisher.private.pem',
  outputPath: './dist/free-starter-1.0.0.sspack',
  keyId: 'com.storystudio.key.primary',
  minAppVersion: '1.0.0',
})
```

The private key remains path-only and in memory; neither key material nor arbitrary template
values are written to the archive or command output.

Published identity is immutable: a `(pack_id, exact version, archive SHA-256)` tuple is permanent.
Any byte change—including a preview image, document, manifest field, or signature—requires a new
exact pack version. Never rebuild and republish different bytes under an existing version.
The build output path must not already exist: the publisher refuses to replace it, including if a
second build races the final write. Choose a new versioned output path for every new artifact.

```json
{
  "pack_format": 1,
  "pack_id": "com.storystudio.pack.example",
  "publisher_id": "com.storystudio",
  "key_id": "com.storystudio.key.primary",
  "version": "1.0.0",
  "min_app_version": "1.0.0",
  "lifecycle": "active",
  "entitlement": {
    "sku": "com.storystudio.sku.example",
    "family": "com.storystudio.family.example"
  }
}
```

## Build

Use an explicit path to an Ed25519 PKCS#8 private-key PEM:

```bash
npm run content-pack:build -- ./my-pack \
  --private-key ./keys/com.storystudio.primary.private.pem \
  --output ./dist/example-1.0.0.sspack
```

For CI, set the explicit path in `STORY_CONTENT_PACK_PRIVATE_KEY_PATH` instead:

```bash
STORY_CONTENT_PACK_PRIVATE_KEY_PATH=./keys/com.storystudio.primary.private.pem \
  npm run content-pack:build -- ./my-pack --output ./dist/example-1.0.0.sspack
```

The private key is used only in memory. It is never copied into the archive or emitted in command
output. Do not commit private keys, place them in a pack source directory, or pass PEM contents as
an argument or environment value.

Given identical source bytes and key, builds use canonical manifest bytes, fixed ZIP timestamps,
and deterministic archive order: `manifest.json`, `signature.ed25519`, then lexically ordered
content and assets.

### Release-parameterized sources

`content-packs/archival-ledger` is a source-only historical parity reference for Archival Ledger.
Never sign or stock that retired monolith. Its former combined Formula, Topic, Style, and Recipe
content must remain a review reference only; the publisher rejects it before an archive is made.

Build each independently signed component source, then the Channel Kit coordinator that references
their exact versions. These release-parameterized sources deliberately use `{{MIN_APP_VERSION}}`:
final integrators—not pack authors—choose the shared Story Studio release version and pass that
identical value to each build.

```bash
npm run content-pack:build -- ./content-packs/paid/archival-ledger/formula/archival-ledger \
  --private-key ./keys/component.private.pem \
  --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" \
  --output ./dist/formula-archival-ledger-1.0.0.sspack

npm run content-pack:build -- ./content-packs/paid/archival-ledger/kit/archival-ledger \
  --private-key ./keys/component.private.pem \
  --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" \
  --output ./dist/kit-archival-ledger-1.0.0.sspack
```

The same component path pattern applies to all eight component roots under
`content-packs/paid/archival-ledger/{formula,topic,style,thumbnail}/`, with the coordinator at
`content-packs/paid/archival-ledger/kit/archival-ledger`. The builder refuses a
release-parameterized source without that explicit value, and refuses this override for ordinary
sources. Set it only after the combined runtime release that contains the pack's schema, adapter,
thumbnail, and planner support has an agreed version.

## Validate

Validation requires the intended key identity and an explicit public-key PEM. It reports only the
verified pack ID, version, and archive SHA-256:

```bash
npm run content-pack:validate -- ./dist/example-1.0.0.sspack \
  --key-id com.storystudio.key.primary \
  --publisher-id com.storystudio \
  --public-key ./keys/com.storystudio.primary.public.pem
```

Always validate a published artifact with the public key that Story Studio will pin for that key
ID. A successful local build also performs this same in-memory verification before it writes the
archive.
