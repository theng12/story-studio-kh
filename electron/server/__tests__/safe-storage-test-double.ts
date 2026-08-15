import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronModulePath = require.resolve('electron')
const prefix = Buffer.from('story-studio-test-safe-storage-v1:')
let available = true

const safeStorage = {
  isEncryptionAvailable: () => available,
  encryptString: (plaintext: string) => Buffer.concat([prefix, Buffer.from(plaintext)]),
  decryptString: (encrypted: Buffer) => {
    if (!encrypted.subarray(0, prefix.length).equals(prefix)) throw new Error('invalid test safeStorage envelope')
    return encrypted.subarray(prefix.length).toString()
  },
}

export function installTestSafeStorage(): void {
  require(electronModulePath)
  const cached = require.cache[electronModulePath]
  if (!cached) throw new Error('Unable to install the Electron safeStorage test double')
  cached.exports = { safeStorage }
}

export function setTestSafeStorageAvailable(value: boolean): void {
  available = value
}
