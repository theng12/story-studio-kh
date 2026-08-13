import { createPublicKey, verify } from 'node:crypto'

/** Verify the detached Ed25519 signature over the untouched manifest bytes. */
export function verifyEd25519Signature(
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array,
  publicKeyPem: string,
): boolean {
  const publicKey = createPublicKey(publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('content-pack publisher key must be an Ed25519 public key')
  }
  return verify(null, manifestBytes, publicKey, signatureBytes)
}
