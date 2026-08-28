# Paid Wave Proposal: Deep Time Field Record, wave one

Status: **proposal**. Not a product, not a release, not a price, not a shelf entry. This document
is submitted against `docs/product/content-store-paid-wave-boundaries.md` and must be accepted
against all seven admission gates before any commercial identity is assigned.

Free foundation: **Deep Time**.
Approved paid depth path for that lane: *"Enriched Prehistoric Life & Extinction; Ancient Oceans
& Deep Sea; Human Origins & Ancient Worlds; Speculative Earth Scenarios."*

This proposal takes that path as the wave's scope — four Topic components — and authors the
first of them. Packs two to four are scoped here and authored later, each against this same
document plus the per-pack notes in "Wave sequencing" below.

## 1. What the wave is

**Deep Time Field Record** is an evidence-led palaeontology and deep-history collection for the
Deep Time Documentary channel format. Its editorial posture is the field record itself: a
specimen, a quarry, a core, a section, a monograph plate, an expedition notebook — and the
method that turns that object into a claim about the past.

Four Topic components, each an independent catalog identity:

| # | Component | Direction | Status |
| --- | --- | --- | --- |
| 1 | Prehistoric Life & Extinction (enriched) | Ancient ecosystems, evolutionary transitions, extinction mechanisms, and the specimens and sections that record them | **Authored in this wave** |
| 2 | Ancient Oceans & Deep Sea | Ocean chemistry, reef systems, marine reptiles and fishes, anoxia and ventilation, the deep-sea record read from cores | Scoped; not authored |
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

Pack 1 as authored:

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

**No identity is reserved by this proposal, and none is registered.** The content-pack authoring
registry is deliberately untouched: another authoring wave holds the writer slot, and identity
reservation for this family is sequenced after that landing. The manifest authored in this wave
therefore carries a *proposed* identity and the `{{KEY_ID}}` build token rather than a reserved
publisher key.

Because the registry refuses any unregistered `pack.json` under `content-packs/` -- correctly, since
a signable source without a reserved identity is what that rule exists to prevent -- the authored
source is parked in `content-packs-proposed/`, outside the discovered root, and moves into
`content-packs/paid/deep-time-field-record/` as a plain rename once its identities are reserved.
`content-packs-proposed/README.md` records that procedure. The proposed strings are:

```
pack_id  com.storystudio.pack.topic.deep-time-field-record.prehistoric-life-extinction
item_id  com.storystudio.topic.deep-time-field-record.prehistoric-life-extinction
sku      com.storystudio.sku.topic.deep-time-field-record.prehistoric-life-extinction
family   com.storystudio.family.topic.deep-time-field-record.prehistoric-life-extinction
```

These strings are a proposal input. GenStudio assigns the eventual product, release and SKU
identities after approval; Story Studio must not guess or cache them, and this document creates
none.

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
| the gates can actually see defects | mutation test: six deliberate defects injected one at a time, each caught, clean document re-measured |

The mutation test is the load-bearing one. A gate that has never been shown to fail is not
evidence, and this family needed a new false-positive class closed before its casing rule could
be trusted at all — see §9.

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

## 10. Wave sequencing

**Pack 1 — Prehistoric Life & Extinction (enriched).** Authored in this wave at 100 x 20.

**Pack 2 — Ancient Oceans & Deep Sea.** Same shape and same four axes. Its distinctness from
pack 1 must be argued explicitly at proposal time, because marine reptiles, reef systems and
anoxia events could be written from either direction. The boundary proposed: pack 1 owns the
*organism and the extinction*, pack 2 owns the *ocean as a system and its record* — water
chemistry, circulation, ventilation, sea level, the deep-sea core record, and the modern deep
sea read as a deep-time archive. A cross-pack subject-overlap gate should be added before pack 2
is authored, not after.

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
listing. It reserves no identity and writes no registry record. It does not publish, grant,
purchase, install or shelf-place anything, and no such action follows from a passing test.
Publication requires the separate owner-approved release and GenStudio catalog actions.

Independent wave review is still outstanding, and Critical or Important findings block the wave
until corrected and re-reviewed.
