# Story Studio Content Pack publisher tools

These first-party tools build and validate immutable `.sspack` archives through the same strict
schemas, trust profile, ZIP checks, and raster decoding used by Story Studio. They do not
contact GenStudio, purchase content, activate a pack, or modify customer content.

## Art styles apply style only

Owner, 2026-11-01: "all art style must be neutral and only apply style. no other elements should it affect." A `style_bible` says how things are drawn: line, colour, shadow, texture, composition, light. It never says what to draw. Scene prompts alone decide subjects. Any named subject leaks into unrelated scenes on a model that reads the whole prompt, even inside a condition or a limit, and so do genre words and required subject classes. Colour names such as "bone white" are fine. Keep safety limits, phrased generally. A subject-word check runs at build time and stops the build if it finds a flagged word in `style_bible`; passing it does not replace a test drawing, because a text check can't prove what a model draws.

## Authoring registry

`content-packs/authoring-registry.json` is the authoring-lead-owned, Git-tracked authority for Story
Content Pack identities. It reconciles every authored source pack and can reserve a complete
future batch before any leaf author creates source files. It records only Story pack, item or
bundle, version, publisher, source, dependency, and family/SKU proposal facts—never GenStudio
product/release/account identities, prices, shelves, signing, archives, or publication state.

```bash
npm run content-pack:registry -- validate
npm run content-pack:registry -- reserve --request ./reservation-request.json
npm run content-pack:registry -- transition --request ./lifecycle-transition.json
npm run content-pack:registry -- verify-receipt --revision 2 \
  --receipt authoring:<sha256> --expected-identity ./expected-identity.json
```

The reservation request supplies the current `expected_revision`, coordinator `task` and `branch`,
a proposal reference, and every requested record. The command returns a deterministic receipt and
increments the revision exactly once, without creating source files. Start from the committed
revision; competing coordinators receive a conflict and must rebase, validate, and reserve again.
Each accepted batch persists the canonical request metadata that produced its receipt. Before
creating source files, a leaf writes its coordinator-issued complete record (without `receipt_ref`)
to the expected-identity JSON file and runs `verify-receipt`. The command succeeds only when the
revision, receipt, and every expected identity field match the persisted batch and current registry
record. Leaf authors never mint or repair identities themselves.

After exact source files exist, the coordinator uses `transition` to advance a reserved record to
`authored`. The same command advances family and SKU proposals exactly one step at a time from
`proposed` to `reserved` to `confirmed`; only a confirmed step accepts and requires a
`confirmation_ref`. Each transition carries the current `expected_revision`, original receipt,
pack ID, and exact version, and is written as a deterministic lifecycle event under the same CAS
lock as reservations. Receipt verification remains bound to the immutable original identity while
validation replays the event journal to reject skipped, reversed, or unrecorded mutable changes.

A reservation may instead transition once to `withdrawn` before any source directory exists.
Withdrawal is terminal: the original receipt remains verifiable, but the `pack_id`, item or bundle
ID, family, and SKU stay burned forever; it cannot be authored, stocked, or given a later version.
This is pre-sale identity closure, not archive retirement. Customer archives keep their existing
`active`, `retired`, and `replaced` lifecycle values; `withdrawn` never appears inside an archive.

An **authored** record transitions once to `retired` when the product is discontinued and its
source directory leaves this repository. Retirement is the post-sale mirror of withdrawal: also
terminal, also burning the `pack_id` against any later reservation, and it requires a `reason`
string that is written into the lifecycle journal — once the source is gone, that sentence is the
only surviving explanation of why. Retirement changes nothing a customer already installed; their
archives keep working under their own manifest lifecycle.

Retirement is two moves, and the registry refuses to hold either half alone: an `authored` record
must have its source directory, a `retired` one must not. So retire the record, then delete the
directory, one record at a time. A repository left between the two fails `validate`.

```json
{
  "expected_revision": 234,
  "coordinator": { "task": "content-pack-authoring", "branch": "content/kits-retired" },
  "receipt_ref": "authoring:<sha256>",
  "pack_id": "com.storystudio.pack.kit.example",
  "version": "1.0.0",
  "changes": { "status": "retired" },
  "reason": "Owner ruling 2026-09-08: channel kits discontinued; components sold individually"
}
```

Genesis records carry a `baseline:<pack_id>@<version>` receipt instead of an authoring receipt.
They have no batch to replay, so retirement is the only lifecycle event they accept; a baseline
transition carrying anything else is refused.

```json
{
  "expected_revision": 2,
  "coordinator": { "task": "content-pack-authoring", "branch": "codex/content-pack" },
  "receipt_ref": "authoring:<sha256>",
  "pack_id": "com.storystudio.pack.style.example",
  "version": "1.0.0",
  "changes": {
    "status": "authored",
    "stocking_proposal": { "family": { "status": "reserved" } }
  }
}
```

Generic discovery reconciles every `pack.json` source below `content-packs/`, including future
catalog waves. `content-packs/archival-ledger` — the retired source-only monolith, deleted
2026-09-08 once its content sold as the six split packs under `content-packs/paid/archival-ledger`
— stays refused as a `source_path` so it cannot be reintroduced. Canonical forward-slash repository
paths are mandatory; aliases, absolute paths, backslashes, symlinks, cycles, coordinators in
creative dependency closure, and unregistered authored sources fail closed.

