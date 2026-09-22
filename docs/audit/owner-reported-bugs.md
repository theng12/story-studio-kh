# Owner-reported bugs — intake list

**What this file is for.** Drop anything you notice here in plain language — no format, no
reproduction steps needed. One bullet (or one paragraph) per bug is enough. The lead session reads
this file at the start of every session, gives each item an `OB-###` id, and moves it into the real
machine:

- [`Story Studio Project Status.md`](../../Story%20Studio%20Project%20Status.md) — the source of
  truth: what is queued, what is in progress, what is fixed, and the exact next step.
- `docs/handoffs/deepseek-reports/DS-XX.md` — the evidence for each finished packet.

**The workflow for each item**

1. **Intake** — recorded here with an `OB-###` id and whatever you saw.
2. **Triage** — either matched to an existing candidate (`H-16`, `E-04`, …), promoted to a new
   `NEW-###`, or queued as a packet (`DS-XX`).
3. **Reproduce** — this is the important part: a bug is only "confirmed" once it fails on purpose in
   a test or a rendered screen. Until then it stays **open**, never "fixed".
4. **Verify** — a fix is only "fixed" once the failure is reproduced first (RED), the smallest fix
   is applied, and the affected tests and lanes pass (GREEN).
5. **Record** — the status file and a `DS-XX` report get the outcome, the exact commands, the
   counts, and any limitation. If it can't be done, it is marked `blocked` / `deferred` with the
   reason — never quietly dropped.

**How you can add a bug**

- Easiest: just tell me in chat ("OB: when I switch episodes the audio list shows the old one").
  I will add it here and to the status file before doing anything else.
- Or edit this file yourself and add a bullet under **Open reports**. It survives everything —
  closing the app, a new session, a reboot.
- If you have a screenshot or a job id, mention it; it shortens reproduction a lot.

---

## Open reports

_Add new bullets here. Oldest first or newest first — either is fine._

<!--
Example of the shape that helps most (not required):

- **OB-001** — On the video Mac, switching to Episode 3 keeps Episode 2's audio list on screen for
  a second. Screenshot attached. Suspect: episode-change watcher.
-->

_(none yet)_

---

## Triaged / closed reports

_Kept so we can see what happened to each one. Do not delete entries._

- **OB-2026-09-21-a** — "Video computer can't reach the gateway over Tailscale; it keeps returning
  to 127.0.0.1:8000." **Triaged:** Tailscale HTTP was already supported; the visible 503 was the
  gateway's deliberate `CONTENT_STORE_NOT_CONNECTED` stub, and the catalog `0/0` was the stale
  1.4.210 install. **Produced:** `NEW-05` (Content Store copy) and `NEW-06` (stale `:8000` default),
  queued as **DS-17**. **Status:** fixed in **1.4.215**.
- **OB-2026-09-21-b** — "I used different providers for the models but the Jobs rows don't show me
  which provider served each one (Token Harbour, Experimental Labs, OpenRouter…)." **Triaged:**
  the gateway publishes `provider_name` per model and the backend already sends it, but the
  frontend's display catalogue dropped the field and the Jobs model tag only showed the model name.
  **Produced:** `NEW-07`. **Status:** fixed in **1.4.215** — the Jobs model tag now reads
  `Model: DeepSeek V4.1 Flash · Token Harbour`, display-only, with the provider remembered for old
  rows and never invented when unpublished.
