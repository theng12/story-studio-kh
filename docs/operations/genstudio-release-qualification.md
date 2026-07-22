# GenStudio release qualification

Run this once from the repository root before approving a Story Studio build:

```sh
node scripts/qualify-genstudio-release.mjs
```

This is the single pre-release command for the GenStudio client boundary. It
runs the focused GenStudio contract suite and typechecks that suite plus its
transitive production imports. A non-zero exit blocks qualification.

## Safety boundary

The qualification is deterministic and zero-spend:

- The GenStudio service is an in-process Node HTTP fixture bound to an
  ephemeral `127.0.0.1` port.
- The test installs a fetch-origin guard. Any HTTP request whose origin is not
  that fixture fails the test before the request is sent.
- Keys, jobs, assets, and credit balances are synthetic. The command does not
  read a saved GenStudio key, contact a provider, modify a live job, or spend
  credits.
- The fixture returns a generated one-pixel PNG, a short silent WAV, and a
  fixed SRT. TTS uses Story Studio's normal local FFmpeg conversion so the final
  MP3 contract is still exercised.

## Release gates

| Gate | Qualification evidence |
|---|---|
| Catalog and key scopes | Loads the model, voice, image, chat, transcription, and video catalogs with a fully scoped mock key; missing `models:read`, `voices:read`, `images:generate`, or `audio:transcribe` fails closed. |
| Generation scopes | Missing `chat:generate`, `images:generate`, `tts:generate`, or `audio:transcribe` creates no GenStudio job. |
| LLM, image, TTS, transcription | Submits every requested modality through the public GenStudio routes and verifies its terminal output. |
| Polling and terminal states | Observes `accepted → reserved → dispatched → running → validating → succeeded`, plus terminal `failed`. |
| Credits | The mock ledger proves quoted, reserved, final, and returned credits. Story Studio payloads are rejected if they try to provide any settlement field; GenStudio alone owns billing. |
| Idempotency | Drops the first accepted LLM response, then proves the client replays the same `Idempotency-Key`, receives the same job, and creates one provider submission. |
| Cancellation | Proves pre-submit abort creates no job. After acceptance, cancellation stops polling; recovery uses the accepted job ID and never submits replacement work. |
| Failure taxonomy | Keeps `CHAT_PROVIDER_NETWORK_UNAVAILABLE` distinct from `CHAT_PROVIDER_SUBMISSION_UNCERTAIN`; both are terminal, produce no fallback, and return the full reservation. |
| Asset expiry and failed jobs | A succeeded job with an expired private PNG or SRT is incomplete, and a failed TTS job cannot produce an output asset. |
| No fallback | Runtime traffic is restricted to the mock GenStudio origin, and a source-boundary check rejects direct-provider or Studio Hub client imports from GenStudio-only modules. |

## Credit interpretation

The fixture follows GenStudio's billing invariant:

```text
quote → reserve maximum → verify terminal output → settle final usage
                                      failure → settle zero
                      unused or failed reservation → return credits
```

The public job payload may describe current `credit_cost` and
`remaining_credits`; the release harness keeps a separate authoritative mock
ledger for the four values above. This prevents a test from accidentally
"proving" billing by trusting numbers supplied by Story Studio itself.

## Cancellation interpretation

For LLM, image, TTS, and transcription, Story Studio cancellation is a
cooperative client stop. Before acceptance it prevents submission. After
acceptance it stops monitoring while preserving the durable GenStudio job ID;
the same job can be recovered without duplicate work. Story Studio must not
invent a direct-provider cancellation or fallback path.
