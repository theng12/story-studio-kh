# fal.ai model slug audit — Delivery 5

**Date:** 2026-04-21
**Method:** WebFetch each slug's public page at `https://fal.ai/models/<slug>`; treat HTTP 200 + no deprecation notice = verified; HTTP 404 = missing. Cross-checked ambiguous cases against fal.ai's blog post ["ElevenLabs Audio Suite: Next-Generation Voice and Audio AI Now on fal"](https://blog.fal.ai/elevenlabs-audio-suite-next-generation-voice-and-audio-ai-now-on-fal/) and the [ElevenLabs landing page on fal.ai](https://fal.ai/elevenlabs).

## TTS (from `electron/server/lib/fal-client.ts` + `electron/server/models/defaults.ts`)

| Slug | File:line | Status | Notes |
|---|---|---|---|
| `fal-ai/elevenlabs/tts/turbo-v2.5` | [fal-client.ts:19](../../electron/server/lib/fal-client.ts) | ✅ verified | Low-latency ElevenLabs model. Active. |
| `fal-ai/elevenlabs/tts/v2` | [fal-client.ts:20](../../electron/server/lib/fal-client.ts) | ❌ missing | **404 on fal.ai.** No such endpoint exists. The ElevenLabs v2 engine was superseded by `eleven-v3`. |
| `fal-ai/elevenlabs/tts/multilingual-v2` | [fal-client.ts:21](../../electron/server/lib/fal-client.ts) | ✅ verified | 29-language stable narration. Active. |
| `fal-ai/elevenlabs/tts/flash-v2.5` | [fal-client.ts:22](../../electron/server/lib/fal-client.ts) | ❌ missing | **404 on fal.ai.** I added this in Delivery 1 as a "gap fix" assuming the slug mirrored ElevenLabs' own Flash v2.5 model — it does not exist on fal.ai's queue. fal.ai's low-latency option is `turbo-v2.5`. |
| `fal-ai/elevenlabs/tts/eleven-v3` | *(new)* | ✅ verified | ElevenLabs' latest TTS model. $0.10/1K chars, 70+ languages, inline emotion tags. **Add as a replacement** for the missing `v2`. |

### Related legacy catalog entries (`DEFAULT_AUDIO_MODELS`)
| Id | Slug it routed to | Decision |
|---|---|---|
| `v2` | `fal-ai/elevenlabs/tts/v2` (missing) | **Remove**. Users should pick `eleven-v3` or `multilingual-v2` going forward. |
| `flash-v2.5` | `fal-ai/elevenlabs/tts/flash-v2.5` (missing) | **Remove**. No equivalent on fal.ai — low-latency path is `turbo-v2.5`. |
| `eleven-v3` | *(new)* `fal-ai/elevenlabs/tts/eleven-v3` | **Add**. Pricing ~$0.10/1K chars per fal.ai. |

## Video (`electron/server/models/defaults.ts`)

| Slug | File:line | Status | Notes |
|---|---|---|---|
| `fal-ai/veo3.1` | [defaults.ts:67](../../electron/server/models/defaults.ts) | ✅ verified | Active, pricing "From $0.20/s". |
| `fal-ai/veo3.1/image-to-video` | [defaults.ts:75](../../electron/server/models/defaults.ts) | ✅ verified | Listed as an endpoint variant on the Veo 3.1 page. |
| `fal-ai/sora-2/text-to-video` | [defaults.ts:83](../../electron/server/models/defaults.ts) | ✅ verified | Active partner model. |
| `fal-ai/sora-2/image-to-video` | [defaults.ts:91](../../electron/server/models/defaults.ts) | ✅ verified | Active partner model. |
| `fal-ai/minimax/hailuo-02/standard/text-to-video` | [defaults.ts:99](../../electron/server/models/defaults.ts) | ✅ verified | $0.045/sec 768P. |
| `fal-ai/minimax/hailuo-02/standard/image-to-video` | [defaults.ts:107](../../electron/server/models/defaults.ts) | ✅ verified | Same pricing as t2v. |
| `fal-ai/wan/v2.2-a14b/image-to-video` | [defaults.ts:115](../../electron/server/models/defaults.ts) | ✅ verified | Current flagship Wan i2v model, major upgrade notice on the page but not a deprecation. |

No corrections needed for video — all 7 slugs verified against their live pages.

## Actions taken in this delivery

1. **`lib/fal-client.ts`** — dropped `'v2'` and `'flash-v2.5'` entries; added `'eleven-v3'`. Removed the silent `|| FAL_MODELS['turbo-v2.5']` fallback so an unknown model now throws with a clear message instead of silently running turbo.
2. **`models/defaults.ts`** — dropped the `'v2'` and `'flash-v2.5'` entries from `DEFAULT_AUDIO_MODELS`; added an `'eleven-v3'` entry with `provider: 'fal'` and cost `$0.10/1K chars` per fal.ai's pricing.
3. Left the `genaipro-*` audio models alone — those are on a different gateway (genaipro.vn), not fal.ai, so this audit doesn't cover them.
4. Left the `eleven_*` direct-API models alone — those hit ElevenLabs directly, not fal.ai.

## Follow-ups

- The audit did not cover non-fal providers. A separate pass should verify ElevenLabs direct API slugs (`eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`) against [elevenlabs.io/docs/models](https://elevenlabs.io/docs/models) — the `eleven_flash_v2_5` direct-API slug is plausible but was not re-verified here.
- Consider surfacing a one-time migration notice in the UI for any existing project whose saved audio model id is `v2` or `flash-v2.5`, since those will now fail-loud at generation time instead of silently routing to turbo.
