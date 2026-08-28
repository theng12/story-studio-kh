# Published-pack mark scrub — 2026-08-28

The owner ruled on 2026-08-28 that a third-party video-platform mark must leave
customer-visible text. The earlier batch handled the six Production Looks, which could
be edited in place because they were pre-stock. It deliberately left the
already-published free-starter packs alone, because those cannot be edited at all.

This batch prepares that remainder. **Nothing here is published, stocked or priced.**

## Why a new version rather than an edit

A published pack's `(pack_id, version, sha)` is frozen. So each affected pack gets a new
version in a `<slug>-v<version>` sibling root and the existing directory is left
byte-identical — the mechanism `human-behavior-explained-v1.0.1` used, not the
in-place edit that `ancient-humans` needed archaeology to undo afterwards.

`git status` shows zero modified tracked files under `content-packs/`. Thirteen new
directories, reserved at revision 94 and authored at 95–107.

Those numbers moved once. The batch was first minted at 92 / 93–105 on a base of revision
91; Ancient Oceans landed on that same base and took 92–93, so this batch was re-minted by
replaying `reserve` and `transition` against the moved head. Exactly one value changed by
hand — `expected_revision` in the reservation request. The receipts are new, because refs
hash `expected_revision`; the pack bytes are identical at both bases, which was measured
in a throwaway worktree before the shift rather than assumed after it.

## What changed, and what it now says

| was | now |
| --- | --- |
| `Evidence-led YouTube package` | `Evidence-led video package` |
| `Immersive YouTube package` | `Immersive video package` |
| `Reflective YouTube package` | `Reflective video package` |
| `Pastoral YouTube package` | `Pastoral video package` |
| `crisp professional YouTube explainer illustration` | `crisp professional explainer-video illustration` |
| `YouTube explainer thumbnail energy` | `explainer-video thumbnail energy` |
| `the full YouTube title` | `the full episode title` |
| `End the YouTube title with "\| Documentary for Sleep"` | `End the episode title with "\| Documentary for Sleep"` |
| `readable on YouTube` | `readable in a video feed` |
| `optimised for YouTube CTR without clickbait` | `optimised for click-through without clickbait` |

Internal ids (`evidence-youtube`, `youtube_tags_hint`) are unchanged. They are never
rendered, so renaming one would churn a content-addressed record and gain the customer
nothing. `calm-youtube` already had a generic label, which is the precedent.

The app's real integration surfaces — upload, the finalizer, OAuth, playlists, category
lookup — still name the platform, and must. Naming the service you upload to is not the
exposure the ruling was about.

## What the owner has to decide

Republication is the whole remaining step, and it is one decision:

1. **Publish the thirteen successors.** Until that happens the scrub is invisible to
   customers — the live app still serves the published 1.0.0/1.0.1 bytes.
2. **Then, in the same change,** the live legacy copy has to move with them. It is
   pinned field-for-field to the published pack bytes by
   `free-starter-signed-source-golden.test.ts` and `free-starter-signed-style-golden.test.mjs`,
   so it cannot be scrubbed a moment earlier without turning those tests red:
   - `electron/server/niches/ancient-humans.json`, `.../deep-time-documentary.json`
   - `electron/server/thumbnail-templates/curiosity-question-cartoon.json`, `.../documentary-label-tableau.json`
   - the `evidence` / `immersive` / `reflective` labels in `electron/server/services/niche-loader.ts`
   - the two style bibles in `frontend/composables/useBuiltInStyles.ts`

`scripts/content-packs/__tests__/published-mark-scrub.test.mjs` holds that list as a
ledger: a mark appearing anywhere else fails, and clearing one of these without removing
its entry also fails. Neither direction can happen quietly.

Two surfaces no published pack pinned were scrubbed outright and need no approval: the
`faith` metadata-profile label, and the `listicle-explainer` title hint.
