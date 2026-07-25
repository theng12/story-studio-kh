# Channel Identity UI

**Status:** design proposal. It records the requested correction to the current Ideas and Settings experience; no UI code is changed yet.

## Problem

The app currently makes one word, **Format**, mean two different things:

- a video-production shell (`format_id`), such as narrated scenes, listicle, or continuity;
- a recurring channel formula, such as *The Economics of…*.

The latter is also configured inside the Ideas Generator, which makes the channel identity feel temporary and difficult to find.

## Proposed visible status

Below the Story Studio KH mark and the project/channel name in the sidebar, add one compact clickable **Channel Identity** card:

- **Formula** — `The Economics of…`
- **Topic Packs** — `Businesses & Companies` (plus `+2` when needed)
- **Production** — a plain-language production path such as `Narrated Visuals` or `Character Continuity`

The complete card opens Settings directly on the unified Channel Identity panel. It is status first, not a small editor; it should remain readable on every generator page.

## Unified Settings panel

Replace separate customer-facing **Format** and **Niche** tabs with one project-scoped tab named **Channel Identity**. It contains three clearly separated sections:

1. **Series Formula** — recurring title grammar, script structure, perspective, evidence and quality contract.
2. **Topic Packs** — compatible subject lanes and their default research/title vocabulary.
3. **Production Path** — the existing execution pipeline, renamed from Video Format so it is not mistaken for the creative formula. This determines scene planning, continuity, and assembly behaviour, not the channel's subject or narrator.

The selected formula displays its resolved perspective as read-only status. There is no per-script perspective chooser.

## Ideas Generator

Ideas uses the saved Channel Identity automatically. Its current setup strip becomes a concise read-only **Using this channel identity** summary with a link to Settings. It should not be the primary place to change formula, packs, or production path.

An advanced, explicitly labelled **Explore outside this channel** campaign can remain for deliberate one-off experiments. It must show a warning, save the override with the campaign/job, and never silently replace the channel default.

## Safe retirement of root formats

Do not delete `scenes` or `listicle` directly. They currently carry real execution and script semantics in saved projects.

- Normalize the generic `scenes` presentation shell into a plainly named `Narrated Visuals` production path, while retaining `scenes` as a readable legacy alias.
- Move independent-section/listicle writing rules into the `Counted Explainer` Series Formula, then map legacy Listicle projects to that formula plus a compatible production path.
- Retain `continuity-chain` as a distinct `Character Continuity` production path; it has materially different scene planning and image-to-image behaviour.
- Add migration tests for legacy project metadata, presets, pipeline runs, completion gates, and deep links before hiding legacy choices.

This makes channel identity scalable without breaking existing projects or conflating how a video is built with what series it belongs to.
