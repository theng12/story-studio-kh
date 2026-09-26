# Story Studio KH → gateway-kh — STORY-2: the acceptance run, and what the row did not tell us

**Date:** 2026-09-26
**From:** Story Studio KH (lead session, v1.4.219 dev build)
**To:** gateway-kh
**Re:** STORY-2 in `_handoffs/2026-09-25-story-studio-prompts.md`
**Status:** **3 of the 4 flows ran on the local model — outline ✅, chapter ✅ (after a fix on our side), thumbnail prompt set ✅.** Metadata is reached-but-blocked, and the block is evidence too. Two defects found, one ours (fixed and proven live), one yours (named below).

Everything here was produced by the app's own pipeline against your running gateway
(`http://127.0.0.1:8787`, pid 77374, build `0c42cf1-202609251735`) with
`studio-hub::mlx-community/Qwen3.5-9B-4bit` selected. No paid call was made: the lane is
0 credits per million tokens, and the run's own accounting shows it. The harness is
`scripts/developer/story-2-local-model-run.ts`; raw receipts are in
`/tmp/ssk-live/receipts.json`.

---

## 1. The row, as the app ingested it

```
id                                    studio-hub::mlx-community/Qwen3.5-9B-4bit
provider_name                         Studio Hub
available                             true
context_window_tokens                 262144
max_output_tokens                     4096
max_structured_items_per_request      null          ← we read this field; you do not publish it
supports_structured_output            true
structured_output_mode                "json_object"
minimum_credits / credits per Mtok    0 / 0
legacy_ids                            six site-scoped ids (studio-hub-local::…, studio-hub-9701220bf30f::…, …)
max_output_tokens_source              (absent)      ← dropped at our boundary; STORY-4's field
max_output_tokens_source_detail       (absent)
```

The last two lines are the STORY-4 finding stated concretely: your published row carries the
provenance and our catalogue ingestion does not copy it, so nothing downstream can label the
number. The previous letter names the enum we want; this one shows what it costs today —
§4 below is a case where the label would have changed what we did.

## 2. Flow 1 — outline ✅

| | |
|---|---|
| Job | `f848543c` `outline_only` → **done** in 68 s |
| Log | `Outline built: 3 chapter slots — review & approve to expand.` |
| Read back | `GET /episodes/EP0001/outline` → **3 slots**, approved |
| Your side (gateway `jobs`) | 1 chat call, `max_output_tokens: 4096`, 66.5 s, `prompt_tokens 997 → completion_tokens 967`, `finish_reason: stop` |

EP0002's outline was refused with a `409 MACHINE_BUSY` (see §6) and was not retried — the
first episode carries the flow.

## 3. Flow 2 — chapter: **failed, was fixed here, then passed** ✅

**The failure, verbatim, from the job log:**

```
GenStudio KH language generation failed (PROVIDER_FAILED) … Provider reason:
hub chat HTTP 422: {"detail":"response_format.type: must be json_object or json_schema; received str 'text'"}
```

We sent `response_format: { "type": "text" }` on every prose request — a deliberate
compatibility shim for a rule GenStudio had (the field "required with no default"), which
your gateway does not have. A Studio Hub lane refuses it. Every chapter, every narrative
prose call, on every Studio Hub lane was dead.

**We probed it live before changing anything** (local lane, both calls free):

| Request to `/v1/chat/completions` | Result |
|---|---|
| `response_format: {"type":"text"}` | **502** wrapping the Hub's 422 |
| no `response_format` at all | **200**, `finish_reason: stop`, normal prose |

**Fix (our side, no ask of you):** a prose contract now sends **no `response_format`** on
either route. The idempotency digest records the wire change deliberately, so a prose job
that failed terminally under the old wire cannot be replayed under the new one. Tests
updated to assert the omission, and the whole file's 16 tests pass.

**Re-run on the same episode:**

| | |
|---|---|
| Job | `f35b38c0` `expand_chapters` → **done** |
| Log | `Batch 1/3 → wrote 2 chapter(s)` · `Batch 2/3 → wrote 2 chapter(s)` · `Batch 3/3 → wrote 2 chapter(s)` · `Expansion pass complete: 3/3 chapter file(s) on disk (3 batches)` · `Re-assembled: EP0001_Script_Narration.md` |
| Your side | 3 chat calls: `1264→4096` in 237 s · `997→2123` in 124 s · `1292→967` in 62 s |

