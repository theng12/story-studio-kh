# Paid Wave Proposal: Deep Time Field Record, wave one

Status: **proposal**. Not a product, not a release, not a price, not a shelf entry. This document
is submitted against `docs/product/content-store-paid-wave-boundaries.md` and must be accepted
against all seven admission gates before any commercial identity is assigned.

Free foundation: **Deep Time**.
Approved paid depth path for that lane: *"Enriched Prehistoric Life & Extinction; Ancient Oceans
& Deep Sea; Human Origins & Ancient Worlds; Speculative Earth Scenarios."*

This proposal takes that path as the wave's scope — four Topic components — and authors the
first two of them. Packs three and four are scoped here and authored later, each against this
same document plus the per-pack notes in "Wave sequencing" below.

## 1. What the wave is

**Deep Time Field Record** is an evidence-led palaeontology and deep-history collection for the
Deep Time Documentary channel format. Its editorial posture is the field record itself: a
specimen, a quarry, a core, a section, a monograph plate, an expedition notebook — and the
method that turns that object into a claim about the past.

Four Topic components, each an independent catalog identity:

| # | Component | Direction | Status |
| --- | --- | --- | --- |
| 1 | Prehistoric Life & Extinction (enriched) | Ancient ecosystems, evolutionary transitions, extinction mechanisms, and the specimens and sections that record them | **Authored in this wave** |
| 2 | Ancient Oceans & Deep Sea | Ocean chemistry and anoxia, currents and gateways, reefs as archives, sea-level cycles, the deep-sea record read from cores, and the instruments and expeditions that read them | **Authored in this wave** |
| 3 | Human Origins & Ancient Worlds | Hominin fossils, sites, dating controversies, dispersal and the archaeological record of the deep past | Scoped; not authored |
| 4 | Speculative Earth Scenarios | Counterfactual Earths built from real physical constraints and published model runs | Scoped; **evidence contract unresolved — see §8** |

## 2. Net-new outcome

The customer outcome this wave adds, which no unchanged free or legacy-included component
delivers today:

> A Deep Time channel can run a *specimen-first* documentary series — each episode built on one
> named object, in one named formation, at one named geological interval, with the analytical
> method that establishes it — for a full production year, without the operator selecting
> subjects, localities or evidence framing by hand.

The free foundation delivers the *format*: the Deep Time Documentary Formula (free) and the
Earth Systems & Deep Change Topic Pack (free), which is a planetary-mechanism direction —
mountains, oceans, atmospheres, ice. Neither delivers a life-and-extinction direction at
authored tuple grain.

The legacy built-ins deliver a *subject list only*. `deep-time-prehistoric-life` carries 30
subject strings, two idea axes and a prompt context, and **zero** authored episode objects,
scopes, mechanisms or evidence lenses — so it plans nothing at tuple grain and offers no
structured spread of place, period or method. That is a different product from what this wave
proposes, not a smaller amount of it.

This outcome is observable in the supported workflow: the difference shows up as authored
assignments the planner can reserve, with distinct localities and evidence methods, not as
different cover art.

## 3. Material content

Both authored packs carry the same shape. Pack 1 as authored:

* **100 named subjects**, spread across eight geological eras and nine evidence regions.
* **20 authored whole tuples per subject** on the family's four axes —
  `{episode_object, time_place_scope, mechanism, evidence_lens}` — matching
  `deep-time-earth-systems@1.0.1` exactly.
* **2,000 authored whole tuples**, every value on every axis distinct across the document.
* Coverage-profile mode: the runtime selects an authored whole tuple, never an independently
  zipped combination of axis values.

### Why 100 x 20 and not 50 x 20

The wave-boundaries policy sets no number; the honest floor is what the material supports and
what the family already publishes. Three reference points were measured, not assumed:

| Reference | Subjects | Tuples per subject | Structured assignments |
| --- | --- | --- | --- |
| Legacy built-in `deep-time-prehistoric-life` | 30 | none authored | 0 |
| Free family standard, `deep-time-earth-systems@1.0.1` | 50 | 20 | 1,000 |
| Paid family standard, the Archival Ledger 1.0.1 successors | 100 | 20 | 2,000 |

