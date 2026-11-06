/**
 * A finished video that lives at the Library's export root is part of the
 * episode's status, but it is written OUTSIDE the project's `episodes/` tree.
 *
 * The episode-status cache trusts its live folder watcher for anything it has
 * already confirmed against disk ("any change would have fired an event"), and
 * the watcher only watched `episodes/`. So a final appearing or disappearing at
 * the export root was invisible: the cached verdict survived, and the Production
 * Board kept showing Video Assembly unfinished for a finished episode (or done
 * for one whose final had been archived away) until an unrelated file inside the
 * project tree changed. Found live during ACCEPT-01 as `NEW-13`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { waitFor } from './_timing.js'

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'External final fixture', logline: 'A deterministic export-root fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    title: idea.title,
    code: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

test('a final video appearing or disappearing at the export root refreshes episode status', async () => {
  const temp = await useTempDataDir()
  const { stopAllWatchers, watcherTrustedSince } = await import('../services/episode-folder-watcher.js')
  try {
    const library = await import('../services/library.js')
    const external = await import('../services/external-video-store.js')
    const visual = await import('../services/video-visual-source.js')
    const { ensureProjectWatcher } = await import('../services/episode-folder-watcher.js')
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')

    const libraryRoot = path.join(temp.dir, 'library')
    await library.setLibraryRoot(libraryRoot)
    assert.equal(await external.getExternalFinalVideoRoot(), path.join(libraryRoot, 'Exports'))

    const { project, code, title } = await createEpisode('External final status watch')
    await ensureProjectWatcher(project.slug)
    assert.notEqual(watcherTrustedSince(project.slug), null,
      'the channel watcher is live; the export tree sits inside the folder it watches')

    // Nothing has been assembled yet.
    assert.equal((await episodeStatusCache.getForList(project.slug, code)).video_assembly, false)

    const dir = await external.ensureExternalFinalVideoDir(project.slug, code, title)
    assert.ok(dir, 'the export root resolves for this project')
    const finalPath = path.join(dir, `${code}_final_video.mp4`)
    await fs.writeFile(finalPath, 'finished video bytes')
    await visual.writeVideoAssemblySourceStamp(finalPath, code, 'scene_plan')

    // What the watcher does on the file event is `invalidate` — that is exactly
    // what `bindInvalidator` wires, and what the Board's next list read
    // consumes. Driving it here is deliberate: fs.watch delivery is not an
    // assertable contract (it can start and then deliver nothing, and on this
    // machine it has arrived seconds late under load), while this test is about
    // the status refresh, not the OS. The disk fallback below is asserted on
    // its own, with no watcher to announce anything.
    episodeStatusCache.invalidate(project.slug, code)
    await waitFor(
      async () => (await episodeStatusCache.getForList(project.slug, code)).video_assembly === true,
      { label: 'the external final is noticed', timeoutMs: 5_000 },
    )

    // A watcher that delivers no events: the export folders are still part of
    // the mtime snapshot, so the Board converges from disk on its own. Before
    // v20 it never did — the snapshot watched only the project tree, so the
    // cached verdict survived an external final appearing or being archived
    // away for the life of the process.
    stopAllWatchers()
    await fs.rm(finalPath)
    await waitFor(
      async () => (await episodeStatusCache.getForList(project.slug, code)).video_assembly === false,
      { label: 'removing the external final refreshes the status', timeoutMs: 5_000 },
    )

    // And back again, so the watch is not one-directional.
    await fs.writeFile(finalPath, 'finished video bytes again')
    await visual.writeVideoAssemblySourceStamp(finalPath, code, 'scene_plan')
    await waitFor(
      async () => (await episodeStatusCache.getForList(project.slug, code)).video_assembly === true,
      { label: 'a replacement external final is noticed too', timeoutMs: 5_000 },
    )
  } finally {
    stopAllWatchers()
    await temp.cleanup()
  }
})
