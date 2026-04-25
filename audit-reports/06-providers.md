# Session 06 — AI Provider Integrations

**Scope:** the five AI provider adapters under [electron/server/providers/](electron/server/providers/) (Anthropic, OpenAI, kie.ai, FAL.ai, GenAIPro) and the seven shared HTTP clients under [electron/server/lib/](electron/server/lib/) that they wrap. The hazard class is **wallet drain overnight** — a bounded-less retry, a misrouted key, or a poisoned fallback could burn through provider credit before the operator wakes up. Session 04 already flagged two provider-related items (H4 error-body echo, H5 `getConfig()` key leak). This session audits the code on the wire end-to-end against 10 criteria: auth, cost control, error discrimination, streaming/abort, prompt injection into downstream sinks, response validation, downtime fallback, model-ID handling, multi-account routing, and telemetry/proxy use.

**One-line verdict:** **the catastrophic case is covered, but the guard isn't uniform.** [http-retry.ts::pollForResult](electron/server/lib/http-retry.ts:51) caps consecutive failures at 8 with exponential backoff and Retry-After awareness — worst-case on a bad key is ~5 min of polling, not a wallet drain. Image (fal-audio, kie-image) already routes through this helper. **Video polling does not** ([kie-video-client.ts:79](electron/server/lib/kie-video-client.ts:79) still does `if (!resp.ok) continue` inside a 10-minute loop) and genaipro polling has its own untimed, backoff-free loop. Provider error bodies are still echoed to the renderer at 200–300 chars — Session 04's H4 at provider scope. No adapter logs API keys or full request/response bodies, and every endpoint hits the provider's documented URL with no proxy. Three High, five Medium, two Low findings below.

---

## Part A — Authentication & key hygiene

### 1. API keys never logged, never proxied — ✓

Grepped all 11 provider files + 7 lib/ clients for `console.log`, `logger.`, and `apiKey` appearing together in a log-like statement. The only dispatch-time log is [registry.ts:152,165,170](electron/server/providers/registry.ts:152), which emits `providerId`, `accountId`, `label`, `model`, and `jobId` — the key itself is **not** in the log line. Every client's POST/poll sends the key as `Authorization: Bearer ${apiKey}` (`Key ${apiKey}` for fal) and never as a URL query parameter at the provider scope. ([kie-client.ts:24-26](electron/server/lib/kie-client.ts:24), [kie-video-client.ts:52-55](electron/server/lib/kie-video-client.ts:52), [fal-client.ts:56-59](electron/server/lib/fal-client.ts:56), [genaipro-client.ts:64-67](electron/server/lib/genaipro-client.ts:64), [genaipro-veo-client.ts:32](electron/server/lib/genaipro-veo-client.ts:32).) Cross-reference: Session 02 C2 (Gemini image-edit key in URL) is a **different** call site ([image-edit-client.ts:72](electron/server/lib/image-edit-client.ts:72)) — not part of the adapters audited here, still live there.

Every base URL is hardcoded to the documented provider endpoint. No proxy, no telemetry intermediary:

| Provider | Base URL | File |
|---|---|---|
| Anthropic | `https://api.anthropic.com` (via SDK) | [text/anthropic.ts:33](electron/server/providers/text/anthropic.ts:33) |
| OpenAI | `https://api.openai.com` (via SDK) | [text/openai.ts:38](electron/server/providers/text/openai.ts:38) |
| kie.ai text | `https://api.kie.ai/api/v1` | [text/kie-text.ts:36](electron/server/providers/text/kie-text.ts:36) |
| kie.ai image/video | `https://api.kie.ai/api/v1` | [lib/kie-client.ts:15](electron/server/lib/kie-client.ts:15), [lib/kie-video-client.ts:8](electron/server/lib/kie-video-client.ts:8) |
| FAL.ai audio | `https://queue.fal.run/{slug}` | [lib/fal-client.ts:71](electron/server/lib/fal-client.ts:71) |
| GenAIPro | `https://genaipro.vn/api` | [lib/genaipro-client.ts:10](electron/server/lib/genaipro-client.ts:10), [lib/genaipro-veo-client.ts:13](electron/server/lib/genaipro-veo-client.ts:13) |

(Criteria 1 + 10.)

### 2. Multi-account key routing — ✓