The paid standard is chosen. Palaeontology supports it comfortably and without padding: the
named Lagerstatten alone run to several dozen, the formally named extinction events and their
competing kill mechanisms to a dozen more, and every major evolutionary transition carries its
own well-attested specimen series, type locality and analytical literature. The owner's standing
rule is that more is better and there is no cap; the constraint applied instead was that every
one of the 100 subjects had to survive the same test — could a competent documentary writer
build twenty materially different episodes from it, each with its own object, locality, interval,
mechanism and method? Subjects that could not were cut before authoring, not padded during it.

At 2,000 authored assignments and the Deep Time Documentary Formula's two episode lanes, a
channel publishing three episodes a week has more than twelve years of non-repeating directions
from this component alone.

### Pack 2 as authored

Pack 2 is the same 100 x 20 = 2,000 on the same four axes, in coverage-profile mode, and meets
every structural commitment below at the same numbers. Its material is the ocean as a system
rather than the organism: 100 subjects across ten bands, from Precambrian ocean chemistry to the
instruments and expeditions that read the deep-sea record, spread over nine evidence regions.
Its editorial content divides roughly into ocean chemistry and redox, gateways and circulation,
reefs and carbonate platforms, sea-level cycles, the deep-sea sediment record, seafloor
ecosystems and ichnology, and the expeditions, vessels and proxies that recover them.

Two bars are stated differently for pack 2 because the subject matter differs, and both are
declared rather than assumed:

* **"Global and ocean basins" carries 39 subjects against pack 1's 20.** An ocean basin, a
  gateway, a circulation mode and a global isotope excursion have no single onshore address.
  The bar applied instead is the count of subjects that DO sit at a named regional address:
  61 of 100, against a declared floor of 55.
* **A process-heavy ceiling replaces pack 1's transition-subject ceiling.** Pack 1 counted
  subjects naming an evolutionary transition rather than a locality and capped them at 15/100.
  The same class here is the subject naming a process, a concept or an analytical method rather
  than a named basin, section, event, instrument or expedition. Pack 2 spends 11 against a
  ceiling of 12 — about one in ten.

### Structural commitments, each machine-checked

* Every `time_place_scope` names **both** a real place or stratigraphic setting **and** a real
  geological interval. (The free sibling satisfies this for roughly three-quarters of its scopes;
  the paid pack is held to all of them.)
* No two scopes inside a subject are the same setting reworded. Checked three ways: as a bag of
  words ignoring articles, again ignoring hedges, and again as {period words} plus {place words}.
* No subject echo: a subject string never appears inside its own episode objects or mechanisms.
* Affix share at or under 5% on every axis, so no template opening carries the pack.
* Disputed datings, affinities and kill mechanisms appear **only** in the evidence lens, as a
  named-record comparison. They are never asserted in a mechanism.

## 4. No legacy rebilling

* The four legacy built-ins (`deep-time-prehistoric-life`, `deep-time-deep-ocean`,
  `deep-time-human-origins`, `deep-time-speculative-earth`) remain in the app, unmodified,
  usable, and free. This wave withdraws nothing and rewrites nothing.
* Existing projects keep their current pins, including the free Deep Time kit's pin of
  `deep-time-earth-systems@1.0.1`.
* The paid pack shares **no authored bytes** with any legacy file. The legacy subject lists were
  read as reference material for editorial direction only; the paid subject list was authored
  independently at a materially finer grain — named formations, quarries, sections, expeditions
  and events in place of generic labels.
* No migration, replacement or upgrade path is offered by this wave. If one is ever wanted, the
  policy requires it to be a separate, separately reviewed choice.

## 5. Independent identity

Each of the four Topic components is proposed as its own catalog identity and entitlement
family, so any one of them can be owned, updated, withdrawn or reviewed without the others. The
wave is not a monolith and this proposal does not create a kit.

Each of the four Topic components is its own catalog identity and entitlement family, so any one
can be owned, updated, withdrawn or reviewed without the others. The wave is not a monolith and
this proposal does not create a kit.

