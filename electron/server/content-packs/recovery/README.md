# Story Studio Content Pack recovery catalog

This directory contains immutable public recovery resources packaged with Story Studio. It contains no private signing key, customer credential, account data, or network configuration.

## Included archive

| Archive | Pack identity | SHA-256 |
| --- | --- | --- |
| `free-recovery-test.sspack` | `com.storystudio.pack.free-recovery-test@1.0.0` | `f5d7d2fc65211b217cd1834a5a6d6faee39ead76b382afd2a7371a967b53d976` |

The archive is signed by `com.storystudio.key.free-recovery-test`; its matching Ed25519 public key is in `trust-keys.json`.

## Publishing a replacement

Use the publisher machine's explicit, owner-held key path with `npm run content-pack:build`, then validate the completed archive with `npm run content-pack:validate`. Never place a private-key path or key material in this repository, this directory, or a release log. Update this manifest, the archive hash above, and `trust-keys.json` only as one reviewed release change.
