/**
 * A synthetic large library for the Publishing Overview's cost tests.
 *
 * The overview's cold read resolves EVERY accepted episode of EVERY channel
 * through `remoteVideoFor` (operation record, reconcile link, legacy sidecar)
 * plus a rendered-video probe. The owner's machine is 19 channels of 100–300
 * episodes; this fixture is 19 × 250 with a deliberate MIX of the three
 * evidence stores, so a change that makes one store cheap while leaving the
 * other two per-episode would still be measured as the cost it is.
 *
 * Real files, real readers — no mocked stores. Only the per-episode shape is
 * synthetic.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as utils from '../services/utils.js'
import { configureYouTubeApplication, assignProjectYouTubeChannel } from '../services/youtube-connection-store.js'
import { setAppSetting } from '../services/app-settings.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { linkYouTubeEpisodeVideo } from '../services/youtube-project-publishing-store.js'
import { createYouTubeOperation, acceptYouTubeOperation } from '../services/youtube-operation-store.js'

export const FIXTURE_CHANNELS = 19
export const FIXTURE_EPISODES_PER_CHANNEL = 250

export interface FixtureEpisode {
  code: string
  title: string
  /** Which store can answer "already on YouTube?" for this episode. */
  evidence: 'operation' | 'link' | 'sidecar' | 'sidecar_other_channel' | 'sidecar_deleted' | 'none'
  /** Where the finished final video sits, if there is one. */
  final: 'exports' | 'video_dir' | 'missing'
}

export interface FixtureChannel {
  slug: string
  name: string
  channelId: string
  episodes: FixtureEpisode[]
}

export interface OverviewFixture {
  channels: FixtureChannel[]
  /** Total accepted episodes across every channel. */
  episodes: number
  /** Path of a given episode's folder, so a test can seed/remove evidence later. */
  episodeDir(channel: FixtureChannel, episode: FixtureEpisode): string
}

function episodeEvidence(index: number): FixtureEpisode['evidence'] {
  switch (index % 8) {
    case 0: return 'operation'
    case 1:
    case 2: return 'link'
    case 3: return 'sidecar'
    case 4: return 'sidecar_other_channel'
    case 5: return 'sidecar_deleted'
    default: return 'none'
  }
}

function episodeFinal(index: number): FixtureEpisode['final'] {
  return index % 3 === 0 ? 'exports' : index % 3 === 1 ? 'video_dir' : 'missing'
}

/**
 * Build the fixture into the CURRENT data dir (call `useTempDataDir()` first).
 *
 * Only the folders the sweep actually touches are created: the episode folder,
 * the local video folder when the final lives there, and the channel's
 * `Exports` folder when it lives there.
 */
export async function buildOverviewFixture(options: {
  channels?: number
  episodesPerChannel?: number
} = {}): Promise<OverviewFixture> {
  const channelCount = options.channels ?? FIXTURE_CHANNELS
  const perChannel = options.episodesPerChannel ?? FIXTURE_EPISODES_PER_CHANNEL
  // A Library, so `Exports` is a real place rather than an unset setting.
  // Without it `resolveExternalFinalVideoDir` answers null for every episode and
  // the finished-video probe silently degrades to the project tree alone —
  // which is not the machine this cost is measured on.
  await setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
  await configureYouTubeApplication({ client_id: 'fixture-client', client_secret: 'fixture-client-secret-value' })

  const channels: FixtureChannel[] = []
  for (let c = 0; c < channelCount; c += 1) {
    const name = `Fixture Channel ${c + 1}`
    const created = await pm.createProject({ name, episode_prefix: 'EP' })
    const channelId = `UC-fixture-${c + 1}`
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: channelId, title: name, granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({
      project_slug: created.slug, channel_id: channelId, expected_previous_channel_id: null,
    })

    const episodes: FixtureEpisode[] = []
    for (let i = 0; i < perChannel; i += 1) {
      const code = utils.formatEpisodeCode(i + 1, 'EP')
      episodes.push({ code, title: `Story ${i + 1}`, evidence: episodeEvidence(i), final: episodeFinal(i) })
    }

    // Written straight to disk rather than through `acceptIdea`: 250 accepted
    // episodes per channel is 4,750 locked read-modify-writes of ideas.json
    // (and a folder tree) to reach a shape this fixture describes exactly.
    const ideasPath = path.join(pm.getProjectDir(created.slug)!, 'ideas.json')
    await fs.writeFile(ideasPath, JSON.stringify({
      ideas: episodes.map((episode, index) => ({
        id: `fixture-${c}-${index}`,
        title: episode.title,
        logline: '',
        themes: [],
        suggested_chapters: 1,
        suggested_length: 'short',
        mood: 'calm',
        status: 'accepted',
        episode_code: episode.code,
        generated_at: '2026-01-01T00:00:00.000Z',
        accepted_at: '2026-01-01T00:00:00.000Z',
        batch_id: 'fixture',
        model_used: 'fixture',
      })),
      next_episode_number: perChannel + 1,
      recycled_numbers: [],
    }))

    await seedEvidence(created.slug, channelId, episodes)
    channels.push({ slug: created.slug, name, channelId, episodes })
  }

  return {
    channels,
    episodes: channelCount * perChannel,
    episodeDir(channel, episode) {
      return path.join(pm.getProjectDir(channel.slug)!, 'episodes', seasonDir(episode.code), `${episode.code} - ${episode.title}`)
    },
  }
}

