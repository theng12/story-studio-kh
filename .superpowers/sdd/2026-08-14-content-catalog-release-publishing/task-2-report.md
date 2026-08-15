# Task 2 — GenStudio delivery-attested Content Pack verifier

## Status

DONE_WITH_CONCERNS — implementation and local verification are complete on
`codex/content-store-delivery-attestation`; no production key, archive,
credential, request, purchase, publication, packaging, version, or changelog
change was made.

## Contract applied

- The generic `verifyContentPackArchive` remains the Story publisher-signature
  verifier. A manifest declaring `delivery_profile:
  "genstudio-store-receipt-v1"` is refused by that path, so local import and
  recovery cannot claim GenStudio delivery authority.
- The new Store-only parser retains the ZIP, manifest, declared-file,
  document, raster, size, and materialised-byte checks but requires the Story
  delivery-profile discriminator instead of a Story publisher signature.
- A Store install persists bounded canonical purchase-receipt bytes, signature,
  named Ed25519 key entry, account/product/family/release identity, archive
  SHA-256, and byte count. It re-verifies all of these against retained archive
  bytes without network access. The 900-second grant remains transfer-only.
- Receipt verification requires the signed receipt type, payload key id,
  account, product/family, root release identity/hash/byte count, complete
  deterministic entitlement-family sequence, and ordered exact bundle closure.
- Runtime verification refuses missing/tampered evidence and checks every
  Store dependency against the signed closure pin before usability. Mutable
  state manifest data is not the authority; archive bytes and signed evidence
  are re-read and revalidated.
- Verified restore state records bounded insert-only key history. A repeated
  key id with different public-key bytes is refused. Historical receipt keys
  remain usable because evidence carries the named key that signed it.

## Tests and checks

Observed RED before production code for:

1. Missing Store-only archive verifier export.
2. Missing permanent delivery-receipt verifier export.
3. Missing persisted delivery-attestation verifier module.
4. Missing exact closure reader.

GREEN evidence:

- `content-pack-delivery-attestation.test.ts`: delivery-only profile boundary;
  receipt hash/identity tampering; ordered closure-pin tampering.
- `content-store-commerce-state.test.ts`: repointed historical key id fails
  closed; full 25-test suite passed.
- `content-store-routes.test.ts`: Store install is receipt-attested and local
  archive damage prevents installed state; full 34-test suite passed.
- `content-pack-installer.test.ts`: all 18 local publisher-signature/import
  tests passed unchanged.
- `content-pack-recovery.test.ts`: all 12 recovery/offline tests passed
  unchanged.
- `genstudio-content-store-client.test.ts` and
  `genstudio-content-store-delivery.test.ts`: 45 tests passed, including
  historical-key and terminal-recall paths.
- `npm run typecheck:electron`, `npm run lint -- --quiet`,
  `npm run check:security`, and `git diff --check` passed.

## Deliberately preserved

- Local-import, bundled recovery, and publisher tools still use only Story's
  independent publisher-signature keyring.
- No first-party production public key, private key, receipt fixture, or Store
  archive was added.
- Existing recall handling remains terminal for exact download/closure
  resolution. No receipt or ownership record is deleted or silently rewritten.

## Concern for integration review

The redacted deployed fixtures cannot cryptographically verify after account-id
redaction, as documented by GenStudio. Tests therefore use ephemeral local
Ed25519 keys and mock responses with the field-exact 1.14.1 shape; no live
network call was made. The controller should independently review the new
closure relationship and the planned online recall-reconciliation wiring when
combining the release branch.
