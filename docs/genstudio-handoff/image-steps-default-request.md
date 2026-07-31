# Request to GenStudio: own the per-model step default

**From:** Story Studio KH
**Status:** **ANSWERED — shipped.** GenStudio owns fixed server-side steps; FLUX.2 Klein
uses 4. Story Studio correctly sends no `steps` field.
**Why it mattered:** Story Studio stopped sending `steps`, so the model-specific default had
to live in GenStudio.

## What changed on our side

Story Studio used to send `steps: 4` on every image generation. That value originated with
**FLUX 2 Klein on the old ImageStudio integration**, which needed it. It then became a
blanket default applied to every image model, including ones with no step concept at all.

`ImageGenerationRequest` does not declare a `steps` field — GenStudio never accepted it — so
Story Studio was sending something ignored at the boundary. It has been removed entirely,
along with the invented `default_steps` / `min_steps` / `max_steps` fields Story Studio was
synthesising locally (GenStudio publishes none of them).

## The request

**Apply the appropriate step count server-side, per model.** Specifically: FLUX 2 Klein
generations should default to **4 steps**, since that is what that model expects and what
Story Studio was previously supplying.

More generally: any model that needs a step count should get a sensible one chosen by
GenStudio, because GenStudio is the only side that knows which model is actually serving the
request. Story Studio deliberately cannot see the provider or route, so it cannot make a
per-model rendering decision — and it should not be guessing one.

If GenStudio would rather expose the control than own the default, publish a step contract
on `ImageModelResponse` (something like `default_steps` / `min_steps` / `max_steps`, only on
models where it applies) and accept `steps` on `ImageGenerationRequest`. Story Studio would
then read and send it like any other published capability. **Owning the default is the
simpler option and our preference** — a step count is a rendering detail, not a creative
choice a customer should have to reason about.

## Sequencing — worth coordinating

Story Studio's next release stops sending `steps`. Until GenStudio applies a default,
FLUX 2 Klein generations will run with whatever GenStudio's own fallback is, which may not be
4. Worth confirming before that release reaches customers, or FLUX 2 Klein output quality
could change with no visible cause.

## One note on our side, for completeness

Story Studio keeps a frozen `4` inside its request-fingerprint calculation — never sent, just
retained so idempotency keys stay byte-identical across the upgrade. Without that, a retry
crossing the release boundary would compute a new key and GenStudio would start and bill a
second job for work already running. That is purely internal and needs nothing from GenStudio;
mentioning it only so the value `4` appearing in our hashes isn't mistaken for a live request
field.