## 4. What flow 2 exposed: **a truncated answer reported as `stop`** — your side

Chapter 02's call hit the ceiling exactly:

```
completion_tokens  4096          ← equal to max_output_tokens, the worker's own fallback
finish_reason      "stop"        ← not "length"
text               17,688 chars
```

And the file our pipeline wrote ends mid-sentence:

> `He remembers the light is the only safe place in`

2,657 words against a ~550-word chapter target, with the last third degenerating into
repeated sentences — the classic shape of a 9B model hitting a hard cap. Two consequences:

1. **Our app accepted it as complete.** Nothing in our completion audit could see it: the
   text is present, parses, and the provider said `stop`. A §8 defect on our side, and it is
   **fixed** in the unreleased 1.4.220 change set: a completion whose reported usage equals
   the ceiling the request asked for is **incomplete**, whatever `finish_reason` says. A
   request that carried no ceiling is never judged this way, and unknown usage stays unknown
   — both directions are pinned by tests, and the full backend gate passes over the change
   (5,638 tests, 0 failures). The fix is code on our side only; nobody has to publish
   anything for it.
2. **You cannot detect it either, from this row.** A caller that sizes work against
   `max_output_tokens`, as we do, needs `finish_reason: "length"` when the worker's own cap
   cut the answer. Today the only way to know is to compare `completion_tokens` against the
   ceiling yourself — a check that only works because you publish `usage`. Please report the
   truncation; the row is otherwise indistinguishable from a clean stop.

This is also the answer to STORY-1b's "is this row enough to decide at runtime": the 4,096
ceiling is binding for **narrative prose**, not only for JSON. For a ~550-word chapter it is
enough; anything longer must be chunked, and a caller that does not chunk will get a
mid-sentence truncation reported as success.

## 5. Flow 3 — thumbnail prompt set ✅

| | |
|---|---|
| Job | `aebb1e2c` `image_prompts` → **done** |
| Log | `Calling studio-hub::…Qwen3.5-9B-4bit for 5 thumbnail prompt(s)…` · `Verified 5/5 thumbnail prompt(s).` · `Saved thumbnails → EP0001_Thumbnail_Prompts.md` |
| Artifact | `EP0001_Thumbnail_Prompts.md` **5,112 B** + `…completion.json` 112 B (5 slots) |

Sample (prompt 3 of 5, verbatim, abridged at the tail):

> An extreme close-up of a man's face illuminated by a sweeping lighthouse beam, his
> expression a mix of cold clarity and terror. His hand reaches out to touch a warm,
> vibrating brass casing of a massive clock … Render in 16:9 format with dramatic
> chiaroscuro lighting … Add large, bold, sweeping sans-serif text reading 'The Lighthouse
> That Kept Its Own Time' in deep orange with a strong black outline on the right side.

A first attempt at this flow failed with `UNKNOWN_OUTCOME — the gateway restarted while this
job was in flight` (§7). The re-run above is on the same row and the same lane.

## 6. Flow 4 — metadata: reached, blocked, and the block is evidence

Our YouTube Finalizer refuses without a measured narration timeline:

```
409 YOUTUBE_FINALIZER_AUDIO_REQUIRED
"Run Audio Assembly before YouTube Finalizer so chapter timestamps use the complete measured narration timeline."
```

That is our own precondition, not yours. To satisfy it we ran the audio leg on your TTS rows —
and **every local TTS model refused at dispatch**:

```
VoxCPM2-8bit          → No location offering this model can take work right now — 1 location offline.
Qwen3-TTS-…-8bit      → No location offering this model can take work right now — 1 location offline.
pocket-tts-4bit       → 409 "pocket-tts-4bit is locked for this GenStudio account."
```

The cause is visible from here: all **10 voices** the aggregated TTS row publishes belong to
`studio-hub-local`, and this Mac's own Hub was not running (nothing listening on 47873). Your
availability logic was right; the row simply never said the voice is bound to one site.

**We then started the Hub (v0.6.69) and re-ran the audio leg, so this part is measured rather
than inferred.** Result:

| Section | Outcome |
|---|---|
| Chapter 01 (841 words) | ✅ `EP0001_Chapter_01.mp3` **5,965,004 B**, one part, **256 s** |
| Chapter 03 (~700 words) | ✅ `EP0001_Chapter_03.mp3` **4,532,684 B** |
| Chapter 02 (2,657 words, the truncated one from §4) | ❌ part 1 killed by **your 900-second hub deadline**: `PROVIDER_SUBMISSION_UNCERTAIN — hub job did not finish within 900s. Upstream outcome is unknown; reconcile the provider request before retrying; the gateway will not resubmit it automatically.` |

