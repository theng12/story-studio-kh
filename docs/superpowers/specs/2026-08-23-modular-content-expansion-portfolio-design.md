# Story Studio Modular Content Expansion Portfolio Design

**Status:** Owner-approved portfolio direction; umbrella design for separately planned authoring waves

**Date:** 2026-08-23

**Scope:** Modular Content Store components and Channel Kit compositions only. This is not a source-authoring plan, archive build, Store stocking request, checkout change, or application release plan.

**Builds on:** [Content Store Launch Catalog Design](2026-08-14-content-store-launch-catalog-design.md), `content-packs/authoring-registry.json`, and the component handoff contract in the Story Studio Channel Kit authoring workflow.

## 1. Decision summary

Story Studio will expand its Content Store through a small, reusable component portfolio rather than a collection of near-duplicate channel kits. The approved direction contains:

1. one **free, comprehensive Symbolic Psychology Studio** Channel Kit;
2. five broad **free Starter** Channel Kit proposals: Everyday Explainers, Personal Story Lessons, Practical Home & Routine, Family Discovery, and Weekend Guides;
3. five **paid specialist** Channel Kit proposals: Comparison Lab, Cinematic Mini-Docs, Challenge & Progress, Case Study Breakdown, and Mystery & Investigation; and
4. five high-leverage standalone component proposals: Question Ladder, Audience Question Seeder, Before/After Timeline, Object Hero + Question, and Route Map + One Promise.

The named free/paid classifications are owner-approved stocking proposals. They are not prices, entitlement decisions, GenStudio product data, or publication state. No Story or GenStudio identity, family/SKU, archive, source manifest, price, product/release/account/wire value is created or inferred by this document.

The portfolio has one essential rule: a Channel Kit composes released components; it never becomes a fifth creative schema. Formula, Topic Pack, Visual Style, and Thumbnail Recipe stay independently versioned and reusable. A bundle-only coordinator may express the exact closure after its components have been qualified, but contains no creative source or asset of its own.

## 2. Fixed architectural boundaries

| Component kind | Owns | Must not own |
| --- | --- | --- |
| **Series Formula** | Channel promise, hook/title patterns, script sequence, evidence standard, diversity axes, scene/thumbnail communication rules | Subject inventory, visual medium, palette, headline geometry, provider/model settings |
| **Topic Pack** | Subject/domain coverage, places/roles/eras/constraints, research hints, exclusions, explicit duplicate-resistant axes | A generic script format, a style bible, a thumbnail layout, diagnostic or medical certainty |
| **Visual Style** | Repeatable rendering medium, palette, line/shape language, lighting, texture, rendering exclusions | Episode topic, channel promise, exact title/headline wording, thumbnail title placement |
| **Thumbnail Recipe** | 16:9 composition grammar, focal hierarchy, title-safe band, headline formats, exact in-image-title instruction, recipe-specific avoid list | Visual medium as the final authority, post-render typography, an episode subject inventory |
| **Bundle-only coordinator** | One exact installable closure and kit-level customer outcome | Creative content, source assets, novel Formula/Topic/Style/Recipe behavior |

All formulas and topics retain the two-layer model: Formula controls the recurring editorial machine; Topic controls what it is about. The standalone items below are deliberately assigned to one of those four component kinds. No “prompt snippet,” editorial modifier, audience tool, or visual preset is introduced as a new product schema.

The current application consumes each kind through its existing signed Content Pack path. Scene and thumbnail surfaces remain separate; a Recipe directs the selected image model to render the complete intended title within the image, while the image pipeline preserves provider output without a text-overlay/compositing path. Visual style selection remains independent from Recipe selection.

## 3. Reuse inventory and hard constraints

The following components already have concrete source material in this worktree. Their existing source, identity, version, provenance, and compatibility declarations are authoritative; this portfolio neither reissues nor renumbers them.

