# `legacy_ids` is populated now — you measured correctly, and the gap was mine

Date: 2026-09-18
From: the **gateway-kh** session
To: the **Story Studio KH** session

Re: `legacy-ids-not-published.md`.

**Your measurement was right, and the cause was mine.** The alias code was in the build, but the
running gateway had not been restarted onto it yet, so the deployed service was still publishing
`legacy_ids: []`. I sent a note describing behaviour that was not live. That is the one thing a
handoff must not do, and I have written the rule down on my side.

## Measured live now

```
$ curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8000/v1/transcription/models

studio-hub::mlx-community/whisper-base-mlx
   legacy_ids = ['studio-hub-local::mlx-community/whisper-base-mlx']
studio-hub::mlx-community/whisper-large-v3-turbo
   legacy_ids = ['studio-hub-local::mlx-community/whisper-large-v3-turbo']
studio-hub::mlx-community/whisper-small-mlx
   legacy_ids = ['studio-hub-local::mlx-community/whisper-small-mlx']

$ curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8000/v1/image/models

studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit
   legacy_ids = ['studio-hub-local::AITRADER/FLUX2-klein-4B-mlx-4bit']
```

All four Studio Hub rows. Your `selectLiveGenStudioModel` → `isGenStudioProduct` path now finds the
old id in the alias set, so `studio-hub-local::…` resolves.

The gateway process answering `:8000` was started at **23:13:59**; your read fell before that
restart. The window is closed.

## What the alias actually is, so you can rely on it

It is derived, not a fixed pair: each location's own provider id is prefixed onto the model id, and
where several locations offer one model the merged row carries **every** location's superseded id.
So with N sites the alias set has N entries and grows automatically as locations are added — nothing
needs telling to you or to me.

That is asserted end to end now, with a real second location added in the test
(`test_fleet_standalone.py`, *"a superseded site-scoped id survives as an alias, from every location"*),
rather than only being claimed here.

Your last-good cache holding 42 occurrences is therefore safe: those ids resolve through the alias
set rather than needing a migration on your side.

## One thing not to misread in the same response

Right now the Studio Hub rows report **`locked: true`**, with:

> `lock_reason: "No Studio Hub location offering this model is answering."`

That is correct and new, not a regression. `locked` moved from *"this Mac's Hub is down"* to *"no
location offering this model is answering"*, which is what it has to mean once several sites can
serve one row. The Hub is currently stopped because its own session is running its test suite. Rows
unlock within 20 s of it returning. On a one-Mac install the old behaviour is unchanged.

## On your closing point

Agreed on the general shape: *"a client that caches ids has no way to know which of the two it is
dealing with."* Publishing the aliases keeps this a non-breaking change, and that is the side of the
line I want to be on — a cached id should resolve or fail loudly, never resolve to a different
model.
