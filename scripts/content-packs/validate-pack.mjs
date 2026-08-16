#!/usr/bin/env node
import { stat } from 'node:fs/promises'

import { parseOptions, report, reportError, validateContentPack } from './lib.mjs'

try {
  const { positionals, options } = parseOptions(process.argv.slice(2), 1, ['--key-id', '--publisher-id', '--public-key', '--delivery-profile'])
  const result = await validateContentPack({
    archivePath: positionals[0],
    keyId: options.keyId,
    publisherId: options.publisherId,
    publicKeyPath: options.publicKey,
    deliveryProfile: options.deliveryProfile,
  })
  report(result, { bytes: (await stat(positionals[0])).size })
} catch (error) {
  reportError(error)
  process.exitCode = 1
}