**Both authored packs now hold a reserved identity promoted to `authored`.** Pack 1's
reservation chains from the repaired ledger (`d0b741f0` re-mint plus the committed-ledger guard
at `45ea6ae3`):

| Event | Revision | Reference |
| --- | --- | --- |
| reserve `topic.deep-time-field-record.prehistoric-life-extinction@1.0.0` | 90 | `authoring:62e4f791...81e33ae` |
| transition that record to `authored` | 91 | `lifecycle:1ba362ae...714f1661` |

Pack 2's reservation chains from pack 1's, one batch of its own, exactly as the proposal said
packs 2 to 4 would be reserved:

| Event | Revision | Reference |
| --- | --- | --- |
| reserve `topic.deep-time-field-record.ancient-oceans-deep-sea@1.0.0` | 92 | `authoring:2692b7a5...2167f6b` |
| transition that record to `authored` | 93 | `lifecycle:d484def3...49465c0` |

Registry after both packs: **revision 93, 140 records, 19 batches, 73 transitions.**

The reserved strings are:

```
pack_id  com.storystudio.pack.topic.deep-time-field-record.prehistoric-life-extinction
item_id  com.storystudio.topic.deep-time-field-record.prehistoric-life-extinction
sku      com.storystudio.sku.topic.deep-time-field-record.prehistoric-life-extinction
family   com.storystudio.family.topic.deep-time-field-record.prehistoric-life-extinction

pack_id  com.storystudio.pack.topic.deep-time-field-record.ancient-oceans-deep-sea
item_id  com.storystudio.topic.deep-time-field-record.ancient-oceans-deep-sea
sku      com.storystudio.sku.topic.deep-time-field-record.ancient-oceans-deep-sea
family   com.storystudio.family.topic.deep-time-field-record.ancient-oceans-deep-sea
```

`stocking_proposal` holds the family and SKU at status `proposed`, which is what that field is
for: GenStudio still assigns the eventual product, release and SKU identities after approval.
An authoring reservation is not a catalog listing, and this document creates none.

### Packs 3-4: identities NOT reserved, and why

The sixteen-record `topic-pack-1000-repair` batch (revision 34) is the precedent for reserving a
whole planned wave up front and promoting each record to `authored` as its source lands. That
batch could do it because all sixteen records were the *same settled operation* against an
accepted design doc -- repair each Topic Pack to 1,000 -- so every identity described something
whose shape was already known.

This wave does not meet that bar, by its own account. Section 10 records an unresolved cross-pack
overlap boundary for pack 2, two missing contracts for pack 3, and an explicit **block** on pack
4 pending an evidence contract. A reserved record is a claim in a permanent ledger; reserving
three identities for components this document says are not ready would make the ledger assert a
readiness the proposal denies.

So one pack per batch. Pack 2 was reserved at its own authoring, in its own batch, exactly as
this section said it would be — and only after its overlap boundary was resolved and gated, which
was the reason it was held back. Packs 3 and 4 wait on the same terms. Nothing is lost by
waiting: reservation is cheap, and the identity strings are already written down above the line
that reserves them.

## 6. Proofable claim

Every number this wave will ever put in front of a customer is derived from the signed release
and backed by a named offline gate. Nothing is inferred from a title, a folder count or an
authoring intention.

| Claim | Proof |
| --- | --- |
| 100 subjects, all distinct | standalone gate, subject and profile arithmetic |
| 2,000 authored tuples, 20 per subject | standalone gate, profile arithmetic |
| 2,000 distinct values on each of the four axes | standalone gate, set arithmetic after `slug()` |
| 2,000 lifetime non-repeating assignments | planner gate: `planIdeaAssignments` returns exactly 2,000, replays deterministically, and **fails closed at 2,001** rather than repeating an object or mechanism |
| every assignment is an authored whole tuple | planner gate, tuple membership assertion per assignment |
| works with the free Deep Time Documentary Formula | planner gate runs against that exact free Formula document |
| the archive is reproducible | build twice, byte-identical, then validate the signature |
| no pack authors another pack's subject | standalone gate plus the committed cross-pack overlap gate: normalised-subject identity, near-duplicate and shared-anchor comparison, a curated boundary-event vocabulary, and two categories held by exclusion |
| the gates can actually see defects | mutation tests: eleven deliberate content defects and six deliberate boundary defects injected one at a time, each caught, clean document re-measured |

