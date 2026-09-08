# Upload plan editor restoration

Status: implementation complete, independently approved, and full application verification passed. Runtime version: 1.4.131. Final base includes the additive content-only PR83 at 000b74f7.

## Owner report and cause

On v1.4.130, Story Sprout could use an existing plan but had no UI to create, choose or edit one. Settings preserved its cadence-as-seed behavior, yet directed users to an editor removed from Upload Center. The Publish empty-plan error incorrectly directed them back to Settings. Production logs showed successful plan-list requests, not an API outage.

## Completed work

- Upload Center > Upload plans restores channel-specific create/edit/activate controls through the existing local plan APIs. Weekly weekdays and intervals, monthly day, time, IANA timezone and date bounds are editable.
- Settings and upload review link to the editor. Save and activation are explicit. An active plan supplies future slot choices; existing episode dates and YouTube publication are unchanged by saving or activating.
- Hidden existing defaults and unrelated schedule fields survive edits. Cadence seeds new drafts. Project/channel identity fence responses and mutations; unsaved drafts receive navigation protection.
- Plan inputs are validated before persistence. No new scheduler, dependencies or paid calls were added.
- Manual provider-status recheck now awaits an in-flight startup check, revalidates the job/project, and performs its requested read if evidence remains unresolved. A deterministic regression holds startup's provider request in flight.
- Release verification corrections preserve legacy owned-kit install/restore coverage after source-kit retirement, narrow current content types correctly, and synchronize generator tests on actual worker slot release rather than terminal status. An existing handoff's personal paths were redacted.

## Verification and review

- Missing-editor navigation regression reproduced before implementation. Focused frontend 69/69 passed; editor route tests 7/7 passed.
- Synthetic browser create/save/activate succeeded. Desktop editor x=263.7..1408.3 at width 1440; narrow editor x=16..374 at width 390. No document overflow; Save remained reachable. Dark and light themes inspected. Only synthetic local API writes occurred.
- Independent reviews approved the editor, channel-race guards, dirty-draft protection, manual recheck race, and exact slot-release test synchronization.
- Full `npm run verify` passed, exit 0, on ba75d9be plus the complete application change: backend 4,957/4,957 across all 437 files; frontend 1,555/1,555 across all 160 files; release 36/36; content 326 passed, 2 optional external-evidence checks skipped. Lint had zero errors (existing warnings remain), both typechecks and production build passed. Configured production projects remained byte-identical.
- Final content-only base update PR83 changes authored products, registry and content tests; application code is unchanged. Its full content lane passed: 350 passed, 2 optional external-evidence checks skipped, all 37 discovered files completed, exit 0.
- Evidence directory: `<owner-home>/pinokio/_handoffs/logs/story-upload-plan-editor-2026-09-08/`. The final local installer is built from integrated main in repository-root `dist/`; artifact/merge receipts are recorded in the shared release handoff.

## Using the restored flow

After installing the update, open Upload Center > Upload plans, save the desired schedule and make it active. Return to Publish to preview/apply missing episode dates. Upload review still chooses the actual YouTube publication time separately.

The owner's actual plan, channel assignment, uploads and schedules were not changed by this work.