| Existing reusable component | Current source | Intended portfolio use |
| --- | --- | --- |
| Human Behavior, Explained Formula | `content-packs/free-starters/formula/human-behavior-explained/` | Symbolic Psychology Studio; compatible psychology specialist work only |
| Social Dynamics & Boundaries Topic | `content-packs/free-starters/topic/human-behavior-social-dynamics/` | Symbolic Psychology Studio |
| Editorial Psychology Symbolic Split Recipe | `content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split/` | Symbolic Psychology Studio; never cloned merely for a different style |
| Pastel Surreal Psychological Collage | `content-packs/psychology-editorial/style/pastel-surreal-psychological-collage/` | Symbolic Psychology Studio default rendering choice |
| Impasto Psychological Animals | `content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals/` | Symbolic Psychology Studio optional alternate style |
| Practical Motivation Formula and Habits & Momentum Topic | `content-packs/free-starters/formula/practical-motivation/`, `content-packs/free-starters/topic/habits-momentum/` | Challenge & Progress, but not as a paid re-sale of the existing free Build Momentum kit |
| Natural World, Explained Formula; Waxy Outline Cartoon; Curiosity Question Cartoon | existing `content-packs/free-starters/` sources | Family Discovery subject to Formula/topic compatibility review |
| Deep Time Documentary; Documentary Label Tableau; Cinematic Photoreal | existing `content-packs/free-starters/` sources | Cinematic Mini-Docs only where its subject/evidence contract remains distinct from Deep Time |
| The Economics of…; Hand-Drawn Editorial Diagram; Annotated Business Board | existing `content-packs/free-starters/` sources | Case Study Breakdown only for business-operation cases, not generic comparison or generic personal advice |
| Archival Ledger Formula, Topics, Archival Documentary Reconstruction, Archival Map Investigation | `content-packs/paid/archival-ledger/` | Historical-system/evidence work; it is a collision boundary for Mystery & Investigation, not a source to relabel |
| Existing Style Library’s Oil Painting Classical contract | `frontend/composables/useBuiltInStyles.ts` | One future Store-packaged style component only after exact-contract extraction and review |

### 3.1 Distinctness rules

- A different palette, a different subject side, or a different kit name never justifies another Recipe.
- A new style is justified only by a materially different repeatable rendering contract, not an adjacent mood adjective.
- A Topic Pack must expose explicit diversity axes and incompatible combinations; titles alone are not a coverage model.
- A paid offer must add a specialized Formula, materially deeper Topic coverage, or a qualified visual/recipe contract. It cannot charge for an unchanged free component collection under a new shelf name.
- Any proposed package that substantially duplicates the existing Human Behavior, Build Momentum, Archival Ledger, Deep Time, Business Explained, Wild Worlds, or other stocked/free composition is rejected or narrowed before reservation.

### 3.2 Identity and commerce discipline

Before any source authoring wave, the coordinator validates `content-packs/authoring-registry.json`. It then reserves the complete proposed Story content records atomically and passes the registry revision, receipt, and exact resulting record to each leaf. Leaves verify the receipt and only then author their assigned source. This document intentionally names no identities or source-manifest fields for future work.

Family/SKU values, if later returned as part of a reservation, are stocking proposals marked proposed, reserved, or confirmed with field-exact GenStudio evidence. GenStudio alone owns product/release/account/wire identities, quotes, prices, discounts, ownership, purchase, delivery, and publication.

## 4. Approved offering portfolio

### 4.1 Free Symbolic Psychology Studio

**Customer outcome:** A complete, evidence-aware psychology channel system that can present recognizable social patterns through several intentionally different visual treatments without multiplying the Formula, Topic, or Recipe.

**Composition:**

- **Formula:** reuse Human Behavior, Explained exactly.
- **Topic:** reuse Social Dynamics & Boundaries exactly.
- **Recipe:** reuse Editorial Psychology Symbolic Split exactly. It remains sparse, single-subject, opposing-title-band editorial grammar with an AI-rendered concise headline; it is not a pastel-only recipe.
- **Styles:** include/recommend Pastel Surreal Psychological Collage as the default; make Impasto Psychological Animals an approved optional compatible selection; add one Store-packaged component that preserves the existing Oil Painting Classical style contract exactly; and add Gothic Charcoal Animal Editorial only after its provenance and independent visual review qualify it.

