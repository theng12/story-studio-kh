# GenStudio Model Cost Tiers Design

**Status:** Approved by the owner on 2026-08-13

## Goal

Give customers a consistent, truthful way to browse every GenStudio model catalog by cost position without hiding expensive products or implying that lower-cost products are lower quality.

The same three labels apply to Language, Image, Video, Music, TTS, and Transcription:

- **Economy** — optimized for routine volume and low credit use.
- **Balanced** — moderate cost with greater capability.
- **Premium** — expensive models requiring an intentional choice.

The 500–1,000-idea originality redesign is a separate workstream. It must not share schema, UI state, release dependencies, or implementation tasks with this feature.

## Source of Truth

GenStudio is the sole authority for tier membership. Every published model response will carry:

```json
{
  "cost_tier": "economy"
}
```

The only valid values are `economy`, `balanced`, and `premium`.

Tier membership is operator-authored on the GenStudio public product and is consistent across every Story workflow. Story must never infer it from price, provider, product ID, name, sale status, or workflow-specific observed cost. Promotions may change a displayed price without moving a model between tiers.

GenStudio must publish the field through all six customer model catalogs:

- `GET /v1/chat/models`
- `GET /v1/image/models`
- `GET /v1/videos/models`
- `GET /v1/music/models`
- `GET /v1/tts/models`
- `GET /v1/transcription/models`

The field is display and navigation metadata only. It never participates in routing, provider selection, generation payloads, charging, capability checks, or model availability.

GenStudio must reject publication of a new product whose tier is missing or invalid once the new catalog contract is activated. Existing published products require an owner-approved tier backfill; a price-derived migration is forbidden.

## Story Studio Picker Behavior

Story implements the behavior once in the shared `ModelMenu` and supplies the published tier from each catalog adapter.

When every presented row has a valid tier, the dialog shows three tabs in this order:

1. Economy
2. Balanced
3. Premium

Each tab filters models by the published tier while retaining the current provider headings, descriptions, badges, exact prices, availability state, keyboard behavior, and accessibility semantics.

Opening rules:

- A new or empty selector opens Economy.
- A saved explicit model reopens the tier containing that model, including Premium.
- Changing workflows does not change the model's tier.
- Story never silently substitutes a Premium model.
- If an empty tiered selector has an available Economy model, existing workflows that require an automatic initial model may choose the first available Economy row only.
- If no Economy model is available, Story leaves the selection empty and asks the customer to choose. It must not escalate to Balanced or Premium.
- A saved missing, retired, locked, or unavailable model remains visible as a selection problem; Story does not heal it to a more expensive product. Existing explicit legacy-ID migrations remain allowed because they preserve product identity.

Search rules:

- An empty search respects the active tab.
- A non-empty search covers all three tiers so a customer can find a model without first knowing its classification.
- Every search result visibly carries its tier.
- Selecting a cross-tier search result is a deliberate row click and therefore changes the saved selection normally.

Premium requires deliberate selection, not a repetitive confirmation modal. The tier name describes cost position only and must not claim superior output quality.

## Compatibility and Rollout

GenStudio deploys the catalog contract before Story enables tier tabs against it.

Story validates `cost_tier` at its GenStudio boundary but keeps it optional in its compatibility types during rollout. A picker enters tiered mode only when every row supplied to that picker has one of the three valid values. If any row is missing or malformed, the entire picker retains its current flat presentation and current legacy selection behavior. Story does not hide the unclassified row, partially tier the list, or guess membership.

This all-or-flat rule is evaluated per picker because constrained Language catalogs may contain a subset of the full catalog. It allows an older GenStudio release or a partially deployed catalog to remain usable without producing inconsistent tabs.

Transcription receives the full contract and shared behavior now even if only one product is currently published. With one classified product, the picker may show the three tabs and naturally contain empty tiers; later models require no Story release.

Music receives the transport and shared-option contract now. Story currently has no customer-facing Music generation picker, so no new Music workflow is invented by this feature. Any future Music picker must use the shared `ModelMenu` and will inherit the tier behavior.

## Components and Data Flow

### GenStudio

