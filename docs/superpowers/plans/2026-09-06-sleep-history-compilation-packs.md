# Sleep History Compilation — six standalone Content Packs

**Owner direction (chat, 2026-09-06):** build a long-form, sleep-friendly "history of things" channel system
as store products, not app code. Videos run 90–180 minutes and cover 10–20 independent subjects each,
in an old-master painted look. Preview images may be generated with the GenStudio `gpt-image-2` product
through the running Story Studio app; the owner authorised that spend for this authoring pass.
No Channel Kit; every pack is its own 300-credit product with no discount.

**Release classification:** content-only. Every kind below (`series-formula`, `topic-pack`,
`visual-style`, `thumbnail-recipe`) is already interpreted by the released runtime at the floor in
`content-packs/release-floor.json` (1.0.843). No app version bump, changelog, DMG, or restart.

**Companion app work (not part of this content release):** slower scene-pacing presets and the buried
Image Pool / Scene Recycling surfaces are filed as `docs/handoffs/` briefs for the application lane.

## Reserve (one atomic batch)

| kind | pack_id | item_id | source_path |
| --- | --- | --- | --- |
| series-formula | `com.storystudio.pack.formula.sleep-history-compilation` | `com.storystudio.formula.sleep-history-compilation` | `content-packs/sleep-history/formula/sleep-history-compilation` |
| topic-pack | `com.storystudio.pack.topic.food-histories` | `com.storystudio.topic.food-histories` | `content-packs/sleep-history/topic/food-histories` |
| topic-pack | `com.storystudio.pack.topic.everyday-object-histories` | `com.storystudio.topic.everyday-object-histories` | `content-packs/sleep-history/topic/everyday-object-histories` |
| topic-pack | `com.storystudio.pack.topic.drinks-and-spices-histories` | `com.storystudio.topic.drinks-and-spices-histories` | `content-packs/sleep-history/topic/drinks-and-spices-histories` |
| visual-style | `com.storystudio.pack.style.old-master-still-life` | `com.storystudio.style.old-master-still-life` | `content-packs/sleep-history/style/old-master-still-life` |
| thumbnail-recipe | `com.storystudio.pack.thumbnail.period-portrait-serif-title` | `com.storystudio.thumbnail.period-portrait-serif-title` | `content-packs/sleep-history/thumbnail/period-portrait-serif-title` |

All six: `publisher_id` `com.storystudio`, version `1.0.0`, `min_app_version` `{{MIN_APP_VERSION}}`
(`release-bound`), `dependencies: []`, family/SKU proposals derived from the pack id, `proposed`.

## Contracts

**Formula — Sleep History Compilation.** `chapters_independent: true`; 10–20 chapters, default 15;
90–180 minutes, default 150; ~120 words per minute; calm grounded documentary voice, no per-topic hooks
or payoff lines; sleep-landing intro (greeting, soft teaser, gentle question, one early subscribe line,
three breaths, close-your-eyes transition). Own `visual_pacing_profile`: opening 600 s at 8–15 s per
scene, settled 40–60 s per scene (about 220 images for a 150-minute episode). Compatible with the three
topic packs below; recommends both Old Master Still Life and Oil Painting Classical; default thumbnail
recipe Period Portrait Serif Title.

**Topic packs.** Profile-based at the current house standard: 50 subjects × 20 coherent tuples
(`episode_object`, `time_place_scope`, `mechanism`, `evidence_lens`), `max_siblings_per_subject: 20`,
all 20 objects and mechanisms unique within a subject, no named individuals, no third-party marks,
no brand names as subjects.

**Visual style — Old Master Still Life.** Distinct from Oil Painting Classical (figure-led chiaroscuro):
this is object-led — one hero object on a worn wooden table, dark umber ground, single cool window
light from the left, period props, glazed oil surface, varnish sheen. Content-independent bible and
conflict-focused negative prompt. One 1672×941 preview.

**Thumbnail recipe — Period Portrait Serif Title.** Hero layout: a period-dressed anonymous figure
holding or presenting the subject on one side, a two-line serif title on the other (`History of` small,
subject large), dark painterly ground, warm rim light. `title_mode: ai`, episode-title headline mode,
3–5 original previews with varied subject, side, distance, and title line count.

## Gates before stocking

Schema parse via the runtime `ContentPackDocumentSchema`; registry validate; per-pack test file;
`ship-pack` deterministic double build; forbidden-marks scan; decoded preview evidence in
`content-packs/sleep-history/PREVIEW-PROVENANCE.md`; registry transition to `authored`; merged PR.
Stocking runs `python -m app.tools.stock_pack` on this control Mac with `discount_by_family`
opt-outs for all six families.
