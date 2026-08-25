# Topic Pack 1,000-Idea Repair — Owner Decision Groundwork

**Date:** 2026-08-25  
**Mode:** read-only investigation; no pack, planner, schema, registry, archive, stocking, pricing, publication, commit, or push mutation was performed.  
**Inbound finding:** `<owner-home>/Developer/_handoffs/2026-08-24_to-gpt-storystudio_from-claude-genstudio_topic-pack-idea-capacity-shortfall.md`

## Outcome first

GenStudio's corrected finding is reproducible with the real
`planIdeaAssignments()` implementation. Individually, none of the 16 stocked Topic
Packs can currently supply 1,000 planned ideas. The ten authored-profile Starter
packs currently stop at one idea per subject (10–40 total), Audience Question
Seeder stops at 6, and each Archival Ledger Topic Pack stops at 100.

The smallest source-only repair that works without changing any Formula, schema,
or planner behavior is:

- at least **50 subjects** per Topic Pack;
- `max_siblings_per_subject: 20`;
- for each of the ten packs that already uses `coverage_profiles`, preserve that
  quality boundary and author **20 complete coherent tuples per subject**;
- for each of the six packs that already intentionally uses independent axes,
  preserve that model and author at least **20 distinct values in each material
  axis**: `episode_objects`, `time_place_scopes`, and `mechanisms`.

That is the mathematical minimum: `50 subjects × 20 materially distinct siblings
= 1,000`. An in-memory structural fixture for each real Formula/Topic pairing was
run through the repository's real planner and returned exactly 1,000 assignments
and 1,000 unique fingerprints for all 16 packs.

This is a capacity proof, not a creative-quality shortcut. For the ten profile
packs, 50×20 means 1,000 subject-specific authored tuples per pack. Shared generic
axis lists or formula coverage angles cannot replace those tuples: the planner
deliberately filters coherent material axes out when a profile exists, and it
rejects siblings that repeat an episode object or mechanism.

## Applicable contracts read

- repository `AGENTS.md`;
- `<owner-home>/.codex/skills/story-studio-niche-adoption/SKILL.md`;
- `<owner-home>/.codex/skills/story-studio-niche-adoption/references/two-layer-model.md`;
- `electron/server/services/idea-campaign-planner.ts`;
- Topic Pack schema and refinements in
  `electron/server/content-packs/schemas.ts`;
- planner/source coverage in
  `electron/server/__tests__/idea-campaign-planner.test.ts` and
  `electron/server/__tests__/free-starter-signed-source-golden.test.ts`;
- GenStudio's stocking intake contract, noting the owner's later standalone
  300-credit ruling supersedes its earlier kit-only/component-zero-price rule.

## Reproduced current capacity

The probe used each committed Topic Pack source, adapted it with
`contentPackDocumentToTopicPack()`, paired it with a compatible committed Formula,
and called the real `planIdeaAssignments()`.

For profile packs the recorded maximum is a successful call at the maximum and a
throw at maximum+1. For non-profile packs a request for 5,000 was made and the
returned assignment count recorded.

| Current source (all `1.0.0`) | Subjects | Sibling cap | Profile tuples/subject | Actual individual maximum | Proof boundary |
|---|---:|---:|---:|---:|---|
| `ancient-humans-survival` | 20 | 1 | 2 | 20 | 20 returns; 21 throws |
| `deep-time-earth-systems` | 30 | 1 | 2 | 30 | 30 returns; 31 throws |
| `economics-businesses` | 40 | 1 | 2 | 40 | 40 returns; 41 throws |
| `everyday-calm` | 15 | 1 | 2 | 15 | 15 returns; 16 throws |
| `habits-momentum` | 15 | 1 | 2 | 15 | 15 returns; 16 throws |
| `historical-wars-treaties-world-order` | 25 | 1 | 2 | 25 | 25 returns; 26 throws |
| `human-behavior-social-dynamics` | 10 | 1 | 2 | 10 | 10 returns; 11 throws |
| `natural-world-animals` | 10 | 1 | 2 | 10 | 10 returns; 11 throws |
| `night-journeys` | 15 | 1 | 2 | 15 | 15 returns; 16 throws |
| `pov-historical-occupations` | 25 | 1 | 2 | 25 | 25 returns; 26 throws |
| `audience-question-seeder` | 6 | 1 | none | 6 | request 5,000 returns 6 |
| `archival-ledger.empires-trade-extraction` | 25 | 4 | none | 100 | request 5,000 returns 100 |
| `archival-ledger.infrastructure-commodities-corporate-power` | 25 | 4 | none | 100 | request 5,000 returns 100 |
| `archival-ledger.money-debt-financial-institutions` | 25 | 4 | none | 100 | request 5,000 returns 100 |
| `archival-ledger.states-revolutions-collapse` | 25 | 4 | none | 100 | request 5,000 returns 100 |
| `archival-ledger.wars-treaties-world-order` | 25 | 4 | none | 100 | request 5,000 returns 100 |

