# Legacy Content Closure Design

**Status:** Owner-approved on 2026-09-01 by accepting all 24 recommended legacy-disposition decisions. Local Story Studio implementation, tests, commits, pull-request integration, and the repository-required local release artifact are authorized. Uploading, publishing, pricing, purchasing, granting, charging, or otherwise mutating GenStudio remains out of scope.

## Goal

Close every known Story Studio legacy-content ambiguity with a verifiable disposition: finish the prepared standalone products, convert the remaining useful runtime-only niches and topic lanes into independent Content Packs, withdraw obsolete pre-sale reservations without recycling identities, preserve customer compatibility, and record which built-ins intentionally remain free.

Completion means the authoring registry validates with no unexplained `reserved` records, all approved new sources build independently, every legacy lane appears in a tested disposition ledger, and no new Channel Kit can enter the authoring or shipping path.

## Product boundary

Every new product is one independently purchasable Content Pack with exactly one supported kind and `dependencies: []` unless the runtime technically consumes an exact external `pack_id@version`. Compatibility never creates a bundle, shared entitlement, coordinator product, or Channel Kit.

Historical Channel Kits remain readable, installable, and validatable for customers. They are read-only product history. New reservations, promotion to authored, arbitrary builds, shipping, stocking guidance, or publication of Channel Kits are refused. Historical rebuild support is limited to exact authored Kit identities already recorded in the authoring registry.

## Registry lifecycle

Add `withdrawn` as a terminal authoring-registry status for a reserved identity abandoned before sale.

- Allowed transition: `reserved -> withdrawn`.
- `withdrawn` may not transition to `authored`, change stocking-proposal state, or gain a later version under the same `pack_id`.
- The original receipt remains verifiable.
- The issued `pack_id`, item or bundle ID, family, and SKU remain permanently owned and may never be recycled.
- A withdrawn record must not have a materialized source directory. This distinguishes pre-sale withdrawal from post-sale retirement.
- Runtime archive lifecycle remains unchanged. An authored customer archive uses the existing `retired`/`replaced` semantics; `withdrawn` never appears inside an archive.
- Direct shipping selection of a withdrawn identity fails terminally. A mixed selector skips withdrawn versions and may ship only authored leaves.

## Existing reservation closure

Promote these prepared, source-complete products from `reserved` to `authored` after exact receipt, schema, preview, provenance, deterministic-build, and independent-review checks:

1. `com.storystudio.pack.thumbnail.prehistoric-survival-title-card@1.0.0`
2. `com.storystudio.pack.thumbnail.dreamlike-story-title-card@1.0.0`
3. `com.storystudio.pack.style.hand-drawn-hardship-cartoon@1.0.0`
4. `com.storystudio.pack.style.dreamlike-luminous-sleep-illustration@1.0.0`

Withdraw these obsolete pre-sale reservations, preserving their identities but removing only exact unused source roots after reference checks:

1. `com.storystudio.pack.thumbnail.animal-hardship-annotation@1.0.0`
2. `com.storystudio.pack.thumbnail.centered-hero-headline@1.0.1`
3. `com.storystudio.pack.thumbnail.portrait-block-right@1.0.1`
4. `com.storystudio.pack.thumbnail.dreamscape-story-window@1.0.1`
5. `com.storystudio.pack.kit.symbolic-psychology-studio@1.0.1`

The four obsolete Thumbnail versions have authored same-lineage alternatives. The Symbolic Psychology creative leaves remain intact; only its unsold coordinator reservation is withdrawn.

## New standalone Series Formula products

Reserve all five identities atomically, author one source per identity, verify each exact reservation receipt before source creation, and transition each independently to `authored`:

| Legacy input | Standalone identity | Decision |
| --- | --- | --- |
| `listicle-explainer` | `com.storystudio.formula.counted-explainer` | Adopt as Counted Explainer. |
| `pov-hustle` | `com.storystudio.formula.build-under-constraints` | Adopt as Build Under Constraints. |
| `philosophy` | `com.storystudio.formula.philosophy-real-problem` | Adopt as Philosophy for a Real Problem. |
| `devotional` + `preaching` | `com.storystudio.formula.pastoral-scripture` | Absorb both modes into one Pastoral Scripture Formula. |
| `prayer` | `com.storystudio.formula.prayer` | Adopt separately from teaching/preaching. |

Each Formula carries the legacy prompt-relevant contract through explicit schema fields: promise, audience, perspective, narrative-quality contract, title rules, script structure, planning axes, vocabulary, evidence posture, metadata guidance, and compatible Topic IDs. Camel-case legacy objects are translated field by field; sources are never spread blindly.

`dark-psychology` is absorbed into the authored Human Behavior Formula and compatible social-dynamics topics. It does not receive a competing Formula product. `music-mix` remains readable for old projects but is retired from Story Content Store migration because its workflow is owned by the existing music-video subsystem rather than a narrative Formula.

## New standalone Topic Pack products

Create twelve separate products so customers can choose each lane independently:

1. `com.storystudio.topic.ancient-humans-environments`
2. `com.storystudio.topic.ancient-humans-social-life`
3. `com.storystudio.topic.ancient-humans-technology`
4. `com.storystudio.topic.deep-time-speculative-earth`
5. `com.storystudio.topic.economics-ancient-civilizations`
6. `com.storystudio.topic.natural-world-fungi`
7. `com.storystudio.topic.natural-world-insects`
8. `com.storystudio.topic.natural-world-plants`
9. `com.storystudio.topic.pastoral-daily-reflection`
10. `com.storystudio.topic.pastoral-expository-teaching`
11. `com.storystudio.topic.pov-criminal-hierarchies`
12. `com.storystudio.topic.pov-law-enforcement`

Each Topic source preserves every legacy subject and adds the strict planning corpora required by the current schema: episode objects, time/place scopes, mechanisms, evidence lenses, exclusions, prompt context, and explicit compatibility. The conversion must advertise and test only the capacity it actually contains; it must not inherit or imply a 1,000-idea claim from unrelated successor work.

Compatibility is exact and reciprocal:

- Ancient Humans topics -> `com.storystudio.formula.ancient-humans`.
- Speculative Earth -> `com.storystudio.formula.deep-time-documentary`, with counterfactuals explicitly labeled and constrained by real physical evidence.
- Ancient Civilizations Economics -> `com.storystudio.formula.economics-of` and `com.storystudio.formula.history-explained`.
- Fungi, Insects, and Plants -> `com.storystudio.formula.natural-world-explained` and the new Counted Explainer.
- Daily Reflection and Expository Teaching -> the new Pastoral Scripture Formula.
- Criminal Hierarchies and Law Enforcement -> `com.storystudio.formula.pov-your-life-as`, with non-glorification, no operational criminal guidance, and institutional/factual evidence rules.

Legacy short IDs remain readable through the current loaders. Existing projects are not silently rewritten or repinned.

The authored free `History, Explained` releases predate Ancient Civilizations Economics and therefore cannot reciprocate that new Topic ID without changing immutable release bytes. Before authoring the Topic, reserve and author a minimal free `com.storystudio.pack.formula.history-explained@1.0.2` successor that differs only by adding `com.storystudio.topic.economics-ancient-civilizations` to `compatible_topic_pack_ids` and documenting the compatibility addition. The successor retains the existing family/SKU and free-builtin disposition; it is qualification evidence, not a twenty-second paid handoff product.

## Intentional free baselines

The following are complete as built-in customer choices and are not cloned into Store products:

- 35 built-in Lettering styles.
- Five built-in Metadata formulas.
- 16 built-in Subtitle styles.
- 31 built-in Scene effects.
- 13 built-in Overlays.

Future premium products in these kinds must be materially distinct additions. They are new product design, not unfinished legacy migration.

## Verifiable disposition ledger

Add `content-packs/legacy-migration-dispositions.json` as a non-authoritative audit ledger. The authoring registry remains the sole identity authority. The ledger records every legacy niche, runtime-only Topic lane, prepared reservation, obsolete reservation, and built-in-only category as exactly one of:

- `authored-standalone`
- `absorbed`
- `withdrawn-pre-sale`
- `retained-free-builtin`
- `retired-runtime-compatible`
- `historical-read-only`

A source-contract test cross-checks ledger targets against the authoring registry and runtime inventories, rejects duplicate or missing legacy keys, and proves that no entry is labeled complete while its target is still reserved or absent.

## Evidence and archives

Every authored standalone leaf must pass:

- strict schema parse and exact manifest/document identity;
- registry receipt verification and source reconciliation;
- compatibility resolution and adapter projection;
- originality, factual/safety, copy, and commercial-boundary review;
- deterministic source build twice to fresh paths;
- `genstudio-store-receipt-v1` validation;
- identical bytes and SHA-256 across both builds;
- archive size at or below 52,428,800 bytes;
- absence of publisher signatures, private keys, prices, provider routing, executable content, and Channel Kit membership.

Visual and Thumbnail leaves also retain their existing decoded-preview, provenance, license, checksum, and independent visual-review evidence. Thumbnail Recipes retain three to five meaningfully varied 16:9 previews and exact in-image-title behavior.

Candidate archives and review evidence are local artifacts only. The final handoff may request separate products and one 300-credit/no-discount price per product, but Story Studio does not upload, publish, price, stock, or mutate GenStudio.

## Release and integration

Runtime/tooling changes require Story Studio `1.4.93`, matching `package.json`, `package-lock.json`, and the newest `CHANGELOG.md` entry. Run focused red/green tests during implementation, then the complete repository verification and unsigned DMG smoke workflow required by `AGENTS.md`. Integration follows the standing clean-branch pull-request and merge rule; no deployment or public publication is authorized.

## Non-goals

- No new Channel Kit, bundle, shared entitlement, or coordinator product.
- No conversion of free built-ins into look-alike paid products.
- No production preview generation on this control Mac.
- No silent migration of persisted legacy project selections.
- No GenStudio product, release, price, purchase, grant, upload, publication, or customer-data mutation.
