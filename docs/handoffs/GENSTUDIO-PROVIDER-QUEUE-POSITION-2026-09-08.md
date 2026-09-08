# GenStudio now queues at provider pace and reports queue position / ETA — Story should show it

**From:** Claude (GenStudio lane) · **To:** GPT / Story Studio app owner · **Date:** 2026-09-08
**Status:** open — GenStudio side is live (1.24.56 + 1.24.57); Story display work is yours.

## What changed on the GenStudio side

Owner decision 2026-09-08: a provider rate limit is routine and must never surface to a customer
as a failure or as "language product is not available". Live now:

- **Admit and queue.** When a provider throttles (HTTP 429 / Retry-After) or GenStudio's own
  per-provider in-flight cap is reached, a language job is ADMITTED and parked (reservation held,
  nothing charged) and dispatched at the provider's learned pace. The old flat 3-minute
  COOLING_DOWN refusal is gone.
- **Retries inside GenStudio.** Provably-not-accepted outcomes (429, documented "not processed",
  connection never opened) are re-queued with backoff (5 s, 15 s, 45 s, 120 s…) for up to 10
  minutes before a job can become FAILED. A read timeout mid-generation stays terminal and
  refunded (no idempotency key on the chat transport; a retry could double-run).
- **Honest refusals only.** 429 + `Retry-After` + "temporarily throttled by the provider, retry
  after Ns" for pressure; 503 + `Retry-After` + a sentence naming the cause when a provider is
  genuinely broken (5xx circuit breaker); the usual codes for out-of-balance, retired product,
  missing credentials.
- **New job fields** on the customer job payload (`GET /v1/account/jobs`, `GET /v1/chat/jobs/{id}`
  and the durable chat job response) — all three null together when the job is not queued:
  - `queue_position` (int, 1 = next), `queue_eta_seconds` (int | null when unknown),
    `queue_reason` (`"provider_pace"`).
- Story-side observation: with `deepseek-v4-flash-genstudio-5` (Experiential, ~18 tok/s) a fan-out
  of 26 research jobs is now dispatched 3 at a time; the rest sit in the queue with positions.

## What Story should do

1. **Show the wait, not a blank "running".** On Project Jobs / All Jobs, when a GenStudio job
   carries `queue_reason = "provider_pace"`, render a calm line such as
   "Queued at provider pace · position 3 · about 40 s" (omit the ETA when null). Refresh with the
   normal poll; positions move as the provider drains.
2. **Stop marking throttles as "needs attention".** Today Story treats a 429 as "External or
   unverified provider work requires a manual Retry". GenStudio now retries these itself and
   returns 429 only when it has already given up within the 10-minute window, or the job is
   admitted-and-queued (202) in the first place. So: a 202 with queue fields = normal progress;
   a 429 with `Retry-After` = auto-retry after that delay (bounded), no operator action; a 503
   with `Retry-After` = provider broken, surface the message and retry after the delay; only the
   existing codes (balance, retired, credentials) need a person.
3. **No client-side fan-out limits needed** for GenStudio-routed language work; the cap lives in
   GenStudio. Story may keep its own batch size for UI reasons.

## Reference

GenStudio PRs: theng12/genstudiokh#106 (timeouts, cap, Retry-After, message) and #107 (adaptive
AIMD limit table `provider_dispatch_limits`, runner retries, queue position/ETA, breaker,
migration 0408). Studio Control gets an operator "provider pace" panel in the next release.
