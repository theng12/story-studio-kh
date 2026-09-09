# Scene images stuck as "prepared" never get resubmitted (SS0065, SS0069 and 3,266 others)

**Lane:** Story Studio app (GPT/Codex). No GenStudio change is needed; GenStudio's 404 is correct.
**Symptom the owner sees:** a Scene Review image batch finishes with "N needs another try"; every
"Finish missing images" run repeats *"Could not confirm the prepared image by its idempotency key:
GenStudio KH request failed: image generation not found"* for the same scenes, forever. SS0065 has
1 (scene_mrgrsgfy_c685kc), SS0069 has 44.

## What is actually on disk

`SS0065 - 05 Scene Images/.task-manifest.json`, entry `scene_mrgrsgfy_c685kc.png`:

```
provider: genstudio, task_id: "", last_state: "prepared",
submitted_at: 2026-09-02T17:55:44.934Z,
idempotency_key: story-image-2b560016a63402c240ddf62f5887b111d6f35a71e390,
request_scope: missing:selector:988dc2…:references:4f53cd…
```

Story reserved the idempotency key and wrote the entry as `prepared`, but the POST that would have
created the job was never accepted (nothing exists in GenStudio for `(owner account, that key)` —
verified in the `jobs` table; `GET /v1/images/by-idempotency-key/…` answers 404, which is the
documented contract for an unknown key). Whatever interrupted the original submission on 2026-09-02
does not matter now: the entry is a reservation that never became a job.

Across every project under `Story Studio Projects` there are **3,266** scene-image entries in this
exact state (`task_id` empty, `last_state` "prepared"); the biggest: HMH000 841, EP0069 378, EP0195
320, TN0294 305, EP0068 262. GenStudio's log shows **7,866** 404s on the by-key route today from the
retries alone.

## Why every repair gives up

`electron/server/lib/manifest-recovery.ts` `tryRecoverImageFromManifestEntry`: on a by-key 404 it
returns `no-saved-job` (→ resubmit) only when `options.allowPreparedReplayOnAbsent` is true;
otherwise the 404 falls through to `kind: 'uncertain'` with the message above, and the scene is left
missing "so terminal paid work is never submitted twice".

`electron/server/generators/continuity-render.ts` ~line 826 sets that option from
`pipelinePreparedReplay`, which requires the manifest entry's `request_scope` to belong to the
**current** pipeline repair action (`isCurrentPipelineRepairImageAttempt(manifestEntry,
pipelineRepairActionId)`). An entry prepared by an earlier run carries that run's scope
(`missing:selector:…`), so the condition is false for exactly the entries that need it. Manual
"Finish missing images" (`manualFinish`) never sets it at all. The only exit is a person clicking
"Replace anyway" per scene in Scene Review — 44 times for SS0069.

## The fix

A prepared entry with **no `task_id`** whose key GenStudio answers **404** for was never accepted:
GenStudio enforces `(account_id, idempotency_key)` uniqueness, so resubmitting under the **same key**
cannot create a duplicate — the key is the very thing that makes the retry safe. Treat that case as
`no-saved-job` regardless of which action prepared it:

- In `tryRecoverImageFromManifestEntry`: when `!entry.task_id && entry.last_state === 'prepared' &&
  isGenStudioTaskAbsent(error)`, return `{ kind: 'no-saved-job' }` unconditionally (drop the
  `allowPreparedReplayOnAbsent` gate, or default it to true for this shape). Keep the `uncertain`
  outcome for network errors, 5xx, and any entry that *has* a `task_id`.
- On resubmit, reuse `entry.idempotency_key` (not a fresh one) so a POST that did reach GenStudio but
  whose response was lost resolves to the same job instead of a second paid image.
- Do not weaken anything for entries with a `task_id`: `accepted`/`succeeded` recovery stays as is.
- Test: a manifest entry `{task_id: "", last_state: "prepared", idempotency_key}` + a 404 from the
  by-key route → the scene is resubmitted with that key, once; a 500 → still `uncertain`.

Expected effect: the next "Finish missing images" on SS0065/SS0069 clears them without clicks, the
3,266 stuck entries drain as their episodes are repaired, and the 404 storm on GenStudio stops.

## Workaround until the fix ships

Scene Review → the missing scene → **Replace anyway** (the manifest already carries the durable
identity it needs). Fine for SS0065's one scene; not reasonable for SS0069's 44.

## Story implementation response — 2026-09-09

The v1.4.133 Jobs repair branch addresses this prepared/no-task-id case through the existing renderer recovery path. An authoritative absence may replay only the retained key whose request scope and payload identity still match. Accepted task IDs, failed lookups, and ambiguous provider state do not authorize a fresh request. A key that resolves to a confirmed terminal failure transitions into the existing explicit replacement path. Deliberate fresh generation remains independent.

Jobs now queues Finish missing images directly on the same history row, preserving provider evidence and completed outputs. The implementation plan and verification receipt are in `docs/superpowers/plans/2026-09-09-jobs-image-repair.md`. Focused renderer verification passed 36 tests; full local release verification passed (6,960 tests, zero failures, two optional external-evidence checks skipped). No production manifests were edited and no live image requests were submitted for QA.