1. An operator assigns `cost_tier` to each public model product.
2. Publication validation refuses a missing or invalid tier after contract activation.
3. Each modality catalog copies the exact stored value into its response schema.
4. API-client/OpenAPI contracts expose the same literal union.
5. Catalog tests prove all six endpoints publish exact values and do not alter pricing or capability fields.

### Story backend

1. `genstudio-client.ts` validates and preserves the field for all six catalog response types.
2. Narrow Story routes such as `/models`, Research web models, and vision-model filters pass it through unchanged.
3. No generator request includes `cost_tier`.

### Story frontend

1. Catalog composables retain the optional compatibility field.
2. Model-option adapters map it to the shared menu option as `costTier`.
3. A small pure policy helper determines whether the supplied list is fully tiered and which tier may be selected automatically.
4. `ModelMenu` owns tab state, tier-aware search, labels, and accessibility once for every modality.
5. Modality pages retain their existing live provider, price, capability, and availability behavior.

## Error and Edge States

- **Missing or malformed tier:** flat legacy picker; no warning that blames the customer.
- **No models in active tier:** show a clear empty state and leave other tabs available.
- **No Economy model:** no automatic selection; explain that the customer must choose a published model.
- **Saved Premium model:** open Premium and retain it exactly.
- **Saved unavailable model:** show the existing unavailable/retired guidance; never replace it because of tier.
- **Catalog refresh changes a tier:** the next open uses the newly published tier. Story never caches membership beyond the live catalog snapshot.
- **Search across tiers:** results show their tier and remain grouped by published provider within the result set.

## UX and Accessibility

The tabs are a compact tablist inside the existing centered picker dialog, below search and above the scrollable model list. They use real buttons with `role="tab"`, `aria-selected`, keyboard Left/Right/Home/End navigation, visible focus, and a linked `tabpanel`.

The tier labels remain textual; color may support recognition but cannot be the only cue. Premium uses a restrained warning/accent treatment, not a recommendation treatment. Touch targets remain at least 44 pixels. The existing modal focus trap, Escape behavior, focus restoration, row arrow-key navigation, and viewport-bounded scrolling remain unchanged.

Visual verification must cover desktop and narrow layouts, long model names, all three tabs, empty tiers, cross-tier search, and a saved Premium selection.

## Testing

GenStudio tests must prove:

- exact `cost_tier` publication for all six catalogs;
- invalid or missing operator values are rejected at the publication boundary after activation;
- catalog prices, providers, availability, capability fields, and ordering remain unchanged;
- generated OpenAPI/API-client types expose the three-value union.

Story tests must prove:

- all six parsers preserve only the three valid values;
- a missing field keeps the complete picker flat;
- a complete catalog enables all three tabs;
- empty/new opens Economy;
- saved Balanced or Premium opens its own tier;
- non-empty search finds and labels results from all tiers;
- no Economy model produces no automatic Balanced/Premium selection;
- explicit unavailable selections are not replaced;
- constrained Language menus and every modality adapter pass the tier through;
- the Motion Review fallback no longer silently replaces a selected product;
- provider and exact-price display remain live and unchanged.

Story's full release must include focused component and boundary tests, Electron and frontend typechecks, the repository verification suite, manual desktop/narrow visual inspection, mandatory version/changelog alignment, and packaging checks required by the repository.

## Non-goals

- No quality ranking or benchmark score.
- No workflow-specific tier membership.
- No price threshold or automatic classifier in Story or GenStudio.
- No hiding, retiring, renaming, or rerouting Fable, Pro, or any other model.
- No separate picker implementation per modality.
- No new Music generation workflow.
- No coupling to service-account tiers such as Starter, Creator, or Pro.
- No coupling to the separate large-scale idea originality redesign.

## Release Order

1. Owner approves the initial GenStudio tier map for every currently published product.
2. GenStudio ships the stored field, publication gate, all six catalogs, and contract tests.
3. Story ships compatibility parsing and the shared tiered picker.
4. Story visually verifies the live GenStudio catalog and releases the app.

Story may ship its compatibility parser before GenStudio, but it must remain visually flat until the live list is completely classified. That is a safe staging path, not permission to infer temporary tiers.
