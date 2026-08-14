#!/usr/bin/env node
import { buildContentPack, parseOptions, report, reportError } from './lib.mjs'

try {
  const { positionals, options } = parseOptions(process.argv.slice(2), 1, ['--private-key', '--output', '--min-app-version'])
  report(await buildContentPack({
    sourceDirectory: positionals[0],
    privateKeyPath: options.privateKey ?? process.env.STORY_CONTENT_PACK_PRIVATE_KEY_PATH,
    outputPath: options.output,
    minAppVersion: options.minAppVersion,
  }))
} catch (error) {
  reportError(error)
  process.exitCode = 1
}
