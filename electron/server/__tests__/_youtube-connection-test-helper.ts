import {
  readYouTubeConnectionRegistry,
  saveYouTubeChannelGrant,
} from '../services/youtube-connection-store.js'

type GrantInput = Parameters<typeof saveYouTubeChannelGrant>[0]

/** Test setup helper that pins the currently configured application explicitly. */
export async function saveYouTubeChannelGrantForTest(
  input: Omit<GrantInput, 'expected_application_id'> & { expected_application_id?: string },
): Promise<Awaited<ReturnType<typeof saveYouTubeChannelGrant>>> {
  const expected = input.expected_application_id
    ?? (await readYouTubeConnectionRegistry()).application?.application_id
  if (!expected) throw new Error('Test must configure a YouTube application before saving a grant')
  return saveYouTubeChannelGrant({ ...input, expected_application_id: expected })
}