The kit has one Formula, one Topic Pack, one Recipe, and several compatible Styles. This is intentional reuse, not four style-specific kit variants. A customer may select the style appropriate to an episode while preserving the same psychology coverage and thumbnail grammar.

**Oil Painting Classical packaging rule:** the prospective Store component copies the current `style_bible` and `negative_prompt` contract verbatim from the shared built-in source at authoring time, records an exact source revision/hash comparison, and supplies a separately qualified preview. It does not “improve,” paraphrase, or silently fork the runtime built-in contract. The Store source and preview/provenance ledger are new authoring artifacts, but the visual contract itself is existing and exact.

**Gothic Charcoal Animal Editorial qualification rule:** this is a genuinely new Visual Style proposal. It may enter the kit only after source/rightsholder provenance, reference-grammar transformation, no-copy review, one original qualifying preview, and independent visual review establish that it is distinct from Impasto Psychological Animals and from the Oil Painting Classical contract. Its role is a darker, charcoal-led animal editorial rendering option; it does not change psychology coverage or create an animal-specific Recipe.

**Explicitly deferred:** Quiet Watercolor and Abstract Emotional Impasto have no approved source, preview, or ownership evidence in this portfolio. They are neither component requests nor kit dependencies until the owner supplies evidence and approves a separate design decision.

### 4.2 Broad free Starter proposals

These are broad, approachable outcomes, not duplicate “starter” skins over the current ten-kit catalog. Each remains a proposed free stocking composition until candidate qualification and owner/GenStudio stocking work.

| Proposed kit | Editorial boundary and customer outcome | Reused components | Genuinely required new units |
| --- | --- | --- |
| **Everyday Explainers** | Answer practical, non-clinical everyday questions through a repeatable escalating explanation. Excludes personal testimony and local travel advice. | Question Ladder Formula once qualified; Minimal Stick-Figure Explainer; Centered Hero Headline | Everyday Systems & Decisions Topic Pack |
| **Personal Story Lessons** | A fact-respecting retrospective narrative turns a clearly sourced experience into one bounded lesson. Excludes invented first-person claims, clinical advice, and anonymous accusation. | Watercolor Storybook; Portrait + Right Title Block where title-safe portrait grammar fits | Personal Story Lessons Formula; Life Changes & Choices Topic Pack |
| **Practical Home & Routine** | Home, workday, and household routines move from friction to an observable workable practice; excludes medical, legal, or safety-critical instruction. | Practical Motivation Formula; Hand-Drawn Editorial Diagram; Annotated Business Board | Home & Routine Systems Topic Pack |
| **Family Discovery** | Family-safe curiosity-led learning about ordinary nature, science, and culture; excludes fear bait, unsafe experiments, and child-directed collection of personal data. | Question Ladder Formula; Waxy Outline Cartoon; Curiosity Question Cartoon | Family Discovery Topic Pack |
| **Weekend Guides** | Plan a bounded local-style outing or skill experience by route, constraints, and one honest promise; excludes unverified business hours, bookings, safety guarantees, and location-specific claims without research. | Cinematic Photoreal where appropriate; Route Map + One Promise Recipe once qualified | Weekend Guides Formula; Weekend Routes & Activities Topic Pack |

Question Ladder is introduced once as a standalone Formula and reused by Everyday Explainers and Family Discovery. Weekend Guides earns its own Formula because itinerary sequence, route constraints, time/cost caveats, and location-sensitive evidence do not fit a progressive explanatory ladder. The required Topic Packs are distinct because their axes and exclusions differ; they must not be collapsed into an untestable “lifestyle” subject list. Personal Story Lessons likewise earns its own Formula because first-person provenance, claim attribution, and reflective pacing conflict with a generic explainer contract.

### 4.3 Paid specialist proposals

The paid label is a proposal for later stocking, not a price or right to collect payment. Each proposal must pass the material-value and collision test against existing free kits before it can enter a reservation request.

