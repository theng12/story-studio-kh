# Store consistency audit — 2026-09-08

Every authored Content Pack in this repository, checked against what the Content
Store actually sells, then made consistent. Written the day of the audit,
after the fixes, against the live shelf.

**The rules it was checked against**, all owner rulings, none invented here:

- every pack is **300 credits**;
- every pack carries **90% off for one year from its own stocking day**, and the
  anniversary day itself is discounted because the store's window dates are
  inclusive (ruling 2026-08-28);
- the discount records a reason;
- **no Channel Kits.** The eleven on the shelf are legacy: not repriced, not
  realigned, not withdrawn — reported below and otherwise untouched;
- names describe content.

Owner rulings that this audit exists to close, verbatim, 2026-09-08:

> *"as for the chinese ink wash, make it 90% discount too. it was a mistake or oversight."*
>
> *"as for the pastel surreal psychological collage, we need to sell it. oversight. i think i
> keep forgetting about the stuff i asked to stock and you keep thinking i deliberately left
> it. no, i want to sell it all. i want consistent pricing with no future decision to make.
> as it's been decided."*
>
> *"do remember to always check and cleanup old stuff that's not consistent or tell me about
> it when you find it. i can decide it if there's no precedent."*

## Counts

| | Before | After |
| --- | --- | --- |
| Authored non-kit packs (highest version each) | 144 | 144 |
| …with a product on the shelf | 121 | **144** |
| …whose latest authored version is published | 108 | **144** |
| …at 300 credits | 121 of 121 | **144 of 144** |
| …carrying a 90% discount | 120 of 121 | **144 of 144** |
| …whose discount runs to its own anniversary | 43 of 121 | **144 of 144** |
| Products on the shelf with no source pack (orphans) | 0 | 0 |
| Channel Kit products (untouched) | 11 | 11 |

**144 packs audited, 103 products changed, 3 items with no precedent.**

The 103 distinct products are: 23 created and stocked from packs that had never
been sold, 13 existing products given the newer release they were already
authored for (11 of those 13 also had their discount realigned), 77 discount
windows moved onto the anniversary rule, and 1 discount created where there had
been none.

## What was wrong, and what was done

### 1. `chinese-ink-wash-storytelling` was the one product on the shelf at list price

It had **no discount at all** — 300 credits to a shopper, where every sibling
was 30 — because the stocking policy carried a standing per-family exemption
for it. The owner ruled that an oversight.

- Discount created: 90%, **2026-09-08 → 2027-09-08 inclusive**, one year from
  today rather than from its 2026-09-02 stocking day, because today is the day
  the offer was decided. Product `cprod_b27fa76906f14b94987a0729e1a09f7d`,
  discount `cdsc_269f3dfbaf034841bf0129fd4244602e`, reason quoting the ruling.
  Applied with `stock_pack` over the pack's existing 1.0.1 artifact, so the
  same code path that stocks anything else created it. The stocker records its
  reason on the discount row rather than in the platform audit log — it creates
  discounts, it does not edit live ones — which is why the 36 stockings below
  carry no audit event id and the 77 realignments do.
- The exemption was removed from **four** places, because leaving any one of
  them would have put it back: the committed policy file, `DEFAULT_POLICY` in
  `app/tools/stock_pack.py` (what a recreated policy file would carry), the
  runbook's worked example, and the test that asserted it existed.
  **No product is exempt from the standing discount any more.**

This is also why the realignment tool below *refuses* this one product: its own
anniversary would be 2027-09-02, six days earlier than what the shelf now
promises, and shortening a live offer is not an alignment.

### 2. 77 products still carried the pinned `2026-12-31` launch window

The anniversary rule replaced a pinned end date on 2026-08-28. `stock_pack`
applies it only to a discount it *creates* — an existing discount is left
exactly as it is, deliberately — so every pack stocked before that day kept the
old window and drifted a year behind the rule. The stocking record of
2026-09-08 counted 21 of these among the styles it touched; across the whole
shelf there were 77 non-kit products plus the 11 kits.

Each was extended to one year from **its own** stocking day, read from
`content_products.created_at` on the store's business calendar
(Asia/Phnom_Penh) — the same source the store quotes from:

| Original stocking day | Products | New end date |
| --- | --- | --- |
| 2026-08-16 | 44 | 2027-08-16 |
| 2026-08-23 | 6 | 2027-08-23 |
| 2026-08-24 | 5 | 2027-08-24 |
| 2026-08-25 | 16 | 2027-08-25 |
| 2026-08-28 | 6 | 2027-08-28 |

Every stocking day was established from the shelf itself; none had to fall back
to "today + 1 year". Full per-product table in section B below.

### 3. 36 authored packs were not being sold, or were being sold stale

23 packs had **no product at all** — authored, registry-approved, never
shipped. 13 more had a **newer authored version than the store's latest
published release**. Both were shipped and stocked by the documented route:
`npm run content-pack:ship` per pack into
`~/Developer/_handoffs/artifacts/store-audit-2026-09-08`, then
`python -m app.tools.stock_pack` — dry run, then writing mode, both exit 0,
zero problems across all 36. Each new product: 300 credits, 90% to 2027-09-08.

`pastel-surreal-psychological-collage` was **verified rather than fixed**: it
was stocked earlier today as a new product and is complete — 300 credits, 1.0.2
published, 90% to 2027-09-08, 30 credits to a shopper.

### 4. Prices

No non-kit product was at anything other than 300 credits, before or after.
Nothing to correct.

### 5. Orphans

**None.** Every product on the shelf traces to a pack source in this
repository. The six `paid/lettering/*` products that look orphaned against the
*item* index are not: a lettering pack ships one product per theme directory
(arcade, archive, calm, dread, explainer, investigation) holding many lettering
items, and the item index lists the items.