[registry.ts:128-184](electron/server/providers/registry.ts:128) resolves `(slug, providerId, ctx.accountId?)` via [secrets-accounts.ts::resolveApiKey](electron/server/services/secrets-accounts.ts) and falls back to `''` on `account_not_found` or `unknown_provider`. Callers surface "no key configured" at the existing check — no mis-routing risk found. The same key is used for all concurrent requests in a `runLimitedSettled` batch ([kie.ts:59](electron/server/providers/video/kie.ts:59), [fal.ts:79](electron/server/providers/video/fal.ts:79)), which is correct: one key per logical job. (Criterion 9.)

### 3. Model-ID allowlist is prefix-based, not explicit — **Medium finding**

Text providers accept models that *look like* the provider's models:

- [anthropic.ts:22-24](electron/server/providers/text/anthropic.ts:22): `MODELS.includes(modelId) || modelId.startsWith('claude-')`
- [openai.ts:24-29](electron/server/providers/text/openai.ts:24): `MODELS.includes || startsWith('gpt-') || /^o[1-9]/.test(modelId)`
- [kie-text.ts:22-24](electron/server/providers/text/kie-text.ts:22): `modelId in MODEL_MAP || modelId.endsWith('-kie')`

A typo like `claude-opus-4-7` routes to the Anthropic SDK and fails cleanly as a 404 model-not-found — not a wallet drain. But the **image-generation path is laxer**: `modelConfig.endpoint` is a user-config string appended to the hardcoded kie base URL ([kie-client.ts:47](electron/server/lib/kie-client.ts:47)). A hand-edited `config.json` with `"endpoint": "/../../admin"` still resolves against `api.kie.ai` (the base URL is hardcoded, not user-controllable), so it can't be redirected off-provider — but it *can* reach arbitrary paths on kie.ai, which is still an unexpected surface. (Criterion 8.)

→ No fix task — track in Session 08 if a cleaner allowlist pattern shows up; today's impact is confusing error messages, not wallet risk.

---

## Part B — Cost control & retry behaviour

### 4. `pollForResult` is the reference retry loop — ✓

[http-retry.ts:51-96](electron/server/lib/http-retry.ts:51) is the only well-behaved polling loop in the repo:

- `MAX_CONSECUTIVE_FAILURES = 8` ([:13](electron/server/lib/http-retry.ts:13)) with escalation to `throw` on the 9th ([:64-65, 73-75](electron/server/lib/http-retry.ts:64)) so a sustained 401/429/502 surfaces as a *real error* instead of a silent `MAX_WAIT` timeout.
- `Retry-After` respected as numeric seconds OR HTTP-date ([:99-113](electron/server/lib/http-retry.ts:99)), capped at 60 s.
- Exponential backoff otherwise: `baseMs * 2^min(consecutive, 5)` capped at 60 s.
- Per-poll `AbortSignal.timeout(30_000)` ([:60](electron/server/lib/http-retry.ts:60)) so a hung TCP socket can't block the loop.
- `isCancelled` probe ([:54, :120-127](electron/server/lib/http-retry.ts:54)) threaded through `sleepCancellable` so a user-cancelled job exits in ≤200 ms instead of after a 60-second backoff.

[kie-client.ts::pollForImageUrls](electron/server/lib/kie-client.ts:154) and [fal-client.ts::generateTts](electron/server/lib/fal-client.ts:99) already use or mirror this pattern. (Criterion 2, partial.)

### 5. Video polling predates the retry-helper refactor — **High finding**

[kie-video-client.ts:79](electron/server/lib/kie-video-client.ts:79):

```ts
if (!resp.ok) continue
```

Inside a 10-minute poll loop. A sustained 401 (bad key) silently loops every 6 s until `MAX_WAIT = 600_000` ([:10](electron/server/lib/kie-video-client.ts:10)) elapses, then throws `kie.ai video task ${taskId} did not complete within 600s`. The user has no way to tell a bad key from a slow upstream. This is the exact anti-pattern `http-retry.ts` was introduced to replace; the image client got migrated, the video client was skipped. No POST happens per poll — **not wallet-scale drain** — but it misleads the operator for 10 min on a clearly-terminal auth error.

Also missing from the video poll loop:
- No `AbortSignal.timeout(...)` on the poll GET (fixed; see M1 below — actually [kie-video-client.ts:77](electron/server/lib/kie-video-client.ts:77) *does* have `AbortSignal.timeout(30000)`, so this one is OK).
- `successFlag >= 2 ? 'failed' : 'pending'` ([:84-86](electron/server/lib/kie-video-client.ts:84)) silently maps unknown types to `pending`, feeding the silent-loop behaviour. If the provider ever returns `successFlag: "2"` as a string, comparison behaviour is JS-coerced and still works; a `null` or object return would map to `pending` forever.