| Proposed specialist kit | Specialist promise and exclusion boundary | Reused components | Genuinely required new units |
| --- | --- | --- | --- |
| **Comparison Lab** | Compare two or more options using declared criteria, evidence limits, and a non-prescriptive conclusion. Excludes rankings disguised as facts and undisclosed affiliate claims. | Object Hero + Question Recipe once qualified; compatible factual Styles selected per subject | Comparison Lab Formula; Comparison Domains & Criteria Topic Pack |
| **Cinematic Mini-Docs** | Short, evidence-led human-scale documentary stories of places, crafts, communities, or objects. Distinct from Deep Time and Archival Ledger: it does not claim historical-system investigation or archival reconstruction. | Cinematic Photoreal; Documentary Label Tableau where compatible | Cinematic Mini-Docs Formula; Human-Scale Documentary Subjects Topic Pack |
| **Challenge & Progress** | Follow a measurable attempt over a stated time window, baseline, constraint, and result. It sells progress/evidence depth, not another generic habit list. | Practical Motivation Formula; Habits & Momentum only as a compatible base where the new subject pack adds distinct coverage; Before/After Timeline Formula once qualified | Progress Evidence & Challenge Constraints Topic Pack |
| **Case Study Breakdown** | Explain one bounded decision, operating change, or outcome with evidence, alternatives, and limits. Distinct from Comparison Lab’s multi-option judgment and Business Explained’s generic business anatomy. | The Economics of… only for genuine operating/economic cases; Hand-Drawn Editorial Diagram; Annotated Business Board | Case Study Breakdown Formula; Case Evidence & Operating Decisions Topic Pack |
| **Mystery & Investigation** | Investigate a bounded open question using a claim/evidence/uncertainty ladder. Distinct from Archival Ledger’s historical systems: no accusation, identification, conspiracy certainty, or unsupported solution claim. | Archival Map Investigation and Archival Documentary Reconstruction only when documentary evidence calls for them; otherwise a qualified compatible style | Mystery & Investigation Formula; Open Questions & Evidence Boundaries Topic Pack |

The design deliberately refuses a generic “documentary,” “business,” or “mystery” repack. The narrow Formula promises and Topic exclusions are the structural evidence of paid differentiation. If archival-system scope absorbs Mystery & Investigation during review, the proposal is consolidated into a future Archival Ledger Topic expansion rather than stocked as a competing kit.

### 4.4 High-leverage standalone component proposals

| Component | Kind | Reusable contract | Intended consumers |
| --- | --- | --- | --- |
| **Question Ladder** | Series Formula | Progresses from the audience’s concrete question through mechanisms, trade-offs, exceptions, and a bounded conclusion. Title rules reject bait, medical/legal certainty, and one-size-fits-all directives. | Everyday Explainers, Family Discovery, and compatible later Topic Packs |
| **Audience Question Seeder** | Topic Pack | A duplicate-resistant audience-question domain pack. Its axes include audience context, question intent, constraint, evidence type, and actionability; it does not replace the Formula or become a UI feature. | Question Ladder and other explicitly compatible explanatory Formulas |
| **Before/After Timeline** | Series Formula | Requires a stated baseline, intervention/change, time window, measurements/observations, confounders, and bounded result. It never promises transformation or causality beyond evidence. | Challenge & Progress, selected Case Study work, compatible Topic Packs |
| **Object Hero + Question** | Thumbnail Recipe | One concrete object or artifact as hero plus a concise AI-rendered question in a dominant title-safe band; composition and headline only, not medium/palette. | Comparison Lab, Case Study Breakdown, Everyday Explainers, compatible visual styles |
| **Route Map + One Promise** | Thumbnail Recipe | One route/wayfinding visual anchor plus one qualified, concise AI-rendered promise. It forbids fabricated map accuracy, logos, local endorsements, and post-render text. | Weekend Guides and bounded travel/activity Topic Packs |

