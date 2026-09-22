/**
 * Throwaway probe: why does a completed Video Assembly leave `video_assembly`
 * false while `video_ready` is true? Reads the same helpers the status map uses.
 */
process.env.STORY_STUDIO_DATA_DIR = process.env.STORY_STUDIO_DATA_DIR || '/tmp/ssk-accept-data'

const SLUG = process.env.PROBE_SLUG || 'accept-01-walkthrough-v2-2026-09-22'
const CODE = process.env.PROBE_CODE || 'EP0001'

const { computeEpisodeStatus } = await import('../../electron/server/services/asset-status.js')
const { resolveExternalFinalVideoDir, getExternalFinalVideoRoot } = await import('../../electron/server/services/external-video-store.js')
const { readVideoVisualSource, videoAssemblySourceStampPath, videoVisualSourceRequiresBrollProof } = await import('../../electron/server/services/video-visual-source.js')
const { resolveEpisodePathsByCode } = await import('../../electron/server/services/utils.js')
const fs = await import('node:fs/promises')
const path = await import('node:path')

const paths = await resolveEpisodePathsByCode(SLUG, CODE)
console.log('episode dir:', paths.episode_dir)
const externalRoot = await getExternalFinalVideoRoot().catch(error => `ERR ${error.message}`)
console.log('external final-video root:', externalRoot)
const externalDir = await resolveExternalFinalVideoDir(SLUG, CODE, 'The Ledger of a Vanishing Harbour')
console.log('resolveExternalFinalVideoDir:', externalDir)

if (typeof externalDir === 'string' && externalDir) {
  console.log('  entries:', await fs.readdir(externalDir).catch(e => `ERR ${e.message}`))
  const finalName = `${CODE}_final_video.mp4`
  const finalPath = path.join(externalDir, finalName)
  const stampPath = videoAssemblySourceStampPath(finalPath, CODE)
  console.log('  final exists:', await fs.stat(finalPath).then(s => `yes size=${s.size} mtime_ms=${Math.round(s.mtimeMs)}`).catch(e => `no (${e.code})`))
  console.log('  stamp path:', stampPath)
  console.log('  stamp:', await fs.readFile(stampPath, 'utf8').catch(e => `ERR ${e.code}`))
}

const source = await readVideoVisualSource(SLUG, CODE)
console.log('visual source:', JSON.stringify({ source: source.source, hasSidecar: !!source.sidecar, requiresBrollProof: videoVisualSourceRequiresBrollProof(source) }))

const status = await computeEpisodeStatus(SLUG, CODE)
console.log('status:', JSON.stringify({
  video_assembly: status.video_assembly,
  video: status.video,
  video_ready: status.video_ready,
  final_video_bytes: status.final_video_bytes,
  all_done: status.all_done,
  publishable: status.publishable,
}))