Canonical migration copies of all five authoring skill packages live under
`developer-migration/codex-skills/`. Install or verify them on a new computer with:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --install
node scripts/developer/sync-story-authoring-skills.mjs --check
```

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
strict JSON documents for the nine supported item kinds; `assets/` contains only PNG, JPEG, or
WebP files. Symlinks, scripts, SVG, HTML, CSS, fonts, and extra files are rejected.

`pack.json` contains the shared manifest metadata, but **must omit** the derived `items` and
`files` arrays. The builder derives them from the files on disk, hashes every file, validates the
complete manifest, and signs its canonical JSON bytes. The pack, key, entitlement, bundle, and
document IDs must fall within the stated publisher namespace; in-pack paths are not namespace IDs.

## Channel Kits are gone

Owner ruling 2026-09-08: *"no channel kit at all or anymore. we don't do that."* All eleven Kit
products are retired in the store, every Kit registry record is `retired`, and every Kit source
directory was deleted from this repository. Do not create, extend, reserve, price, stock, or
rebuild one. Every product is an independently purchasable, mix-and-matchable Content Pack; what a
Kit used to bundle is sold as its four components.

The `channel-kit` item kind stays in the signed archive schema, and only there: Kits customers
already installed must keep parsing. Nothing in this repository builds one any more, because the
builder requires an *authored* registry identity and no Kit record is authored.

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
  sourceDirectory: './content-packs/free-starters/style/watercolor-storybook',
  privateKeyPath: './keys/publisher.private.pem',
  outputPath: './dist/style-watercolor-storybook-1.0.0.sspack',
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

**Anything sold uses the Store delivery profile below, and it takes no signing key.** Do not go
looking for a publisher key to build a Store archive: there is none to find, and supplying one is
refused (`delivery-attested builds must not receive a private key`). The verifier likewise rejects a
Store archive that carries a publisher signature.

Production Store delivery uses GenStudio's signed purchase receipt as the permanent archive
authority. Select that profile explicitly; it accepts no publisher private key and emits neither
`key_id` nor `signature.ed25519`. The source `key_id` is authoring metadata for the independent
local/recovery publisher path and is removed only from this derived Store archive manifest.

```bash
npm run content-pack:build -- ./content-packs/free-starters/formula/ancient-humans \
  --delivery-profile genstudio-store-receipt-v1 \
  --min-app-version 1.0.843 \
  --output ./dist/formula-ancient-humans-1.0.0.sspack
```

The builder immediately runs the delivery-attested structural verifier over the completed bytes.
It reports the exact SHA-256 and byte count needed for the GenStudio draft release.

The publisher-signed command below is **not** the Store path and is not what you want for anything
sold. It is a separate local/recovery developer path, used only for archives that are never stocked.
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

Some sources deliberately use `{{MIN_APP_VERSION}}`: final integrators—not pack authors—choose the
shared Story Studio release version and pass that identical value to each build.

```bash
npm run content-pack:build -- ./content-packs/paid/archival-ledger/formula/archival-ledger \
  --private-key ./keys/component.private.pem \
  --min-app-version "$FINAL_STORY_STUDIO_RELEASE_VERSION" \
  --output ./dist/formula-archival-ledger-1.0.0.sspack
```

The same pattern applies to every component root under
`content-packs/paid/archival-ledger/{formula,topic,style,thumbnail}/`. The builder refuses a
release-parameterized source without that explicit value, and refuses this override for ordinary
sources. Set it only after the combined runtime release that contains the pack's schema, adapter,
thumbnail, and planner support has an agreed version.

### Reserve before the source enters `content-packs/`

`packPaths` walks everything under `content-packs/` and `reconcileSources` refuses any
`pack.json` it finds there with no registry record. `assertSafeSourcePath`, by contrast, allows a
**reserved** record to name a `source_path` that does not exist yet, and only requires the
directory once the record is `authored`.

So when a wave is authored before its identities are reserved -- the normal order, since the
wave-boundaries policy puts identity assignment after proposal acceptance -- the sequence is:

1. Keep the authored source **outside** `content-packs/` while the registry is still unwritten.
   `buildContentPack` takes any source directory, so the wave's acceptance evidence is fully
   reproducible from there.
2. `reserve` the identity, with `source_path` naming the future location inside
   `content-packs/`.
3. `git mv` the source into that location. It now has a record, so discovery accepts it.
4. `transition` the record to `authored`.

Two waves have hit this ordering constraint (`symbolic-psychology` and `deep-time-field-record`).
Moving the source in before step 2 makes every registry write fail, because both
`reserveAuthoringBatch` and `transitionAuthoringRecord` validate the whole document before
mutating it.

## Validate

Validate a production Store archive structurally without a publisher key:

```bash
npm run content-pack:validate -- ./dist/formula-ancient-humans-1.0.0.sspack \
  --delivery-profile genstudio-store-receipt-v1
```

This proves the bounded archive, manifest, documents, hashes, assets, and dependency shape. At
installation time Story separately requires GenStudio's signed receipt to bind these exact bytes
to the release, entitlement family, publisher, version, minimum Story version, and dependency closure.

Publisher-signed validation requires the intended key identity and an explicit public-key PEM. It
reports only the verified pack ID, version, archive SHA-256, and byte count:

```bash
npm run content-pack:validate -- ./dist/example-1.0.0.sspack \
  --key-id com.storystudio.key.primary \
  --publisher-id com.storystudio \
  --public-key ./keys/com.storystudio.primary.public.pem
```

Always validate a published artifact with the public key that Story Studio will pin for that key
ID. A successful local build also performs this same in-memory verification before it writes the
archive.
