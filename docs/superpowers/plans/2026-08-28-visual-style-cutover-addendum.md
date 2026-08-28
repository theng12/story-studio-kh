# Visual Style cutover — package-only addendum (2026-08-28)

**Extends:** `docs/superpowers/plans/2026-08-25-visual-style-content-store-cutover.md`
**Does not replace it.** That plan's Tasks 1–8 remain the work breakdown. This
addendum records what is now verified, corrects two stale statements in it, and
names one unlisted precondition that would otherwise be discovered during the
deletion itself.

Owner rulings this addendum is written under:

- Signed packs become the **only** style source.
- Legacy built-ins are **allowed to break**. No migration, no alias, no
  compatibility layer for `builtin-*` selections.
- Art style is never dictated by a video type.

## 1. Verified state, 2026-08-28

Measured on `main` `8a7f69eb` (1.4.75) and against the running app's API.

| Fact | Evidence |
| --- | --- |
| Six production-look sources exist and are `authored` | registry records, all six `status: authored` |
| Their batch is registry revision 43, receipt `authoring:0b7e…` | registry batch 43, covers exactly those six |
| The registry record schema binds **no payload hash** | record fields are ids/version/source_path/status only |
| 17 legacy built-ins remain in the static catalog | `frontend/composables/useBuiltInStyles.ts` |
| All 17 have a signed equivalent authored under a qualified id | `com.storystudio.style.<slug>` across five pack trees |
| The live app serves **13** signed styles | `GET /api/visual-styles` → 13 entries |
| The 6 absent from that 13 are exactly the six pending stocking | ms-paint(→retro-paint)-fantasy, pixel-art-story, anime-cel, studio-catalog-realism, whiteboard-doodle-explainer, hand-drawn-cartoon-explainer |

So 11 of the 17 built-ins are already fully covered by installed signed packs.
The cutover's remaining exposure is the six in flight — which is exactly what
the base plan's Task 6 gate is for. That part of the plan is sound.

## 2. The unlisted precondition — the app has no bundled style floor

This is the one thing that would bite during Task 7 Step 2.

Task 7 says to initialize the catalog empty, populate it only from
`/visual-styles`, and delete `mergeWithLegacyRecovery` and `usingFallback`.
That is correct as an intent. But the static array it deletes is currently the
app's **only** offline floor, and nothing replaces it:

- `content-packs/recovery/` **does not exist in the repository.** The runtime
  resolves a `recoveryRoot` (`electron/server/content-packs/runtime-paths.ts`,
  packaged: `<resources>/content-packs/recovery`) and `recovery.ts` will verify
  and adopt archives found there — but no archive is ever placed there.
- `package.json` declares no `build.extraResources`, so nothing copies pack
  archives into the packaged app.
- The 13 styles the live app serves are installed under `userData`, i.e. they
  arrived through the store flow on this machine. They are not evidence that a
  fresh machine has them.

Consequence if Task 7 lands as written: a brand-new install opens the style
gallery and sees **nothing** until the user installs packs from the store.

This is not the "legacy presets may break" the owner allowed. That ruling is
about *previously saved selections* breaking. An empty gallery on first run is
a different thing — a new user with no saved state at all, and no way to pick a
look without first going shopping. The two should not be conflated, so the
decision is put here rather than absorbed silently.

### Options (a product-shape decision, not a technical one)

1. **Bundle the free-starter styles as recovery archives.** Build the nine
   free-starter style packs (plus oil-painting-classical and
   archival-documentary-reconstruction as applicable) into
   `content-packs/recovery/` and add `build.extraResources` so they ship. The
   seam already exists and is already verified at boot; this is populating it,
   not building it. Fresh install keeps a real floor, and it is signed — so the
   "signed packs are the only source" ruling holds literally.
2. **Auto-grant and auto-install the free starters on first run**, leaving the
   packaged app thin. More moving parts, and it needs a network path on first
   run, which the current fallback explicitly does not.
3. **Ship with an empty gallery by design**, with the store as the first stop.
   Coherent with "nothing is free" only if free starters are genuinely retired
   as a concept; today they exist as a pack tree.

Option 1 is the smallest change that satisfies the ruling as written and does
not introduce a first-run network dependency. It is recorded here as the
cheapest path, not as a decision — the choice belongs to the owner.

**Sequencing:** this precondition must be settled **before** Task 7 Step 2, and
it is independent of the six-product stocking. It can be done now.

## 3. Corrections to the base plan

