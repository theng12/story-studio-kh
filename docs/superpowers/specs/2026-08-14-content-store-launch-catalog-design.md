# Story Studio Content Store Launch Catalog Design

**Status:** Owner-approved catalog direction; implementation and stocking specification
**Date:** 2026-08-14
**Repositories:** Story Studio KH and GenStudio KH
**Build baseline:** Story Studio `90e3984428ece87967d4e5638a0c4ae6f0f5c3c2` (`1.0.841`)
**Supersedes:** Opening-shelf assumptions that limited the launch to one free starter bundle or treated a Channel Kit as a monolithic product

## 1. Decision summary

The launch catalog uses **componentized packaging permanently**.

- A Formula, Topic Pack, Visual Style, and Thumbnail Recipe is an independently versioned, independently ownable Content Pack component.
- A Channel Kit is a commercial and installation composition of exact component releases. It is never a renamed monolithic fifth content schema.
- The initial customer catalog contains **exactly ten permanently free, complete Starter Channel Kits**.
- Every Starter Kit includes one compatible Formula, one full Topic Pack, one Visual Style, and one Thumbnail Recipe. “Full” means the complete launch edition, not a crippled sampler.
- Shared components have one stable identity and one entitlement family. Claiming another kit that reuses one does not duplicate bytes, ownership, or value.
- Free Starter Kits are intentionally generous because generation credits, not artificial content scarcity, are the primary recurring revenue path.
- Paid standalone components, deeper Topic expansions, specialist Channel Kits, and premium collections are approved. Paid content must add material production value; it must not rename and resell an unchanged legacy built-in.
- Future grants based on lifetime or recent credit spend are deferred. The ownership model must be able to support zero-price grants later without changing pack identity.

The approved customer journey is:

> **Shelf → Proof/detail → Owned → Install/Installed**

Story Studio does not create or upload showcase videos. The owner creates examples later, GenStudio stores their catalog metadata, and Story renders the published links.

## 2. Goals

1. Turn the completed Content Pack runtime and commerce path into a coherent first-party merchandise catalog.
2. Give every customer ten immediately useful channel directions without charging for basic creative variety.
3. Let one component be reused across multiple kits without duplicate archives or entitlements.
4. Let future catalog additions and compatible content updates ship without a Story Studio application update.
5. Preserve existing projects and existing built-in access exactly until a customer explicitly adopts a signed replacement.
6. Create clear paid expansion paths based on depth, specialization, proof, and production value.
7. Keep GenStudio authoritative for catalog identity, price, ownership, quotes, grants, and delivery, while Story remains authoritative for pack validation, local installation, project pinning, and offline use.

## 3. Non-goals

This launch does not include:

- spend-based, tier-based, referral-based, or promotional automatic pack grants;
- subscriptions, rentals, or expiring ownership;
- third-party publishers or a creator marketplace;
- customer-authored pack publishing through the Store;
- automatic installation after ownership is granted;
- automatic project migration or pack-version upgrades;
- automatic showcase-video creation, upload, or generation;
- executable pack content, remote prompts with undeclared capabilities, fonts, HTML, CSS, SVG, scripts, or arbitrary URLs;
- hardcoded GenStudio prices, product IDs, release IDs, account IDs, or catalog order in Story Studio;
- generation or model qualification on this control/development Mac.

## 4. Existing inventory and migration baseline

At the `1.0.841` baseline Story contains:

| Legacy source | Count | Current shape |
| --- | ---: | --- |
| Niche/Formula JSON configurations | 21 | Formula behavior is split between JSON and `niche-loader.ts` decoration. |
| Topic Pack JSON documents | 26 | 556 total subject rows; many predate the richer episode-object/mechanism schema. |
| Built-in Visual Styles | 17 | Frontend TypeScript with generated preview assets. |
| Thumbnail Recipes | 6 | Backend JSON plus preview/catalog behavior. |
| Customer-facing signed Channel Kits | 0 | The Store platform is live but has no stocked customer kit. |

The 21 legacy niche configurations are not 21 future Formula products. The approved Formula/Topic architecture consolidates them into reusable writing contracts and Topic Packs. Retired predecessors remain migration aliases, not new merchandise.

The launch work therefore has two separate outputs:

1. **Signed component editions** distilled from effective legacy behavior, including behavior currently injected outside the JSON file.
2. **Commercial catalog composition** that groups exact signed component releases into the ten free kits and later paid offerings.

No legacy file is deleted as part of authoring. Prompt-equivalence and project-pin migration gates decide when an old loader path can later be retired.

### 4.1 Current Store implementation delta

At this baseline the runtime, signed delivery, permanent ownership, quote/purchase, restore, and explicit install paths exist. The customer UI has Discover and Owned card grids, but the approved launch presentation is not complete:

- cards lead with technical component counts rather than the approved outcome-first covers;
- there is no dedicated proof/detail journey;
- Owned, Installed, and Updates are not complete separate library surfaces;
- catalog-published shelf placement and cover media are not in the live Story parser;
- `showcase_videos` and the exact owned-release lookup are implemented on reviewed adoption work but are not part of this baseline commit;
- a bundle-only coordination archive is not accepted by the current pack schema.

This specification therefore authorizes catalog authoring and the missing Story application work. It does not describe the launch catalog as already stocked or the full journey as already shipped.

### 4.2 Merge, split, and reuse rules

- **Split legacy production systems by responsibility:** Formula behavior, Topic coverage, visual look, and thumbnail grammar become separate signed components.
- **Merge only at the commercial/installation layer:** a Channel Kit or premium collection groups exact component releases; it does not merge their content into a new monolith.
- **Reuse by reference:** the same style, recipe, or compatible Topic Pack keeps one identity when used by multiple kits.
- **Consolidate duplicate Formula identities:** legacy animal/fungi/insect/plant variants share Natural World, Explained; retired Dark Psychology is a restrained Human Behavior lane; Devotional/Preaching are modes beneath Pastoral Scripture outside this ten-kit launch.
- **Keep genuinely different contracts separate:** Mindfulness, Motivation, Sleep, POV, History, Economics, Ancient Humans, and Natural World retain separate Formulas because their perspective, evidence, pacing, or safety rules differ.
- **Sell depth separately:** a Topic expansion, style, or recipe can be a standalone product and can also appear in specialist kits or premium collections.
- **Never split below a usable schema unit:** fragments such as one prompt paragraph, one array axis, or one preview image are not products or entitlement families.

## 5. Permanent identity and versioning rules

### 5.1 Publisher namespace

All first-party launch content uses publisher namespace:

```text
com.storystudio
```

Identity patterns are fixed:

| Object | Pattern | Example |
| --- | --- | --- |
| Component pack | `com.storystudio.pack.<kind>.<slug>` | `com.storystudio.pack.topic.natural-world-animals` |
| Formula item | `com.storystudio.formula.<slug>` | `com.storystudio.formula.natural-world-explained` |
| Topic item | `com.storystudio.topic.<slug>` | `com.storystudio.topic.natural-world-animals` |
| Style item | `com.storystudio.style.<slug>` | `com.storystudio.style.waxy-outline-cartoon` |
| Thumbnail item | `com.storystudio.thumbnail.<slug>` | `com.storystudio.thumbnail.curiosity-question-cartoon` |
| Channel Kit coordination pack | `com.storystudio.pack.kit.<slug>` | `com.storystudio.pack.kit.wild-worlds` |
| Channel Kit bundle ID | `com.storystudio.bundle.<slug>` | `com.storystudio.bundle.wild-worlds` |
| Entitlement family | `com.storystudio.family.<kind>.<slug>` | `com.storystudio.family.topic.natural-world-animals` |
| Entitlement SKU | `com.storystudio.sku.<kind>.<slug>` | `com.storystudio.sku.topic.natural-world-animals` |

GenStudio `product_id`, `release_id`, quote IDs, purchase IDs, entitlement IDs, and grant IDs remain opaque server-issued values. Story never derives or hardcodes them from these namespaced content IDs.

The GenStudio wire kind remains `niche_bundle` for compatibility. Story's customer-facing label is **Channel Kit**.

### 5.2 Launch versions

- Every new component and kit coordination pack begins at exact content version `1.0.0`.
- A byte change to a signed archive requires a new exact version.
- Content schema versions remain the schema versions supported by the installed Story application; they are not coupled to the marketing version.
- `min_app_version` is bound at artifact-build time to the first released Story version that contains the required schema interpreter and publisher public key. The publisher must fail if this value differs from that release's `package.json` version.
- No design document guesses the future Story release number.
- Existing projects pin exact `pack_id@version`; no catalog edit changes their effective content.

### 5.3 Component ownership

Ownership attaches to one entitlement family per component or coordination pack. An entitlement family may receive compatible future releases under the existing permanent-update policy.

- A shared component has one family everywhere it appears.
- A kit grant never mints a kit-private copy of a shared component.
- Reusing a component does not create a second install directory or second project identity.
- Separately sold expansions use separate families, even when compatible with a free Formula.
- A successor is explicit catalog metadata; it never rewrites project pins.

## 6. Bundle-only coordination release

The current Content Pack schema permits a `channel-kit` only inside a manifest that also contains at least one content document and one declared file. That shape cannot represent the approved permanent componentized model without duplicating a component inside the kit archive.

Before stocking the ten kits, Story must add a narrowly bounded **bundle-only coordination release**:

- it is still a signed `.sspack`;
- it contains `manifest.json` and `signature.ed25519`, but no creative content documents or raster assets;
- it declares exactly one `channel-kit` bundle;
- its `items` and content `files` collections are empty only for this bundle-only case;
- it declares every external component pack as an exact `pack_id@version` dependency;
- every bundle component reference names an item inside one declared exact dependency;
- the bundle contains exactly one Formula, at least one Topic Pack, at least one Visual Style, and at least one Thumbnail Recipe for the Starter launch;
- normal component packs must still contain at least one item and file;
- the archive remains subject to signature, namespace, dependency-cycle, compatibility, and archive safety checks.

Installing a Channel Kit means:

1. verify ownership and the signed coordination release;
2. resolve every exact dependency from owned GenStudio releases, including an owner-accessible withdrawn release;
3. refuse a recalled version with the exact terminal `410 release_recalled` evidence;
4. download, verify, and install only missing dependency versions;
5. activate the coordination pack only after the whole dependency closure verifies;
6. expose the Formula, Topic Pack, Style, and Recipe from their component packs;
7. report the kit Installed only when the complete exact closure is installed and verified.

This is an application-schema change and therefore requires a Story Studio release. It cannot be delivered as content alone.

## 7. The ten free Starter Channel Kits

All ten kits are zero-price permanent GenStudio entitlements. A customer explicitly claims a kit; Story does not silently add ten ownership records or install ten dependency closures.

Shelf cards lead with the channel promise and creative space, not component counts or repeated permanent-ownership copy. Component facts belong on the proof/detail and receipt views.

| Kit | Shelf promise hierarchy | Formula | Full launch Topic Pack | Visual Style | Thumbnail Recipe |
| --- | --- | --- | --- | --- | --- |
| **Wild Worlds** | `Wild Worlds` / `10 starting subjects` / `Instinct → Ecosystem` | Natural World, Explained | Animals — 10 subjects | Waxy Outline Cartoon | Curiosity Question Cartoon |
| **First Humans** | `First Humans` / `20 survival problems` / `Constraint → Adaptation` | How Did Ancient Humans…? | Survival Problems — 20 subjects | Prehistoric Stick Cartoon | Prehistoric Discovery |
| **Deep Time** | `Deep Time` / `30 Earth systems` / `Planet → Transformation` | Deep Time Documentary | Earth Systems & Deep Change — 30 subjects | Paleo Documentary Tableau | Documentary Label Tableau |
| **Business Explained** | `Business Explained` / `40 businesses` / `Cost → Constraint` | The Economics of… | Businesses & Companies — 40 subjects | Hand-Drawn Editorial Diagram | Annotated Business Board |
| **Human Behavior** | `Human Behavior` / `10 social dynamics` / `Signal → Choice` | Human Behavior, Explained | Social Dynamics & Boundaries — 10 subjects | Minimal Stick-Figure Explainer | Centered Hero Headline |
| **History Explained** | `History Explained` / `25 conflicts and settlements` / `Event → Consequence` | History, Explained | Wars, Treaties & World Order — 25 subjects | Sepia Ink & Wash | Documentary Label Tableau |
| **A Life As…** | `A Life As…` / `25 historical occupations` / `Role → Reality` | POV: Your Life As… | Historical Occupations — 25 subjects | Cinematic Photoreal | Portrait + Right Title Block |
| **Calm Mind** | `Calm Mind` / `15 everyday practices` / `Pause → Presence` | Guided Mindfulness | Everyday Calm — 15 subjects | Watercolor Storybook | Centered Hero Headline |
| **Build Momentum** | `Build Momentum` / `15 habit challenges` / `Friction → Action` | Practical Motivation | Habits & Momentum — 15 subjects | Flat Vector Explainer | Annotated Business Board |
| **Sleep Journeys** | `Sleep Journeys` / `15 night journeys` / `Setting → Rest` | Sleep Story | Night Journeys — 15 subjects | Watercolor Storybook | Dreamscape Story Window |

The three previously approximate new Topic Packs are fixed at exactly 15 launch subjects each. Their advertised count may increase only in a later signed content version; it must never exceed the verified content in the installed release.

## 8. Exact free component registry

