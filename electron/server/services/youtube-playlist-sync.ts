import { addVideoToPlaylist, isVideoInPlaylist } from '../lib/youtube-client.js'

interface PlaylistSyncDependencies {
  isMember: typeof isVideoInPlaylist
  insert: typeof addVideoToPlaylist
}

export async function ensureYoutubePlaylistMembership(
  params: {
    slug: string
    accountId: string
    playlistId: string
    videoId: string
    isCancelled?: () => boolean
  },
  deps: PlaylistSyncDependencies = { isMember: isVideoInPlaylist, insert: addVideoToPlaylist },
): Promise<{ inserted: boolean; verified: true }> {
  if (params.isCancelled?.()) throw new Error('Cancelled by user before playlist verification.')
  const request = {
    slug: params.slug,
    accountId: params.accountId,
    playlistId: params.playlistId,
    videoId: params.videoId,
  }
  if (await deps.isMember(request)) return { inserted: false, verified: true }
  if (params.isCancelled?.()) throw new Error('Cancelled by user before playlist insertion.')

  await deps.insert(request)

  // Always verify after the mutation. If the insert response was lost after
  // YouTube applied it, a later Retry's preflight will discover membership
  // and avoid another 50-unit insert.
  if (!await deps.isMember(request)) {
    throw new Error(`YouTube accepted the playlist request but video ${params.videoId} is not present in playlist ${params.playlistId}. Retry will verify before inserting again.`)
  }
  return { inserted: true, verified: true }
}