## No precedent — for the owner to decide

Three things were found and deliberately **not** changed.

1. **The eleven Channel Kits.** All `active`, all **1200 credits**, all still on
   the pinned **90% to 2026-12-31** window, and ten of the eleven are selling a
   release older than their latest authored version. The ruling is *"no channel
   kit at all or anymore"*, which says the line is closed — it does not say
   whether the ones already sold should keep selling, be realigned to the
   anniversary rule like everything else, or be retired. Left exactly as found.
   A twelfth kit, `symbolic-psychology-studio` 1.0.0, is authored but has never
   been on the shelf; its 1.0.1 is `withdrawn` in the registry.

2. **`content-packs/archival-ledger`** — a pre-split monolithic pack source
   (`com.storystudio.pack.archival-ledger`, 1.0.0) with **no record in the
   authoring registry**, so nothing can ship it. Its content is on the shelf
   already through the six `paid/archival-ledger/*` packs that replaced it. It
   looks like a leftover source folder that should be deleted, but deleting
   authored source is a decision, and the registry belongs to another lane.

3. **`chinese-ink-wash-storytelling` now ends six days after its own
   anniversary** (2027-09-08 rather than 2027-09-02), because its discount was
   decided today rather than on its stocking day. Consistent with the ruling,
   inconsistent with the arithmetic every other product follows. Left as ruled;
   say the word and it moves to 2027-09-02.

## How it was fixed

| Change | Route |
| --- | --- |
| Chinese ink-wash discount created | `python -m app.tools.stock_pack` over the existing 1.0.1 artifact |
| Exemption removed from the policy and the code | genstudiokh [PR #110](https://github.com/theng12/genstudiokh/pull/110) |
| 77 discount windows realigned | `apps/cloud-api/scripts/realign_pack_discounts.py`, new in PR #110 |
| 36 packs shipped | `npm run content-pack:ship` → `~/Developer/_handoffs/artifacts/store-audit-2026-09-08` |
| 36 packs stocked | `python -m app.tools.stock_pack` |

The realignment script exists because there was no operator route for changing
an **existing** discount: `stock_pack` refuses to on purpose, and the admin
route is cookie-session-only. It computes each product's anniversary through
`stock_pack`'s own `discount_for`, so the two cannot disagree about a year, a
leap day, or a percentage, and it restates the discount through
`ContentStoreService.update_discount` — the same call the console's
`PATCH /discounts/{id}` makes, version bump included — writing the same audit
action and shape plus the previous end date. It refuses to shorten a window, to
touch a kit, or to change a percentage. 8 tests, all passing.

**No app code was changed and the service was not restarted.** Every write went
through the same service object the admin routes construct; the running API
reads the shelf from the database.

## Verification

Independent read-only SQL over the live database, after the fixes, grouped by
product kind — counting rows that disagree with each rule:

```
       kind       | products | not_active | not_300 | no_discount | not_90 | has_start | no_reason | off_anniversary
------------------+----------+------------+---------+-------------+--------+-----------+-----------+-----------------
 font_pack        |       17 |          0 |       0 |           0 |      0 |         0 |         0 |               0
 niche_bundle     |       11 |          0 |      11 |           0 |      0 |         0 |         0 |              11
 series_formula   |       24 |          0 |       0 |           0 |      0 |         0 |         0 |               0
 thumbnail_recipe |       30 |          0 |       0 |           0 |      0 |         0 |         0 |               0
 topic_pack       |       40 |          0 |       0 |           0 |      0 |         0 |         0 |               0
 visual_style     |       33 |          0 |       0 |           0 |      0 |         0 |         0 |               1
```

**Zero non-kit rows off-rule**, with two expected exceptions, both listed above:
the 11 `niche_bundle` rows are the Channel Kits, untouched by ruling, and the
one `visual_style` row is chinese ink-wash's 2027-09-08.

Separately, all 144 non-kit packs were re-joined to the shelf from their
`pack.json` sources: every one has a product, that product is `active`, and the
highest authored version is `published`. Zero off-rule. Zero orphans.

`stock_pack`'s own shopper check ran on all 36 stocked packs, reading the shelf
back through the customer-facing catalogue: *"300 credits, less 90% (270
credits) = 30 credits."*

## Every change made

### A. Shipped and stocked by this audit — 36 packs

Every product 300 credits, `active`, its release `published`. The 13 that
reused an existing product also had that product's discount window realigned
in section B, so the end date shown is the live one after both changes.