→ **Fix task spawned: "Fix: migrate kie-video-client polling to pollForResult"**

### 6. genaipro poll loops ignore Retry-After and have no backoff — **Medium finding**

[genaipro-client.ts:99-112](electron/server/lib/genaipro-client.ts:99):

```ts
while (Date.now() < deadline) {
  await sleep(POLL_INTERVAL)
  const poll = await fetch(`${BASE}/v1/labs/task/${task_id}`, { headers })
  if (!poll.ok) {
    const err = await poll.text()
    throw new Error(`GenAIPro poll failed (${poll.status}): ${err.slice(0, 200)}`)
  }
  ...
}
```

The loop hard-fails on *any* non-2xx, including 429. No `Retry-After` read. No exponential backoff. No `AbortSignal.timeout` on the poll fetch — a hung socket blocks for the full 20-minute `MAX_WAIT` ([:16](electron/server/lib/genaipro-client.ts:16)). [genaipro-veo-client.ts:67-83](electron/server/lib/genaipro-veo-client.ts:67) has the same shape.

Impact: user hits one 429 tick and the whole TTS task fails instead of waiting the provider-suggested N seconds. Not a wallet drain, but undermines reliability. Should share `pollForResult`.

### 7. Missing per-request timeouts on submit fetches — **Medium finding (M1)**

[fal-client.ts:71](electron/server/lib/fal-client.ts:71) (`POST /queue.fal.run/{slug}`), [genaipro-client.ts:80](electron/server/lib/genaipro-client.ts:80) (`POST /v1/labs/task`), [genaipro-veo-client.ts:30,53](electron/server/lib/genaipro-veo-client.ts:30) (both multipart and JSON submit) — none have `AbortSignal.timeout(...)`. Kie by contrast does ([kie-client.ts:49](electron/server/lib/kie-client.ts:49), [kie-video-client.ts:61](electron/server/lib/kie-video-client.ts:61)). If the provider accepts the TCP connection but never sends a response, the generator blocks indefinitely. The user-facing effect is a stuck job; the code-level effect is that cancellation from the job-queue side has no plumbing to the `fetch()` call.

→ No fix task spawned; roll into Session 07 (wizard/validation) or handle alongside the H1 video-client migration.

### 8. Streaming abort semantics — ✓ (SDK-managed)

Anthropic and OpenAI text providers both use the official SDKs' streaming API ([anthropic.ts:36-49](electron/server/providers/text/anthropic.ts:36), [openai.ts:41-56](electron/server/providers/text/openai.ts:41)). The `for await` iterator is the only closure mechanism; the SDKs close the upstream socket on iterator exit. No explicit `AbortController` is wired by the adapter, but because the SDK owns the HTTP response, aborting the iterator closes the upstream. Not ideal (cancelling a job further up the call stack does not cancel an in-flight Anthropic stream), but **not charging-after-cancel**. (Criterion 4.)

Media providers (kie/fal/genaipro) use submit→poll→download, not true streaming. Cancelling the poll loop (via the `isCancelled` probe in `pollForResult`) stops polling but does **not** send a cancel signal to the provider — the task continues server-side and the user is charged for work they won't use. This is a provider-side limitation (kie exposes no cancel endpoint; fal's queue has one but the adapter doesn't call it) and is a known cost-of-doing-business for this session.

---

## Part C — Response handling & validation

### 9. Provider error bodies echoed verbatim up to 300 chars — **High finding (re-confirms Session 04 H4)**

Session 04 Part B downgraded H4 from "High" to "Medium" under the personal-multi-machine model, and left the fix-task *"Fix: sanitize provider errors before returning to renderer"* live. This session **re-confirms it at provider scope** and restores a **High** severity for the specific finding that API keys can transit through error bodies.

Call sites that slice upstream response text into `throw new Error(...)`:

| File:line | Slice length | Error body source |
|---|---:|---|
| [kie-client.ts:54](electron/server/lib/kie-client.ts:54) | full (no slice) | kie.ai submit response |
| [kie-client.ts:175](electron/server/lib/kie-client.ts:175) | 200 | kie.ai poll response |
| [kie-client.ts:237](electron/server/lib/kie-client.ts:237) | 500 | kie.ai success-but-no-URL response |
| [kie-video-client.ts:65](electron/server/lib/kie-video-client.ts:65) | 300 | kie.ai video submit response |
| [fal-client.ts:79](electron/server/lib/fal-client.ts:79) | full | fal.ai submit response |
| [genaipro-client.ts:87](electron/server/lib/genaipro-client.ts:87) | 300 | GenAIPro submit response |
| [genaipro-client.ts:104](electron/server/lib/genaipro-client.ts:104) | 200 | GenAIPro poll response |
| [genaipro-veo-client.ts:37,60,76](electron/server/lib/genaipro-veo-client.ts:37) | 200-300 | Veo submit / poll responses |
| [http-retry.ts:75](electron/server/lib/http-retry.ts:75) | 200 | any `pollForResult` caller |
| [text/anthropic.ts:71](electron/server/providers/text/anthropic.ts:71) | unbounded (`err.message`) | Anthropic SDK error |
| [text/openai.ts:76](electron/server/providers/text/openai.ts:76) | unbounded | OpenAI SDK error |
| [text/kie-text.ts:72](electron/server/providers/text/kie-text.ts:72) | unbounded | kie.ai DeepSeek SDK error |

OpenAI and Anthropic don't echo the submitted key in 4xx bodies (verified against their public error shapes). kie/fal/genaipro are **unverified** — their error bodies have been observed to echo submitted field contents in some failure modes. If an operator's key ever ends up in an upstream response, the chain from `throw new Error(... ${text} ...)` → JobQueue output_lines → renderer → `logs/*.log` means the key is in plaintext in logs that travel in support bundles.

→ **Fix task spawned: "Fix: redact API keys from provider error bodies before surfacing"**

### 10. Response validation is field-sniffing + regex fallback — **Medium finding (M4, M5)**

No `zod`/`joi`/`ajv` anywhere in the provider tree. Every adapter does `await resp.json()` then `data?.field?.subfield` access with fallback chains. Two specific footguns:

- **Regex URL scrape on unknown JSON shapes.** [fal-client.ts:131-134](electron/server/lib/fal-client.ts:131) and [kie-video-client.ts:139-142](electron/server/lib/kie-video-client.ts:139) both do: if the documented result fields are absent, `JSON.stringify(result).match(/https?:\/\/[^\s"']+\.(mp3|wav|mp4|webm|mov)[^\s"']*/)`. A provider error response that contains a URL-shaped string (billing help-center link, tutorial pointer, signed error redirect) could be matched and downloaded as the "generated" asset. Low probability; unusual trust surface.
- **`successFlag` brittle comparison.** [kie-client.ts:192](electron/server/lib/kie-client.ts:192), [kie-video-client.ts:84-86](electron/server/lib/kie-video-client.ts:84): `successFlag >= 2 ? 'failed' : 'pending'`. Works today because the provider returns `0|1|2|3`. If they ever start returning `null`, a string, or an enum, the comparison silently classifies as `pending` and the loop spins until `MAX_WAIT`. Brittle, no schema validation to catch shape drift.

→ No fix task spawned (Medium).

### 11. Prompt injection from LLM output into YouTube metadata sink — **High finding**

[generators/episode.ts:193](electron/server/generators/episode.ts:193) defines `youtubePrompt(code, title, storySummary)` which asks the LLM to produce a YouTube description. The response flows via [:353](electron/server/generators/episode.ts:353) into episode metadata, which [generators/youtube-upload.ts:120-126](electron/server/generators/youtube-upload.ts:120) passes to `updateVideoMetadata({ snippet: snippetFromMeta(meta), ... })`. `snippetFromMeta` at [lib/upload-metadata.ts:144-151](electron/server/lib/upload-metadata.ts:144) is a pass-through:

```ts
export function snippetFromMeta(meta: EpisodeMetadataForUpload): VideoSnippet {
  return {
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    categoryId: '22',
  }
}
```

No length cap. No control-char stripping. No URL-in-title rejection. No escape of YouTube-specific markup. The LLM output is trusted byte-for-byte as YouTube metadata.

Risk is bounded by: you're paying for your own LLM output, so the primary attacker is "a provider that prompt-smuggles a novel payload into its response." Probability low. Impact: the operator publishes a video whose title/description contains content the operator did not compose — brand risk. This is the same class as H1/04 (wrong-channel upload), one rung less severe because the metadata is reviewable before the video goes public.

`snippetFromMeta` is the correct sanitization seam — one function, three fields, called from every upload path ([youtube-upload.ts:124,140](electron/server/generators/youtube-upload.ts:124); [routes/upload.ts:650,1032,1081,1165](electron/server/routes/upload.ts:650)).

