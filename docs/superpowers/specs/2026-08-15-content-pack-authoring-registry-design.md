# Content Pack Authoring Registry Design

**Status:** Owner-approved implementation design

## Goal

Provide one Git-tracked Story Studio authority that reserves Content Pack identities before
parallel component authoring begins. The registry prevents silent identity reuse, produces an
auditable reservation receipt, and keeps Story content identities separate from GenStudio wire
and commerce identities.

## Authority boundary

The registry may issue and record only:

- `pack_id`, optional `item_id`, optional kit `bundle_id`, `version`, and `publisher_id`;
- the release-bound `min_app_version` status;
- exact source path, kind, and dependency closure;
- Story stocking proposals for `family` and `sku`, each marked `proposed`, `reserved`, or
  `confirmed`, with a GenStudio confirmation reference only when confirmed.

It must reject `product_id`, `release_id`, account, quote, purchase, entitlement, grant, price,
discount, shelf, and other GenStudio-owned wire facts. The registry never publishes, stocks,
signs, builds, uploads, purchases, installs, or grants content.

## Repository shape

`content-packs/authoring-registry.json` is the single coordinator-owned source. It contains a
monotonic integer revision and one record per authored or reserved Story pack. The initial
revision reconciles all 55 current source packs: 46 Free Starter packs and nine componentized
Archival Ledger packs.

Every record contains a stable receipt reference, identity facts, component kind, source path,
status, exact dependency records, and the stocking proposal state. Coordination packs have a
`bundle_id` and no `item_id`; creative component packs have one `item_id` and no `bundle_id`.

Future paid-wave directions stay out of the registry until their proposal passes the admission
policy in `docs/product/content-store-paid-wave-boundaries.md`. A direction is not a reservation.

## Reservation flow

Only the coordinator reserves identities. A reservation request supplies the expected registry
revision and the complete batch before leaf agents start. The command:

1. reads and strictly validates the current registry;
2. requires the expected revision to match;
3. rejects duplicate or previously used pack, item, bundle, family, and SKU identities;
4. rejects GenStudio-owned or unknown fields;
5. validates exact dependency identities and the coordinator/leaf shape;
6. derives a deterministic receipt reference from the canonical accepted request;
7. writes the complete next registry atomically; and
8. returns the new revision and receipt without creating source files.

Parallel leaf agents consume the committed registry revision and receipt. They never mint IDs.
Independent coordinators starting from the same revision produce an explicit Git conflict rather
than silently combining competing reservations; the later coordinator must rebase and reserve
again against the new revision.

## Lifecycle flow

The coordinator records mutable lifecycle changes as revisioned CAS events. A reserved pack may
advance to authored only after its registered source exists and reconciles to the exact immutable
identity. Family and SKU proposals advance only `proposed` to `reserved` to `confirmed`, one step
per transition; `confirmation_ref` is required only for `confirmed` and forbidden otherwise.
Receipt binding covers the immutable identity from the accepted reservation, while registry
validation replays persisted lifecycle events to prove that current mutable state was reached by
monotonic validated transitions. The retired `content-packs/archival-ledger` source-only monolith
cannot be reserved.

## Validation and migration

The validator reconciles every discovered registered source against its actual `pack.json`, including
version, publisher, source path, item or bundle identity, dependency closure, family, and SKU. It
also proves every authored source is registered and exists exactly once. All JSON inputs are opened
without following symlinks, read through a bounded file handle to proven EOF, and rejected if the
file grows, changes, or is replaced during the read.

The four Story authoring skills name the real registry path and validation, reservation, and
leaf-facing receipt-verification commands. They fail closed with `Registry task required` when the
registry is missing, stale, invalid, or lacks an exact verified identity assignment.

Canonical complete copies of those four packages are stored under
`developer-migration/codex-skills/`; the developer migration command installs or checks their
personal `~/.codex/skills` copies byte-for-byte on a new computer.

## Acceptance

- All 55 current source packs reconcile with no duplicate identity.
- Stale revision, collision, malformed dependency, unknown field, and GenStudio-field requests
  fail without changing registry bytes.
- One accepted batch increments the revision once and returns a deterministic receipt.
- Replaying the same request cannot create a second reservation.
- Validation and reservation make no network, generation, signing, archive, customer-data, or
  commerce mutation.