The mutation tests are the load-bearing ones. A gate that has never been shown to fail is not
evidence; this family needed a new false-positive class closed before its casing rule could be
trusted at all (§9), and the boundary gate had to be shown catching a defect that neither of its
cheaper rules could see (§9c).

## 7. Complete use

Pack 1 is not an orphan. It declares
`compatible_formula_ids: ["com.storystudio.formula.deep-time-documentary"]` — the **free** Deep
Time Documentary Formula that ships in the free Deep Time starter kit. A customer who owns
nothing else can install this Topic and run it immediately.

The acceptance test exercises that path rather than validating a manifest: the planner gate
loads the free Formula document, attaches this Topic, and plans the full 2,000.

No paid Formula, Style or Thumbnail component is required, proposed or implied by this wave.

## 8. Transparent dependency

The one required component is the free Deep Time Documentary Formula, and the detail view must
say so in those words: *required, free, already included in the free Deep Time kit*.

Story Studio calculates no price, discount, grant or dependency value. The customer sees the
exact GenStudio quote and ownership facts. Price follows the policy order: GenStudio recommends
from the live credit economy, then the owner decides — after the evidence review, not before it.

## 9. What this wave had to build

The checker lineage was inherited from `content/infrastructure-commodities-1.0.1-2026-08-28`
(commit `e0e9dbc3`), which carries the empires-trade and wars-treaties gates before it. Adapting
it to a palaeontological family required three changes, all of them measured rather than assumed:

1. **The period signal was rewritten for geological time.** The inherited rule looked for
   centuries, dynasties and eras. This family's intervals are the geological time scale, so the
   rule now recognises eons, eras, periods, epochs and the stage names the pack actually uses,
   plus numeric ages.
2. **The place rule was rewritten for stratigraphy.** A palaeontological setting is legitimately
   named by a lithostratigraphic unit, a depositional environment or a collecting locality, not
   only by an ordinary geographic name.
3. **Binomial nomenclature broke the inherited casing rule.** Species names are written
   `Genus species` by international convention, so the half-lowercase rule — the rule that
   catches "Indian ocean" and "Hell creek" — fires on every correctly written species name in
   the pack. The fix is an explicit binomial allowlist rather than a `[A-Z][a-z]+ [a-z]+`
   pattern, so genuine half-lowercasing is still caught; mutation test 6 proves it.

A fourth false-positive class was found by running the inherited rule against the family's own
free sibling: informal chronostratigraphic modifiers ("early Cambrian", "late Palaeozoic") are
lowercase by convention and produced 9 of that sibling's 11 half-hits, all of them correct. That
pair is now exempt from the half rule, and a separate consistency check was added in its place —
the pack must pick one casing per modifier-and-period pair and keep it. Run against the free
sibling, that new check immediately found a real split it carries (`late Palaeozoic` and
`Late Palaeozoic` in the same document). The sibling is not in this wave's scope and is left
alone; the check is recorded here so the finding is not lost.

## 9a. House-style audit against the family's published sibling

All three packs were measured with the same final checker. The audit runs in both directions,
and no direction came back empty.

| Measure | Free sibling `deep-time-earth-systems@1.0.1` | Pack 1 | Pack 2 |
| --- | --- | --- | --- |
| subjects / tuples | 50 / 1,000 | 100 / 2,000 | 100 / 2,000 |
| distinct `episode_object` | 1,000 / 1,000 | 2,000 / 2,000 | 2,000 / 2,000 |
| distinct `time_place_scope` | 995 / 1,000 | 2,000 / 2,000 | 2,000 / 2,000 |
| distinct `mechanism` | 1,000 / 1,000 | 2,000 / 2,000 | 2,000 / 2,000 |
| distinct `evidence_lens` | 994 / 1,000 | 2,000 / 2,000 | 2,000 / 2,000 |
| scopes with no geological interval | 615 / 1,000 | 0 / 2,000 | 0 / 2,000 |
| scopes naming no place | 210 / 1,000 | 0 / 2,000 | 0 / 2,000 |
| casing hits (single / bigram / half) | 1 / 0 / 5 | 0 / 0 / 0 | 0 / 0 / 0 |
| modifier splits, lowercase formal subdivisions | 2, 41 | 0, 0 | 0, 0 |
| median length: object / scope / mechanism / lens | 48 / 40 / 49 / 52 | 56 / 61 / 67 / 65 | 53 / 54 / 69 / 68 |

