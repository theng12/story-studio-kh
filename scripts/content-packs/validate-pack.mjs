#!/usr/bin/env node
import { parseOptions, report, reportError, validateContentPack } from './lib.mjs'

try {
  const { positionals, options } = parseOptions(process.argv.slice(2), 1, ['--key-id', '--publisher-id', '--public-key'])
  report(await validateContentPack({
    archivePath: positionals[0],
    keyId: options.keyId,
    publisherId: options.publisherId,
    publicKeyPath: options.publicKey,
  }))
} catch (error) {
  reportError(error)
  process.exitCode = 1
}
