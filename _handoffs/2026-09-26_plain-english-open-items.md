# The open items in plain English — no row numbers

The gateway session keeps one shared to-do list for all three projects. Its rows are named `GW-n`
(gateway), `HUB-n` (Studio Hub) and `STORY-n` (Story Studio) — they are just line numbers, nothing
more. This page says what each one actually is, for the owner.

## Answered and shipped — nothing to do

- **The ceiling and the deadline** (they call it HUB-19). Studio Hub's worker limit went 4,096 →
  16,384 output tokens and the per-job time limit went 900 → 1,800 seconds. **Already live here** —
  verified on our wire. Our numbers moved by themselves: ~2,900 words per chapter call, 3 chapters
  per call, ~40 scene prompts per request, 30-scene plan windows.
- **Two-pass vs a model id** (STORY-1b): answered — no id marker, nothing for them to build.
- **The acceptance run** (STORY-2): outline, chapters and thumbnail prompts produced by the local
  model; metadata blocked and fully explained.

## Open on Studio Hub — three are about not misleading you in the app

1. **"Whose number is this?"** (HUB-20). Every limit arrives with a note saying who it came from —
   the model's own documentation, Studio Hub's fallback, or your own curated file. Today we receive
   "16,384, worker default" as a sentence we cannot show, so the app prints **16,384** as if the
   model stated it. Studio Hub's own fallback is not the model's spec — the checkpoint states no
   output figure at all. **This is the one that matters:** it is exactly the "don't show a number as
   the model's when it isn't" rule you gave me. They agree; it is not built yet.
2. **"How many items fit in one answer?"** (HUB-21). For bulk work — 30 scenes, 15 tags — the app
   needs to know how many items one reply may contain. We already read that field; nobody publishes
   it, so it is always blank. Nothing breaks today; bulk sizing is just done by token count alone.
3. **"What does an empty setting mean?"** (HUB-22). They guarantee that if a request leaves a
   setting out, the value used is *that Mac's* saved default — not the model's. Publishing that as a
   sentence instead of prose in a note, so the app can say it. Lowest priority; nothing blocked.

## Open on Studio Hub — not ours, but worth knowing

4. **"Say cut off when it is cut off"** (HUB-18). When an answer hits the output ceiling, their lane
   reports "finished normally" instead of "ran out of room". We no longer depend on it — our own
   check catches it by comparing the tokens used against the ceiling — but any other caller would be
   misled. They agree it is worth fixing; it is not built yet.

## Why nothing of ours is stuck

Neither open item blocks a run. Item 1 changes what the app *says* about a number; item 2 makes bulk
sizing more precise; item 3 is a sentence. When their build lands and the gateway re-reads it, the
app picks all three up with no release from us.
