# Security and reliability contract

This is the current contract for customer-facing Story Studio builds. It is a
living specification, not an audit trail. Source code and automated gates are
authoritative when this document and runtime behavior disagree.

## Trust boundaries

- Story Studio sends generation requests only to GenStudio. It does not call
  sibling Studio apps, Studio Hub, or upstream model providers directly.
- Model capabilities, prices, provider labels, limits, and availability come
  from the live GenStudio catalog. Story Studio never invents or persists
  catalog-owned values.
- Provider identity may be displayed when GenStudio publishes it, but it is
  never used for dispatch.
- Project, job, and generated-content input is untrusted. Validate identifiers,
  paths, JSON shapes, filenames, and request bodies at their boundaries.

## Secrets and network access

- Secrets are app-level, machine-local values. They do not belong in project
  folders, presets, logs, jobs, exports, screenshots, or renderer responses.
- Renderer-visible job data passes through the central redaction boundary.
- Server Mode requires authentication and is intended for a trusted private
  network. Do not weaken its origin, token, or rate-limit checks.
- Downloaded provider artifacts must be non-empty and validated before they
  count as complete. Partial downloads are removed.

## Filesystem integrity

- Shared JSON stores use the atomic-write and lock helpers. A corrupt store
  fails loudly; write paths must never replace it with an empty object.
- Resolve project and episode paths through the project and media-root helpers.
  Never concatenate user-controlled filesystem paths into a trusted root.
- FFmpeg concat inputs reject newline, carriage-return, and NUL bytes.
- Destructive storage actions require an explicit user action, a preview when
  practical, and post-write verification.

## Jobs and paid work

- GenStudio request identities are durable. Restart recovery reconnects an
  accepted task and must not submit a duplicate paid request.
- Completion is proven from authoritative artifacts and expected item IDs, not
  from a returned promise, a directory, one file, or `progress = 100`.
- Valid partial output is preserved. Missing or malformed required output keeps
  the job failed and names the repair path.
- Automatic retry is reserved for local, no-charge work. Provider work remains
  manual unless the GenStudio recovery contract proves the same accepted task
  is being resumed.

## Publishing

- YouTube account identity is shown before upload and must not be inferred from
  stale project data.
- Resumable upload state is treated as current operational state, never as a
  second source of truth for project content.
- Quota accounting failures surface visibly; they are not silently ignored.

## Release gates

Every shipped change updates `package.json`, `package-lock.json`, and the newest
`CHANGELOG.md` entry. Before release, run lint, typechecks, backend/frontend/
release tests, security and model-drift checks, and both builds. Visual changes
also require screenshot inspection because automated tests cannot verify layout.

## Data policy

Story Studio does not retain migration tools, retired-feature tombstones, or
dated recovery/audit evidence solely to support pre-product test data. Current
customer data contracts and active GenStudio recovery remain supported.