1. **Pricing line is stale.** The base plan's Global Constraints say "exactly
   one 300-credit price version with **no discount**". The current owner terms
   (2026-08-28) are 300 credits base with a **90% promotion to 30 credits,
   ending 2026-12-31**, consistent with the standing every-pack-300 ruling. The
   handoff document uses the current terms; the plan line should not be
   followed as written.
2. **Product name changed.** The base plan names the first product `MS Paint
   Fantasy`. The owner approved renaming the user-facing product to **`Retro
   Paint Fantasy`** before first stocking, because the prior independent review
   found the old name places a Microsoft product mark as the leading element of
   a paid product name. Technical ids (`ms-paint-fantasy`,
   `com.storystudio.pack.style.ms-paint-fantasy`, sku, family, asset filename)
   are deliberately unchanged, so the revision-43 receipt chain still resolves.
   Task 7 Step 5 needs a separate correction — see below.
3. **Task 7 Step 5 must not be done as written.** It says to replace the
   shipped niche style recommendations with signed ids
   (`com.storystudio.style.paleo-documentary-tableau`,
   `com.storystudio.style.archival-documentary-reconstruction`). That would
   write a style id back into a Formula, which is the binding the owner
   outlawed on 2026-08-25 — *"art style is a selection, a preference for the
   user; they can't be dictated this way"*. Trading `builtin-x` for
   `com.storystudio.style.x` does not satisfy the ruling, because the ruling is
   about the binding, not the id space.

   `electron/server/__tests__/niches-suggest-never-dictate.test.ts` is the fence
   built for that ruling, but its check only caught `recommendedVisualStyleId`
   and `"builtin-` ids — a qualified signed id would have passed it silently.
   The fence has been hardened here to reject `"com.storystudio.style.` as well.
   It is green today: no niche names a style id in any shape.

   What niches legitimately keep is `visualStyleHint`, a descriptive one-liner
   that never reaches a prompt. Suggesting is allowed; naming an id is not.

## 4. Blast radius of the deletion, as measured

Recorded so Task 7 is executed with the real dependency list rather than a
repository search done at the time.

**Persisted legacy ids — exactly one path.** `config.active_style_preset_id`
may hold a bare `builtin-*` id, and only `settings.vue` writes it, mirroring the
style's prose into `config.style_presets` first (which is what makes the
server-side `assertResolvableSelections` guard accept it). Everything else —
Character Sheet, Scene Plan default, Image Prompts — persists only the
`style_bible` **prose**, never an id, and re-derives the display name by exact
string match at view time.

So under the no-migration ruling the observable breakage is bounded and
predictable: projects that picked a legacy style keep rendering exactly the
same look (the prose is what reaches the model), and simply stop showing that
look's *name*. That is a labelling regression, not a rendering one. Worth
stating plainly, because it is much milder than "saved projects may break"
suggests, and it should not be over-warned about in release notes.

**Runtime consumers of the static catalog** (all via `useVisualStyleCatalog`):
`StylePicker.vue`, `BuiltInStyleLibraryModal.vue`, `ProjectStyleLibrary.vue`,
`settings.vue`, `image-prompts.vue`, `scene-plan.vue`.

**Tests that hard-assert built-ins** and must move in lockstep — six files, not
the four the base plan implies: `frontend/__tests__/builtInStyles.test.ts`
(asserts length `17` and five specific ids),
`frontend/__tests__/visualStyleCatalog.test.ts` (asserts merged length and
fallback length `17`), `frontend/__tests__/scenePlanStyleIdentity.test.ts`,
`frontend/__tests__/styleLibraryModal.test.ts`,
`electron/server/__tests__/content-pack-migration-golden.test.ts` (golden-freezes
prose for five ids), and
`electron/server/__tests__/symbolic-psychology-studio-wave-1-source.test.ts`
(text-compares `builtin-oil-painting-classical` against its signed pack).

Also delete `frontend/public/builtin-style-previews/*.webp` — 17 files, one per
built-in — but only after the floor decision in §2, since option 1 makes them
redundant and option 3 does not.

## 5. Why this is a plan and not a completed rip-out

The deletion is gated on two things that are not ours to close today:

- The six products must be stocked and published, then observed installed and
  API-visible (base plan Task 6). Not started; the stocking handoff is only now
  being prepared.
- `npm run content-pack:registry -- validate` currently **fails** on `main`
  ("batch 15 receipt does not match its persisted request metadata"). A repair
  is in flight on another branch. The registry is the identity authority and it
  fails closed, so no registry-touching cutover step may proceed until it is
  green.

Neither is a reason to defer the §2 floor decision, which is independent and
actionable now.
