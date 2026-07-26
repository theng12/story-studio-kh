export function inspectPublicReleaseCredentials(env = process.env) {
  const signingReady = Boolean(env.CSC_LINK || env.CSC_NAME)
  const apiKeyReady = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
  const appleIdReady = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)

  return {
    signingReady,
    notarizationReady: apiKeyReady || appleIdReady,
    notarizationKind: apiKeyReady ? 'api-key' : appleIdReady ? 'apple-id' : null,
  }
}

export function publicReleaseCredentialErrors(env = process.env) {
  const status = inspectPublicReleaseCredentials(env)
  const errors = []
  if (!status.signingReady) {
    errors.push('Developer ID signing is not configured: set CSC_LINK (recommended) or CSC_NAME.')
  }
  if (!status.notarizationReady) {
    errors.push(
      'Apple notarization is not configured: set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, '
      + 'or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.',
    )
  }
  return errors
}

export function notarytoolCredentialArgs(env = process.env) {
  const status = inspectPublicReleaseCredentials(env)
  if (status.notarizationKind === 'api-key') {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER]
  }
  if (status.notarizationKind === 'apple-id') {
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID]
  }
  throw new Error('Apple notarization credentials are incomplete.')
}
