# Paste this into the new session

You are taking over **Story Studio KH** (an Electron + Nuxt desktop app) on this Mac. Work like the
lead developer: investigate, decide, implement, verify, record — **acting as the orchestrator
`AGENTS.md` §10 requires**, delegating bounded implementation work with a base commit, owned files,
deliverable and proving checks, and keeping one writer per file. Workers do not recursively delegate,
commit, push, or make paid calls unless that authority is explicitly assigned. This is the cold-start
prompt; the repository is the record.

## Read these first, in this order

1. `AGENTS.md` — the rules. They are imperative. §1 (everything follows the published model),
   §8 (verified completion), and `## Working rules` matter most today.
2. `docs/tasks/HANDOFF.md` — the living briefing: current release, working loop, footguns, what's
   open. **Keep it current; update it in every release.** If it disagrees with the code, the code
   wins and you fix the file.
3. `docs/audit/2026-09-26-audit-triage.md` — the triage of an independent audit, with verdicts and
   the exact next step for each item started.
4. `_handoffs/2026-09-26_plain-english-open-items.md` — what the `HUB-n` / `GW-n` row numbers mean,
   in words. Never hand the owner a bare row number.
5. `Story Studio Project Status.md` — the long-form status and review log.

## Standing instructions from the owner (he is on this machine)

- **Ship and install updates yourself. Never wait to be asked.** Bump `package.json` **and**
  `package-lock.json`, add a newest-first `CHANGELOG.md` entry, run `npm run check:changelog`, run the
  **full** backend gate (`npm run test:backend` — never quote a filtered run as a gate), build the DMG
  from the **main** checkout (`npm run dist:smoke`), then install it: quit the app → move the old
  bundle into `_trash/app/` → `ditto "dist/mac-arm64/Story Studio KH.app" "/Applications/Story Studio KH.app"`
  → `xattr -dr com.apple.quarantine` → relaunch → verify from the app's own `/api/health` and its
  server log. Do not leave a verified fix uninstalled. What still needs him is a decision about *what*
  the app should do, never permission to update it.
- **Never `rm`.** Every removal moves to `_trash/` (keep sub-structure, say where it went). `_trash/`
  is his — never tidy inside it. Never rewrite published history.
- **Relay replies are files, not chat messages.** Gateway-kh and Studio Hub read `_handoffs/*.md`.
- Commit and push finished work to `main`; mirror record commits onto `codex/stabilization-takeover`.
- Plain English, one line per item, a recommendation with every decision.

## Where things stand right now

- Installed app: **1.4.225** at `/Applications/Story Studio KH.app` (the Scene Plan item-limit fix,
  landed `38b87ae3`). The bundles it replaced are **no longer in `_trash/app/`** — the owner deleted
  that folder by hand, so `_trash/` now holds only its README; do not go looking for them there.
  Latest gate: **5,646 tests / 5,645 pass / 0 fail / 1 skip, exit 0.**
- `main` = `origin/main` @ `4483bb74` (or later record-only commits above it); work happens on
  `codex/stabilization-takeover`.
- Endpoint: **gateway-kh**, the owner's app at `http://127.0.0.1:8787` (it is running; its key lives
  in Story Studio's own secret store, never print it). **Studio Hub is running on this Mac — leave it
  running.** Local lane: `studio-hub::mlx-community/Qwen3.5-9B-4bit` (free), now publishing
  **16,384 output tokens / 1,800 s**; the voice lane also has 1,800 s.
- Recent fixes already shipped: prose requests send no `response_format` (chapters work on Studio Hub
  lanes); a completion that used its whole requested ceiling counts as **incomplete**; Scene Plan's
  auto window respects the output ceiling; the motion stage's 4,096 cap on the published allowance is
  gone; an unpublished structured-item limit is no longer a limit of zero; chapter splitting uses a
  measured 1.6 tokens/word.
- STORY-2 receipts and a disposable run live in `/tmp/ssk-live/`; the harness is
  `scripts/developer/story-2-local-model-run.ts`.

## The work, in priority order

**1. The independent audit (largest item).** `docs/audit/2026-09-23-independent-audit.md` claims ~90
findings (~26 high/medium) against §8/§6/§4 plus 12 P0s. Triage verdicts live in
`docs/audit/2026-09-26-audit-triage.md`. Take them one at a time, verify against **current** source
(the audit's line numbers are from 1.4.219), and record a verdict with `file:line`.
- **P0-5 — confirmed, do this first.** `generators/images.ts:318` falls back to the hardcoded retired
  paid model `'grok-imagine'`; `generators/music-generate.ts:197` falls back to `models[0]` — the wrong
  paid model, silently. Fix by resolving through `findGenStudioProduct`
  (`contracts/genstudio-product-identity.ts`) and **throwing** (`unavailableLegacyModelMessage`)
  instead of substituting. Prove it: an unknown id must produce **zero** POSTs. Then the ~12 `id ===`
  comparison sites the audit lists.
- **P0-1 (partial):** read the two retry paths in `generators/images.ts` (~`:1058`, `:1499`) and
  determine whether a worker can submit a new **paid** request after a pause; the audit reproduced
  this, so treat it seriously.
- **P0-3 (unverified):** read the `requireJobCompletion` call near `images.ts:1703` and check whether
  `invalid: errors` is missing.
- **Then, in the audit's own order:** P0-9 (presets carrying one episode's title into every other
  episode — the §4 defect class with six recorded instances) and P0-11 (a pipeline auto-run
  overwriting a human's research triage — a §9 violation, found by two auditors independently), then
  P0-2, P0-4, P0-6, P0-7, P0-8, P0-10, P0-12, then Priority 1 and Priority 2.

**2. Exercise the local lane now that its ceilings moved.** A 30-scene plan pack and a 3-chapter batch
against the published 16,384 — the first run that can use Studio Hub's raise. Watch for the same class
of failure the earlier run found (a rambling model, a truncation reported as `finish_reason: "stop"`).

**3. `NEW-11` (small):** identify the packaging step that rewrote `package.json` once. The restore
guard makes it harmless; instrument one `npm run dist:smoke` to hash both manifests after each phase.

**4. Waiting on gateway-kh / Studio Hub — nothing blocked, do not invent anything.**
**The `*_source` enum is already on the wire**: Studio Hub 0.6.72 publishes `source_kind` and
gateway 0.2.48 relays it as `max_output_tokens_source` / `context_window_tokens_source`
(`worker_default` on the local row today). **So this one is ours now** — copy the fields into
`GenStudioChatModel` (`lib/genstudio-client.ts`) and show the label and the `*_source_detail`
sentence next to the number, so 16,384 stops reading as the model's own figure. Still owed by
Studio Hub: `max_structured_items_per_request` and the omitted-parameter statement
(`defaults_scope`). Their outstanding letters are the newest files in `_handoffs/`.

**5. A real end-to-end run** (assembly and upload included) through the real gateway — the earlier
acceptance work covered the language half only.

## Environment footguns that cost time

- Unset `ELECTRON_RUN_AS_NODE` before launching Electron, or it exits silently.
- Backend edits change nothing until `cd electron && npx tsc` **and** a relaunch; only the frontend
  hot-reloads. Put `bundled/ffmpeg` on `PATH` for any audio work.
- One test suite at a time. A filtered run prints `PARTIAL RUN` — it is not a gate.
