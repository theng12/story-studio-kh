// electron-builder `mac.sign` hook (CommonJS because this package is
// `type: module`). The shared identity is self-signed and untrusted, so
// electron-builder's trusted-identity search finds nothing and skips signing
// unless `mac.identity` is "-". With "-" the packager calls this hook, which
// always substitutes the exact shared certificate and hands the packager's own
// sign options to @electron/osx-sign. osx-sign signs nested code inside-out,
// then the bundle (never deep-sealed). There is no ad-hoc fallback.
// A local, self-signed, unnotarized build needs no secure timestamp, and asking the
// public timestamp authority for one file at a time flakes under load ("A timestamp was
// expected but was not found"). Notarized/public builds use their own signing path.
async function signWithLocalIdentity({ opts, identity, signApp }) {
  return signApp({ ...opts, identity, identityValidation: false, timestamp: 'none' })
}

module.exports = async function signMac(opts) {
  // Loaded lazily so this hook (and its test) never needs the installed
  // @electron/osx-sign until the packager actually signs.
  const { requireLocalSigningIdentity } = await import('./local-signing.mjs')
  const { signApp } = require('@electron/osx-sign')
  return signWithLocalIdentity({ opts, identity: requireLocalSigningIdentity(), signApp })
}

module.exports.signWithLocalIdentity = signWithLocalIdentity
