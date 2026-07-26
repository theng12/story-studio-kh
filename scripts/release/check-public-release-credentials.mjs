#!/usr/bin/env node

import { inspectPublicReleaseCredentials, publicReleaseCredentialErrors } from './public-release-credentials.mjs'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`Public DMG releases require an arm64 Mac; got ${process.platform}/${process.arch}.`)
  process.exit(1)
}

const errors = publicReleaseCredentialErrors()
if (errors.length) {
  console.error('Public release credentials are incomplete:')
  for (const error of errors) console.error(`- ${error}`)
  console.error('No package was signed, notarized, or published.')
  process.exit(1)
}

const status = inspectPublicReleaseCredentials()
console.log(`Public release credentials are present (notarization: ${status.notarizationKind}).`)