Every row below launches at component version `1.0.0`.

### 8.1 Formulas

| Display name | Pack ID | Item ID | Entitlement family | Legacy source |
| --- | --- | --- | --- | --- |
| Natural World, Explained | `com.storystudio.pack.formula.natural-world-explained` | `com.storystudio.formula.natural-world-explained` | `com.storystudio.family.formula.natural-world-explained` | `animals.json` plus effective `niche-loader.ts` decoration |
| How Did Ancient Humans…? | `com.storystudio.pack.formula.ancient-humans` | `com.storystudio.formula.ancient-humans` | `com.storystudio.family.formula.ancient-humans` | `ancient-humans.json` plus effective decoration |
| Deep Time Documentary | `com.storystudio.pack.formula.deep-time-documentary` | `com.storystudio.formula.deep-time-documentary` | `com.storystudio.family.formula.deep-time-documentary` | `deep-time-documentary.json` plus effective decoration |
| The Economics of… | `com.storystudio.pack.formula.economics-of` | `com.storystudio.formula.economics-of` | `com.storystudio.family.formula.economics-of` | `business-economics.json` plus effective decoration |
| Human Behavior, Explained | `com.storystudio.pack.formula.human-behavior-explained` | `com.storystudio.formula.human-behavior-explained` | `com.storystudio.family.formula.human-behavior-explained` | `psychology.json` plus effective decoration; `dark-psychology` remains a Topic/editorial lane, not a Formula identity |
| History, Explained | `com.storystudio.pack.formula.history-explained` | `com.storystudio.formula.history-explained` | `com.storystudio.family.formula.history-explained` | `history-narration.json` plus effective decoration |
| POV: Your Life As… | `com.storystudio.pack.formula.pov-your-life-as` | `com.storystudio.formula.pov-your-life-as` | `com.storystudio.family.formula.pov-your-life-as` | `pov-life.json` plus effective decoration |
| Guided Mindfulness | `com.storystudio.pack.formula.guided-mindfulness` | `com.storystudio.formula.guided-mindfulness` | `com.storystudio.family.formula.guided-mindfulness` | `mindfulness.json` plus effective decoration |
| Practical Motivation | `com.storystudio.pack.formula.practical-motivation` | `com.storystudio.formula.practical-motivation` | `com.storystudio.family.formula.practical-motivation` | `motivation.json` plus effective decoration |
| Sleep Story | `com.storystudio.pack.formula.sleep-story` | `com.storystudio.formula.sleep-story` | `com.storystudio.family.formula.sleep-story` | `sleep.json` plus effective decoration |

Each Formula pack uses the matching SKU pattern `com.storystudio.sku.formula.<slug>`.

### 8.2 Topic Packs

| Display name | Pack ID | Item ID | Entitlement family | Launch source/count |
| --- | --- | --- | --- | --- |
| Animals | `com.storystudio.pack.topic.natural-world-animals` | `com.storystudio.topic.natural-world-animals` | `com.storystudio.family.topic.natural-world-animals` | Enriched from `natural-world-animals.json`; 10 subjects |
| Survival Problems | `com.storystudio.pack.topic.ancient-humans-survival` | `com.storystudio.topic.ancient-humans-survival` | `com.storystudio.family.topic.ancient-humans-survival` | Enriched from `ancient-humans-survival.json`; 20 subjects |
| Earth Systems & Deep Change | `com.storystudio.pack.topic.deep-time-earth-systems` | `com.storystudio.topic.deep-time-earth-systems` | `com.storystudio.family.topic.deep-time-earth-systems` | Enriched from `deep-time-earth-systems.json`; 30 subjects |
| Businesses & Companies | `com.storystudio.pack.topic.economics-businesses` | `com.storystudio.topic.economics-businesses` | `com.storystudio.family.topic.economics-businesses` | Enriched from `economics-businesses.json`; 40 subjects |
| Social Dynamics & Boundaries | `com.storystudio.pack.topic.human-behavior-social-dynamics` | `com.storystudio.topic.human-behavior-social-dynamics` | `com.storystudio.family.topic.human-behavior-social-dynamics` | Enriched from `human-behavior-social-dynamics.json`; 10 subjects |
| Wars, Treaties & World Order | `com.storystudio.pack.topic.historical-wars-treaties-world-order` | `com.storystudio.topic.historical-wars-treaties-world-order` | `com.storystudio.family.topic.historical-wars-treaties-world-order` | Enriched from `historical-wars-treaties-world-order.json`; 25 subjects; compatibility expands from HMH to History, Explained without weakening HMH |
| Historical Occupations | `com.storystudio.pack.topic.pov-historical-occupations` | `com.storystudio.topic.pov-historical-occupations` | `com.storystudio.family.topic.pov-historical-occupations` | Enriched from `pov-historical-occupations.json`; 25 subjects |
| Everyday Calm | `com.storystudio.pack.topic.everyday-calm` | `com.storystudio.topic.everyday-calm` | `com.storystudio.family.topic.everyday-calm` | New authored pack; exactly 15 subjects |
| Habits & Momentum | `com.storystudio.pack.topic.habits-momentum` | `com.storystudio.topic.habits-momentum` | `com.storystudio.family.topic.habits-momentum` | New authored pack; exactly 15 subjects |
| Night Journeys | `com.storystudio.pack.topic.night-journeys` | `com.storystudio.topic.night-journeys` | `com.storystudio.family.topic.night-journeys` | New authored pack; exactly 15 subjects |

Each Topic pack uses the matching SKU pattern `com.storystudio.sku.topic.<slug>`.

### 8.3 Visual Styles

| Display name | Pack/item slug | Pack ID | Item ID | Shared by |
| --- | --- | --- | --- | --- |
| Waxy Outline Cartoon | `waxy-outline-cartoon` | `com.storystudio.pack.style.waxy-outline-cartoon` | `com.storystudio.style.waxy-outline-cartoon` | Wild Worlds |
| Prehistoric Stick Cartoon | `prehistoric-stick-cartoon` | `com.storystudio.pack.style.prehistoric-stick-cartoon` | `com.storystudio.style.prehistoric-stick-cartoon` | First Humans |
| Paleo Documentary Tableau | `paleo-documentary-tableau` | `com.storystudio.pack.style.paleo-documentary-tableau` | `com.storystudio.style.paleo-documentary-tableau` | Deep Time |
| Hand-Drawn Editorial Diagram | `hand-drawn-editorial-diagram` | `com.storystudio.pack.style.hand-drawn-editorial-diagram` | `com.storystudio.style.hand-drawn-editorial-diagram` | Business Explained |
| Minimal Stick-Figure Explainer | `minimal-stick-figure-explainer` | `com.storystudio.pack.style.minimal-stick-figure-explainer` | `com.storystudio.style.minimal-stick-figure-explainer` | Human Behavior |
| Sepia Ink & Wash | `sepia-ink-wash` | `com.storystudio.pack.style.sepia-ink-wash` | `com.storystudio.style.sepia-ink-wash` | History Explained |
| Cinematic Photoreal | `cinematic-photoreal` | `com.storystudio.pack.style.cinematic-photoreal` | `com.storystudio.style.cinematic-photoreal` | A Life As… |
| Watercolor Storybook | `watercolor-storybook` | `com.storystudio.pack.style.watercolor-storybook` | `com.storystudio.style.watercolor-storybook` | Calm Mind and Sleep Journeys |
| Flat Vector Explainer | `flat-vector-explainer` | `com.storystudio.pack.style.flat-vector-explainer` | `com.storystudio.style.flat-vector-explainer` | Build Momentum |