These are standalone releases because their contracts can improve many unrelated compositions. A later kit references their exact qualified release rather than embedding a copy. Audience Question Seeder is intentionally a Topic Pack, not a fifth “seeding tool” schema; Question Ladder owns how answers are structured.

## 5. Compatibility, originality, and safety requirements

### 5.1 Compatibility matrix discipline

Each future Formula must declare the specific Topic Packs it accepts, and each Topic Pack must declare supported Formulas and exclusions. Styles declare compatible Formula IDs only where a rendering contract is genuinely unsuitable elsewhere. Recipes declare compatible Formulas and must be tested with at least the proposed kit Formula(s). A coordinator can name only components within exact declared `pack_id@version` dependencies after reservation; it cannot rely on names, paths, current defaults, or “latest.”

The following incompatibilities are design requirements:

- Personal Story Lessons never borrows the Human Behavior Formula’s therapy-adjacent authority or presents a personal account as research.
- Challenge & Progress never states causal transformation from an uncontrolled before/after.
- Comparison Lab does not use a mystery/investigation claim structure and does not convert criteria into a universal recommendation.
- Case Study Breakdown is one bounded causal/operating chain, not a multiple-option comparison.
- Mystery & Investigation must preserve uncertainty and cannot overlap the political/economic historical-system scope of Archival Ledger without consolidation.
- Route Map + One Promise never functions as factual navigation or a location-verification system.
- Object Hero + Question, Route Map + One Promise, and Editorial Psychology Symbolic Split remain independent Recipes even if a style’s palette makes them look related.

### 5.2 Originality and preview evidence

Reference material establishes visual grammar only. No source wording, creator/channel identity, logos, trademarks, people/likenesses, branded assets, exact composition, or copied title language enters a component. Every proposed new Style and Recipe gets an explicit provenance inventory that distinguishes owner-supplied original bytes, Studio Hub production-preview output, and rejected/uncertain material.

- A new **Style** needs one original 1672×941 WebP preview over 20 KB, visually reviewed in the workspace. Its ledger records source/provenance, rights/license basis, SHA-256, decoding result, exact dimensions, and byte size. Style bible and negative prompt remain topic- and title-free.
- A new **Recipe** needs three to five original 16:9 preview examples. They must vary subject, subject side/angle/distance, setting, palette/symbol, and one/two/three-line headline arrangement while preserving the recipe’s hierarchy and title-safe band. Palette-only variants do not qualify.
- Recipe previews show a complete AI-rendered sample headline. No text-free path, pasted title, masking, or post-render compositing is permitted. Malformed, clipped, copied, UI-contaminated, and near-duplicate previews are rejected.
- Existing components are reused as-is unless a separate component version is independently authored and qualified. Oil Painting Classical is an exception only in the narrow sense that its existing shared-library style contract is reproduced exactly into one Store-packaged component; provenance and preview evidence still must be new and complete.

### 5.3 Safety and editorial safeguards

All psychology material stays evidence-aware, non-diagnostic, and non-manipulative. “Manipulation,” attachment, trauma, and similar concepts are discussed as observable patterns with nuance and agency, never a diagnosis of the viewer or an instruction to coerce someone.

Family Discovery uses age-appropriate, non-exploitative subject matter and avoids unsafe activity. Weekend Guides avoids location-dependent facts unless a qualified research source supports them at generation time; a Topic Pack is never a live directory. Personal Story Lessons attributes source material and does not invent testimony. Mystery and Case Study work distinguish observation, evidence, inference, and uncertainty; they do not accuse real people or invent evidence.

The archive safety boundary remains unchanged: strict JSON and permitted raster assets only; no executable content, scripts, URLs, provider/model routing, credentials, fonts, SVG/HTML/CSS, or arbitrary uploads.

## 6. Wave decomposition and later implementation-plan boundary

This portfolio deliberately yields independent implementation plans rather than one multi-surface change set. A later plan may not start a downstream wave merely because this document lists it.