→ **Fix task spawned: "Fix: sanitize LLM output before it lands in YouTube metadata"**

(FFmpeg-argument sink is out of scope for this session; Session 05's FFmpeg task already covers spawn-arg safety.)

---

## Part D — Resilience & multi-account

### 12. No provider-downtime fallback — **Low finding (L1)**

If Anthropic is down and `config.script_model === 'claude-sonnet-4-6'`, [anthropic.ts:68-69](electron/server/providers/text/anthropic.ts:68) throws `"Anthropic API is overloaded. Try again in a few minutes."` with no "try your OpenAI key" breadcrumb. Same for 401 (anthropic.ts:62-63). Registry has no "try another provider on terminal failure" hook. Under the personal-multi-machine model this is acceptable — operator sees a clear error and switches providers manually in Settings. Flagging per criterion 7; no fix required.

### 13. No global spend cap — **Low finding (L2, cross-reference)**

Session 04 §3 ("Provider retry drains wallet overnight") already documented: `http-retry.ts:13,64,73` caps *consecutive* failures but **not lifetime cost**. Alternating 200/429 or a malformed input that bounces on every render defeats the consecutive-failure cap. Session 04 punts this to Session 06; **Session 06 punts it again** to a dedicated spend-cap design (daily budget + job-queue gate), because it's out of scope for the provider-adapter audit proper. Noted here for cross-reference only. (Criterion 2, partial.)

### 14. Session 04 H5 — `getConfig()` merges raw keys into callers' objects

Still live at [project-manager.ts:477-483](electron/server/services/project-manager.ts:477). Not a provider-scope finding (it's a service-manager issue), referenced here only so readers understand the end-to-end key-handling picture: secrets land in `secrets.json` under mode 0600 + safeStorage envelope ([secrets-store.ts:197-210](electron/server/services/secrets-store.ts:197)), but a `getConfig()` caller gets them merged into the return value. Session 04's existing fix-task **"Fix: stop leaking raw keys through getConfig()"** still covers it. Not re-spawned here.

### 15. Session 04 H4 — error-body echo

See finding #9 above. H4's existing fix-task **"Fix: sanitize provider errors before returning to renderer"** covers the logger/renderer side; this session's H2 fix-task **"Fix: redact API keys from provider error bodies before surfacing"** covers the adapter side. Both should land together; the redaction utility H2 introduces is the implementation of what H4 asks for. Coordinate the two tasks rather than doing them independently.

---

## Findings summary

| # | Finding | Severity | Affects |
|---|---|---|---|
| 1 | API keys never logged; all endpoints hit documented provider URLs; `pollForResult` solid | ✓ positive | Criteria 1, 10, 2 |
| 2 | Multi-account key routing clean — no mis-route risk | ✓ positive | Criterion 9 |
| 3 | Model-ID allowlist is prefix-based, not explicit | Medium (M3) | Criterion 8 |
| 4 | `pollForResult` reference implementation | ✓ positive | Criterion 2 |
| 5 | **Video polling predates retry-helper refactor** — `kie-video-client.ts:79` silently loops 10 min on 401 | **High (H1)** | Criteria 2, 3 |
| 6 | genaipro poll loops ignore Retry-After, no backoff, no per-request timeout | Medium (M2) | Criteria 2, 3 |
| 7 | Missing `AbortSignal.timeout` on fal submit + genaipro submit/poll | Medium (M1) | Criterion 4 |
| 8 | Streaming abort SDK-managed; media providers leak cost-after-cancel (no provider cancel endpoint called) | Positive w/ note | Criterion 4 |
| 9 | **Provider error bodies echoed verbatim up to 300 chars** — API-key leakage path if upstream echoes it | **High (H2)** | Criteria 3, 5; re-confirms S04 H4 |
| 10 | Response validation is field-sniffing + regex URL fallback; `successFlag >=2` brittle | Medium (M4, M5) | Criterion 6 |
| 11 | **LLM output → YouTube metadata sink has no sanitization** | **High (H3)** | Criterion 5 |
| 12 | No provider-downtime fallback | Low (L1) | Criterion 7 |
| 13 | No global spend cap (cross-ref S04 §3) | Low (L2) | Criterion 2 |
| 14 | S04 H5 `getConfig()` key leak still live — not re-filed | cross-ref | Secrets hygiene |
| 15 | S04 H4 error-body echo still live — adapter-side fix is H2 above | cross-ref | Secrets hygiene |