The free sibling's "scopes naming no place" reads 210 here against the 227 recorded when pack 1
was measured. Nothing changed in the sibling: the place rule learned the sea for pack 2 (water
masses, gateways, bathymetric features, depth horizons and drill sites), and seventeen of the
sibling's scopes that the palaeontological rule could not see are legitimate oceanographic
settings. The number is restated rather than left standing, because the earlier one was measured
with a ruler that could not read them.

### Finding against this pack: register drift, open for review

This pack runs longer than its sibling on every axis, and the `mechanism` axis is the widest
gap: median 67 characters against the family's 49. One of the ten writers measured this in their
own part and rewrote all 200 of their mechanisms to close it; the other nine did not, so the
divergence is real and uneven.

It is left as authored, and flagged here rather than silently accepted, because the reason is
arguable in both directions. A palaeontological mechanism carries a biological or taphonomic
process rather than a one-clause geological one, and the evidence lenses that hold this family's
contested datings and kill mechanisms are named-record *comparisons* -- "the Deccan argon age
model set against the Chicxulub ejecta horizon in the same sections" -- which cannot be said in
52 characters without losing the second half of the comparison. Every value is inside the
authored ceilings. But a reader moving between the free and paid packs would notice, and no
automated gate measures register.

**This is a taste call for the independent wave review, not a defect the author should settle
alone.** If the review wants the family's shorter register, the fix is a mechanism-only rewrite
pass; the content and its evidence would not change.

Pack 2 lands in the same place and is recorded the same way. It is tighter than pack 1 on the two
axes a reader meets first (object 53 against 56, scope 54 against 61) and marginally wider on the
two that carry the argument (mechanism 69 against 67, lens 68 against 65). Three of the ten
writers measured the free sibling themselves and tightened their own mechanisms and lenses before
submitting; the rest did not. So the same divergence, from the same cause, and the same open
question: it is one decision for the family, not two, and it belongs to the wave review.

### Findings against the free sibling, recorded and not acted on

The audit also found real defects in the published free pack. They are out of this wave's scope
-- it is a published component pinned at 1.0.1 by the free Deep Time kit, and editing it would
change bytes the kit's pin depends on -- so they are recorded here rather than lost:

* 5 duplicate `time_place_scope` values and 6 duplicate `evidence_lens` values.
* 615 of 1,000 scopes name no geological interval, and 227 name no place.
* 1 lowercased proper noun (`maar` beside `Maar`).
* 5 half-lowercased proper names: `Indian ocean` (twice), `Atlantic ridge`, `American southwest`,
  `Chinese loess`.
* 2 chronostratigraphic modifier pairs written both ways, and 41 lowercase formal subdivisions.

None of these is severe, and none blocks this wave. They are the natural candidates for a
`deep-time-earth-systems` 1.0.2 whenever one is wanted, and they are the reason the paid pack's
own bars were set where they are rather than at "matches the sibling".

## 9b. Two gate gaps found while registering this wave

Registering pack 1 meant merging the repaired ledger, and doing that surfaced two problems that
are not this wave's content but are this wave's to report.

**A stale registry snapshot, red before this branch existed.**
`scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs` asserted that two
leaf records were still `reserved` and that no Kit record existed. The symbolic-psychology wave
then promoted both leaves and reserved the Kit, which is exactly what it was supposed to do, and
the test was not updated. Bisected rather than assumed: it fails identically at `45ea6ae3`,
before this branch touched anything. Repaired here by restating the claim so it survives the wave
completing -- each leaf is promoted by its own transition, distinct from the Formula's, and the
Kit is a separate reservation under a different receipt -- rather than by re-pinning a new
snapshot that the next legitimate write would break again.

