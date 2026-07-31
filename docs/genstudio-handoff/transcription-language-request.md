# Request to GenStudio: publish transcription language support

**From:** Story Studio KH
**Status:** open
**Urgency:** low — Story Studio ships a working control either way; this makes it accurate

## Goal

Story Studio is adding a language control to transcription: the customer picks from the
languages their selected model actually supports, with an auto-detect option. We want it
driven entirely by the catalogue, so that when GenStudio's support changes, nothing in
Story Studio needs a code change or a release.

## What is published today

`TranscriptionModelResponse` carries a single `language` string, defaulting to
`"multilingual"`. That tells us a model isn't English-only, but not *which* languages it
handles — so a list cannot be built from it.

## Requested

1. **`supported_languages[]`** — the language codes the model accepts, in exactly the form
   the request's `language` field expects. If a model genuinely accepts anything, an empty
   array plus a flag saying so is fine; knowing that is better than guessing.

2. **`supports_language_auto_detect`** (bool) — whether omitting `language` means the model
   detects it, or falls back to some default. Story Studio currently assumes omitting it
   triggers detection. Please confirm or correct, because this is about to become a
   customer-facing option.

3. **Clarify the existing `language` field.** Is `"multilingual"` a sentinel meaning "many,
   unenumerated", or is it sometimes a real single language like `"en"`? Today Story Studio
   cannot distinguish "this model only does English" from "this model does everything" —
   both arrive as one string.

4. **Return the detected language on the job** when auto-detect ran — e.g.
   `detected_language` on `TranscriptionJobResponse`. If a customer picks auto-detect, we
   would rather show what it decided than leave it unexplained. It is also useful evidence
   when a transcript comes back wrong.

## What Story Studio does meanwhile

Offers **Auto-detect** (by omitting `language`), plus a free-entry language code clearly
marked as unvalidated because the model has not published its list. The moment
`supported_languages[]` arrives, that becomes a proper selector and the free-entry fallback
disappears — no release required.

Auto-detect and "the model published no language" are rendered as different states.
Auto-detect is a deliberate customer choice; an unpublished language is a gap in what
GenStudio told us. Collapsing them would make missing data look like a decision.

## Context, so you can judge priority

Story Studio's content is English-only today, and that is a deliberate product decision
rather than a permanent one — the owner's words were *"it's only english only for now. i
might change my mind tomorrow and support 20 more languages."*

So the control is being built now specifically so that adding languages later is a dropdown
change rather than an engineering project. Low urgency, but worth getting the shape right
before a UI is built around it.