| pack id | ver | product | new or reused | release | discount ends |
| --- | --- | --- | --- | --- | --- |
| `com.storystudio.pack.formula.build-under-constraints` | 1.0.0 | `cprod_027e94246232448eb1c382686f9e1992` | **new product** | `crel_734330f0c76340ea83c019f0ffeef5f6` | 2027-09-08 |
| `com.storystudio.pack.formula.counted-explainer` | 1.0.0 | `cprod_a4cb21cbeb4948d8a86071e6c9cb82ed` | **new product** | `crel_f645deb991d843119ba487c2906da545` | 2027-09-08 |
| `com.storystudio.pack.formula.history-explained` | 1.0.2 | `cprod_4eee184f89a94db782c908b1ac41fc8a` | reused | `crel_07bb2749f54346fcb7c3ee4f118d4450` | 2027-08-16 |
| `com.storystudio.pack.formula.pastoral-scripture` | 1.0.0 | `cprod_4e6cec2c630540729e4736a3a10d74e2` | **new product** | `crel_cb0e47480b664c25b10070e10cd5615e` | 2027-09-08 |
| `com.storystudio.pack.formula.philosophy-real-problem` | 1.0.0 | `cprod_f0410b692ab54b0593aeb4db89b1edb8` | **new product** | `crel_6c87d599f2e14a21afad31b98cd4009f` | 2027-09-08 |
| `com.storystudio.pack.formula.prayer` | 1.0.0 | `cprod_034c5212e9184076bb42d13531157bc1` | **new product** | `crel_dc6c7d28d4e342daaa4285d5cf3aedda` | 2027-09-08 |
| `com.storystudio.pack.metadata-formula.editorial` | 1.0.0 | `cprod_a79fd6803b0a4d3681a027040af11a00` | **new product** | `crel_a509be428d6442be902e0f4ef9e514b0` | 2027-09-08 |
| `com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split` | 1.0.1 | `cprod_95494d261a4a4e30ab18a8cedac7f36f` | reused | `crel_c94eb0a80bb142b8bee5fdccfb17c14f` | 2027-08-24 |
| `com.storystudio.pack.thumbnail.object-hero-question` | 1.0.0 | `cprod_a8b810ff71104cf699af9cf4e7215138` | **new product** | `crel_f1e3f3ed048a438289c5dc9c9b98adae` | 2027-09-08 |
| `com.storystudio.pack.thumbnail.route-map-one-promise` | 1.0.0 | `cprod_bcccf59bdadc4d02a7695903352479ac` | **new product** | `crel_2b954cbc906244158b086290f332b4ad` | 2027-09-08 |
| `com.storystudio.pack.topic.ancient-humans-environments` | 1.0.0 | `cprod_0f4943d455364a8e8501d52fee721484` | **new product** | `crel_656681e670804b2c9d0d929d948a212d` | 2027-09-08 |
| `com.storystudio.pack.topic.ancient-humans-social-life` | 1.0.0 | `cprod_cc1aa51722ff4753838502caeaa64e67` | **new product** | `crel_079439d452804c01ba72bc160c56a6af` | 2027-09-08 |
| `com.storystudio.pack.topic.ancient-humans-survival` | 1.0.1 | `cprod_491f8585c1df47f79edb4c041482512e` | reused | `crel_9d8884b07466479fa1e696fbda7ad836` | 2027-08-16 |
| `com.storystudio.pack.topic.ancient-humans-technology` | 1.0.0 | `cprod_67a72ebc2bc74de6817e39fa71328953` | **new product** | `crel_68d986f0918f4148bebf1f26815bc550` | 2027-09-08 |
| `com.storystudio.pack.topic.audience-question-seeder` | 1.0.1 | `cprod_490d832a953341109923a614122a994b` | reused | `crel_bcf067625dbe49c49a921f5110dad26c` | 2027-08-24 |
| `com.storystudio.pack.topic.deep-time-earth-systems` | 1.0.1 | `cprod_92125271a79d46b4a4b79512124899b9` | reused | `crel_ad201791db09435ea567c317ac7b8656` | 2027-08-16 |
| `com.storystudio.pack.topic.deep-time-field-record.ancient-oceans-deep-sea` | 1.0.0 | `cprod_7f6996177ad94915907efc038ecbed21` | **new product** | `crel_10f5b68925f94167b44e7edb698b0445` | 2027-09-08 |
| `com.storystudio.pack.topic.deep-time-field-record.human-origins-ancient-worlds` | 1.0.0 | `cprod_4086c5315b3147f8857beaf904d4fbd8` | **new product** | `crel_fcf7cdea4f7c4015bd76964d72fa957b` | 2027-09-08 |
| `com.storystudio.pack.topic.deep-time-field-record.prehistoric-life-extinction` | 1.0.0 | `cprod_bcae69d363e848e880f70d8f488b6afe` | **new product** | `crel_3706add482f34820817c119d1100e160` | 2027-09-08 |
| `com.storystudio.pack.topic.deep-time-speculative-earth` | 1.0.0 | `cprod_a43f41540e884388b71e84efb1150dda` | **new product** | `crel_a4ed4719831444448a0e5cb90b29da49` | 2027-09-08 |
| `com.storystudio.pack.topic.drinks-and-spices-histories` | 1.0.1 | `cprod_1715c3a5df38495eac94a316df12399d` | reused | `crel_218bcfdba2bc4c5d93d7087f94e0f6ac` | 2027-09-06 |
| `com.storystudio.pack.topic.economics-ancient-civilizations` | 1.0.0 | `cprod_87f81b547d7740cc87eb00dee235e00a` | **new product** | `crel_47f2742b7ed04daeaab2c2b8304b0acd` | 2027-09-08 |
| `com.storystudio.pack.topic.economics-businesses` | 1.0.1 | `cprod_7386b9c6e34d4024a4fbd259ea8bea4f` | reused | `crel_aa588c6f240540ac8b77c85ea88302aa` | 2027-08-16 |
| `com.storystudio.pack.topic.everyday-calm` | 1.0.1 | `cprod_4c0a4a33e6534b8d99a0936c3857c38b` | reused | `crel_f661a80d49844558a9716611634add3e` | 2027-08-16 |
| `com.storystudio.pack.topic.everyday-object-histories` | 1.0.1 | `cprod_cac30fcc9a0d47758fa0b3e8ff67b5f2` | reused | `crel_a2ef51cd216a4321b24e61dd4be9a83e` | 2027-09-06 |
| `com.storystudio.pack.topic.habits-momentum` | 1.0.2 | `cprod_dfc44bdf2e884105a51fb02ba2c0dd6c` | reused | `crel_3ae9dd81167646188808b102ca4b2788` | 2027-08-16 |
| `com.storystudio.pack.topic.human-behavior-social-dynamics` | 1.0.1 | `cprod_b36f075973444cd78dc97d5a05c78bc7` | reused | `crel_dda8b0c2d5ed412f9ac9e88534a02081` | 2027-08-16 |
| `com.storystudio.pack.topic.natural-world-fungi` | 1.0.0 | `cprod_4587c2b1c58440dfbcfcc9fd6a7a41cc` | **new product** | `crel_0204cea273d541818b37ae1529d5d92e` | 2027-09-08 |
| `com.storystudio.pack.topic.natural-world-insects` | 1.0.0 | `cprod_5bc1df293c32474a9eb82a854c59af6e` | **new product** | `crel_ba84434111704b6b8d285c26d7304e0a` | 2027-09-08 |
| `com.storystudio.pack.topic.natural-world-plants` | 1.0.0 | `cprod_1082c847dd674364a6e6ffd610120d2e` | **new product** | `crel_82b4ff0e0bb54b07be65ae623de643d4` | 2027-09-08 |
| `com.storystudio.pack.topic.night-journeys` | 1.0.1 | `cprod_a0398fa9251f4fcd810355e0e36fbf0c` | reused | `crel_e68fd35682694e148a89eb4ded15b2ff` | 2027-08-16 |
| `com.storystudio.pack.topic.pastoral-daily-reflection` | 1.0.0 | `cprod_f4a43d5927584f9fb6003cd986757fe3` | **new product** | `crel_0297e2a8ae2c4d4283cc45380024766f` | 2027-09-08 |
| `com.storystudio.pack.topic.pastoral-expository-teaching` | 1.0.0 | `cprod_29cfda6b9df74111a5e67759f080c613` | **new product** | `crel_2436f9de95a64837ac659ec7e05cdc47` | 2027-09-08 |
| `com.storystudio.pack.topic.pov-criminal-hierarchies` | 1.0.0 | `cprod_bfba4780d95242809cd9902a5d7971a7` | **new product** | `crel_b93b86445b054418a1c0c50ba771d873` | 2027-09-08 |
| `com.storystudio.pack.topic.pov-historical-occupations` | 1.0.1 | `cprod_08d5344b8d604c2782db2b59f2c6d670` | reused | `crel_f2139e542d4c4ba7911c983e9d96bd49` | 2027-08-16 |
| `com.storystudio.pack.topic.pov-law-enforcement` | 1.0.0 | `cprod_40f9495776aa4579b4244adb196b8ce2` | **new product** | `crel_ad09170893b747c0818cc470d7d5c88b` | 2027-09-08 |