**That whole directory ran in no gate at all.** `npm test` chained `test:backend`,
`test:frontend` and `test:release`; nothing ran `scripts/content-packs/__tests__`. That is 156
tests, including the ones that describe the authoring ledger, executing only when somebody
happened to invoke them by hand. It is the same gap that let a corrupted ledger land through a
fully green suite, and the symbolic-psychology wave closed the highest-value part of it by adding
a committed-ledger guard under `electron/server/__tests__/`. The rest is closed here: a
`test:content-packs` script now runs the directory, and `npm test` chains it. All 156 pass.

The backend gate's own anchors are unchanged by this, because the new script is separate from
`test:backend`.

## 9c. The cross-pack overlap gate, built before pack 2 was authored

Section 10 held pack 2 back for one reason: marine reptiles, anoxia events and reef extinctions
can honestly be written from either side of the wave's boundary, and "no two packs may name the
same subject" is too blunt while "trust the author" is not a gate at all. The gate was built
first, and is committed at
`electron/server/__tests__/deep-time-cross-pack-overlap.test.ts`, beside the anti-padding guard
and inside the same backend suite. It discovers packs from the authoring registry, so pack 3 is
measured against packs 1 and 2 on the day its record lands, with no edit beyond adjudicating what
it flags.

### What it measures

Three rules, in increasing tolerance:

1. **Identical normalised subject** — lowercased, de-articled, crudely singularised, sorted.
   Always a defect, never adjudicable.
2. **Near-duplicate (token overlap at or above 35%), or a shared named anchor** — an anchor
   being a locality, unit, event, vessel or programme name. Geological eon, era, period and
   epoch names are excluded from anchors (half of every pack in this family names one, so a
   shared period says nothing); stage and substage names are deliberately kept, because naming
   a stage names one interval. Ocean and continent names are excluded as too coarse. A flagged
   pair must appear in `ADJUDICATED` with a written reason **and** the borrowing pack's subject
   must carry a system or record word.
3. **A curated list of boundary events** — events both halves of the wave may reach for. Naming
   one outside the pack that owns it requires the same system-or-record word.

Rule 3 exists because rule 2 cannot see the hardest cases. "the end-Permian extinction and the
Siberian Traps" and "the Meishan sections and end-Permian ocean chemistry" share no anchor and
few words, yet they are exactly the pair the boundary was written for.

The rulings are held honest two ways: a ruling naming a subject no pack authors any more fails,
and so does a ruling on a pair the gate no longer flags. A ruling that protects nothing hides
the next real overlap.

### The adjudicated cases

Four pairs are flagged and ruled on. Each is a boundary case the proposal named in advance.

| Pack 1 subject | Pack 2 subject | The ruling |
| --- | --- | --- |
| the Western Interior Seaway and the Niobrara Chalk | the Western Interior Seaway and its water chemistry | Pack 1 builds on the Niobrara chalk and what is preserved in it; pack 2 builds on the epeiric sea's salinity, stratification and oxygen budget. Same body of water, different object: a chalk slab against a water column. |
| the Messinian salinity crisis and its faunas | the Messinian desiccation of the Mediterranean basin | Pack 1 owns what happened to the animals; pack 2 owns the basin's water budget and the evaporite sequence that records it. |
| the end-Ordovician extinction and the Hirnantian glaciation | the Hirnantian eustatic fall recorded on the shelf | Pack 1 owns the extinction; pack 2 owns the sea-level record left on the shelf. The glaciation is the shared cause, not the shared subject. |
| the Late Devonian extinctions and the Kellwasser events | the Kellwasser black shales as a water-column record | Pack 1 owns the extinction pulses; pack 2 owns the redox chemistry of the water column the black shales record. |

Five boundary events are declared with an owner: Kellwasser, the Hirnantian, the Messinian and
the end-Permian and end-Triassic events belong to pack 1; the Hangenberg event and the Capitanian
crisis belong to pack 2.

### Two categories held by not authoring them at all

