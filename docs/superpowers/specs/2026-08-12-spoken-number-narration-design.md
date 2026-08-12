# Spoken-Number Narration Design

**Status:** Owner approved

**Date:** 2026-08-12

## Outcome

Story Studio narration is written for listening, not merely for reading. New or
rewritten chapter bodies will store ordinary speakable numbers as English words,
and the shared TTS request boundary will apply the same deterministic conversion
as a safety net for old, imported, or manually edited narration.

Examples:

- `1871` becomes `eighteen seventy-one`;
- `2001` becomes `two thousand one`;
- `2010` becomes `twenty ten`;
- `January 18, 1871` becomes `January eighteenth, eighteen seventy-one`;
- `42 percent` becomes `forty-two percent`; and
- `$5 million` becomes `five million dollars`.

Digits remain unchanged when they are intentionally exact technical text, such
as episode codes, identifiers, URLs, citations, equations, model names, version
numbers, file names, and addresses. The conversion must never guess through an
ambiguous token or change factual numeric value.

The existing HMH0001 narration and audio are stale because their saved script
contains digit years and the old audio was generated with the retired voice.
This change does not regenerate them automatically. Regeneration remains an
explicit, paid owner action after the new voice is published and approved.

## Existing Behavior

`normalizeForTts` is a deterministic punctuation safeguard. It currently
rewrites em/en dashes, smart quotes, ellipses, semicolons, and paired Markdown
marks because those harm spoken delivery. It does not use an LLM and it does
not currently convert numbers.

The HMH0001 saved narration contains text such as `January 18, 1871`; the same
digits reached the TTS request. The voice therefore chose the undesirable
cardinal reading, “one thousand eight hundred and seventy-one.”

## Approaches Considered

### Prompt instruction only

Rejected as incomplete. It improves new model output but cannot protect old,
imported, manually edited, or noncompliant generated scripts.

### TTS-boundary conversion only

Rejected as incomplete. Audio improves, but the authoritative saved narration
remains digit-heavy and downstream script/subtitle views do not reflect the
spoken wording.

### Saved-script normalization plus an idempotent TTS safeguard

Selected. One deterministic spoken-number helper is reused at both boundaries:
chapter persistence produces clean narration, and TTS submission protects every
source path. Applying it twice must produce byte-for-byte identical text.

## Spoken-Number Policy

The converter operates on English narration prose and is conservative.

### Years

- `1000` is `one thousand`; `1001` through `1009` retain the `one thousand`
  form; `1010` through `1099` use paired-year speech (`1066` → `ten sixty-six`).
- Years from 1100 through 1999 use paired-year speech when their context is a
  prose year: `1871` → `eighteen seventy-one`, `1905` → `nineteen oh five`.
- `2000` is `two thousand`.
- `2001` through `2009` use `two thousand one` through `two thousand nine`.
- `2010` through `2099` use paired-year speech: `2010` → `twenty ten`.
- A year range retains its range meaning: `1862–1866` → `eighteen sixty-two to
  eighteen sixty-six`.

### Dates, ordinals, quantities, and common symbols

- A numeric day immediately following a month name becomes an ordinal.
- Signed whole numbers, ordinary decimals, percentages, and common currency
  forms become natural English without changing value.
- Comma-grouped integers are converted only when grouping is valid.
- Existing word multipliers remain words: `$5 million` becomes `five million
  dollars`, not `five dollars million`.

### Deliberate digit preservation

The helper does not rewrite a numeric token when it is part of:

- a URL, email address, Markdown link target, or file-system-like path;
- an alphanumeric identifier such as `HMH0001`, `GPT-5.6`, `S2.1`, or `v1.0.826`;
- a citation/reference marker, source metadata, timecode, equation, mathematical
  expression, IP address, phone-like string, or code span; or
- any token whose punctuation makes its spoken intent ambiguous.

Writers may intentionally retain digit speech by using one of those exact
forms. Story Studio does not add a new user-facing override or markup language.

## Script Generation and Persistence

The universal script system prompt gains an explicit number rule with the
approved examples and preservation exceptions. This reduces cleanup and teaches
the model to compose sentences around spoken forms naturally. Required chapter
and section heading numbers remain digits because they are structural metadata,
not narration.

Before a generated or edited chapter body is persisted, the shared chapter
write boundary applies the deterministic spoken-number conversion. Markdown
headings and episode metadata remain untouched. The unified narration is then
assembled from those normalized chapter files, so script review, subtitles,
scene planning, and later audio all share the same words.

Existing files are not silently migrated. They change only when that chapter is
regenerated, saved through the chapter writer, or explicitly regenerated as part
of the owner-approved HMH0001 rerun.

## TTS Boundary

`normalizeForTts` invokes the spoken-number helper before its existing
punctuation cleanup, so a numeric range dash can become the spoken word `to`
rather than being mistaken for a clause break. Both passes still happen before
quoting, chunking, idempotency calculation, and submission. The audio reconciler
already uses the same request planner, so
predicted chunk filenames and actual billed requests remain aligned.

The log message distinguishes punctuation cleanup from spoken-number cleanup.
No LLM rewrite is introduced at audio time, and the expression-tag sidecar is
not allowed to change narration words.

## Published Audio Concurrency

Story Studio already reads `provider_submit_concurrency` from the selected live
TTS model and passes it to `resolveGenStudioTtsFanout`; the worker count is
bounded by the number of missing TTS parts and the existing local admission
ceiling. This design preserves that mechanism rather than adding a second
concurrency setting.

Qualification must prove that changing the selected live model's published
hint changes observed simultaneous TTS POSTs. A missing or invalid hint remains
serial and account/provider admission remains authoritative. The HMH0001 rerun
will use the newly republished Andrew Griffin voice only after owner approval.

## Safety and Recovery

- No existing audio, narration, or provider job is deleted by this change.
- No automatic regeneration or paid request occurs.
- Missing-only audio retry remains authoritative and preserves usable outputs.
- Changing spoken text invalidates the old audio by normal file freshness rules;
  the owner explicitly decides when to regenerate.
- The deterministic converter is idempotent and shared by quote, generation,
  and reconciliation paths.

## Verification

Automated tests must prove:

1. the script system prompt requires spoken numbers and names the preservation
   exceptions;
2. representative historical/modern years, dates, ordinals, quantities,
   percentages, currency, decimals, and ranges convert exactly;
3. identifiers, URLs, citations, equations, versions, model names, and paths
   retain their digits;
4. conversion is idempotent;
5. chapter persistence stores normalized body prose without changing headings
   or episode identifiers;
6. TTS quote planning, generation, and reconciliation use byte-identical
   normalized text;
7. a live selected-model concurrency hint controls real observed TTS fanout,
   while invalid/absent hints remain serial; and
8. no provider or paid call is needed for verification.