### B. Discount windows realigned — 77 products

| entitlement family | kind | product | discount | ends_on old → new | audit event |
| --- | --- | --- | --- | --- | --- |
| `com.storystudio.family.formula.ancient-humans` | series_formula | `cprod_b28ed94b0a1c404db2ee291105092e8d` | `cdsc_61743dac613149b6b8f2833d4720c4fc` | 2026-12-31 → **2027-08-16** | `audit_4a40059b8ae240e28930c9711e6fb01d` |
| `com.storystudio.family.formula.archival-ledger` | series_formula | `cprod_0ec1b31d08dd4ed7851aa7512b9a18a4` | `cdsc_7a9008b1cf8248b8ad428793ccdde55f` | 2026-12-31 → **2027-08-16** | `audit_3d0e3f6edbb541b68893be6778f3db11` |
| `com.storystudio.family.formula.before-after-timeline` | series_formula | `cprod_5c64acab02a44f3fa557ccb179043cb2` | `cdsc_aea72c22eeb5401ba55dc0d01ea6b5b1` | 2026-12-31 → **2027-08-24** | `audit_22c7a03867704772bc96a53f3b193f9c` |
| `com.storystudio.family.formula.deep-time-documentary` | series_formula | `cprod_a509220dda5541ddbce037094f8ec850` | `cdsc_cb701b81693e4726b3b08757eff58b54` | 2026-12-31 → **2027-08-16** | `audit_e3dd15f705b84ca59521bc6e3869c6af` |
| `com.storystudio.family.formula.economics-of` | series_formula | `cprod_1e0dfb4c49444bc6a5c7fd5e57b24029` | `cdsc_968762a599a9444189e4f2e0d68a71b8` | 2026-12-31 → **2027-08-16** | `audit_150d7971d60e439ab1f2c45c2ee866c9` |
| `com.storystudio.family.formula.guided-mindfulness` | series_formula | `cprod_9e9eb7e1bdf045d1a2ab1aa567453edc` | `cdsc_e7e66dca6215495d99e7d5aba9e94a8e` | 2026-12-31 → **2027-08-16** | `audit_391be6d641354efeab3aa35d17b5ebc5` |
| `com.storystudio.family.formula.history-explained` | series_formula | `cprod_4eee184f89a94db782c908b1ac41fc8a` | `cdsc_9dd922b7ee6d41eba482ed0663d6ae85` | 2026-12-31 → **2027-08-16** | `audit_70966f43d4a54d9e842bf75daf2d32e3` |
| `com.storystudio.family.formula.human-behavior-explained` | series_formula | `cprod_6f1a65a493b84f738c01382ecca63b3a` | `cdsc_702547355cab456c895d621267438ae4` | 2026-12-31 → **2027-08-16** | `audit_f72eff97130047f1961a2c812610533d` |
| `com.storystudio.family.formula.natural-world-explained` | series_formula | `cprod_7afb2627c8e84be29a89aa2b8d0e2ba9` | `cdsc_0dec4bf481ce4b179fac50990c7c993a` | 2026-12-31 → **2027-08-16** | `audit_8d3568dfd983441a9a5187c8abad857c` |
| `com.storystudio.family.formula.pov-your-life-as` | series_formula | `cprod_c66758f321234d1ea3cea15223ec9027` | `cdsc_335ffcd7d6364b64b379233e50fc41d1` | 2026-12-31 → **2027-08-16** | `audit_5e8bb941bd3245be80546e08e54d0faa` |
| `com.storystudio.family.formula.practical-motivation` | series_formula | `cprod_7e003309c99445c3960e7a07e2a5ea5c` | `cdsc_6559560b99544b49973f87f92062cd91` | 2026-12-31 → **2027-08-16** | `audit_3d05600c2d624040a4c1f6c7edc29342` |
| `com.storystudio.family.formula.question-ladder` | series_formula | `cprod_a9836a4540d44ae6bd33592d003ef2d6` | `cdsc_6b2f4f7513704bf1b76b7465cc965284` | 2026-12-31 → **2027-08-24** | `audit_a7ccb17192e24c128e16138d38dbb0d1` |
| `com.storystudio.family.formula.sleep-story` | series_formula | `cprod_55808e02905e47cdb57f3ad60131f5e1` | `cdsc_40f319529bd449c9a8e44e86a2c5e4ea` | 2026-12-31 → **2027-08-16** | `audit_fac06c99e13843859a66dfe9ba19f643` |
| `com.storystudio.family.lettering.arcade` | font_pack | `cprod_25a8fcfe937e490d8ecefcc34865dea8` | `cdsc_815de5ae6b664e9f8f8ee648eaddeda0` | 2026-12-31 → **2027-08-25** | `audit_ee747e40a1e04cc6bfc5f1552d96ef38` |
| `com.storystudio.family.lettering.archive` | font_pack | `cprod_c0dab9375f604c67adb395cecd308a6f` | `cdsc_2b7f200190dc490fbebcfc3ea1bd3e68` | 2026-12-31 → **2027-08-25** | `audit_7e0578d1085b45988de9fcb197fc2b93` |
| `com.storystudio.family.lettering.calm` | font_pack | `cprod_520bf1a552d642a2ab66856898b50ce9` | `cdsc_4118f1d547ea44b28e9aabd08c6121ad` | 2026-12-31 → **2027-08-25** | `audit_7b44bab335214536ab5fc2f0a925a734` |
| `com.storystudio.family.lettering.dread` | font_pack | `cprod_39b01efebe4844d3a6093e709e7dbf1d` | `cdsc_5adeb79e352647cb97b930b09f379eb1` | 2026-12-31 → **2027-08-25** | `audit_af60ca9b858f4ddfa120b677d8683688` |
| `com.storystudio.family.lettering.explainer` | font_pack | `cprod_840dcae8e0214fde9208ab21d2039f36` | `cdsc_76f8013b632e4654abafe3b6868e6f5f` | 2026-12-31 → **2027-08-25** | `audit_427d16f9c1234e4494126b953f58273a` |
| `com.storystudio.family.lettering.investigation` | font_pack | `cprod_cca131b544454b5e8ae6303a151b2349` | `cdsc_093da64507f54d6994fd8cf439523da5` | 2026-12-31 → **2027-08-25** | `audit_41fbfb57ccfe4e128650d9cfdedd5520` |
| `com.storystudio.family.style.anime-cel` | visual_style | `cprod_1e9dd29a5445409eb7552bb683393112` | `cdsc_6365a8f4a65845858e333495a268908d` | 2026-12-31 → **2027-08-28** | `audit_9440343cbab3460fa0a2ff81f6d3912a` |
| `com.storystudio.family.style.archival-documentary-reconstruction` | visual_style | `cprod_184046657b2c4e4f88a43c1aa2c86b7d` | `cdsc_9c759ce6121440f78a59cc23a7e96bbd` | 2026-12-31 → **2027-08-16** | `audit_8550aed4fa0c4e32a810665f6af1b042` |
| `com.storystudio.family.style.cinematic-photoreal` | visual_style | `cprod_06daabae3a224582accd02d9af70a3ed` | `cdsc_aa8b47ce8a164c859c0b2db52f71acd0` | 2026-12-31 → **2027-08-16** | `audit_6ffb8ba7b4a84ad38dab92c7b22341ed` |
| `com.storystudio.family.style.dreamlike-luminous-sleep-illustration` | visual_style | `cprod_f762d2f2d5b246d9bdd6960bef68e93e` | `cdsc_74f22d0e20c140df8c7f577b9622789a` | 2026-12-31 → **2027-08-23** | `audit_7e4ab702dc9c4848ac5d9470399bf5cc` |
| `com.storystudio.family.style.flat-vector-explainer` | visual_style | `cprod_77dbf153d5284369b5cb7b13268d0ac4` | `cdsc_cd95aee578ab429a8b96bbc507a6874c` | 2026-12-31 → **2027-08-16** | `audit_015bab1b6bb348fda9c81a79f953c61f` |
| `com.storystudio.family.style.hand-drawn-cartoon-explainer` | visual_style | `cprod_2aa3c9b767794d8c9ae4e09f3d077283` | `cdsc_bf9037343d3248fa816548b0bf6b5eb2` | 2026-12-31 → **2027-08-28** | `audit_b13e63f269374ac096fecaa1e83eb7e2` |
| `com.storystudio.family.style.hand-drawn-editorial-diagram` | visual_style | `cprod_23ad4d41a74040be910efa84d7601ba1` | `cdsc_ac0ef22ef05741f3b8cb1eca26672c6d` | 2026-12-31 → **2027-08-16** | `audit_cbdee2b3cbdb4bfd8ef36dec6a19fc27` |
| `com.storystudio.family.style.hand-drawn-hardship-cartoon` | visual_style | `cprod_231ce84183024d2f89ed92d065f97e46` | `cdsc_20b5db333b8c40e7b9d87ac6b9399195` | 2026-12-31 → **2027-08-23** | `audit_677a4626eccb4e1b955f6597f937991b` |
| `com.storystudio.family.style.impasto-psychological-animals` | visual_style | `cprod_2daf5eba149c46afafd53a4baef6ff11` | `cdsc_414363073d394157a1db18b64f63ddc8` | 2026-12-31 → **2027-08-23** | `audit_bdb5f49a9b89438dad549a53c75fb010` |
| `com.storystudio.family.style.minimal-stick-figure-explainer` | visual_style | `cprod_a98559230c12434797012b44ed3301b6` | `cdsc_ec31373dba1e4378acc7075d88536e9e` | 2026-12-31 → **2027-08-16** | `audit_77da23a84f2d4c7880af2e2b59122e2c` |
| `com.storystudio.family.style.oil-painting-classical` | visual_style | `cprod_11e4c8960fa04d49868b829de56da829` | `cdsc_58011573cc224d7a860367084e5655ca` | 2026-12-31 → **2027-08-24** | `audit_aaf621e4563049c2816947a67c7904d5` |
| `com.storystudio.family.style.paleo-documentary-tableau` | visual_style | `cprod_72fbf40a56cd4266834bc21dde21367e` | `cdsc_139044834f264480b788fba5300089d4` | 2026-12-31 → **2027-08-16** | `audit_9d025b749de54820ac5ee5b0572e9f71` |
| `com.storystudio.family.style.pixel-art-story` | visual_style | `cprod_16dd44fa5bf1420b8559265d3fcd80b3` | `cdsc_789427d9d30e4ad1a849ac94049b1156` | 2026-12-31 → **2027-08-28** | `audit_bb306b79e6d54e54a6042a54dfe291cf` |
| `com.storystudio.family.style.prehistoric-stick-cartoon` | visual_style | `cprod_accd0e12a8794f45aa98c473b7911980` | `cdsc_7cbe6acdc4464e12a0e0131a434b09a7` | 2026-12-31 → **2027-08-16** | `audit_604adaeeb0a14a2bb423720afa40d388` |
| `com.storystudio.family.style.retro-paint-fantasy` | visual_style | `cprod_38d545e590b6401e86c92500a936af1c` | `cdsc_e01d7148d77e471b92efb6619ce1a1da` | 2026-12-31 → **2027-08-28** | `audit_b8e0eb3248294425a5d4e376c8e6353f` |
| `com.storystudio.family.style.sepia-ink-wash` | visual_style | `cprod_099be2d6bf3a4bff9de0812c13f50b3a` | `cdsc_3d6739293bfb4a289d703b4d7bb26e1a` | 2026-12-31 → **2027-08-16** | `audit_70df2302702244b8ab53cfe7c963ebad` |
| `com.storystudio.family.style.studio-catalog-realism` | visual_style | `cprod_658ec85d3e8345f5969893b0cbf8e35f` | `cdsc_a3b1dcf0b86d4dc59974bf09055277bb` | 2026-12-31 → **2027-08-28** | `audit_7af3fe49a0084fdc8c9a80866dd7b3bd` |
| `com.storystudio.family.style.watercolor-storybook` | visual_style | `cprod_512fd6202336415aaa1fc1a8f0ea279c` | `cdsc_47aef76591d44730bbaa6c9bfcc6181e` | 2026-12-31 → **2027-08-16** | `audit_a51489ed4ec846028298dadeb3df3373` |
| `com.storystudio.family.style.waxy-outline-cartoon` | visual_style | `cprod_4dd1173ee1d54869a1627c8769c0e2e0` | `cdsc_9cd8e851bdec482d96118a5c3580e340` | 2026-12-31 → **2027-08-16** | `audit_f614f64cd2fd492d8a73c5c8466839f5` |
| `com.storystudio.family.style.whiteboard-doodle-explainer` | visual_style | `cprod_8d8b670523634c3dbff1f806fa47a74d` | `cdsc_a43611d4edc64778b57487f38924439c` | 2026-12-31 → **2027-08-28** | `audit_009814199cfc4e58a936d0343a769405` |
| `com.storystudio.family.thumbnail.animal-hardship-annotation` | thumbnail_recipe | `cprod_ff4372cebc0f413798a76d8fb4257545` | `cdsc_3badd4ef10de4a3e9c71d4f23203fccc` | 2026-12-31 → **2027-08-23** | `audit_ea50f48c78384fe2acfe9f2e6f2c8fff` |
| `com.storystudio.family.thumbnail.annotated-business-board` | thumbnail_recipe | `cprod_17e76a7a71b14449ad9588b64225f80f` | `cdsc_5dc7dcb3b7c34ca894994f7cc43c225a` | 2026-12-31 → **2027-08-16** | `audit_a331973d81c54f65a3f57ecbde676680` |
| `com.storystudio.family.thumbnail.archival-map-investigation` | thumbnail_recipe | `cprod_1774acd1762b4b06a953643b0933e898` | `cdsc_5edeefff17a848309e6f13481228c7ae` | 2026-12-31 → **2027-08-16** | `audit_24d5cc261a814697a78f5cf41f29f32f` |
| `com.storystudio.family.thumbnail.before-after-proof-panel` | thumbnail_recipe | `cprod_6232c0d2a0d94dc98868d070a091a78e` | `cdsc_6bb90f8f2df44e5b81a20c3f2cc2f30f` | 2026-12-31 → **2027-08-25** | `audit_5c66c705cafc41908bd4bf3b89eb600f` |
| `com.storystudio.family.thumbnail.centered-hero-headline` | thumbnail_recipe | `cprod_e23dadf042e748a380fd830eb9a4b1f2` | `cdsc_a286eae493f743038222ef1d47c7bf63` | 2026-12-31 → **2027-08-16** | `audit_dc7364a333df49a293352bef0f192081` |
| `com.storystudio.family.thumbnail.curiosity-question-cartoon` | thumbnail_recipe | `cprod_8e40081fc0d54865a3624550c53762eb` | `cdsc_6f8547a278ef45a583eabf8312eacea9` | 2026-12-31 → **2027-08-16** | `audit_f8135fd5938c4bde9e85a7a95d38058c` |
| `com.storystudio.family.thumbnail.cutaway-exploded-object` | thumbnail_recipe | `cprod_70b6d950de2a41c091d14d92868e8c87` | `cdsc_354fd3c6efae4c3882dc6c646763c6ff` | 2026-12-31 → **2027-08-25** | `audit_064e1f4639c64caab72d5343c101ecd3` |
| `com.storystudio.family.thumbnail.documentary-label-tableau` | thumbnail_recipe | `cprod_c5c46a8825b248c1bee2305d009d668b` | `cdsc_b03231d2b8a54f2c94fc582b8f05d006` | 2026-12-31 → **2027-08-16** | `audit_a6e9943dfa37413f85d52c2a25fe8e1c` |
| `com.storystudio.family.thumbnail.dreamlike-story-title-card` | thumbnail_recipe | `cprod_7ea218904b6448fc8d4eed8c50d3916c` | `cdsc_b9fe96e479d94e548cc45301c2cc25eb` | 2026-12-31 → **2027-08-23** | `audit_c4f8a265ce6242c88ab903675e749f05` |
| `com.storystudio.family.thumbnail.dreamscape-story-window` | thumbnail_recipe | `cprod_f073183bf5a64581aadde1bad3c4f7a3` | `cdsc_1251d22bccd44c1bbc1c14b5f9f81eb8` | 2026-12-31 → **2027-08-16** | `audit_469c0127f77b40abb043cd785a991152` |
| `com.storystudio.family.thumbnail.editorial-psychology-symbolic-split` | thumbnail_recipe | `cprod_95494d261a4a4e30ab18a8cedac7f36f` | `cdsc_473c8033a8e349df97494de12fa2d3b3` | 2026-12-31 → **2027-08-24** | `audit_c7673004a65343ee92c30a8b4e855438` |
| `com.storystudio.family.thumbnail.hands-on-pov-moment` | thumbnail_recipe | `cprod_e7b74c230bb64d54a888ca040e8bd86c` | `cdsc_cc42c0382b074e6c8c0eaff0520177a8` | 2026-12-31 → **2027-08-25** | `audit_b61e0c97638a4b7c9a6e97307fe7577e` |
| `com.storystudio.family.thumbnail.hero-payoff-companion` | thumbnail_recipe | `cprod_ce8b52c298a84046bd977544ca3a6e16` | `cdsc_ff63fc62ecd1429b883240e7b307f37a` | 2026-12-31 → **2027-08-25** | `audit_b59cbb9c360d479093043994b6b594e9` |
| `com.storystudio.family.thumbnail.iconic-result-closeup` | thumbnail_recipe | `cprod_3d2e5544b62c426eb45d4d61a0b3cddb` | `cdsc_885fe02ea04f4aba935a71a7bfa18f71` | 2026-12-31 → **2027-08-25** | `audit_e97dc9e75c874421ba4802b680e83dc6` |
| `com.storystudio.family.thumbnail.macro-mystery-detail` | thumbnail_recipe | `cprod_e4c696363e4b432188ed030e615bbf7c` | `cdsc_7be4d6306a734d4280d1b3d755c81c48` | 2026-12-31 → **2027-08-25** | `audit_3774dc538ffd4b5f9aa8f0f2b8ef209a` |
| `com.storystudio.family.thumbnail.numbered-lineup` | thumbnail_recipe | `cprod_c2f17e04f2f04f93860b929c6b907184` | `cdsc_7547c935fa1b4964940ca978e4292343` | 2026-12-31 → **2027-08-25** | `audit_c1458e104e48438ca36bea88e279306a` |
| `com.storystudio.family.thumbnail.portrait-block-right` | thumbnail_recipe | `cprod_9de0828f2b4747898ef6c617fa3678b3` | `cdsc_84063c2744894a8b9efbd9b0f97e7366` | 2026-12-31 → **2027-08-16** | `audit_6f8d1b4d541f49f1baedc5ebd96f3275` |
| `com.storystudio.family.thumbnail.prehistoric-discovery` | thumbnail_recipe | `cprod_a2ad704a7c454d7aa03400045cf5576f` | `cdsc_8086398ec0184740bbf559d6c13874be` | 2026-12-31 → **2027-08-16** | `audit_52a1f413ee9040408e3678e468a230fc` |
| `com.storystudio.family.thumbnail.prehistoric-survival-title-card` | thumbnail_recipe | `cprod_28707e237b434512ab22d615d61a30de` | `cdsc_e583f8dedc444b6dafcacf63e70bc943` | 2026-12-31 → **2027-08-23** | `audit_66d7c09ac5454259b543c796ef6a895b` |
| `com.storystudio.family.thumbnail.reaction-evidence-inset` | thumbnail_recipe | `cprod_a06f6560ba554b5e9f51870a948e9836` | `cdsc_4762f59acf9d44df982b63a4b7b33345` | 2026-12-31 → **2027-08-25** | `audit_96f54d9599f448e0af2e4b09cd4249e2` |
| `com.storystudio.family.thumbnail.scale-journey` | thumbnail_recipe | `cprod_2b76af88a5a545e6a809d8f748b442fa` | `cdsc_363eb4bca6d741ef940f6c06c456b8c9` | 2026-12-31 → **2027-08-25** | `audit_0f7101173e264b749c48064ce639da42` |
| `com.storystudio.family.thumbnail.two-option-criteria-split` | thumbnail_recipe | `cprod_56df6fde8353484895fa82a2aaef3caf` | `cdsc_ebab09eae4e6481a8b256059acf9260a` | 2026-12-31 → **2027-08-25** | `audit_b4fefbfe823f4aedaf61852840cc0e53` |
| `com.storystudio.family.topic.ancient-humans-survival` | topic_pack | `cprod_491f8585c1df47f79edb4c041482512e` | `cdsc_032df9355e8e4040a119bf3982164a06` | 2026-12-31 → **2027-08-16** | `audit_a3cb8a16bafd44f9b3268283dacc9bbe` |
| `com.storystudio.family.topic.archival-ledger.empires-trade-extraction` | topic_pack | `cprod_ea6724d6902e486782086e744edc0d66` | `cdsc_42bd864ade534f00a1ca54e75181cf29` | 2026-12-31 → **2027-08-16** | `audit_6b2033f0584f4579954291abc23edc5e` |
| `com.storystudio.family.topic.archival-ledger.infrastructure-commodities-corporate-power` | topic_pack | `cprod_41ac8a84fc2e44ddb0b8b74e2d17b0f1` | `cdsc_cbc5982414934e53862f16b4fa30ca57` | 2026-12-31 → **2027-08-16** | `audit_3f67db35152a44ec95f46376bf1a9399` |
| `com.storystudio.family.topic.archival-ledger.money-debt-financial-institutions` | topic_pack | `cprod_ebb2e783dc104a8d93dab194523f34ae` | `cdsc_42bdb078f7a24d18b648beadeb4a47ea` | 2026-12-31 → **2027-08-16** | `audit_043051f360f9408a875fec71bb78e56f` |
| `com.storystudio.family.topic.archival-ledger.states-revolutions-collapse` | topic_pack | `cprod_192a081dc14748679c7a1764597dfaa6` | `cdsc_1f4a94bb5e844506b3986d9c7cecf92b` | 2026-12-31 → **2027-08-16** | `audit_8a100de181cd4a438b4562500b636620` |
| `com.storystudio.family.topic.archival-ledger.wars-treaties-world-order` | topic_pack | `cprod_82100d001fa949599bbd38eaa037c15e` | `cdsc_8af6b632a7c5432caebb10a266664166` | 2026-12-31 → **2027-08-16** | `audit_79bd58a966f84da2b87c9c22f4985507` |
| `com.storystudio.family.topic.audience-question-seeder` | topic_pack | `cprod_490d832a953341109923a614122a994b` | `cdsc_84e0dc417a4c48a7971af803cf5c7827` | 2026-12-31 → **2027-08-24** | `audit_5c864bf34c3347a0b05f3e46de265986` |
| `com.storystudio.family.topic.deep-time-earth-systems` | topic_pack | `cprod_92125271a79d46b4a4b79512124899b9` | `cdsc_02a1b6f63c204a92be94635ca66af242` | 2026-12-31 → **2027-08-16** | `audit_fc42c6bb8da847ffaa82296d2d1c67ef` |
| `com.storystudio.family.topic.economics-businesses` | topic_pack | `cprod_7386b9c6e34d4024a4fbd259ea8bea4f` | `cdsc_19a251b723814523bf54175d1daa2d12` | 2026-12-31 → **2027-08-16** | `audit_c876ca64a38e48499e28114096ae767f` |
| `com.storystudio.family.topic.everyday-calm` | topic_pack | `cprod_4c0a4a33e6534b8d99a0936c3857c38b` | `cdsc_601d091b22b04207ba6c34dcdf155194` | 2026-12-31 → **2027-08-16** | `audit_f259b0ea3af34862b925c5b5cc9abd64` |
| `com.storystudio.family.topic.habits-momentum` | topic_pack | `cprod_dfc44bdf2e884105a51fb02ba2c0dd6c` | `cdsc_540ebc6e95ce46f8b9c5b3114af313d1` | 2026-12-31 → **2027-08-16** | `audit_19ff6357daf444648c7e77bb71a86aad` |
| `com.storystudio.family.topic.historical-wars-treaties-world-order` | topic_pack | `cprod_1ae93e360d554f1c9c17c136131b91c3` | `cdsc_4a4f52022a864a498ac6ff48773edb7c` | 2026-12-31 → **2027-08-16** | `audit_fd2a195f157740beba59a3cecc60aeb9` |
| `com.storystudio.family.topic.human-behavior-social-dynamics` | topic_pack | `cprod_b36f075973444cd78dc97d5a05c78bc7` | `cdsc_83a89d2c998a43cfb283234adaa34208` | 2026-12-31 → **2027-08-16** | `audit_dd7082d7aa89415ea22c1713c1ba2e37` |
| `com.storystudio.family.topic.natural-world-animals` | topic_pack | `cprod_712d77964e314ab79741dbc591a59b30` | `cdsc_267a6eb42ee14ed9ad27adbc12d840ad` | 2026-12-31 → **2027-08-16** | `audit_74c52857c0f5401891617dcc00598a70` |
| `com.storystudio.family.topic.night-journeys` | topic_pack | `cprod_a0398fa9251f4fcd810355e0e36fbf0c` | `cdsc_a621af69376a44cbad85bfe01009d2d5` | 2026-12-31 → **2027-08-16** | `audit_d667064694d8490d959dd7bd9d31df32` |
| `com.storystudio.family.topic.pov-historical-occupations` | topic_pack | `cprod_08d5344b8d604c2782db2b59f2c6d670` | `cdsc_266ffb40dfef463a984d16cb856d7852` | 2026-12-31 → **2027-08-16** | `audit_c49ed28932d5462b9601543d251bd55a` |
