# Drinks & Spices Histories — topic pack authoring report

Pack `com.storystudio.pack.topic.drinks-and-spices-histories` / item
`com.storystudio.topic.drinks-and-spices-histories`, version 1.0.0
(registry revision 143, receipt `authoring:6a7d2a107dacc5f4f3ba37f76913e0dcc7861459094d7eb7af7ebf0fcbb9a473`).

## Files created

- `content-packs/sleep-history/topic/drinks-and-spices-histories/pack.json`
- `content-packs/sleep-history/topic/drinks-and-spices-histories/content/topic-pack.json`
- `.superpowers/sdd/2026-09-06-sleep-history-compilation/drinks-and-spices-histories-corpus.mjs` (hand-authored corpus + generator + audit)

Nothing else in the source root. `content-packs/authoring-registry.json` untouched.

## Counts

| item | count |
| --- | --- |
| subjects | 50 |
| coverage profiles | 50 (one per subject, in subject order) |
| coverage tuples | 1000 (20 per subject) |
| episode_objects (deduplicated) | 1000 |
| time_place_scopes (deduplicated) | 945 |
| mechanisms (deduplicated) | 1000 |
| evidence_lenses (deduplicated) | 907 |
| exclusions | 5 |
| idea_axes / values | 1 axis, 10 values |
| example_topics | 12 |
| tags | 3 |
| youtube_tags_hint | 12 |
| compatibility_rules | 3 |
| evidence_expectations | 4 |
| prompt_context | 1322 characters |
| `content/topic-pack.json` | 814,200 bytes |

`compatible_formula_ids` holds exactly `com.storystudio.formula.sleep-history-compilation`.
`max_siblings_per_subject` is 20.

## Schema validation

Run from the worktree root:

```
npx tsx -e "import { ContentPackDocumentSchema } from './electron/server/content-packs/schemas.ts'; ..."
SCHEMA OK
```

## Uniqueness / content audit

The generator asserts, and reports, all of the following:

- exactly 50 profiles, each with exactly 20 tuples, subjects matching the
  `subjects` list one-for-one and in order;
- within each subject, all 20 `episode_object` values unique and all 20
  `mechanism` values unique;
- across the whole pack, no repeated `episode_object|mechanism` pair and no
  repeated complete tuple (every object and every mechanism string is in fact
  globally unique, so both hold with room to spare);
- length bounds: `episode_object` and `time_place_scope` 40–140 characters,
  `mechanism` and `evidence_lens` 40–160 characters;
- every string 1–1000 characters (`prompt_context` 1–1500), and no string
  containing a URI/domain shape, a provider/model routing directive, a
  credential-shaped assignment, or any of the forbidden platform and product
  names.

Result: **AUDIT OK** (0 problems). An earlier run flagged 78 `time_place_scope`
strings that had fallen just under the 40-character floor; each was rewritten as
a fuller scene (season or working period added) and re-audited.

The only occurrence of a forbidden word anywhere in the JSON is the permitted
key name `youtube_tags_hint`.

## Three sample tuples

**tea**
- episode_object: a compressed brick of tea bound in bamboo leaf and roped for a mule load
- time_place_scope: a mountain trade road between Sichuan and the Tibetan plateau in the 1000s
- mechanism: compression makes a perishable leaf carriable, and the state exchanges it for horses under a controlled border trade
- evidence_lens: border market registers and the tribute and exchange schedules kept for frontier trade

**cinnamon**
- episode_object: a lined chest of quills stowed high and dry in a company ship
- time_place_scope: an Indian ocean passage toward Europe in the 1700s
- mechanism: a light bulky aromatic must be kept dry and away from other cargo, so stowage rules protect the value of a fragile good
- evidence_lens: ship cargo inventories and the company instructions issued to supercargoes

**star anise**
- episode_object: a seized consignment found mixed with fruit of the toxic relative
- time_place_scope: a European port inspection office in the 2000s
- mechanism: mixing is hard to see and dangerous to eat, so laboratory identification becomes a compulsory step at importation
- evidence_lens: port inspection laboratory reports and the published import control requirements

## Authoring notes

Each subject was given 20 deliberately different mechanism families — cultivation,
processing, vessel and container technology, trade route, monopoly and taxation,
adulteration and regulation, medicinal use, ritual use, class and fashion,
technological change, labour, naming and grading, migration, storage,
measurement, and decline or revival — so no two chapters of one subject are the
same episode retold. No named individuals, no makers or companies. Alcohol is
handled as making, trade, custom, and law; coercion (enslaved labour on rum,
coffee, and clove estates; debt bondage in the yerba mate camps) is stated once
and plainly through the records that hold it, never for colour.