The planner throws for an under-capacity profile campaign rather than returning a
partial result. A 1,000 request therefore produces no usable campaign in those ten
packs today.

### Exact committed source/version inventory

Every manifest below declares `version: "1.0.0"`; the authoring registry records
the same version and an `authored` Story status. GenStudio's handoff supplies the
separate evidence that these products are stocked. Repository state alone must
not be mistaken for deployed-store state.

| Pack ID / item ID | Current source root |
|---|---|
| `com.storystudio.pack.topic.ancient-humans-survival` / `com.storystudio.topic.ancient-humans-survival` | `content-packs/free-starters/topic/ancient-humans-survival` |
| `com.storystudio.pack.topic.deep-time-earth-systems` / `com.storystudio.topic.deep-time-earth-systems` | `content-packs/free-starters/topic/deep-time-earth-systems` |
| `com.storystudio.pack.topic.economics-businesses` / `com.storystudio.topic.economics-businesses` | `content-packs/free-starters/topic/economics-businesses` |
| `com.storystudio.pack.topic.everyday-calm` / `com.storystudio.topic.everyday-calm` | `content-packs/free-starters/topic/everyday-calm` |
| `com.storystudio.pack.topic.habits-momentum` / `com.storystudio.topic.habits-momentum` | `content-packs/free-starters/topic/habits-momentum` |
| `com.storystudio.pack.topic.historical-wars-treaties-world-order` / `com.storystudio.topic.historical-wars-treaties-world-order` | `content-packs/free-starters/topic/historical-wars-treaties-world-order` |
| `com.storystudio.pack.topic.human-behavior-social-dynamics` / `com.storystudio.topic.human-behavior-social-dynamics` | `content-packs/free-starters/topic/human-behavior-social-dynamics` |
| `com.storystudio.pack.topic.natural-world-animals` / `com.storystudio.topic.natural-world-animals` | `content-packs/free-starters/topic/natural-world-animals` |
| `com.storystudio.pack.topic.night-journeys` / `com.storystudio.topic.night-journeys` | `content-packs/free-starters/topic/night-journeys` |
| `com.storystudio.pack.topic.pov-historical-occupations` / `com.storystudio.topic.pov-historical-occupations` | `content-packs/free-starters/topic/pov-historical-occupations` |
| `com.storystudio.pack.topic.audience-question-seeder` / `com.storystudio.topic.audience-question-seeder` | `content-packs/reusable-primitives/topic/audience-question-seeder` |
| `com.storystudio.pack.topic.archival-ledger.empires-trade-extraction` / `com.storystudio.topic.archival-ledger.empires-trade-extraction` | `content-packs/paid/archival-ledger/topic/empires-trade-extraction` |
| `com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power` / `com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power` | `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power` |
| `com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions` / `com.storystudio.topic.archival-ledger.money-debt-financial-institutions` | `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions` |
| `com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse` / `com.storystudio.topic.archival-ledger.states-revolutions-collapse` | `content-packs/paid/archival-ledger/topic/states-revolutions-collapse` |
| `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order` / `com.storystudio.topic.archival-ledger.wars-treaties-world-order` | `content-packs/paid/archival-ledger/topic/wars-treaties-world-order` |

## Why these are the real limits

The committed schema permits:

- up to 1,000 subjects;
- `max_siblings_per_subject` from 1 through **20**;
- one coverage profile for every declared subject when profiles are used;
- 2 through **50** tuples per coverage profile;
- up to 1,000 top-level values for each material list.

The planner enforces materially distinct siblings with
`episode-object`, `time-place-scope`, and `mechanism`; repeated episode objects or
mechanisms are rejected. For a profile pack, capacity is therefore:

`subjects × min(max_siblings_per_subject, minimum tuples per subject)`

For an independent-axis pack it is:

`subjects × min(max_siblings_per_subject, episode_objects, time_place_scopes, mechanisms)`

Formula-owned coverage angles, presentation lenses, evidence-lens variations,
and title rewordings do not raise that material-sibling ceiling.

## Smallest truthful authoring targets

### A. Preserve profiles for the ten packs that already use them

These packs have explicit source tests rejecting cross-subject generic objects,
requiring complete atomic tuples, and requiring a new episode object and mechanism
for every sibling. Converting them to shared coverage groups or independent axes
would weaken an intentional quality guarantee merely to reduce authoring volume.

