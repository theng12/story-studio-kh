# Request to GenStudio: publish transcription language support

**From:** Story Studio KH
**Status:** partial — `supported_languages[]` shipped; auto-detect publication remains open
**Urgency:** low — Story Studio ships a working control either way; this makes it accurate

## Goal

Story Studio is adding a language control to transcription: the customer picks from the
languages their selected model actually supports, with an auto-detect option. We want it
driven entirely by the catalogue, so that when GenStudio's support changes, nothing in
Story Studio needs a code change or a release.

## What is published today

`TranscriptionModelResponse` now publishes `supported_languages[]`, and Story Studio builds
the picker from that list. GenStudio does not yet publish
`supports_language_auto_detect` or a job's `detected_language`.

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

Offers only the selected model's published language codes and sends the chosen code
explicitly. Auto-detect remains hidden until the selected model explicitly publishes
`supports_language_auto_detect: true`; Story Studio never turns missing contract data into a
customer option. A stale preset requesting auto-detect fails before submission rather than
silently omitting `language`.

Auto-detect and "the model published no language" remain different states. Auto-detect is a
deliberate customer choice only after GenStudio publishes it; an unpublished language is a
blocking catalogue gap, never a decision Story Studio invents.

## Context, so you can judge priority

Story Studio's content is English-only today, and that is a deliberate product decision
rather than a permanent one — the owner's words were *"it's only english only for now. i
might change my mind tomorrow and support 20 more languages."*

So the control is being built now specifically so that adding languages later is a dropdown
change rather than an engineering project. Low urgency, but worth getting the shape right
before a UI is built around it.

---

**STILL-REFERENCED — status header added 2026-08-28.** Cited directly (as
`docs/genstudio-handoff/transcription-language-request.md`) in a doc comment on
`GenStudioTranscriptionModel.supported_languages` in `electron/server/lib/genstudio-client.ts`
(~L811) — do not move this file while that comment cites the path.

**A discrepancy worth flagging, not fixed here:** that same code comment (unchanged since
commit `b22440207`, 2026-07-31) says *"GenStudio does not publish this yet... so it is empty
today"* for `supported_languages[]` — but this folder's own README (reconciled 2026-08-10)
says `supported_languages[]` **shipped** and drives the picker in `audio.vue`, and the parser
at `genstudio-client.ts` reads it live. The consumption logic for item #2,
`supports_language_auto_detect`, was also added on 2026-08-10 (commit `e909a4ae`,
"reconcile current GenStudio contracts") and is live in `generators/subtitles.ts:215`. Whether
GenStudio's live payload today actually populates either field with real (non-empty) values
cannot be confirmed from this repo alone — that comment has simply never been updated since
the day it was written, five days before the fields it describes reportedly shipped. Worth a
one-line comment correction the next time this file is touched.
