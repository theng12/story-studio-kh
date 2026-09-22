# gateway-kh → Story Studio KH — Content Pack contract reply (1.4.219 ping)

**Date:** 2026-09-22
**From:** gateway-kh (private Content Packs shelf)
**To:** Story Studio KH (lead session)
**Re:** `_handoffs/2026-09-22_story-ping-1.4.219-and-content-pack-updates.md`
**Provenance:** delivered by the owner as text and transcribed here verbatim in substance. The gateway's own copy
sits on their side at `_handoffs/2026-09-22_gateway-content-pack-1.4.219.md`.

---

## One correction first, because it changes questions 2–4

On 2026-09-22 gateway-kh removed its Content Pack authoring surface (commit `3ab440f`). It is now a
**publisher only**: a `.sspack` is authored outside it and imported into the private shelf, which signs and
serves it. So gateway-kh holds **no pack sources and no `authoring-registry.json`** — the registry your
branch carries in `8051fc28` is in the Story checkout, not ours — and `min_app_version` is **read from each
pack's own manifest**, never set by us. The delivery unit is the archive; the shelf is the source of truth.

## 1. What changed, and the exact kinds we publish now

No kind, pack schema or wire field changed in our recent updates. The shelf accepts and serves **six** wire
kinds (local → wire):

| local kind | wire kind | releases |
|---|---|---|
| topic-pack | `topic_pack` | 49 |
| series-formula | `series_formula` | 22 |
| visual-style | `visual_style` | 44 |
| thumbnail-recipe | `thumbnail_recipe` | 37 |
| lettering-style | `font_pack` | 26 |
| metadata-formula | `metadata_formula` | 9 |
| | **total** | **187** |

The four base kinds are still the four we ship — **49/22/44/37** (your verified 45/19/40/36 predates the
re-authored `-v2` set being shelved) — plus **26 `font_pack`** and **9 `metadata_formula`**. The map is
`kind.replace("-", "_")` plus the one exception `lettering-style → font_pack`. **`niche_bundle` (Channel
Kit) is retired**: `channel-kit` is not accepted and we will not add it. Do not expect it from gateway-kh.

## 2. `min_app_version` per kind — nothing needs more than 1.4.219

`topic_pack` · `series_formula` · `visual_style` · `thumbnail_recipe` are **1.0.843** (the shipped floor).
`font_pack` is **1.4.216** (the lettering prompt bridge, so an installed pack resolves its own phrases).
`metadata_formula` is **1.4.216** (the kind parses and a formula is selectable). **Nothing we publish needs
anything above 1.4.216**, so 1.4.219 clears every pack, and we publish nothing specific to
1.4.217/1.4.218/1.4.219. Both 1.4.216 floors are the pack manifests' own declarations.

## 3. Do our newest packs supersede `8051fc28`?

There is no newer pack update. The newest shelf `published_at` is `2026-09-22T02:14Z`; `8051fc28` is the
authoring record committed after the shelf was populated. The shelf serves the re-authored `-v2` set and
**no `-v1` remains**, so the `-v2` packs are current. All three packs your guards name are on the shelf and
served:

- `com.storystudio.pack.topic.deep-time-field-record.ancient-oceans-deep-sea-v2@1.0.0` — `aee42534f81d5782038c223512f6c058e75ab1d8a863cc825aeea8a8fdc7a5af`
- `com.storystudio.pack.formula.ancient-humans-v2@1.0.0` — `03687670503a35ca92555127193763c40334e8dd4d8ad23102d2eebf4d917b70`
- `com.storystudio.pack.topic.keeping-food-before-refrigeration@1.0.0` — `df2ab135ea82810f15be16e42165ba51a5699429581a107020b6ebc0ab1a4a47`

Your four guard failures (`deep-time-cross-pack-overlap`, `formula-substance-not-rebilled`,
`topic-pack-anti-padding`) read the **authoring record** — the registry and the source directories — neither
of which gateway-kh owns or ships. **Owner's decision: `8051fc28` is retired — drop the commit.** Keep the
sources on that branch if you want them for a future re-author; delivery does not depend on it. Neither repo
can make the guards pass by changing gateway-kh, because gateway-kh no longer authors.

## 4. How to consume the update

Confirmed: pack-only changes ship as their own `.sspack` files imported into the shelf, with **no app
release**. (The gateway's own version is `0.2.1`; its recent changes are fleet routing/readiness and token
copy, none of which touch the Content Pack contract.) **No new pack delivery is pending** since the `-v2`
batch. The shelf is the source of truth: enumerate current releases from the gateway's
`/admin/api/content-shelf` — each row carries `pack_id`, `version`, `kind`, `archive_sha256`, `bytes`,
`published_at` — and verify each download against the `archive_sha256` in the delivery grant. Releases are
signed by the shelf's Ed25519 identity (unchanged); baseline revision is `289`, so every delivered receipt
revision sits above it. A full 187-row manifest is available from the owner on request; it is deliberately
not kept in the git repo.

---

## What Story Studio did with this reply

- **`8051fc28` retired by revert**, not by rewriting published history: the authoring record the commit added
  (`content-packs/rebuilt/**` and the registry revision it carried) is removed from the branch's working
  line, and the registry returns to the **289** baseline the shelf expects. The commit itself stays in
  history and is recoverable; the SHA is recorded in `_trash/README.md`.
- **`NEW-08` closed**: it was an authoring-registry entry with no source directory. With the authoring
  record retired, the shelf — not the registry — is the source of truth, exactly as the gateway states.
- **The four guard failures are resolved by the revert** and re-verified in the content-pack lane.
- **`niche_bundle` stays parseable and is marked retired**: the code accepts it so a historical archive can
  still be read, but the gateway will never publish `channel-kit`, so no UI or catalogue work depends on it.
  Removing the kind outright is a separate cleanup decision, not taken here.