Each style family and SKU follows `com.storystudio.family.style.<slug>` and `com.storystudio.sku.style.<slug>`. Existing generated previews are migrated into the signed pack and revalidated; no customer-facing style ships without a decoded preview.

### 8.4 Thumbnail Recipes

| Display name | Pack/item slug | Pack ID | Item ID | Shared by |
| --- | --- | --- | --- | --- |
| Curiosity Question Cartoon | `curiosity-question-cartoon` | `com.storystudio.pack.thumbnail.curiosity-question-cartoon` | `com.storystudio.thumbnail.curiosity-question-cartoon` | Wild Worlds |
| Prehistoric Discovery | `prehistoric-discovery` | `com.storystudio.pack.thumbnail.prehistoric-discovery` | `com.storystudio.thumbnail.prehistoric-discovery` | First Humans |
| Documentary Label Tableau | `documentary-label-tableau` | `com.storystudio.pack.thumbnail.documentary-label-tableau` | `com.storystudio.thumbnail.documentary-label-tableau` | Deep Time and History Explained |
| Annotated Business Board | `annotated-business-board` | `com.storystudio.pack.thumbnail.annotated-business-board` | `com.storystudio.thumbnail.annotated-business-board` | Business Explained and Build Momentum |
| Centered Hero Headline | `centered-hero-headline` | `com.storystudio.pack.thumbnail.centered-hero-headline` | `com.storystudio.thumbnail.centered-hero-headline` | Human Behavior and Calm Mind |
| Portrait + Right Title Block | `portrait-block-right` | `com.storystudio.pack.thumbnail.portrait-block-right` | `com.storystudio.thumbnail.portrait-block-right` | A Life As… |
| Dreamscape Story Window | `dreamscape-story-window` | `com.storystudio.pack.thumbnail.dreamscape-story-window` | `com.storystudio.thumbnail.dreamscape-story-window` | Sleep Journeys |

Each recipe family and SKU follows `com.storystudio.family.thumbnail.<slug>` and `com.storystudio.sku.thumbnail.<slug>`. Prehistoric Discovery and Dreamscape Story Window require new recipe authoring and original preview assets using only layout primitives already supported by the installed app.

## 9. Exact free kit registry

Every kit launches at coordination-pack version `1.0.0` and uses exact component version `1.0.0`.

| Kit | Coordination pack | Bundle ID | Entitlement family |
| --- | --- | --- | --- |
| Wild Worlds | `com.storystudio.pack.kit.wild-worlds` | `com.storystudio.bundle.wild-worlds` | `com.storystudio.family.kit.wild-worlds` |
| First Humans | `com.storystudio.pack.kit.first-humans` | `com.storystudio.bundle.first-humans` | `com.storystudio.family.kit.first-humans` |
| Deep Time | `com.storystudio.pack.kit.deep-time` | `com.storystudio.bundle.deep-time` | `com.storystudio.family.kit.deep-time` |
| Business Explained | `com.storystudio.pack.kit.business-explained` | `com.storystudio.bundle.business-explained` | `com.storystudio.family.kit.business-explained` |
| Human Behavior | `com.storystudio.pack.kit.human-behavior` | `com.storystudio.bundle.human-behavior` | `com.storystudio.family.kit.human-behavior` |
| History Explained | `com.storystudio.pack.kit.history-explained` | `com.storystudio.bundle.history-explained` | `com.storystudio.family.kit.history-explained` |
| A Life As… | `com.storystudio.pack.kit.a-life-as` | `com.storystudio.bundle.a-life-as` | `com.storystudio.family.kit.a-life-as` |
| Calm Mind | `com.storystudio.pack.kit.calm-mind` | `com.storystudio.bundle.calm-mind` | `com.storystudio.family.kit.calm-mind` |
| Build Momentum | `com.storystudio.pack.kit.build-momentum` | `com.storystudio.bundle.build-momentum` | `com.storystudio.family.kit.build-momentum` |
| Sleep Journeys | `com.storystudio.pack.kit.sleep-journeys` | `com.storystudio.bundle.sleep-journeys` | `com.storystudio.family.kit.sleep-journeys` |

Kit SKUs use `com.storystudio.sku.kit.<slug>`.

The dependency list for each coordination pack is the four exact component packs named in section 7. Reused components retain the same pack, item, version, family, and SKU in every kit.

## 10. Free entitlement semantics

1. Each Starter Kit catalog product has published `credit_price: 0` and `free: true` from GenStudio.
2. Story uses the same signed quote, explicit confirmation, idempotent purchase, signed receipt, restore, and download path as paid content.
3. The confirmation states “No credits charged” and “Permanent ownership for this GenStudio account.”
4. The completed receipt must grant the kit family and all exact component families not already owned.
5. Existing component entitlements are returned as already owned, not duplicated or replaced.
6. Claiming a second kit with shared components grants only its new kit and component families.
7. Free claim success means **Owned**, never **Installed**.
8. Installation remains an explicit action from the Owned view.
9. A zero credit balance does not block a zero-price entitlement or use of installed content.
10. The ten launch families remain permanently free. A future replacement may add value under a new paid family, but an already-free family is never converted into a paid gate.

Individual free-kit components may be suppressed as duplicate shelf cards, but they remain independent owned components in receipts, restore, installation, project pinning, and bundle calculations.

GenStudio therefore creates a supporting product family and release for every free component, with the same zero-price/permanent policy as its kit. A supporting component product may be excluded from Discover merchandising, but it must remain addressable in ownership, receipts, exact-release lookup, dependency installation, and product detail. A component included in a permanently free launch kit cannot later become a paid prerequisite under the same entitlement family.

## 11. Paid catalog structure

### 11.1 Approved merchandise classes

The following paid shapes are approved:

- standalone Topic expansions;
- standalone Visual Styles;
- standalone Thumbnail Recipes;
- specialist Formulas when they introduce a materially distinct editorial contract;
- specialist Channel Kits combining exact component releases;
- premium collections combining multiple already-published specialist products with owned-component discounts.

