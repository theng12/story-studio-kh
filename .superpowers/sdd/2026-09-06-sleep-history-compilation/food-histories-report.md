# Food Histories Topic Pack — authoring report

Pack `com.storystudio.pack.topic.food-histories` / item `com.storystudio.topic.food-histories` v1.0.0
(receipt `authoring:6a7d2a107dacc5f4f3ba37f76913e0dcc7861459094d7eb7af7ebf0fcbb9a473`, registry revision 143).

## Files created

- `content-packs/sleep-history/topic/food-histories/pack.json` (verbatim from the brief)
- `content-packs/sleep-history/topic/food-histories/content/topic-pack.json`
- Generator/corpus: `.superpowers/sdd/2026-09-06-sleep-history-compilation/food-histories-corpus.mjs`

Nothing else exists in the source root. `content-packs/authoring-registry.json` was not touched.
No git commands were run.

## Counts

| item | value |
| --- | --- |
| subjects | 50 |
| coverage profiles | 50 (one per subject, in subject order) |
| tuples total | 1000 (50 x 20) |
| episode_objects (deduplicated) | 1000 |
| time_place_scopes (deduplicated) | 944 |
| mechanisms (deduplicated) | 1000 |
| evidence_lenses (deduplicated) | 963 |
| unique full tuples | 1000 |
| unique episode_object&#124;mechanism pairs | 1000 |
| exclusions | 6 |
| idea_axes values | 10 |
| example_topics | 12 |
| youtube_tags_hint | 14 |
| compatibility_rules | 3 |
| evidence_expectations | 4 |
| prompt_context | 1232 chars (limit 1500) |
| topic-pack.json byte size | 796,410 bytes |

## Schema validation

Command run from the worktree root:

```
npx tsx -e "import { ContentPackDocumentSchema } from './electron/server/content-packs/schemas.ts'; ..."
```

Output:

```
SCHEMA OK
```

## Own audit

Built into the generator (`node .superpowers/sdd/2026-09-06-sleep-history-compilation/food-histories-corpus.mjs`).
Final run output:

```
subjects               50
coverage_profiles      50
tuples total           1000
episode_objects        1000
time_place_scopes      944
mechanisms             1000
evidence_lenses        963
unique full tuples     1000
unique object|mech     1000
prompt_context chars   1232
bytes written          796410
AUDIT OK
```

The audit asserts: 50 profiles of exactly 20 tuples; every tuple value present in the matching
top-level list; unique `episode_object` and unique `mechanism` inside each subject; no repeated full
tuple and no repeated `episode_object|mechanism` pair across the pack; per-field length bands
(object and scope 40–140, mechanism and lens 40–160); no leading/trailing/double whitespace; every
string 1–1000 chars (prompt_context 1–12000); and a regex sweep of every value for the forbidden
platform names, URI/domain-shaped references, provider/model routing directives, and
credential-shaped assignments. Only `youtube_tags_hint` (the key name) contains a forbidden word,
which the brief permits.

One earlier failure was fixed rather than waived: 331 `time_place_scope` values landed below the
40-character house minimum ("a Paris street in the 1720s"). Each of the 306 distinct strings was
rewritten individually with a scene detail appropriate to its own tuple — a season, an hour, a
piece of the setting — not by appending a shared suffix.

## Three sample tuples

**bread**, slot 4
- episode_object: an iron baker peel with a long ash handle, its blade scorched and thinned by use
- time_place_scope: a walled town bakehouse in the Low Countries during the 1400s
- mechanism: guild control of the trade, setting apprenticeship terms, permitted oven numbers, and who might sell bread at all
- evidence_lens: guild statutes, apprenticeship registers, and town council ordinances governing bakers

**pumpkin**, slot 8
- episode_object: a carved and candle-lit fruit set in a farmhouse window on an autumn night
- time_place_scope: a North American rural district in the 1800s
- mechanism: transfer of an older turnip carving custom onto a larger and easier fruit in a new country
- evidence_lens: folklore survey collections, local newspaper accounts, and community festival records

**salt cod**, slot 6
- episode_object: a cargo manifest listing dried fish outward and molasses homeward
- time_place_scope: an Atlantic trading route between three coasts in the 1700s
- mechanism: a triangular trade, in which a cheap grade of preserved fish provisions plantations that ship back sugar products
- evidence_lens: shipping manifests, merchant ledgers, and colonial trade statistics
