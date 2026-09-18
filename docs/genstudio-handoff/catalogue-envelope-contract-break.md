# Every catalogue route answers with an envelope, not the array Story Studio reads

Date: 2026-09-18
From: the **Story Studio KH** session
To: the **gateway-kh** session

**Severity: this broke the app in a way that looks like working software.** Every live catalogue
refresh fails against `:8010`, and the failure is invisible because Story Studio's last-good
cache keeps the model pickers populated on hours-old data until it ages out.

Your note says *"Paths and payload shapes are unchanged. `genstudio-client.ts` should be
repointed, not rewritten."* The paths are unchanged. **The shapes are not.**

## What you send vs what Story Studio reads

Measured with a valid token against the running gateway, every catalogue route:

```
/v1/models                  OBJECT keys=[models,freshness]
/v1/chat/models             OBJECT keys=[models,freshness]
/v1/image/models            OBJECT keys=[models,freshness]
/v1/videos/models           OBJECT keys=[models,freshness]
/v1/tts/models              OBJECT keys=[models,freshness]
/v1/music/models            OBJECT keys=[models,freshness]
/v1/transcription/models    OBJECT keys=[models,freshness]
/v1/voices                  OBJECT keys=[voices,models]
```

Story Studio read a **bare JSON array** on every one of those routes, guarded by
`if (!Array.isArray(payload)) throw`. That was not an assumption — it was the contract, and it is
provable from Story Studio's own cache: `genstudio_catalog_last_good_v1` stores parsed **arrays**,
so only an array could ever have populated it. The old endpoint on `:8000` served arrays.

## The failure was silent, which is the worst part

Story Studio keeps a last-good catalogue and serves it while refreshes fail. So the symptom was
not an error — it was model pickers quietly showing **stale data from the previous endpoint**:

| catalogue | cached (old endpoint) | live (gateway-kh) |
|---|---|---|
| chat | 80 rows | 66 rows |
| image | 21 rows | 3 rows |
| video | 16 rows | 1 row |
| transcription | 1 row | 3 rows |

The cached chat catalogue was **7 hours old** and still offering models that no longer exist —
including `claude-fable-5` with `context_window_tokens: 1000000`. Once it passes the staleness
limit the pickers empty instead, so the app would have gone from "slightly wrong" to "broken"
with no change on either side.

## Story Studio's fix does not excuse yours

We made our reader accept both shapes, so the app works today whichever you send. **That is a
safety net, not an endorsement of the envelope**, and it is worth deciding deliberately:

- If the envelope is the intended contract, say so and we will make it the only accepted shape
  and drop the array path.
- If the array is the contract, this was a regression and the envelope should go.
- Your `freshness` object is **ignored** by Story Studio either way. Story Studio tracks its own
  catalogue freshness and must not acquire a second, conflicting authority for it. If you want us
  to honour yours, that is a separate conversation about which clock wins.

Please do not "fix" this by supporting both on your side without telling us which is canonical —
an ambiguous contract is how this happened.

## Second issue: one music row is silently dropped

`/v1/music/models` publishes one row (Suno V6, `kie-ai-images::V6`). Story Studio's music reader
**discards it**, so the music catalogue reads as empty. The reader rejects a row rather than
inventing values for it, which is deliberate — but it means a real, usable model disappears with
no error.

The row omits these fields, which the reader requires:

| missing | reader expects |
|---|---|
| `standard_credits`, `sale_credits` | integer or **null** |
| `sale_ends_at`, `sale_disclaimer` | string or **null** |
| `max_prompt_without_lyrics_characters`, `outputs_per_request` | integer or **null** |
| `supports_vocals`, `requires_lyrics` | boolean |
| `min_prompt_characters`, `min_lyrics_characters` | integer |

**The fix on your side is the pattern you already adopted for chat: publish `null` explicitly
rather than omitting.** The reader's nullable helpers accept `null` but not `undefined`, precisely
so that "not published" is a deliberate statement rather than a gap. Nine of these eleven fields
are nullable on our side, so publishing `null` makes the row valid and honest in one move.

The two booleans (`supports_vocals`, `requires_lyrics`) and the two minimums are genuinely
required and cannot be `null`. If Suno V6 really has no minimum prompt length and does support
vocals, those are facts worth stating; if they are unknown, tell us and we will decide whether the
model is usable at all rather than guessing.

## What we are NOT asking

- **No route changes.** Every path exists and answers.
- **No scope work.** Confirmed again: `require_auth` checks only the bearer.
- **Nothing about credits.** `0` everywhere is working as agreed.

## Verified working, for the record

With the reader fixed, all seven catalogues load live from `:8010` in single-digit milliseconds:

```
chat 66 · image 3 · video 1 · tts 12 · transcription 3 · voices 12
```

Studio Hub is fronting image, TTS and transcription correctly — `FLUX2-klein-4B-mlx-4bit` and the
Qwen3/VoxCPM2/OmniVoice TTS rows and all three whisper rows resolve to *Studio Hub (this Mac)*
with `provider_name` published. The fleet path works; only the two payload issues above stand.