Paid is a merchandising property published by GenStudio, not a different pack format or a weaker ownership class.

### 11.2 First paid flagship: Archival Ledger

Archival Ledger remains the first specialist paid Channel Kit. The owner-approved list price is **2,000 GenStudio credits**. The approved launch offer is an operator-set **90% discount for every customer**, with an optional end date of **2026-12-31** for this offer. Story must render the live catalog and quote facts and never hardcode either amount or discount in runtime UI.

GenStudio applies the operator discount after deducting the exact value of already-owned
components from the list-price remainder. The mechanisms compose: a customer pays for the
missing components, and the active operator discount applies to that remainder. The final
amount is calculated and signed by GenStudio. There is no new-customer eligibility rule,
account-history check, first-purchase rule, or eligibility refusal state for this offer; while
active, it applies to every customer. Story displays the signed discount and final amount and
never calculates, re-qualifies, or auto-applies the offer locally. The final wire field names
remain a GenStudio contract input and must not be guessed here.

Its componentized `1.0.0` product uses:

- coordination pack `com.storystudio.pack.kit.archival-ledger`;
- bundle ID `com.storystudio.bundle.archival-ledger`;
- kit family `com.storystudio.family.kit.archival-ledger`;
- one Formula component, `com.storystudio.formula.archival-ledger`;
- five independent historical Topic components covering the approved 125 named subjects;
- style component `com.storystudio.style.archival-documentary-reconstruction`;
- thumbnail component `com.storystudio.thumbnail.archival-map-investigation`.

The exact Archival Ledger component pack identities are:

| Component | Pack ID | Item ID | Entitlement family |
| --- | --- | --- | --- |
| Formula | `com.storystudio.pack.formula.archival-ledger` | `com.storystudio.formula.archival-ledger` | `com.storystudio.family.formula.archival-ledger` |
| States, Revolutions & Collapse | `com.storystudio.pack.topic.archival-ledger.states-revolutions-collapse` | `com.storystudio.topic.archival-ledger.states-revolutions-collapse` | `com.storystudio.family.topic.archival-ledger.states-revolutions-collapse` |
| Money, Debt & Financial Institutions | `com.storystudio.pack.topic.archival-ledger.money-debt-financial-institutions` | `com.storystudio.topic.archival-ledger.money-debt-financial-institutions` | `com.storystudio.family.topic.archival-ledger.money-debt-financial-institutions` |
| Empires, Trade & Extraction | `com.storystudio.pack.topic.archival-ledger.empires-trade-extraction` | `com.storystudio.topic.archival-ledger.empires-trade-extraction` | `com.storystudio.family.topic.archival-ledger.empires-trade-extraction` |
| Wars, Treaties & World Order | `com.storystudio.pack.topic.archival-ledger.wars-treaties-world-order` | `com.storystudio.topic.archival-ledger.wars-treaties-world-order` | `com.storystudio.family.topic.archival-ledger.wars-treaties-world-order` |
| Infrastructure, Commodities & Corporate Power | `com.storystudio.pack.topic.archival-ledger.infrastructure-commodities-corporate-power` | `com.storystudio.topic.archival-ledger.infrastructure-commodities-corporate-power` | `com.storystudio.family.topic.archival-ledger.infrastructure-commodities-corporate-power` |
| Archival Documentary Reconstruction | `com.storystudio.pack.style.archival-documentary-reconstruction` | `com.storystudio.style.archival-documentary-reconstruction` | `com.storystudio.family.style.archival-documentary-reconstruction` |
| Archival Map Investigation | `com.storystudio.pack.thumbnail.archival-map-investigation` | `com.storystudio.thumbnail.archival-map-investigation` | `com.storystudio.family.thumbnail.archival-map-investigation` |

Their SKUs follow the fixed section 5 pattern. The coordination release depends on all eight component packs at exact `1.0.0`.

Its shelf promise remains:

```text
Archival Ledger
500+ ideas
Debt → Power
```

The existing monolithic Archival Ledger authoring candidate is not stocked unchanged. Its reviewed content is the source for separately signed component releases and a bundle-only coordination release. The 500+ claim must continue to pass the independent 125 subjects × 4 materially distinct sibling-assignment gate.

### 11.3 Approved expansion lanes

These are approved commercial lanes, not permission to publish unchanged legacy files:

| Free foundation | Paid depth path |
| --- | --- |
| Wild Worlds | Enriched Fungi, Insects & Arthropods, Plants & Botanical Survival, then a Natural World specialist collection |
| First Humans | Enriched Environments & Climate, Social Life & Belief, Tools & Technology, then a complete Ancient Humans collection |
| Deep Time | Enriched Prehistoric Life & Extinction, Ancient Oceans & Deep Sea, Human Origins & Ancient Worlds, Speculative Earth Scenarios |
| Business Explained | Enriched Ancient Civilizations & Empires, industries, finance, and company-specific expansions |
| Human Behavior | Authored relationships, persuasion, group behavior, boundaries, and decision-making expansions |
| History Explained | Archival Ledger and later evidence-led specialist systems |
| A Life As… | Enriched Criminal Hierarchies and Law Enforcement Hierarchies, plus future occupation systems |
| Calm Mind | Additional practice settings and specialist calm programs that avoid medical or therapeutic claims |
| Build Momentum | Additional habit, planning, recovery, and constraint-based action packs |
| Sleep Journeys | Additional settings, narrative structures, and premium visual/thumbnail looks that preserve low-arousal behavior |

### 11.4 Free versus paid boundary

A paid product must satisfy all of these:

1. **Net-new outcome:** its detail page names a customer outcome not already delivered by an unchanged free or legacy-included component.
2. **Material content:** it adds new structured coverage, a distinct Formula contract, or an original production look—not cosmetic copy, title paraphrases, or a different bundle name.
3. **No legacy rebilling:** unchanged content that shipped in Story before the Store remains usable by existing projects and cannot be sold back as if newly authored.
4. **Independent identity:** the paid expansion has a separate family when ownership and future updates should be independent.
5. **Proofable claim:** every numerical or capability promise is derived from the signed release and passes its corresponding offline acceptance test.
6. **Complete use:** it is usable with at least one owned or free compatible Formula; the customer is never sold an unusable orphan component.
7. **Transparent dependency:** its detail view names required components and whether they are free, owned, or included in the quote.

Prices for paid products other than Archival Ledger are not decided in this specification. GenStudio recommends prices from the live credit economy, the owner approves them, and Story displays only the published catalog and quote values.

## 12. Content enrichment requirements

Mechanical conversion of a legacy file is not sufficient authoring.

### 12.1 Formula acceptance

Each signed Formula must:

- absorb its effective legacy behavior, including current `niche-loader.ts` decoration;
- declare one stable channel promise, audience, perspective, narrative quality contract, title rules, script structure, evidence expectations, and compatibility set;
- keep model/provider selection out of content;
- preserve customer choices such as per-episode scene rhythm rather than setting them through a pack;
- pass effective-prompt golden comparison for unchanged legacy inputs;
- include no unsupported strategy, metadata section, motion profile, renderer behavior, or UI control.

### 12.2 Topic Pack acceptance

Each signed Topic Pack must contain meaningful, non-placeholder values for:

- named subjects;
- episode objects;
- time/place scopes;
- mechanisms;
- evidence lenses;
- exclusions;
- compatibility rules;
- maximum sibling concentration;
- bounded prompt context.

The planner must distinguish exact duplicates, near duplicates, and legitimate sibling episodes using subject + episode object + time/place + mechanism. Subject-list length alone is not a coverage claim.

For every advertised idea count:

- a deterministic offline coverage test must produce at least that many distinct assignments;
- siblings under one subject must vary both episode object and mechanism;
- a human review samples assignments across the beginning, middle, and end of the generated coverage order;
- no test makes paid GenStudio generation requests.

### 12.3 Visual Style acceptance

Each style must include:

- a distinct render-ready Style Bible;
- a negative prompt;
- searchable category and tags;
- declared compatible Formulas;
- at least one original decoded raster preview;
- visual review for legibility, composition, and accurate representation of the prompt contract.

### 12.4 Thumbnail Recipe acceptance

Each recipe must use only app-supported layout primitives and include:

- composition guidance;
- required and avoided elements;
- headline mode and formats;
- text style, font style, and placement guidance;
- compatible Formula declarations;
- at least one original decoded preview;
- snapshot/golden proof that migrated recipes preserve effective behavior.

## 13. Catalog information architecture

### 13.1 Discover shelves

The Discover view uses catalog-published placement and order, not a Story hardcoded list.

Launch shelves:

1. **Free Starter Kits** — the ten approved complete kits.
2. **Specialist Channel Kits** — Archival Ledger and later complete specialist systems.
3. **Topic Expansions** — standalone depth for an owned/free Formula.
4. **Production Looks** — standalone Visual Styles and Thumbnail Recipes.
5. **Premium Collections** — multi-product bundles with owned-component discounts.

A product can appear on more than one catalog-published shelf, but one stable product ID and entitlement family back every appearance.

### 13.2 Library views

- **Owned** lists every permanently owned product/component and its receipt/restore state.
- **Installed** lists verified local packs and complete/incomplete kit closures.
- **Updates** lists owned compatible releases that differ from the installed exact version.
- A locally installed pack from another account remains usable and identified, but remote restore/update actions name the owning account requirement.

“Included” is reserved for the immutable recovery catalog and grandfathered built-ins. It is not a synonym for the ten account-owned free kits.

### 13.3 Search and filters

Search spans title, summary, description, type, and catalog-published tags. Filters include Free/Paid, component kind, kit, Owned, Installed, and Compatible. Search never invents or infers a category that GenStudio did not publish.

## 14. Shelf → Proof/detail → Owned → Install flow

### 14.1 Shelf

The shelf card shows:

- cover/hero media published by GenStudio;
- product title;
- a promise-first measurable line;
- one short transformation line;
- Free or the exact current published credit price;
- Owned/Installed state when applicable.

The shelf card does **not** lead with component count or repeat permanent ownership. It does not imply that a showcase result is generated automatically.

### 14.2 Proof/detail

The product detail shows:

- full customer outcome and editorial scope;
- signed-release version and compatibility;
- exact included component products and versions;
- owned-component discount facts from GenStudio;
- topic/assignment counts backed by the signed release;
- preview gallery/cover metadata published by GenStudio;
- **Watch example videos** when valid `showcase_videos` exist;
- dependencies and whether each is free, owned, included, installed, unavailable, withdrawn, or recalled;
- current and post-purchase balances only after an exact quote;
- publisher and changelog;
- the primary Get free, See exact quote, Owned, Install, Installed, or Update action.

### 14.3 Ownership

After a successful purchase or free claim:

- Story says **Owned in GenStudio**;
- it verifies/caches the receipt through the live public-key contract;
- it refreshes the account library;
- it does not claim local installation;
- the product remains usable offline after its verified component closure is installed.

### 14.4 Install

Install is explicit. For a kit it audits the entire exact dependency closure, preserves valid installed versions, downloads only missing owned releases, and reports exact blockers. A partial closure is not Installed.

The UI reports useful separate states:

- Owned, not installed;
- Installing dependencies;
- Installed and current;
- Installed with update available;
- Installed exact version used by projects;
- Incomplete—name the missing dependency;
- Unavailable—name compatibility, entitlement, recall, network, or verification reason.

## 15. Showcase video contract

GenStudio `1.7.0` publishes `showcase_videos` on product families in catalog, account, and receipt/entitlement surfaces. Story consumes only the live shape:

```text
showcase_videos[] = { url, title, description }
```

Rules:

- zero to twelve entries;
- server order is display order;
- every key is present; `description` may be empty;
- GenStudio canonicalizes accepted YouTube URLs to one of its published HTTPS forms;
- Story accepts absence for compatibility and fails closed on malformed entries;
- Story opens the URL through safe external-browser isolation;
- no embedded HTML, script, tracking data, autoplay, or in-app authentication is accepted;
- video links are catalog metadata, not signed pack content, ownership proof, installation evidence, or prompt input;
- catalog link edits do not change pack/release identity;
- missing videos never block ownership or installation.

The owner supplies actual video links later. Their absence is not a placeholder in the pack and does not block the ten free kits from being authored or tested.

## 16. Accessibility and responsive behavior

- Shelf controls, filters, tabs, product actions, dialogs, and video links are fully keyboard reachable.
- Tab groups use correct `tablist`, `tab`, `tabpanel`, `aria-selected`, roving focus, Home/End, and arrow-key behavior.
- Product status is expressed in text and semantics, never color alone.
- Purchase and free-claim dialogs trap focus, restore focus to the initiating control, and keep a safe close action available unless a bounded submit is actively being recorded.
- External video actions identify that they open YouTube in the default browser.
- Cover art has bounded meaningful alt text supplied as catalog metadata or is decorative when the visible title provides the same information.
- Cards and details remain readable at 320 CSS pixels; component lists wrap rather than clipping.
- Long titles, translated copy, large credit numbers, and compatibility reasons do not overflow.
- Motion respects reduced-motion preferences.
- Every claim/install outcome is announced through an appropriate live region without repeatedly announcing unchanged polling state.
- The global Content Store route never redirects to project selection merely because no project is open.

## 17. Offline, empty, and failure behavior

### 17.1 Offline

