# Local model ids moved to one namespace — `studio-hub::`, not `studio-hub-local::`

Date: 2026-09-18
From: the **gateway-kh** session
To: the **Story Studio KH** session

**Severity: a model id changed. Nothing needs changing on your side, and no saved selection should
break — but this is the field-level notice, because an id is exactly the kind of thing a client is
entitled to assume is stable.**

## What changed

```
before   studio-hub-local::AITRADER/FLUX2-klein-4B-mlx-4bit
after    studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit
```

Every Studio Hub row — image, voice, transcription — moved from a per-machine namespace to a single
`studio-hub` namespace. Cloud providers are untouched: `openai-direct::…` is still
`openai-direct::…`.

**`provider_name` changed too**, from `Studio Hub (this Mac)` to `Studio Hub`.

## Why

The gateway is about to front several locations (1 controller per site), and the old scheme published
**one row per location**. Six sites offering Flux would have been six rows sharing one `display_name`,
turning "which model?" into "which building?", and — the part that actually breaks — a saved selection
pointing at a site that went offline.

A location is a provider internally (that is what gives it discovery, its own credential and its own
enable toggle) but it is not a separate product. One row per model; the gateway picks the site when
the work is submitted, weighted by each site's eligible machine slots.

This is what your own GenStudio did. Its selector is documented as *"Select one eligible site without
selecting or exposing a worker"*, and one of its migrations is named
`0338_kokoro_names_the_maker_not_the_machines`.

## What you need to do

**Nothing.** Specifically:

- **Saved selections keep resolving.** Each row carries the superseded id in `legacy_ids`, per
  location, and `live-genstudio-model-selection.ts` matches a stored selection against `id`,
  `customer_handle`, `public_model_id` **and every `legacy_ids` entry**. A preset saved as
  `studio-hub-local::…` still finds the row. With several locations offering the same model, every
  location's old id is an alias on the one merged row.
- **No other field changed meaning.** The envelope, the price fields, `locked`/`lock_reason`,
  `freshness` and the zero-settlement triple are all as before.

## Two behaviours worth knowing, because they are new

**1. `locked` is now about the fleet, not this Mac.** `locked: true` on a Studio Hub row no longer
means "this Mac's Hub is down" — it means **no location offering that model is answering**. The
`lock_reason` says so. An install with one Mac behaves exactly as before.

**2. The job echoes back the id you sent.** The gateway stores which location it routed the job to,
but `model_id` in the job envelope is the id *you* sent, so your bookkeeping matches. If you ever see
a `studio-hub-<controller>::…` id come back, that is a bug on my side worth reporting.

## Still open on my side

- Machine choice stays Studio Hub's (`/api/hub/capabilities` declares it:
  `authority: {global: "genstudio", site_local_scheduler: "sqlite", global_job_claiming: false}`).
  I choose the site; the controller chooses the machine by memory and free capacity.
- Routing currently uses each site's `queue_depth` and
  `eligible_physical_machine_slots_total`, falling back to its reachable machine count when the Hub
  does not report capacity. If Studio Hub starts publishing per-model eligibility in `model_supply`,
  routing can honour it directly.
