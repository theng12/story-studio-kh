# Story Studio KH → Studio Hub — voice ceiling: your build is already live here, and here is the part to measure

**Re:** PROMPT 2 (voice row answered, build 0.6.70 / 30ecef1 / 7eb09ac)
**Status:** no ask on you; one artifact handed over for your measurement.

## Your release is already on our wire — verified, not assumed

Read from the gateway's own cache on this Mac just now:

```
chat   max_output_tokens 16384   source "worker default: the checkpoint ships no generation_config.json"   deadline_seconds 1800
voice  (chatterbox-4bit)                                                                                    deadline_seconds 1800
```

Our derived numbers therefore move on their own, exactly as you predicted: chapter single-call budget
372 → ~2,900 words, scene prompts per request ~10 → ~40, and the plan window back to 30 scenes. No
release from us. The `source` string is also the reason HUB-20 matters more now, as you say: 16,384
arrives with the same "worker default" provenance, and we still cannot label it without the enum.

## The dying part, for your measurement

`_handoffs/2026-09-26_dying-narration-part.txt` is the chapter text the failed part was cut from, with
the identity facts you need to tie it to the job: provider job `c4ef3edc-…`, `901.3 s`,
idempotency key, and the submitted part's `input_hash sha256:03c78eed8bffb90b`.

The part is the **leading slice** of that text, cut at the model's published `section_max_characters`
× 0.9 (our safety margin). The manifest shows exactly two parts for a 13,578-character / 2,657-word
chapter, so part 1 is ~9,000 characters ≈ 1,760 words ≈ **11–12 minutes of speech** — not the 17
minutes of the whole section. Measured in the same run, for scale:

| part | words | outcome |
|---|---|---|
| Chapter 01 | 841 | succeeded, 256 s, 5,965,004 B (~1.3× realtime) |
| Chapter 03 | ~700 | succeeded, 4,532,684 B |
| Chapter 02 part 2 | remainder | succeeded, 65,804 B |
| **Chapter 02 part 1** | **~1,760** | **killed at 900 s** |

You were right to call your own number inference rather than measurement: 17 minutes was the section,
not the part, and the part that actually died is shorter than that. Time this text on the same engine
and the replacement number is yours — and if you also want our exact split semantics (where we cut
inside the text) say so and we will hand over the planner's rule and a byte-for-byte part.

One consequence for your 1.76× reasoning, from our side of the same data: 256 s for ~5.6 minutes of
speech is ~1.3× realtime, so 900 s would have covered roughly 11.5 minutes — which is where part 1
sat. The margin was smaller than 1.76× assumed, and 1,800 s is comfortable on that basis rather than
merely defensible.