The proposal named marine reptiles and reef extinctions as ambiguous. For two of those the
cheaper answer was to leave them wholly to pack 1, and the gate records that so the reasoning
survives the authors: **marine reptiles** (ichthyosaurs, plesiosaurs, mosasaurs, pliosaurs) and
**the Permian reef complex of the Guadalupe Mountains**. Pack 2 authors no subject in either and
the gate rejects one if a future pack tries. Reefs in general are not excluded — pack 2 carries
Gotland, the Canning Basin, the Dachstein platform, the Cretaceous rudist platforms, the Bahama
Bank, Enewetak and the drowned Great Barrier Reef terraces — because a reef treated as a
carbonate factory is not the same subject as a reef treated as a habitat that died.

### The gate was shown to fail

Six deliberate defects were injected into pack 2's source one at a time and the committed gate
was run against each. Each targets a different rule, because a mutation set that exercises only
one rule proves nothing about the other two.

| Injection | Caught by |
| --- | --- |
| a pack-1 subject copied verbatim | rule 1, identical normalised subject |
| a pack-1 subject reworded, same content words in a new order | rule 1, identical normalised subject |
| a new shared anchor ("Solnhofen") with no ruling | rule 2, unruled overlap |
| an adjudicated subject rewritten out from under its ruling | the ruling-honesty assertion |
| a boundary event named without a system treatment | rule 3, the only rule that can see it |
| a marine-reptile subject | the recorded exclusion |

**6/6 caught; the restored document re-measures clean.**

### A defect the gate found in itself

Writing the four rulings first and the vocabulary second produced a real hole: the ruling for
the Kellwasser pair said pack 2 may keep the subject *because* it is a water-column record, and
the word "record" was not in the system vocabulary. The gate would have rejected its own
adjudicated subject. Found by auditing every boundary subject against the vocabulary before the
content existed, and fixed by admitting "record", "records", "section", "sections",
"water-column" and "seawater" — all of which are exactly what the boundary means by "and its
record".

## 10. Wave sequencing

**Pack 1 — Prehistoric Life & Extinction (enriched).** Authored in this wave at 100 x 20.

**Pack 2 — Ancient Oceans & Deep Sea.** Authored in this wave at 100 x 20, on the same four
axes. The boundary this section required is the one it was authored under: pack 1 owns the
*organism and the extinction*, pack 2 owns the *ocean as a system and its record* — water
chemistry, circulation, ventilation, sea level, the carbonate factory, the deep-sea core record,
and the modern deep sea read as a deep-time archive. The cross-pack overlap gate this section
asked for was built and mutation-tested **before** any pack-2 tuple was written, and it runs for
every future Deep Time pack automatically; see section 9c for its rules, its four adjudicated
cases and the two categories held by exclusion.

**Pack 3 — Human Origins & Ancient Worlds.** Same shape. Two additional contracts are needed
before authoring: a dating-dispute posture at least as strict as pack 1's (hominin
chronologies are contested more often than they are settled), and an explicit statement of the
boundary against the **First Humans** free foundation and its own approved paid depth path, so
the two lanes do not author into each other.

**Pack 4 — Speculative Earth Scenarios.** *Blocked pending an evidence contract.* The family's
Formula requires that observation, inference, debate and speculation stay separated in plain
language, and the free Earth Systems pack carries the exclusion *"Do not claim speculative
reconstructions as settled fact."* A counterfactual pack cannot use pack 1's evidence lens
unchanged, because there is no specimen for an Earth that never existed. The proposal for pack 4
must first define what the fourth axis becomes — the published model run, the physical
constraint, the closest real analogue — and what the gate measures in its place. Do not author
pack 4 against this document as written.

## 11. What this proposal does not do

It creates no product ID, SKU, release ID, entitlement family, price, discount or catalog
listing. It does not publish, grant, purchase, install or shelf-place anything, and no such
action follows from a passing test. Publication requires the separate owner-approved release and
GenStudio catalog actions.

It does now hold one **authoring** reservation (section 5). That is the publisher-side ledger
entry that lets the source live in `content-packs/` and be built reproducibly; it is not a
product, a price, a release or a shelf entry, and the family and SKU it names remain at status
`proposed` for GenStudio to assign.

Independent wave review is still outstanding, and Critical or Important findings block the wave
until corrected and re-reviewed.