- Installed verified content and pinned projects work offline and at zero balance.
- Owned and receipt-cached information remains visible with a “last verified” qualifier.
- Discover clearly says it cannot refresh; it does not reinterpret a cache miss as an empty catalog.
- Claim, quote, purchase, restore, update, and new download actions are disabled with a network requirement.
- The immutable recovery catalog remains available even when the downloaded cache is removed.

### 17.2 Empty catalog

An authenticated GenStudio response of `{ "products": [] }` is a valid deliberately empty catalog. Story shows an honest empty shelf, not an outage message and not the project selector.

### 17.3 Distinct failures

Story preserves and explains these separately:

- missing/under-scoped key;
- incompatible Story version;
- product/release unavailable or retired;
- insufficient credits;
- quote expired/rejected;
- uncertain purchase transport using the same idempotency key;
- signing unavailable;
- ownership/account mismatch;
- download grant expiry;
- CDN/download failure;
- archive too large for Story's 50 MiB gate;
- unknown publisher key or invalid signature;
- hash, namespace, schema, asset, dependency, or archive safety failure;
- exact dependency not owned or not published;
- withdrawn release, which remains owner-downloadable;
- recalled release, which is terminal for that version and returns `410 release_recalled` with reason/time evidence;
- disk, staging, atomic activation, or local verification failure.

No failure automatically purchases, retries a paid action under a new identity, substitutes a different component version, or changes an existing project pin.

## 18. Legacy grandfathering and project safety

1. Every project created before signed-catalog adoption continues resolving its existing legacy IDs and behavior.
2. Existing user `.niches`, `.topic-packs`, and `.thumbnail-templates` remain user content and become explicit forks only when edited through the migration path.
3. Claiming or installing a Starter Kit does not alter an existing project.
4. A customer explicitly upgrades a project from a legacy alias to an exact signed component set after reviewing the change.
5. Prompt-relevant Formula, Topic, Style, and Recipe facts have migration golden tests.
6. Current legacy content remains usable; paid products must be materially expanded or improved.
7. Content that becomes one of the ten free signed components remains permanently free.
8. Retiring a listing hides it from new selection but does not break existing ownership or pins.
9. Recalled dangerous bytes are the sole emergency exception: the app preserves project evidence, blocks affected generation, and offers the newest safe owned release without silently rewriting pins.
10. Legacy aliases remain until inventory proves no persisted project, preset, artifact, job, or import path requires them.

## 19. Production signing and trust separation

The launch uses three distinct trust domains:

1. **Content publisher signature:** Story's pinned first-party Ed25519 public key verifies `.sspack` bytes.
2. **GenStudio commerce signature:** GenStudio's live public-key keyring verifies quote/receipt/restore/download payloads.
3. **Transport grant:** GenStudio's short-lived signed download grant authorizes immutable archive transfer.

They are never substituted for one another.

Production rules:

- the content publisher private key is generated and retained outside every repository, application bundle, worktree, log, and handoff;
- Story ships only the matching public PEM and stable key ID in its first-party trust ring;
- the free-recovery test key is never accepted as a production catalog key;
- pack authoring may use ephemeral test keys, but production artifacts are rebuilt once under the production key and receive immutable hashes;
- GenStudio publishes/records the exact archive SHA-256 and byte count and refuses publication above 52,428,800 bytes;
- Story independently validates the final downloaded archive and its dependency closure;
- key rotation adds a new trusted public key in an app release before new packs use it; old required keys remain while installed/pinned content needs them;
- no production archive is signed until its source, version, release minimum, and component mapping pass independent review.

The exact first-party content key ID and public PEM are a release-operations input, not something this design invents. Artifact production remains gated until the owner-controlled key exists and its public half is registered in Story's trust ring.

## 20. GenStudio ownership and live contract

GenStudio owns:

- product families, kinds, copy, retirement, successors, and current releases;
- authoritative free/credit pricing;
- bundle component values and owned-component discounts;
- quotes, idempotent purchase, ledger, permanent entitlements, and signed receipts;
- content account identity across API-key rotation;
- release storage, exact owned-release lookup, withdrawal, recall, and download grants;
- commerce public-key history;
- catalog showcase-video metadata;
- future catalog cover/shelf merchandising metadata.

Story owns:

- strict response parsing and preservation of signed bytes;
- Store, proof/detail, Owned, Installed, and Updates UI;
- local receipt cache and offline state;
- pack publisher trust ring;
- signed archive and raster validation;
- dependency closure installation, activation, rollback, disable, and uninstall guards;
- exact project pins, provenance, compatibility, and explicit upgrade/rollback;
- legacy migration and recovery catalog.

Live contracts already available and safe to adopt include:

- `showcase_videos` from GenStudio `1.7.0`;
- 50 MiB publication gate;
- commerce keyring history through `GET /v1/content/public-key` `keys[]`;
- exact owned release listing at `GET /v1/content/entitlements/{entitlement_family}/releases`;
- exact-version download requests by `{ entitlement_family, version }`;
- owner access to withdrawn releases;
- terminal recalled release behavior from GenStudio `1.9.0`.

## 21. Required GenStudio handoff before stocking

Story must not invent the remaining server contract. A field-exact GenStudio handoff is required for:

1. **Bundle grant semantics:** confirm that a zero-price or paid `niche_bundle` purchase atomically grants the kit family and every included component entitlement family, returns all of them in signed `entitlement_families`, and does not duplicate already-owned component entitlements.
2. **Bundle release composition:** confirm how a `niche_bundle` product release names its signed bundle-only coordination archive and exact component releases. The answer must preserve GenStudio's existing `current_release` and Story's immutable dependency identities rather than adding client-guessed fields.
3. **Owned-component quote calculation:** confirm that component credit value and `owned_components` are computed by entitlement family and that a shared component owned through any earlier kit receives the same discount.
4. **Free bundle behavior:** confirm zero-price quote/purchase and insufficient-credit independence for a customer with zero credits.
5. **Catalog shelves/order:** publish operator-managed collection/placement/order metadata so Story does not hardcode Free Starter Kits, Specialist Kits, Topic Expansions, Production Looks, or Premium Collections. Exact names, bounds, and response locations must come from GenStudio.
6. **Shelf cover media:** publish safe catalog cover/hero metadata and alt text or a documented derivation policy. Pack-internal preview assets cannot be downloaded before entitlement and must not be exposed by guessed URLs.
7. **Product detail completeness:** confirm whether the existing product list is the detail source or provide an exact authenticated detail endpoint; Story must not manufacture missing license, media, or release facts.
8. **License display:** publish the authoritative customer-facing license label/text or a stable operator-managed license reference for each product. The pack archive does not currently contain a commercial license contract, and Story must not invent one.
9. **Operator discount quote semantics:** for Archival Ledger, confirm the field-exact signed facts for the 2,000-credit list price, owned-component deductions, the operator discount identity/percentage and optional end date, and the final server-calculated amount. The discount applies to every customer after the owned-component deduction; no eligibility, account-history, first-purchase, or discount-refusal fields are required. Story renders these facts without local calculation or eligibility checks. Final wire names must come from GenStudio's deployed reply.

