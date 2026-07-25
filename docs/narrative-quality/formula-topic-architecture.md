# Formula and Topic-Pack Architecture

**Status:** design proposal. No data migration, format removal, or prompt behaviour changes have been made.

## Principle

The creator configures exactly two durable layers:

1. **Series Formula** — the repeatable promise and writing/production contract: title grammar, point of view, opening policy, story/argument structure, evidence standard, and anti-AI rules.
2. **Topic Packs** — reusable subject lanes the formula can explore. A pack can be compatible with more than one formula, but it never overrides that formula's perspective or quality contract.

Formula *Families* are library navigation only. They help browse a large catalog, but are not a third channel setting.

## Proposed formula library

| Family | Series Formula | Retain / absorb | Why it remains a formula |
| --- | --- | --- | --- |
| Evidence & systems | **The Economics of…** | Business Economics | A cost/revenue/constraint case-study arc is distinct. |
| Evidence & systems | **How Did Ancient Humans…?** | Ancient Humans | The survival-and-adaptation question, evidence policy, and title grammar are distinct. |
| Evidence & systems | **History, Explained** | History Narration | Event → context → consequence is a reusable documentary contract. |
| Evidence & systems | **Counted Explainer** | Listicle Explainer | This is a delivery structure, not a subject. It eliminates the retired root Listicle format without losing independent-topic episodes. |
| Living world | **Natural World, Explained** | Animals, Fungi, Insects, Plants | The science-first deadpan explainer contract is shared; the organism type belongs in a pack. |
| Immersive paths | **POV: Your Life As…** | POV Life | Formula-owned second-person institutional life-path and tier ladder. |
| Immersive paths | **Build Under Constraints** | POV / Hustle | First-person creator-led action narrative; it must stay separate from Economics and Motivation because its evidence/results rules differ. |
| Mind & ideas | **Human Behavior, Explained** | Psychology, Dark Psychology | Psychology is the evidence base; “dark psychology” becomes a restrained social-dynamics editorial lane, not a sensational standalone identity. |
| Mind & ideas | **Philosophy for a Real Problem** | Philosophy | Source/interpretation/dilemma arc and conversational guide voice are distinct. |
| Mind & ideas | **Practical Motivation** | Motivation | Direct coaching needs a concrete-action contract, different from first-person Hustle. |
| Mind & ideas | **Guided Mindfulness** | Mindfulness | A timed second-person practice is its own production contract. |
| Faith | **Pastoral Scripture** | Devotional, Preaching | Same pastoral/text-led voice. “Devotional reflection” and “expository teaching” become series modes supplied by a compatible pack, not competing top-level niches. |
| Faith | **Prayer** | Prayer | It has a unique section-scoped listener/God perspective policy; do not merge it. |
| Calm stories | **Sleep Story** | Sleep | It has a deliberate no-hook, low-stakes literary contract; do not merge it. |

This reduces nineteen separately managed niche definitions to fourteen actual writing contracts, while retaining every creative capability. It is deliberately not more aggressive: merging formulas that have different point-of-view, research, or safety rules would reintroduce generic AI scripts.

## Topic-Pack conversion and sharing

| Existing item | Proposed home | Reusable with |
| --- | --- | --- |
| Animals | Natural World pack | Natural World, Counted Explainer where appropriate |
| Fungi | Natural World pack | Natural World, Counted Explainer |
| Insects & Arthropods | Natural World pack | Natural World, Counted Explainer |
| Plants | Natural World pack | Natural World, Counted Explainer |
| Dark Psychology | Human Behavior pack: social dynamics, manipulation, status, and boundaries | Human Behavior; not Motivation or POV Life by default |
| Devotional | Pastoral Scripture pack: daily reflection | Pastoral Scripture |
| Preaching | Pastoral Scripture pack: expository teaching | Pastoral Scripture |
| Business & Companies | Existing Economics pack, tagged portable | The Economics of…, Build Under Constraints, Counted Explainer |
| Economics of Ancient Civilizations | Existing Economics pack | The Economics of…, History Explained |
| Ancient Human Survival / Environments / Social Life / Technology | Existing packs | How Did Ancient Humans… |
| Law Enforcement / Criminal Hierarchies / Historical Occupations | Existing POV Life packs | POV: Your Life As… |

The portable Business pack is the key example. With the same subject lane, **The Economics of a Coffee Shop** investigates the business model; **I Tried Building a Coffee Shop With…** follows a first-person constraint-to-plan arc; **7 Things That Actually Decide Whether a Coffee Shop Survives** uses Counted Explainer. The pack contributes subjects and research lanes, while the formula creates the distinct channel.

## What should not be mixed freely

Compatibility is explicit, not a free-for-all. A Topic Pack can have a `compatibleFormulaIds` list and a short warning when a user tries an unsupported pairing.

- Prayer must never inherit a generic, first-person, or “dark psychology” perspective.
- Mindfulness and Sleep should not receive high-arousal Economics, Hustle, crime, or tier-ladder packs.
- Criminal-hierarchy packs remain inside the factual POV Life contract; they must not be paired with Hustle or playful listicle framing.
- Natural-world packs can use Counted Explainer only when research strength and section variety are retained.
- Pastoral Scripture packs are only compatible with Pastoral Scripture; Prayer is a separate formula.

## Suggested catalog browsing

The picker first shows Formula Families, then individual formulas. Once a formula is selected, the Topic Pack picker shows only its compatible packs, with a **Shared packs** label for packs that work in more than one formula. The selected formula resolves perspective automatically; the topic pack may add source domains, time/place filters, and recurring title nouns, but cannot replace the narrative voice.

## Channel examples

| Formula | Topic Pack(s) | Resulting channel/series |
| --- | --- | --- |
| The Economics of… | Business & Companies | The Economics of Running Businesses |
| The Economics of… | Economics of Ancient Civilizations | The Economics of Ancient Civilizations |
| How Did Ancient Humans…? | Survival + Environments | How Ancient Humans Survived Harsh Worlds |
| POV: Your Life As… | Historical Occupations | Your Life in Forgotten Historical Jobs |
| POV: Your Life As… | Law Enforcement | Your Life at Every Tier of Law Enforcement |
| Natural World, Explained | Fungi + Plants | The Strange Economics of Forest Life |
| Human Behavior, Explained | Social Dynamics | The Social Rules People Notice Too Late |
| Counted Explainer | Business & Companies | The 7 Constraints Behind Ordinary Businesses |
| Pastoral Scripture | Daily Reflection | A Daily Scripture Reflection |

## Adoption order after approval

1. Add Formula Family and `compatibleFormulaIds` metadata without changing stored project IDs.
2. Promote the four existing formula-led niches as the first visible formula group.
3. Convert Animals/Fungi/Insects/Plants, Dark Psychology, and Devotional/Preaching into packs or formula modes while retaining legacy IDs as migration aliases.
4. Move root-format-specific writing semantics (especially legacy Listicle) into the Counted Explainer formula. Keep legacy format IDs readable until every persisted project is migrated and verified.
5. Add the channel-identity status and unified Settings surface described in `channel-identity-ui.md` before removing any old control.

No existing project should silently change formula, topic, point of view, or production path during this work.
