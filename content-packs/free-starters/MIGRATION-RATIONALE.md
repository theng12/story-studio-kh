# Free Starter migration rationale

Every migrated Formula, Topic Pack, Visual Style, and AI thumbnail Recipe
retains every prompt-relevant field that the signed Content Pack schema can
represent. The signed-source golden test loads those source documents through
the same adapters used by installed packs and compares them with the effective
legacy catalog.

Two legacy thumbnail templates do not have an AI Recipe object: they are
static canvas templates with fixed pixel geometry, text-zone coordinates,
accent strokes, and logo slots. Those controls are intentionally outside the
safe signed Recipe schema, which permits only the already-supported AI
thumbnail contract. Their unrepresentable geometry is therefore not silently
claimed to migrate:

- `centered-hero-headline` is represented as an AI hero recipe preserving its
  legacy public metadata and Formula compatibility, while its fixed canvas
  coordinates remain a legacy-template-only behavior.
- `portrait-block-right` is represented as an AI hero recipe preserving its
  legacy public metadata and Formula compatibility, while its fixed canvas,
  subtitle banner, accent stroke, and logo slot remain legacy-template-only
  behavior.

No other prompt-relevant legacy field is deliberately omitted. A future signed
schema extension is required before static-template geometry can be migrated.

The legacy `economics-of` source description contains provider-routing wording,
which the signed Content Pack security contract correctly rejects. Its signed
description is the existing safe, provider-neutral summary; all other
representable Formula prompt fields remain preserved.
