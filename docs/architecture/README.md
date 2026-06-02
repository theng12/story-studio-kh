# architecture/

Still-true specifications of how Story Studio KH is built. Read these to build a mental model of the system before changing it.

## Contents

| File | Purpose |
|---|---|
| [`overview.md`](overview.md) | The big-picture map: process model, where each subsystem lives, how data flows from idea to upload. Start here. |
| [`format-contract.md`](format-contract.md) | Schema reference for formats and niches, plus the reverse index showing which code reads which field. Read when adding a new format or debugging why a niche's vocab isn't landing where you expect. |
| [`server-mode.md`](server-mode.md) | Headless / tailnet remote-access mode: launchd setup, auth model, how the SPA shim differs from default Electron mode. |
| [`offline.md`](offline.md) | What works without internet, what doesn't, and how the offline-detection plumbing is wired. |

## When to update these

These are **living specs**. When you change the system in a way that makes a sentence here false, update the sentence. If you can't update without losing context, write a dated note under [`../history/`](../history/) instead and link to it.

Format/pipeline audits — once-in-time deep dives — belong under [`../history/`](../history/), not here.
