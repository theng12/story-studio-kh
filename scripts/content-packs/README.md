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
complete manifest, and signs its canonical JSON bytes. The files and document IDs must fall
within the stated publisher namespace.

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
