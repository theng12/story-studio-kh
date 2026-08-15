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

## Fix round 1 — independent review C1/I1/I2/I3

- **C1:** Pack evidence no longer contains public-key bytes. Offline delivery
  verification resolves the named key id from a separately persisted,
  account/origin-bound verified restore/key-history journal, re-verifies that
  restore signature, and then verifies the delivery receipt. The journal
  remains insert-only for key ids; a same-id replacement fails closed.
- **I1:** No upstream fields were invented. A closure leaf is authorized by the
  receipt's signed product/family/release/version/SHA pin, the root archive's
  signed dependency pack-id/version declaration, and local structural archive
  verification. The byte count is re-derived from the SHA-bound bytes. Nested
  closure-member dependencies fail closed because 1.14 has no signed relation.
- **I2:** Evidence explicitly distinguishes `receipt-root` and
  `bundle-closure-member`. Root assignments are checked against the signed
  receipt, signed manifest, and exact owned history before any child is
  installed; `installContentPack` repeats the checks before staging/activation.
  Leaves verify their own pin and cannot declare unbound dependencies.
- **I3:** Online restore/install reconciliation persists recalled Store
  versions as disabled, clears active selection, preserves ownership/archive
  history, and boot/registry/admission refuse recalled state with no fallback.

Observed RED → GREEN: the focused delivery test initially failed after mutable
key removal; the final adversarial delivery suite passes 6/6, including
same-id key substitution, tampered evidence schema rejection, exact closure
leaf, and unbound leaf rejection. Focused delivery/install/state/recovery/
registry/commerce suites passed 110 tests. `npm run typecheck:electron` and
`git diff --check` passed; lint completed with existing repository warnings
and no errors.

Remaining concern: recall is an authenticated online release-history fact, not
a signed receipt field. It becomes a durable local disablement after online
reconciliation and is enforced on all later offline boots.

## Fix round 2 — independent anchor and recall isolation

- **C1:** Receipt-key mappings now have a second persistence boundary in the
  existing app-secrets safeStorage/OS-keychain envelope. The anchor is bounded,
  append-only and scoped to GenStudio origin, account, and content account.
  Offline delivery and cached-ownership verification require the anchor to
  agree with the mutable commerce journal before accepting a receipt. Missing
  anchors (including installations created before this migration) fail closed
  pending online revalidation. A direct journal receipt/key-history replacement
  under the same key id is rejected because it cannot alter the independent
  anchored bytes.
- **I3:** Normal successful `/api/content-store` overview now reconciles each
  authenticated receipt response's `recalledReleaseVersions`, not just restore
  or install. It writes account/origin-bound recall markers, removes the active
  version but preserves immutable archive and ownership evidence, and the next
  offline boot keeps it disabled.
- **I4:** Recalled retained versions are excluded from the available manifest
  graph. They cannot poison an unrelated local install; an exact dependency on
  the recalled pack is absent from the graph and still fails closed.

Observed RED → GREEN evidence:

- Commerce-state anchor regression: removal of the independent anchor causes
  offline resolution to fail; replacing journal key bytes, receipt signature,
  and receipt under the same id fails against the retained anchor.
- Content Store route regression: ordinary overview recall disables an
  installed version, records matching account/origin markers, and a subsequent
  no-network boot leaves it inactive.
- Installer regression: an unrelated pack installs with a recalled retained
  Store version present, while an exact dependency on that version is rejected.
- Focused delivery/install/recovery/registry/commerce suites passed **131
  tests**. `npm run typecheck:electron`, `npm run lint -- --quiet`,
  `npm run check:security`, and `git diff --check` passed.

## Fix round 3 — safeStorage envelope provenance

The prior anchor used the existing app-secret file but could still read a
plaintext fallback as an anchor. Content Store anchors now have a narrow,
separate safeStorage boundary: production reads require a decryptable encrypted
envelope and production writes require available OS safeStorage. A plaintext
legacy app-secret payload may be preserved only as input to a successful online
revalidation migration; its anchor data is discarded and can never authorize
offline content. A malformed or undecryptable encrypted envelope is terminal,
not reset or rewritten. The general legacy app-secret fallback remains
unchanged for unrelated provider behavior.

Node tests explicitly inject a plaintext-only anchor seam because they do not
have an Electron OS keychain. This is a module-local test injection, not an
environment switch and is not used by packaged runtime code. Production-mode
probes set `STORY_STUDIO_FORCE_KEYCHAIN=1` with that seam disabled and prove:

- direct plaintext anchor substitution is refused;
- anchor write without available safeStorage is refused; and
- encrypted-envelope ciphertext tampering is refused.

The full focused suite passed **132 tests**, with Electron typecheck, quiet
lint, security check, and diff check also passing.

## Fix round 4 — plaintext laundering and production seam removal

The remaining anchor bypasses are closed at their source:

- Every generic app-secrets read-modify-write now remembers whether its input
  came from an unprotected legacy plaintext payload. After the requested
  provider/settings mutation and before any output write, it discards all
  plaintext-origin `contentStoreKeyAnchors`. An unrelated provider-key save can
  therefore preserve legacy provider behavior but cannot wrap and bless a
  rogue plaintext Store anchor in a fresh safeStorage envelope.
- A valid anchor read from an existing decryptable safeStorage envelope
  survives the same ordinary provider-key save unchanged.
- The production `app-secrets-store` module no longer contains or exports a
  plaintext-anchor test switch. Node tests install a deterministic Electron
  `safeStorage` double from `electron/server/__tests__`, a directory excluded
  by `electron/tsconfig.build.json`, so the packaged module has no equivalent
  bypass surface.

Observed RED → GREEN evidence:

- A trusted commerce journal followed by plaintext rogue-anchor replacement,
  an ordinary provider-key save, and matching offline journal repointing first
  resolved the rogue key; it now fails closed for want of an OS-backed anchor.
- Runtime-module export inspection first found the plaintext test seam and now
  proves it absent.
- Direct plaintext reads, unavailable safeStorage writes, malformed encrypted
  envelopes, and missing anchors remain fail closed; the valid encrypted-anchor
  preservation case remains GREEN.
- The focused app-settings/secrets/commerce/routes/archive/installer/delivery
  matrix passed **122/122** tests. Electron typecheck, quiet lint, source
  security, production Electron compilation, compiled export inspection, and
  diff check passed. The separately executed free-Starter integration fixture
  still fails at its pre-existing publisher-profile archive because the newer
  Store path requires `genstudio-store-receipt-v1`; the failure is outside this
  anchor-only correction and occurs before anchor handling.