| Pack | Current subjects | Required subject additions | Target profiles | Target tuples/profile | Target sibling cap | New tuple rows required beyond current source |
|---|---:|---:|---:|---:|---:|---:|
| Animals | 10 | 40 | 50 | 20 | 20 | 980 |
| Social Dynamics & Boundaries | 10 | 40 | 50 | 20 | 20 | 980 |
| Night Journeys | 15 | 35 | 50 | 20 | 20 | 970 |
| Habits & Momentum | 15 | 35 | 50 | 20 | 20 | 970 |
| Everyday Calm | 15 | 35 | 50 | 20 | 20 | 970 |
| Survival Problems | 20 | 30 | 50 | 20 | 20 | 960 |
| Historical Occupations | 25 | 25 | 50 | 20 | 20 | 950 |
| Wars, Treaties & World Order (History cut) | 25 | 25 | 50 | 20 | 20 | 950 |
| Earth Systems & Deep Change | 30 | 20 | 50 | 20 | 20 | 940 |
| Businesses & Companies | 40 | 10 | 50 | 20 | 20 | 920 |

Total new profile tuples: **9,590**. Every tuple must be a complete, coherent,
filmable subject treatment, not a syntactic permutation. Each profile's 20
episode objects and 20 mechanisms must be distinct. Existing golden-source policy
also expects core object+mechanism pairings not to be copied between subjects.

The 50×20 shape is semantically defensible for all ten domains only under that
strict authoring rule: broaden each pack to 50 real subjects and give each subject
20 genuinely distinct treatments. It is not appropriate if “20” would be met by
relabeling the same event or repeating generic objects. In that case the pack is
not ready and must remain unsent.

### B. Preserve independent axes for the six packs that already use them

The Audience Question Seeder and five Archival Ledger cuts were deliberately
authored as reusable cross-subject analytic axes. They do not need 1,000 explicit
profile rows if the expanded material values remain applicable to every subject.

| Pack(s) | Subject target | Subject additions | Material-axis target | Required axis additions | Sibling cap | Capacity |
|---|---:|---:|---:|---:|---:|---:|
| Audience Question Seeder | 50 | 44 | at least 20 each | +14 episode objects, +14 time/place scopes, +14 mechanisms | 20 | 1,000 |
| Each Archival Ledger Topic Pack | 50 | 25 | at least 20 each | +12 episode objects, +16 time/place scopes, +12 mechanisms | 20 | 1,000 |

`evidence_lenses` is not part of the planner's material-capacity minimum. Keeping
fewer than 20 is schema-valid and still produces 1,000 unique material plans, but
**20 evidence lenses is recommended as a quality target** so the evidence posture
does not cycle much faster than the episode structures.

If an axis value is not coherent across every subject in one of these packs, that
pack must be split into evidence-supported coverage groups or converted to
subject profiles. Do not retain the cheaper independent-axis plan by inventing
vague values such as “a system,” “a record,” or “a process.”

## Why not raise caps or lean on Formula axes

- Raising the schema/planner sibling limit would change application behavior and
  still produce 25–100 episodes about one subject in the smaller packs. It does
  not solve the semantic-authoring problem.
- Adding more top-level material lists to a profile pack changes nothing because
  the planner deliberately excludes those lists when the subject has a profile.
- Adding Formula coverage angles changes framing, not the material episode object
  and mechanism, and the duplicate guard correctly rejects it as a new sibling.
- Converting the ten profile packs to shared groups would reduce source volume but
  reverse the current subject-specific coherence contract and its regression
  tests.
- A fixed list of 1,000 titles is not the Topic Pack model and would make
  uniqueness depend on phrasing rather than structured material.

## Exact owner decision

### Decision requested

Approve the **minimum breadth-plus-depth repair** for all 16 existing Topic Pack
products:

1. target 50 real subjects and 20 material siblings per subject;
2. keep the ten existing profile packs profile-based, with 20 authored coherent
   tuples for every subject;
3. keep Audience Question Seeder and the five Archival Ledger packs
   independent-axis based only where every expanded axis remains coherent across
   every subject;
4. preserve all Formula, planner, and schema behavior;
5. release the improved sources as `1.0.1` under the same product/pack/item/family
   identities.

**Recommendation: approve.** It is the smallest implementation that truthfully
meets the stated 1,000-per-pack bar without weakening coherence or modifying the
runtime.

### Alternative

Use **60 subjects × 20 siblings = 1,200** for 200 slots of fresh-idea headroom.
This avoids reaching the exact lifetime ceiling immediately after some ideas are
already reserved, but adds 2,000 more subject-specific tuples across the ten
profile packs. Recommend this only if the owner's meaning is “a campaign can ask
for 1,000 additional ideas after as many as 200 prior ideas from that same pack,”
rather than “the pack contains at least 1,000 unique lifetime assignments.”

No other owner decision is needed for product structure: the owner has already
superseded kit-only distribution and set new standalone assets/packs to **300
credits**. These are versions of existing products, not 16 new products; GenStudio
should preserve the 300-credit product price and add the improved release under
the same product only after finished archives arrive. Exact entitlement/upgrade
behavior remains GenStudio's deployed-store authority and must be confirmed in
its completion reply rather than invented by Story.