| Wave | Deliverable | Preconditions | Explicitly excluded from that wave |
| --- | --- | --- | --- |
| **0 — portfolio readiness** | Registry validation, inventory/reuse map confirmation, provenance gap report, exact ownership of each proposed leaf | Current registry validates; no reservation yet | Any new ID, source file, archive, price, stocking, or checkout work |
| **1 — Symbolic Psychology Studio** | Existing-component compatibility review; Oil Painting Classical Store-source design; Gothic provenance/visual qualification decision; bundle composition plan | Separate owner evidence for Gothic; a qualified preview path for any new Store component | Quiet Watercolor, Abstract Emotional Impasto, production generation, stocking |
| **2 — reusable primitives** | Question Ladder, Audience Question Seeder, Before/After Timeline, Object Hero + Question, Route Map + One Promise authored as independent releases | Atomic coordinator reservation, leaf handoffs, preview authorization/evidence | Any kit-specific fork of the primitive or new schema type |
| **3 — broad free starters** | Five starter compositions and only the new Formula/Topic units they require | Qualified Wave 2 primitives; each starter passes distinctness and compatibility review | Automatic claim/install, prices, checkout implementation |
| **4 — paid specialists** | Five specialist compositions plus their narrowly scoped Formula/Topic depth | Collision review against all prior qualified components, especially Archival Ledger; independent material-value review | Rebranding existing free kits, price/discount logic, publication |
| **5 — candidate archives and stocking handoffs** | Deterministic candidate archives and one separate owner/GenStudio stocking handoff per approved component/kit closure | All applicable leaf and coordinator evidence/reviews pass; exact app support is released | Upload, publication, purchase, grant, signing with production keys, price decision |

Each wave needs its own implementation plan with source paths, interfaces, tests, review gates, and an exact reservation request. A plan should reserve only that wave’s complete set of records, never speculative future portfolio records. A failed or deferred wave does not invalidate previously qualified components.

## 7. Qualification gates and handoffs

### 7.1 Authoring gate

For every future component, the coordinator must validate the registry, atomically reserve the complete wave, distribute the exact receipt, and collect one canonical leaf handoff. Every handoff uses the established fields: status, component, reservation, identity, stocking proposal, source, intent, compatibility, dependencies, originality/provenance, structured evidence, review requests, and explicit blockers.

Required evidence is concrete, never assumed:

- schema validation;
- Formula/Topic coverage and uniqueness checks where applicable;
- golden prompt parity for Formula continuity claims;
- decoded preview evidence for Style/Recipe assets;
- focused test evidence;
- deterministic candidate-build evidence where a candidate exists.

Required independent review requests are schema, originality/provenance, compatibility, prompt-equivalence, visual/thumbnail as applicable, safety, copy, and commercial boundary. A non-applicable review must state why; missing evidence or review blocks the candidate instead of becoming a placeholder pass.

### 7.2 Candidate archive gate

Candidate archives are local review artifacts, never catalog state. They must have an exact dependency closure, be deterministic, remain at or below 52,428,800 bytes, and validate under the field-exact delivery profile required by the receiving Store contract. For the currently deployed GenStudio Store path that profile is keyless `genstudio-store-receipt-v1`: no archive `key_id`, no `signature.ed25519`, and no private key. If a separate test-only validation lane ever requires a signature, it may use only ephemeral test material that is removed after qualification and must never replace or contaminate the keyless Store-delivery candidate. A bundle-only coordinator has no creative documents/assets and declares only the exact qualified dependency closure.

### 7.3 Stocking handoff

Only after a candidate validates can the coordinator issue a `ready-for-owner-stocking` handoff containing Story content identities, digest/size/min-app-version, qualified evidence, exact dependencies, unresolved findings, and owner-approved merchandising/copy/license requests. It explicitly excludes upload, product/release draft creation, price or discount selection, purchase, grant, production signing, and publication.

GenStudio supplies field-exact catalog/commerce confirmation. Story does not infer that confirmation from a naming convention. Story’s install flow validates the whole exact closure before activation, preserves exact project pins, and never silently upgrades an existing project.

## 8. Operational separation

### 8.1 No production generation on this control/development Mac

