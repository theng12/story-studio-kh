# Shipping a content pack, start to finish

This is the whole path from "I have an idea for a pack" to "customers can buy it".
Five stages. Each one says what you run, what checks it, and who decides.

If you only remember two things, remember these:

> **Store archives are keyless by design. Never ask for, generate, or supply a signing key.**
> Publisher signing for production packs was abolished by owner ruling on
> 2026-08-15: the Store delivery profile is receipt-attested through GenStudio's
> commerce keyring instead, and the builder *refuses* a private key on that path.
> A request for "the Story publisher signing key" means something has gone wrong
> upstream, not that a credential is missing. There is nothing to find.
>
> (Two non-Store paths do still sign, and are not what this guide covers: the
> bundled recovery pack keeps its own recovery key, and local developer imports
> keep the explicit publisher-signature path.)

> **A published `(pack_id, version, sha256)` is immutable.**
> Once an archive has been filed and stocked, those exact bytes are that version
> forever. Fixing a typo, swapping a preview image, or retuning a prompt all ship
> as a **new version**. Nothing ever republishes under an old version number, and
> the shipper refuses to overwrite an archive whose contents would change.

---

## Stage 1 — Reserve the identity

**Who decides:** you, before writing anything.

A pack's identity — its pack id, item id, version, kind and entitlement family —
is claimed *before* the pack is written. This is what stops two people minting the
same id, and what makes every later step able to say "yes, this is the thing that
was approved".

```
npm run content-pack:registry -- reserve --request <request.json>
```

The request names the pack id, item id, version, kind, source path, and the
proposed entitlement family and SKU. The registry writes a **receipt** — a hash
over your exact request — and the record starts life as `reserved`.

Two rules worth knowing now, because they surprise people later:

- **Reserve before the files exist.** The registry rejects a pack directory that
  appears on disk without a matching record. Claim the identity, then write.
- **`min_app_version` is a token, not a number.** Records are written with
  `{{MIN_APP_VERSION}}` and `min_app_version_status: "release-bound"`. The real
  number is filled in at ship time from the release floor (see Stage 3).

## Stage 2 — Author the pack, then mark it authored

**Who decides:** you, plus the authoring gates.

Write the pack under `content-packs/<family>/<kind>/<name>/`:

```
pack.json                 identity, entitlement, lifecycle
content/<something>.json  the creative document — its `name` becomes the store title
assets/<preview>.webp     preview art
```

Then advance the record:

```
npm run content-pack:registry -- transition --request <request.json>
```

This flips `reserved` → `authored`. That word means something specific: *this pack
is finished and approved to ship*. Nothing downstream will touch a pack that is
still `reserved`.

The registry checks the pack against its record as part of every transition — the
ids match, the kind matches, the dependency list matches, the entitlement family
matches. A pack cannot be quietly edited out from under its own registration.

## Stage 3 — Ship it to an artifact folder

**Who decides:** the gates. This stage is fully automated; there are no judgement
calls left in it.

```
npm run content-pack:ship -- <selector...> [--out <dir>] [--dry-run]
```

A **selector** is whichever is most convenient:

| Selector | Example |
| --- | --- |
| pack id | `com.storystudio.pack.style.anime-cel` |
| source path | `content-packs/production-looks/style/anime-cel` |
| glob over either | `content-packs/production-looks/style/*` |

Several packs can go into one folder in one run — that is the normal case for a
wave.

`--out` names the folder. Leave it off and the run files into
`dist/ship/store-packs-<today>`, which is already git-ignored, so a build can
never be committed by accident. Give it a real path when the folder is a handoff
someone else will pick up.

**What it does, in order:**

1. **Gates.** Every selected pack must have a registry record and that record must
   be `authored`. Then the registry's own integrity check runs, reconciling every
   authored source against its record. If anything is missing you get a plain
   sentence naming the step that has not been done, and **nothing is built** —
   a refusal never leaves half a folder behind.
2. **Builds it twice**, into two separate scratch directories, with the Store
   delivery profile and no key, and proves the two archives are byte-identical. A
   pack that does not rebuild identically is not reproducible and is refused.
3. **Scans the archive for forbidden marks** — entry names *and* decompressed
   bytes, including inside images. (Ordinary `grep` silently skips any file
   containing a NUL byte, which is every image, so a trademark baked into a
   preview would sail past a grep-based check. This scan reads the bytes.)