## Source and version scope

Preserve every current `1.0.0` source byte-for-byte. Reserve and author sibling
`1.0.1` source directories so historical sources remain reproducible:

- `content-packs/free-starters/topic/ancient-humans-survival-v1.0.1`
- `content-packs/free-starters/topic/deep-time-earth-systems-v1.0.1`
- `content-packs/free-starters/topic/economics-businesses-v1.0.1`
- `content-packs/free-starters/topic/everyday-calm-v1.0.1`
- `content-packs/free-starters/topic/habits-momentum-v1.0.1`
- `content-packs/free-starters/topic/historical-wars-treaties-world-order-v1.0.1`
- `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1`
- `content-packs/free-starters/topic/natural-world-animals-v1.0.1`
- `content-packs/free-starters/topic/night-journeys-v1.0.1`
- `content-packs/free-starters/topic/pov-historical-occupations-v1.0.1`
- `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1`
- `content-packs/paid/archival-ledger/topic/empires-trade-extraction-v1.0.1`
- `content-packs/paid/archival-ledger/topic/infrastructure-commodities-corporate-power-v1.0.1`
- `content-packs/paid/archival-ledger/topic/money-debt-financial-institutions-v1.0.1`
- `content-packs/paid/archival-ledger/topic/states-revolutions-collapse-v1.0.1`
- `content-packs/paid/archival-ledger/topic/wars-treaties-world-order-v1.0.1`

For every successor, retain the exact current `pack_id`, `item_id`,
`publisher_id`, entitlement family/SKU, compatibility declarations, and empty
dependency closure. Change only the Story content version to `1.0.1` plus the
expanded Topic source and truthful changelog. Before authoring, the coordinator
must reserve all 16 exact successor identities in one registry CAS batch and pass
the receipt to leaves; this investigation deliberately did not reserve them.

## Required tests before any GenStudio handoff

### Identity and source integrity

- registry validates before reservation;
- one coordinator-owned 16-record reservation, exact receipt verification for
  every leaf, then authored/reviewed transitions only after evidence passes;
- every `1.0.1` keeps the exact predecessor identity/family/SKU/dependencies and
  only advances the version;
- all 16 predecessor `1.0.0` trees remain byte-identical;
- all Topic documents parse through the strict real schema.

### Capacity and determinism — each pack independently

- adapt the real committed Formula and Topic source through production adapters;
- `planIdeaAssignments({ count: 1000 })` returns at least 1,000 and the first
  1,000 contain exactly 1,000 unique fingerprints and idea keys;
- repeat with the same seed and assert byte/deep equality;
- assert 50+ subjects and no more than 20 siblings per subject;
- assert each subject contributes 20 distinct episode objects, time/place scopes,
  and mechanisms;
- reserve 500, pass those fingerprints as `usedFingerprints`, then reserve the
  remaining 500: no overlap and exactly 1,000 cumulative assignments;
- after all 1,000 are reserved, another profile-pack request fails closed rather
  than repeating structural material; generic packs return no repeated material.

### Profile-pack quality

- exactly one coverage profile per subject;
- at least 20 complete tuples per profile;
- every tuple value exists in the pack's declared lists;
- each returned assignment equals one authored whole tuple—no independent mixing;
- episode object and mechanism are distinct within every profile;
- reject placeholders, subject echoes, copied core object/mechanism pairs, and
  generic abstract objects;
- independent editorial/factual review per pack covering coherence, exclusions,
  evidence posture, compatibility, originality, safety, and copy quality.

### Independent-axis quality

- at least 20 unique values for every material axis;
- prove each material value is coherent with every subject, or place it in a
  narrower reviewed group/profile;
- verify all 20 material values are actually reached for every subject;
- preserve formula-owned structure and pack-owned subject/material separation.

### Candidate/release evidence

- focused planner, schema, adapter, predecessor-golden, pack-source, and
  deterministic-build tests;
- full backend tests plus typecheck, lint, security, model-drift, registry
  validation, changelog/version gates when applicable;
- two deterministic keyless builds per leaf using
  `genstudio-store-receipt-v1`, exact archive SHA-256/bytes/minimum app version,
  strict validator success, component summary v1, and no open review finding;
- independent final review of every candidate and the aggregate 16-pack ledger.

Only after **all required decisions are resolved and a specific release has real
validated archive bytes** may it cross to GenStudio. The submission must contain
no `blocked`, `partial`, `pending-review`, `awaiting-owner`, scaffold, reservation,
or future-version promise. Under the owner's latest instruction, send standalone
completed Topic Pack releases with the required 300-credit final product state;
do not create or depend on a Channel Kit.
