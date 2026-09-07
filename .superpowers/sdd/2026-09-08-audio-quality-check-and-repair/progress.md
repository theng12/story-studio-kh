# SDD ledger — plan: docs/superpowers/plans/2026-09-08-audio-quality-check-and-repair.md

## Pre-execution interface scan

| Producers / consumers | Shared surface | Finding / ruling |
|---|---|---|
| project config / Settings UI / Audio UI | audio_quality | One project setting only; no preset or Pipeline completion coupling. |
| Audio generator / audio merge / quality service | active audio mapping + provenance | Persist source facts with generated parts; quality reads active map and never promotes before verification. |
| Subtitle recovery / quality service | quote, confirm, task manifest | Reuse existing recovery and provider boundaries; action state stores correlation, not a parallel retry engine. |
| quality service / audio sections UI | chapter quality projection | Rows expose concise evidence only; no raw narration or provider routing control. |
| quality repair / downstream consumers | source freshness + SRT/stitch | Targeted refresh relies on the existing freshness gate; no image/video regeneration. |

No task conflict found. The approved handoff is the requirements authority. Existing UI and QA owners receive the stable contract before source changes.