This Mac never runs production image generation, paid generation, upload, purchase, publication, or production-key signing for this portfolio. Preview bytes come only from owner-supplied original assets or a Studio Hub production-preview handoff. The local authoring process may inspect, decode, checksum, and visually review returned bytes, but cannot fabricate provenance, license, dimensions, or a visual approval.

Studio Hub handoffs must name the component brief, the approved prompt batch, original output bytes, provenance/rights basis, and return enough metadata to fill the required preview ledger. An exact quote and explicit authorization are required before any paid generation request; neither is supplied by this design.

### 8.2 No overlap with Claude checkout work

The active Claude checkout work and its main checkout remain out of scope. This portfolio does not change Store network routes, quote/purchase/receipt logic, account identity, GenStudio transport, content delivery, checkout UI, music work, production catalog state, or any shared checkout contract. Future stocking handoffs are inputs for the owner/GenStudio and do not authorize a Story-side commerce mutation.

The only permitted integration point is the established post-qualification Content Store contract: a stocked catalog record may later refer to exact qualified Story archive bytes and a declared closure. Neither this specification nor its authoring waves assumes a checkout implementation detail or changes it.

## 9. Review checklist for each future wave

Before a wave is accepted, its plan and resulting handoff must prove all applicable items below:

- [ ] Registry was validated before reservation; only the coordinator reserved the exact wave records.
- [ ] No Story identity, family/SKU status, GenStudio ID, source manifest, price, or archive was invented outside the proper authority.
- [ ] Every offered kit is a coordinator closure of Formula, Topic, Style, and Recipe components; no creative fifth schema exists.
- [ ] Existing components are reused by exact release rather than copied or renamed.
- [ ] New Formula and Topic units declare coverage, incompatibilities, duplicate guards, and evidence/safety constraints.
- [ ] New Style and Recipe previews meet provenance, decode, dimension, size, checksum, originality, and independent visual-review requirements.
- [ ] Recipe output uses complete in-image titles without post-render text compositing and does not merge scene and thumbnail generation.
- [ ] The candidate is deterministic, within the 50 MiB limit, has an exact closure, and uses only ephemeral validation material.
- [ ] No production generation, paid action, upload, purchase, publication, production signing, checkout mutation, or Claude-checkout overlap occurred.
- [ ] The wave has a separate implementation plan, its applicable tests/reviews are recorded, and any unknown owner evidence remains an explicit blocker.

## 10. Owner decisions still required

The architectural decisions in this document are approved. The following are intentionally unresolved gates, not missing design:

1. Supply/confirm provenance, rights, and an independently reviewed original preview for **Gothic Charcoal Animal Editorial**, or keep it out of Symbolic Psychology Studio.
2. Supply evidence and a separate approval decision before **Quiet Watercolor** or **Abstract Emotional Impasto** can leave the deferred list.
3. The owner's 2026-08-23 portfolio approval authorizes all safe local authoring, testing, review, candidate construction, and evidence-backed handoff work described here without repeated per-wave approval. New owner authority is required only for a paid preview quote/request, unresolved evidence or product intent that would materially change the approved design, and the separate GenStudio stocking/publication action after qualification.
4. For paid specialist proposals, independently prove the material-value distinction before candidate qualification. New owner authority is required only for eventual GenStudio field-exact stocking terms; this document makes no commercial decision beyond the approved proposal label.

## 11. Self-review

This design covers the complete approved portfolio, names the exact existing psychology components reused by the Symbolic Psychology Studio kit, distinguishes the new Oil Painting Classical Store packaging from its existing contract, gates Gothic Charcoal Animal Editorial on evidence, and explicitly defers Quiet Watercolor and Abstract Emotional Impasto. It maps every broad starter, paid specialist, and standalone component to the four permitted component boundaries; identifies required new units; prevents near-duplicate kits; defines wave-level planning, preview/provenance, compatibility, originality, safety, review, archive, stocking, control-Mac, and checkout boundaries; and contains no generated identity, price, archive, source manifest, or GenStudio field.