function seasonDir(code: string): string {
  const number = utils.episodeNumber(code)
  return `Season ${String(Math.floor((number - 1) / 20) + 1).padStart(3, '0')}`
}

async function seedEvidence(slug: string, channelId: string, episodes: FixtureEpisode[]): Promise<void> {
  const projectDir = pm.getProjectDir(slug)!
  const when = '2026-01-02T00:00:00.000Z'
  for (const episode of episodes) {
    const paths = await utils.resolveEpisodePaths(slug, episode.code, episode.title)
    await fs.mkdir(paths.episode_dir, { recursive: true })

    if (episode.final === 'exports') {
      const dir = path.join(projectDir, 'Exports', seasonDir(episode.code), `${episode.code} - ${episode.title}`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${episode.code}_final_video.mp4`), Buffer.alloc(64, 1))
    } else if (episode.final === 'video_dir') {
      await fs.mkdir(paths.video_dir, { recursive: true })
      await fs.writeFile(path.join(paths.video_dir, `${episode.code}_final_video.mp4`), Buffer.alloc(64, 2))
    }

    const videoId = `vid_${channelId.slice(-2)}_${episode.code}`
    switch (episode.evidence) {
      case 'operation': {
        const operation = await createYouTubeOperation({
          project_slug: slug,
          episode_code: episode.code,
          channel_id: channelId,
          source_revision: `sha256:${'a'.repeat(64)}`,
          metadata_revision: 'meta-1',
          origin: 'manual',
          final_action: 'private_upload',
        })
        await acceptYouTubeOperation({
          project_slug: slug,
          operation_id: operation.operation_id,
          expected_revision: operation.revision,
          channel_id: channelId,
          video_id: videoId,
          accepted_at: when,
          final_payload: {
            snippet_json: '{"title":"Fixture"}',
            status_json: '{"privacyStatus":"private"}',
            source_sha256: 'a'.repeat(64),
          },
        })
        break
      }
      case 'link':
        await linkYouTubeEpisodeVideo({
          project_slug: slug, episode_code: episode.code, channel_id: channelId,
          video_id: videoId, source: 'upload', decided_at: when,
        })
        break
      case 'sidecar':
      case 'sidecar_other_channel':
      case 'sidecar_deleted':
        await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), JSON.stringify({
          platform: 'youtube',
          video_id: videoId,
          account_id: 'fixture-account',
          channel_id: episode.evidence === 'sidecar_other_channel' ? 'UC-a-former-channel' : channelId,
          uploaded_at: when,
          last_sync_at: when,
          scheduled_for: null,
          privacy_status: 'private',
          title: episode.title,
          description: '',
          tags: [],
          thumbnail_set: false,
          ...(episode.evidence === 'sidecar_deleted' ? { deleted_at: when, deleted_reason: 'manual' } : {}),
        }))
        break
      case 'none':
        break
    }
  }
}