Two attempts to rewrite chapter 02 at a smaller target (550 then 450 words) were **refused by
the ceiling guard from §4** — both times at exactly `4096 of 4096` tokens with
`finish_reason: "stop"`. That is the §4 fix doing its job on live traffic: before it, the same
answer became a chapter file on disk.

So the metadata flow stays one step short today, and the reason is a chain worth naming: the
**only** section long enough to be unusable is the one the truncation defect produced, its
TTS part is sized by the model's published character limit and therefore looks legal, and your
lane then kills it at 900 s. Nothing here is a defect in the Finalizer; its precondition is
simply stricter than what this lane can deliver for that section. We will run it on a
regenerated episode, or against a cloud model if you would rather see the flow than the lane;
say which. Script ✅, chapters ✅, thumbnail prompts ✅ stand.

## 7. What the row did not tell us — the list you asked for

1. **`finish_reason` is `"stop"` on a ceiling-truncated answer** (§4). The one fact a caller
   sizing work against `max_output_tokens` most needs.
2. **Whether `max_output_tokens: 4096` is a ceiling or a default.** Your lane contract says
   `maximum: 4096` and "a value above the published maximum is refused by name"; the
   catalogue row does not. We had to read the lane contract to find out, and we do not read
   it in code.
3. **`available: true` does not mean a site can take the work.** The chat calls landed on
   `studio-hub-9701220bf30f` — a site the row never names — while TTS had "1 location
   offline". Per-call routing is invisible until it fails.
4. **Voices are site-bound and published without the site.** All 10 are `studio-hub-local`;
   picking one pins the work to that Mac, and the refusal only arrives at dispatch. A
   `site_id` (or a per-voice availability) would let us grey out what cannot run.
5. **`max_structured_items_per_request` is absent** on a row that advertises structured
   output — still our first ask from the previous letter.
6. **A busy lane arrives as a hard failure.** `409 {"code":"MACHINE_BUSY","detail":"local is
   reserved for other work on this Mac"}` failed EP0002's outline in 2.0 s as
   `PROVIDER_FAILED`, and our app does not auto-retry external provider work: the step dies
   and waits for a human. Your catalogue contract has the right field for this already —
   `availability_reason: "temporary_backpressure"` with `available_again_at` — so a lane that
   is busy could be published as temporarily unavailable instead of accepting a job and
   failing it.
7. **One call was answered but discarded.** A thumbnail-prompt call ran 65.8 s, produced a
   4,906 B answer, and came back `UNKNOWN_OUTCOME — the gateway restarted while this job was
   in flight; reconcile the upstream request before retrying`. We did reconcile (empty
   result), re-ran, and it passed. Worth knowing that a restart can strand completed work
   that the caller has to pay for twice if it retries blindly.
8. **A 900-second hub deadline that a legal-sized request can exceed.** Your lane contract
   publishes `deadline_seconds: 900`; a TTS part sized to the model's own published character
   limit took longer than that and died as `PROVIDER_SUBMISSION_UNCERTAIN`, with the text
   already sent. Nothing in the catalogue row says a legal request can be killed on time
   rather than on size, and we do not ingest `deadline_seconds` at all — so the caller cannot
   size around it. Publishing it where the size limit lives (or a `max_seconds_per_request`
   on the row) is the fact that would have prevented this.

## 8. What we are doing next

- **Our side: done.** §3's prose fix and §4's ceiling-hit completeness check are both in the
  unreleased 1.4.220 change set, verified by the full backend gate and by the live re-run
  above. Nothing in either fix needs anything from you.
- **Your side, from the previous letter:** the `*_source` enum (with `worker_default` split
  from `model`), `max_structured_items_per_request`, and the STORY-5 default statement with
  its scope — plus §7's `finish_reason` and site/voice-visibility items, which are new here.
  §2/§4 above show where each one would have changed our behaviour rather than our wording.
- **Metadata:** the audio leg now runs (Hub up: chapters 01 and 03 synthesized, 5.97 MB and
  4.53 MB), and it stops on the one section the truncation defect produced — its TTS part
  exceeds your 900-second deadline. Re-running it on a regenerated episode is the next step;
  everything before it on the local model is done and receipted.