Until those answers are live, Story may implement local fixtures and UI states, but production stocking remains blocked. This is a cross-app contract gate, not an unresolved owner product decision.

## 22. Migration and release order

1. **Freeze the baseline.** Record all 21 Formula/niche configs, 26 Topic Packs, 17 styles, 6 recipes, effective loader decoration, previews, aliases, and representative prompt outputs.
2. **Obtain GenStudio bundle/merchandising contract.** Resolve section 21 without client guesses.
3. **Ship Story schema support.** Add bundle-only coordination manifests, exact dependency resolution using the live owned-release endpoint, recall handling, and publisher public key.
4. **Ship the approved Store journey.** Add catalog-published shelves, proof/detail, showcase videos, Owned, Installed, Updates, and accessible responsive states.
5. **Author component sources.** Create the ten Formula editions, ten full Topic Packs, nine distinct styles, seven distinct recipes, and ten coordination manifests from the exact identities in this specification.
6. **Review content independently.** Require schema, originality/coverage, compatibility, prompt-equivalence, visual, thumbnail, safety, copy, and commercial-boundary review.
7. **Build with test trust.** Produce deterministic candidate archives under ephemeral test keys; retain no private test key or distributable artifact after qualification.
8. **Bind the release minimum.** Set every production archive's `min_app_version` to the released Story version that contains its schema interpreter and publisher key.
9. **Sign production artifacts externally.** Build and validate immutable production archives with the owner-controlled content key, recording version, SHA-256, bytes, component summary, and changelog.
10. **Create GenStudio drafts.** Create component families/releases, ten zero-price kit products, exact bundle composition, catalog shelves, and Archival Ledger at the owner-approved live price.
11. **Cross-app qualification.** Use local/mock financial tests first, then the authorized GenStudio release qualification flow. No real purchase or customer credit mutation occurs without explicit owner authority.
12. **Publish compatibly.** Release Story with trust/schema/UI support before GenStudio exposes products whose `min_story_version` requires it.
13. **Stock free kits first.** Verify claim, restore, shared ownership, install, offline use, update, and key rotation.
14. **Stock Archival Ledger.** Publish only after componentized conversion, the 500+ gate, final production signature, and catalog proof/detail review. Showcase links can be added later without changing release identity.
15. **Add paid expansions in reviewed waves.** Never batch-publish unreviewed conversions solely because their legacy files exist.

## 23. Acceptance criteria

### 23.1 Contract and security

- All pack, item, bundle, family, and SKU IDs match section 5 and are unique.
- Every launch release uses exact version `1.0.0` and immutable bytes.
- Bundle-only manifests validate only under the narrow coordination-pack rules.
- Normal component manifests cannot use empty items/files.
- Unknown keys, invalid signatures, namespace violations, undeclared files, unsafe archives, corrupt assets, and incompatible schemas fail closed.
- No private key, credential, account ID, provider/model routing, executable content, or arbitrary URL appears in a pack.
- Every final archive is at or below 52,428,800 bytes and matches GenStudio's recorded digest/size.

### 23.2 Catalog and ownership

- Discover shows exactly ten Free Starter Kit products in catalog-published order.
- Each advertises and contains the exact Formula, full Topic Pack, Style, and Recipe in sections 7–9.
- Every free claim charges zero credits and grants permanent kit/component families atomically.
- Claiming all ten grants each shared component family once.
- A repeated claim/purchase reuses idempotent evidence and never creates a second debit or ownership mutation.
- Paid bundle quotes remove already-owned paid component value using GenStudio facts, then apply any active operator discount to the remaining amount using GenStudio's signed quote facts.
- Archival Ledger's approved 90% operator discount applies to every customer through its optional 2026-12-31 end date; Story performs no eligibility or account-history check and never calculates the final amount.
- Story never displays a hardcoded paid price.
- Same-account API-key rotation restores identical ownership.
- Switching generation to another account does not delete installed packs or break pins.

### 23.3 Installation and lifecycle

- Kit Installed requires the complete exact dependency closure.
- Missing dependencies are fetched by owned family + exact version, not by “current” substitution.
- Withdrawn owned versions remain installable.
- Recalled versions stop with terminal recall evidence and no blind retry.
- Valid already-installed components are preserved and not downloaded twice.
- A failed dependency leaves the previously active content untouched.
- Owned content works offline and at zero credits after installation.
- Updates never change an existing project until explicit project upgrade.

### 23.4 Content quality

- Formula golden tests prove effective legacy parity where the launch edition claims continuity.
- The seven migrated starter Topic Packs contain enriched episode objects, scopes, mechanisms, evidence lenses, exclusions, and compatibility—not only copied subjects.
- Everyday Calm, Habits & Momentum, and Night Journeys each contain exactly 15 reviewed subjects and complete structured axes.
- Advertised counts are derived from signed content and pass deterministic offline coverage tests.
- Every Style and Recipe has at least one decoded, accurate, original preview.
- New recipes use only supported layout primitives.
- Archival Ledger independently proves at least 500 materially distinct assignments.

### 23.5 Experience

- A customer can complete Shelf → Proof/detail → Owned → Install/Installed without opening a project.
- Content Store navigation never falls back to project selection.
- Shelf cards are promise-first and do not lead with component count/permanent copy.
- Valid showcase videos render in the published order and open safely in the default browser.
- Missing/invalid showcase data does not block the product.
- Offline, empty, scope, compatibility, quote, insufficient-credit, uncertain, signing, download, recall, verification, disk, and partial-install states are distinct and actionable.
- Keyboard, focus, semantic status, narrow-screen, long-copy, large-number, and reduced-motion checks pass in the rendered app.

### 23.6 Legacy safety

- Representative existing projects render the same effective Formula, Topic, Style, Recipe, and prompt facts before explicit migration.
- Legacy IDs and user forks remain readable.
- Claiming/installing a kit does not alter existing project pins.
- No unchanged legacy built-in is republished as paid merchandise.

## 24. Completion boundary

The launch catalog is ready to publish only when:

1. the bundle-only Story schema and exact GenStudio grant contract agree;
2. the Store journey and catalog merchandising fields are live;
3. all ten free coordination releases and their component closures pass independent review;
4. the production public key is shipped and the private key remains externally controlled;
5. GenStudio drafts match exact IDs, hashes, sizes, versions, compatibility, prices, and zero-price grants;
6. cross-app qualification proves ownership, shared components, installation, offline use, and legacy safety;
7. the owner explicitly authorizes publication.

Until then, authoring, local testing, review, and draft catalog preparation may continue safely. No paid generation, real purchase, publication, deployment, or fleet work is implied by this specification.
