# Action: declare the output contract on eight LLM call sites

**From:** the GenStudio KH session, 2026-08-05
**Status:** APPROVED by the owner — please implement
**Companion document:** `LLM-CALL-SITE-SURVEY.md` in this folder has the full
evidence for every call site, including the ones that are already correct.

---

## Read this first — the timing matters

GenStudio currently **forces every language request to return JSON**, regardless
of what was asked for. That is a defect, and the fix is written and committed on
the GenStudio side (`c29f283`) but **deliberately not deployed yet.**

Why it is not deployed: eight call sites in this repo need JSON, never say so,
and are working today only because GenStudio's forcing covers for them. The
moment GenStudio stops forcing, `genstudio-client.ts` falls back to its own
default — **prose** — and those eight start receiving ordinary writing where they
expect parseable data.

- Five would throw.
- One (**metadata template extraction**) would **silently blank fields** — no
  error, just empty output. That is the dangerous one.
- Two would degrade to poor output via tolerant fallback parsers.

**The changes below are safe to ship immediately.** An explicit
`outputContract` behaves identically under GenStudio's current forcing and under
the fixed behaviour. There is no window where declaring the contract makes
anything worse.

**GenStudio will deploy its fix once this ships.** If you need to coordinate,
say so; otherwise the sequence is: this lands → GenStudio deploys → chapter
expansion starts working and nothing else changes.

---

## The mechanism already exists

`electron/server/lib/json-output-contract.ts` defines a per-request
`outputContract` (`prose` / `json_object` / `json_schema`), and
`genstudio-client.ts` already threads it through. **Nothing new needs building.**
These eight sites simply never declare it, so they inherit the prose default.

Where a JSON schema is readily available, prefer `json_schema` over
`json_object` — it is stricter and catches a malformed answer earlier.

---

## The eight, highest risk first

| # | What it is | File | Add |
|---|---|---|---|
| 1 | **Scene planning** — the core pass splitting narration into timed scenes | `electron/server/services/scene-planner.ts:2069` (`planOneWindow`) | `outputContract: { mode: 'json_object' }` |
| 2 | **Style extraction** — "Create Format from sample scripts" | `electron/server/routes/projects.ts:114` | `outputContract: { mode: 'json_object' }` |
| 3 | **Prompt Director** — rewrites scene image prompts to a Visual Recipe | `electron/server/generators/prompt-director.ts:193-198` | `outputContract: { mode: 'json_object' }` |
| 4 | **Idea generation** — the Ideas page "Generate Ideas" button | `electron/server/routes/ideas.ts:600` **and** `:633` (retry pass) | `outputContract: { mode: 'json_object' }` |
| 5 | **Idea Campaign** — batch generation against a Series Formula | `electron/server/generators/idea-campaign.ts:293` | `outputContract: { mode: 'json_object' }` |
| 6 | **Metadata template placeholder extraction** | `electron/server/generators/metadata.ts:250-252` | `outputContract: { mode: 'json_object' }` |
| 7 | **Single image/thumbnail prompt regeneration** | `electron/server/routes/image-prompts-edit.ts:156` | `outputContract: { mode: 'json_object' }` |
| 8 | **Image Pool "suggest prompts from a topic"** | `electron/server/routes/broll-project.ts:625` | `outputContract: { mode: 'json_object' }` |

Every one of these already **instructs the model to return JSON in its prompt
text** and already **parses the reply as JSON**. The declaration is being brought
into line with what the code has always done — this is not a behaviour change.

**#4 has two call sites** — the initial pass and the retry. Both need it; a
retry that silently switches shape would be worse than no retry.

**#6 deserves a second look** beyond the declaration. It currently blanks fields
rather than failing when the answer is unparseable. Consider whether it should
fail loudly instead: a silently empty metadata field ships to YouTube.

---

## Two cosmetic items, same area

**9. `electron/server/routes/vision.ts:108-117`** uses the deprecated
`jsonObject: true` flag rather than `outputContract`. It still works today.
Migrate it while you are here so there is one mechanism rather than two.

**10. `electron/server/services/research/genstudio-web.ts:1-13`** — the header
comment claims the live default route is `POST /v1/chat/completions`. It is not;
`resolveGenStudioChatTransport` defaults to `responses`. Confirmed stale. This
cost the GenStudio session a wrong diagnosis, so it is worth correcting.

---

## Do NOT change these

The survey confirmed these are already correct, and "fixing" them would break
them. They rely on the prose default and are consumed as plain text:

Chapter expansion (narrative, listicle and one-shot repair) · metadata
description/titles/tags · legacy `generateEpisode` script and prompt paths ·
single-scene visual prompt regeneration · single-scene motion prompt
regeneration · docx normalizer · audio expression markup · playlist description
· YouTube comment reply drafts · both research adapters.

**Chapter expansion in particular is already asking correctly.** The live failure
the owner hit was entirely GenStudio's doing. Do not add a contract to it.

`services/research/genstudio.ts` is also already wired correctly — an earlier
handoff flagged it as missing `JSON_OBJECT_OUTPUT_CONTRACT`; that was stale and
has since been fixed.

**Sound design** is not an LLM call at all — it is fully deterministic. **B-roll
shot direction** has prompt and parser code that is never invoked; leave it.

---

## Verification asked for

- For each of the eight, a test that the request carries the contract. These
  broke precisely because nothing asserted the shape being asked for.
- Confirm #6 no longer blanks fields silently, whichever way you resolve it.
- The existing prose call sites must keep working unchanged — the "do not
  change" list above is the regression surface that matters.

## Still outstanding from the earlier handoff

`GENSTUDIO-HANDOFF-20260804.md` in this folder is unrelated to this work and
still open — chiefly **S1**, the `?? 0` coercion at `genstudio-client.ts:2657`
that turns any failed response into a confident claim about what GenStudio
published. That one caused two wrong diagnoses in a single evening and is worth
more than it looks.