4. **Validates** the archive against the Store profile, and confirms it carries no
   `key_id` and no signature.
5. **Files** the archive into the output folder and writes `manifest.json`.
6. **Prints** a per-pack table and the exact next command.

`--dry-run` reports the gates and what *would* be built, and writes nothing. It is
safe to point at a folder that has already shipped: it will tell you each pack is
already built and matching.

Re-running is safe. A pack whose archive is already there with a matching hash is
reported as already shipped and re-verified, not rebuilt blind. A pack whose
source now builds to *different* bytes is refused, loudly, with the immutability
rule quoted — that is the signal to cut a new version.

### Where the minimum app version comes from

`content-packs/release-floor.json`:

```json
{ "min_app_version": "1.0.843" }
```

This is the single source of truth, and it is **data you own, not a constant in
code**. The shipper reads it and substitutes it for the `{{MIN_APP_VERSION}}`
token in each pack. Before this file existed the number lived only in old
handoff manifests and planning docs, and got retyped by hand every wave.

Raise it only when a new pack genuinely needs an app capability that older builds
lack — every customer below the floor stops seeing packs shipped after the change.
Editing it never affects archives that have already been published; those are
immutable and carry the floor that was current when they were built.

### What lands in the folder

```
<artifact folder>/
  manifest.json
  style-anime-cel-1.0.0.sspack
  style-pixel-art-story-1.0.0.sspack
  ...
```

`manifest.json` is the contract with GenStudio. Per pack it carries everything the
stocking tool needs so that no human is asked a question:

| Field | What it is |
| --- | --- |
| `file`, `sha256`, `bytes` | the archive and its identity |
| `pack_id`, `version`, `publisher_id` | who and what |
| `kind` | `visual-style`, `topic-pack`, `channel-kit`, … |
| `title` | the customer-visible name, read out of the shipped bytes |
| `entitlement_family`, `entitlement_sku` | what the purchase grants |
| `min_story_version` | the app floor this archive requires |
| `item_ids`, `dependencies` | contents and closure |
| `source_path`, `source_commit` | the exact commit it came from |
| `build_command`, `validate_command` | how to re-derive it by hand |
| `reproducibility`, `forbidden_mark_scan`, `validator` | the evidence |

Top level it records `manifest_version`, the artifact set name, when it was
generated, the source commit, and the build profile — including, in words, that
Store archives are keyless.

## Stage 4 — Stock it in GenStudio

**Who decides:** the stocking tool, from the manifest.

From the `genstudiokh` repository:

```
python -m app.tools.stock_pack <artifact folder>
```

It reads the folder and its `manifest.json` and creates or updates the products.
The shipper prints this line for you with the real path filled in, so it can be
copied straight out of the terminal.

Nothing in Stage 3 publishes, prices, or sells anything. Shipping produces
artifacts; stocking is a separate, deliberate act.

## Stage 5 — Price and publish

**Who decides:** the owner. This stage is not automated and should not be.

Standing policy as of 2026-08-25: **every pack is 300 credits**, discounted 90%
until year end. Kits are exactly four pieces — one of each kind — at 1200 credits;
a fifth piece is split out and sold separately at 300. Nothing is free.

Margin floors and any exemption to them are the owner's call and are audited
separately. If a price question comes up during shipping, the answer is to ship
the artifact and ask — never to guess a number into a product.

---

## When something is refused

| What you see | What it means | What to do |
| --- | --- | --- |
| `is not in the authoring registry` | Stage 1 never happened for this pack | Reserve it |
| `status is "reserved", not "authored"` | Stage 2 never finished | Transition it |
| `did not rebuild byte-identically` | the source is not reproducible | Find the nondeterminism; do not ship it |
| `names a forbidden third-party mark` | a trademark is in the text or an asset | Rename it; the shared list is `scripts/content-packs/__tests__/forbidden-marks.mjs` |
| `already exists with sha …, but this source builds to …` | you changed a published version | Cut a new version |

A refusal always means nothing was built. The exit code and the contents of the
output folder never disagree.

## Shipping the next pack, in full

Reserve the identity, write the pack, transition it to authored, then:

```
npm run content-pack:ship -- <your pack> --out <folder> --dry-run   # look first
npm run content-pack:ship -- <your pack> --out <folder>             # then ship
python -m app.tools.stock_pack <folder>                             # in genstudiokh
```

Then price it. That is the whole thing.
