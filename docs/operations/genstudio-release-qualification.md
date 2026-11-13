# Gateway release qualification

Run this once from the repository root before approving a Story Studio build:

```sh
node scripts/qualify-genstudio-release.mjs
```

This is the deterministic pre-release command for the Gateway client
boundary. It runs the focused Gateway contract suite and typechecks that
suite plus its transitive production imports. A non-zero exit blocks
qualification.

The Story Studio KH v1.0.700 release is paired with Gateway Studio KH v0.16.0
(`396806d`). Its exact-release staging qualification
`qrun_f27bf5a5bb4a4d64be05c0581e0691da` passed voice, image, and transcription
on `<fleet-host>` with a zero-job backlog.

## Safety boundary

The qualification is deterministic and zero-spend:

- The Gateway service is an in-process Node HTTP fixture bound to an
  ephemeral `127.0.0.1` port.
- The test installs a fetch-origin guard. Any HTTP request whose origin is not
  that fixture fails the test before the request is sent.
- Keys, jobs, assets, and credit balances are synthetic. The command does not
  read a saved Gateway key, contact a provider, modify a live job, or spend
  credits.
- The fixture returns a generated one-pixel PNG, a short silent WAV, and a
  fixed SRT. TTS uses Story Studio's normal local FFmpeg conversion so the final
  MP3 contract is still exercised.

## Release gates

| Gate | Qualification evidence |
|---|---|
| Catalog and key scopes | Loads the model, voice, image, chat, transcription, and video catalogs with a fully scoped mock key; missing `models:read`, `voices:read`, `images:generate`, or `audio:transcribe` fails closed. |
| Generation scopes | Missing `chat:generate`, `images:generate`, `tts:generate`, or `audio:transcribe` creates no Gateway job. |
| LLM, image, TTS, transcription | Submits every requested modality through the public Gateway routes and verifies its terminal output. |
| Polling and terminal states | Observes `accepted → reserved → dispatched → running → validating → succeeded`, plus terminal `failed`. |
| Account admission | Uses one shared scheduler across modalities and API keys, reads canonical `paid_concurrency_limit`, queue, and submission-rate metadata, and leaves all execution admission authoritative in Gateway. |
| Durable local queue | Preserves local pending work across restart, then resumes the same accepted Gateway job ID instead of creating replacement work. |
| Submission pacing | Applies a rolling account submission-rate window and remote queue backpressure without treating Story Studio's local active count as total account activity. |
| Backpressure | Honors Gateway `Retry-After` guidance for retryable submission and polling responses without creating a second logical request. |
| Credits | The mock ledger proves quoted, reserved, final, and returned credits. Story Studio payloads are rejected if they try to provide any settlement field; Gateway alone owns billing. |
| Idempotency | Drops the first accepted LLM response, then proves the client replays the same `Idempotency-Key`, receives the same job, and creates one provider submission. |
| Cancellation | Proves pre-submit abort creates no job. After acceptance, cancellation stops polling; recovery uses the accepted job ID and never submits replacement work. |
| Failure taxonomy | Keeps `CHAT_PROVIDER_NETWORK_UNAVAILABLE` distinct from `CHAT_PROVIDER_SUBMISSION_UNCERTAIN`; both are terminal, produce no fallback, and return the full reservation. |
| Asset expiry and failed jobs | A succeeded job with an expired private PNG or SRT is incomplete, and a failed TTS job cannot produce an output asset. |
| No fallback | Runtime traffic is restricted to the mock Gateway origin, and a source-boundary check rejects direct-provider or Studio Hub client imports from Gateway-only modules. |

## Credit interpretation

The fixture follows the Gateway's billing invariant:

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
acceptance it stops monitoring while preserving the durable Gateway job ID;
the same job can be recovered without duplicate work. Story Studio must not
invent a direct-provider cancellation or fallback path.

## Admission ownership

Story Studio stages requests through one shared, durable local scheduler so its
own UI and queue remain responsive. The scheduler is advisory: it refreshes
account overview, limits bursts, and stops trickling work near remote queue
capacity, but it never treats local activity as the whole account. It must not
expose or enforce a second customer-facing generation policy. Gateway alone
owns:

- generation submissions per minute;
- active paid jobs and the durable account queue;
- provider and local-worker capacity;

A valid request accepted with HTTP 202 remains the same logical job across
polling errors, app restarts, and artifact-download retries. Only Gateway job
state proves completion.
