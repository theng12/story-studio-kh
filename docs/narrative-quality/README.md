# Narrative Quality Design Notes

Planning notes only. These documents do not change Story Studio runtime behavior.

## Direction agreed so far

- A selected Series Formula owns perspective. The normal Script Generator must not make the creator repeatedly choose grammatical POV.
- A formula may use a fixed perspective, a section-scoped perspective (for example prayer), or no grammatical POV constraint. Per-episode override is an advanced exception, not a primary control.
- Every formula will receive a Narrative Quality Contract: opening policy, prohibited AI-tell patterns, evidence policy, outline requirements, closing policy, and a review rubric.
- Research remains opt-in. When research is absent, factual niches should state that the draft is unverified rather than pretending certainty.
- The quality review will flag and selectively repair passages; it must not replace approved outlines or flatten every channel into one generic voice.

## Proposed shared model

`perspectivePolicy` resolves automatically from the formula. `openingPolicy`, `evidencePolicy`, `antiPatterns`, `outlineRequirements`, and `qualityRubric` are formula-owned. Topic Packs continue to supply subject inventory, places, eras, roles, industries, and exclusions.

## Formula and Topic-Pack architecture

[Formula and Topic-Pack architecture](formula-topic-architecture.md) records the proposed consolidation of the legacy niche library into reusable Series Formulas, compatible Topic Packs, and library-only Formula Families. This remains a design proposal until approved; it does not change any project configuration or generator behaviour.

[Channel Identity UI](channel-identity-ui.md) records the related proposal to surface the selected Formula, Topic Packs, and Production Path below the channel name and to unify the two confusing Settings tabs.

## Current formula-led channels

- [Ancient Humans](niches/ancient-humans.md)
- [Business Economics](niches/business-economics.md)
- [POV: Your Life As…](niches/pov-life.md)
- [POV / Hustle](niches/pov-hustle.md)

## Current legacy niches

- [Animals](niches/animals.md), [Fungi](niches/fungi.md), [Insects](niches/insects.md), [Plants](niches/plants.md), [History Narration](niches/history-narration.md)
- [Explainer / Listicle](niches/listicle-explainer.md), [Psychology](niches/psychology.md), [Dark Psychology](niches/dark-psychology.md)
- [Mindfulness](niches/mindfulness.md), [Motivation](niches/motivation.md), [Philosophy](niches/philosophy.md), [Sleep Stories](niches/sleep.md)
- [Devotional](niches/devotional.md), [Prayer](niches/prayer.md), [Preaching](niches/preaching.md)

## Cross-cutting correctness fixes required before rollout

1. Persist `creative_mode` and `creative_direction` in the outline snapshot, then use that snapshot for expansion.
2. Apply the resolved perspective once. Current expansion setup can append it twice and can mix a current-form perspective with the approved outline's perspective.
3. Make formula-owned narrator styles visible in the UI rather than showing legacy hard-coded labels.
4. Keep the existing manual guidance snapshot, but display the entire locked writing contract in Outline Review.
