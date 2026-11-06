import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { listVideoPublicationDetails } from '../lib/youtube-client.js'
import { getProjectDir } from './project-manager.js'
import type { YouTubeOperationRecordV1 } from './youtube-operation-store.js'

type ThumbnailState = { previous_filename: string; video_id: string; channel_id: string }

export function thumbnailImageUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'i.ytimg.com' || url.port || url.username || url.password) {
    throw new Error('YouTube returned an unsupported thumbnail image address. Nothing was replaced.')
  }
  return url.href
}

export async function currentYouTubeThumbnail(record: YouTubeOperationRecordV1, accountId: string) {
  if (!record.video_id) throw new Error('This operation has no YouTube video.')
  const detail = (await listVideoPublicationDetails(record.project_slug, accountId, [record.video_id]))[record.video_id]
  if (!detail || detail.channelId !== record.channel_id || !detail.thumbnailUrl) {
    throw new Error('The current thumbnail could not be read from the assigned YouTube channel. Nothing was replaced.')
  }
  return { url: thumbnailImageUrl(detail.thumbnailUrl), checked_at: new Date().toISOString() }
}

function statePaths(record: YouTubeOperationRecordV1) {
  const projectDir = getProjectDir(record.project_slug)
  if (!projectDir) throw new Error('The project no longer exists. Nothing was replaced.')
  const directory = path.join(projectDir, 'youtube-thumbnails', record.operation_id)
  return { directory, state: path.join(directory, 'previous.json') }
}

export async function previousYouTubeThumbnail(record: YouTubeOperationRecordV1) {
  const paths = statePaths(record)
  let state: ThumbnailState
  try { state = JSON.parse(await fs.readFile(paths.state, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (state.video_id !== record.video_id || state.channel_id !== record.channel_id
    || !/^[a-f0-9]{64}\.jpg$/.test(state.previous_filename)) throw new Error('Saved YouTube thumbnail identity is invalid.')
  const file = path.join(paths.directory, state.previous_filename)
  await fs.access(file)
  return { filename: state.previous_filename, path: file }
}

export async function retainYouTubeThumbnail(record: YouTubeOperationRecordV1, url: string): Promise<void> {
  const response = await fetch(thumbnailImageUrl(url), { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok || !response.body) throw new Error('Could not retain the previous YouTube thumbnail. Nothing was replaced.')
  const limit = 10 * 1024 * 1024
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('Previous YouTube thumbnail exceeds the 10 MB backup limit. Nothing was replaced.')
    chunks.push(chunk)
  }
  const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 }).jpeg().toBuffer()
  const filename = `${createHash('sha256').update(bytes).digest('hex')}.jpg`
  const paths = statePaths(record)
  await fs.mkdir(paths.directory, { recursive: true })
  try { await fs.writeFile(path.join(paths.directory, filename), bytes, { flag: 'wx' }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await writeJsonAtomic(paths.state, { previous_filename: filename, video_id: record.video_id, channel_id: record.channel_id })
}
