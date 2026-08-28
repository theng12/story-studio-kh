# Proposed content-pack sources

Authored pack sources that have been written and measured but whose catalog
identities are **not yet reserved**.

## Why they are not under `content-packs/`

The authoring registry walks every directory under `content-packs/` and refuses
any `pack.json` it finds there that has no registry record
(`scripts/content-packs/authoring-registry.mjs`, `reconcileSources`). That rule is
correct: a signable source inside the publisher tree without a reserved identity
is exactly the thing it exists to prevent.

The wave-boundaries policy
(`docs/product/content-store-paid-wave-boundaries.md`) puts identity assignment
*after* proposal acceptance, and the proposal gate puts authoring *before* it. So
between those two moments a wave's source legitimately exists with no reserved
identity. This directory is where it waits. Nothing here is registered, signed,
stocked, priced or published, and the identity strings in each `pack.json` are a
proposal input rather than a reservation.

## What is here

| Source | Proposal | Status |
| --- | --- | --- |
| `deep-time-field-record/topic/prehistoric-life-extinction` | `docs/product/deep-time-field-record-wave-one-proposal.md` | authored and measured; identity unreserved |

## Moving one into the publisher tree

When a wave is accepted and its identities are reserved:

1. Reserve the identities through `npm run content-pack:registry`.
2. `git mv` the source into `content-packs/paid/<collection>/<kind>/<slug>`.
3. Replace the `{{KEY_ID}}` token with the reserved publisher key id if the family
   uses a fixed one, or leave the token and pass `--key-id` at build time.
4. Re-run the wave's acceptance evidence from the new path.

The move is a rename: no content changes, so the built archive's document bytes
are unchanged by it.
