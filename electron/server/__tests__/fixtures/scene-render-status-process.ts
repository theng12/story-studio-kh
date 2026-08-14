import fs from 'node:fs/promises'
import os from 'node:os'

const [mode, ...args] = process.argv.slice(2)

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitForFile(filePath: string): Promise<void> {
  while (true) {
    if (await fs.access(filePath).then(() => true, () => false)) return
    await sleep(10)
  }
}

if (mode === 'cleanup') {
  const [projectSlug, episodeId, jobId, readyFile, releaseFile] = args
  const { deactivateSceneRenderStatus, RENDER_STATUS_FILENAME } = await import('../../services/scene-render-status.js')
  const realReadFile = fs.readFile.bind(fs)
  let held = false
  ;(fs as any).readFile = async (file: any, ...readArgs: any[]) => {
    if (!held && String(file).endsWith(RENDER_STATUS_FILENAME)) {
      held = true
      await fs.writeFile(readyFile, 'old-read')
      await waitForFile(releaseFile)
    }
    return realReadFile(file, ...readArgs as [])
  }
  await deactivateSceneRenderStatus(projectSlug, episodeId, jobId)
  process.exitCode = 0
} else if (mode === 'write') {
  const [statusPath, startedFile, doneFile] = args
  const { writeSceneRenderStatus } = await import('../../services/scene-render-status.js')
  await fs.writeFile(startedFile, 'started')
  await writeSceneRenderStatus(statusPath, { active: true, job_id: 'new-render-batch', in_flight: [3] })
  await fs.writeFile(doneFile, 'done')
  process.exitCode = 0
} else if (mode === 'live-stale-lock') {
  const [lockPath, readyFile, releaseFile] = args
  await fs.writeFile(lockPath, JSON.stringify({
    created_at_ms: Date.now() - 31_000,
    hostname: os.hostname(),
    pid: process.pid,
    token: 'live-owner',
  }))
  await fs.writeFile(readyFile, 'ready')
  await waitForFile(releaseFile)
  await fs.unlink(lockPath).catch(() => {})
  process.exitCode = 0
} else {
  throw new Error(`Unknown scene render status worker mode: ${mode}`)
}
