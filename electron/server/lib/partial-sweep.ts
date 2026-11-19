/**
 * Unfinished files left by a process that no longer exists.
 *
 * An image is staged as `<name>.partial-<pid>-<stamp>` and renamed into place when it commits. A
 * process killed before the rename strands a complete image under the staging name, and every later
 * boot inherits it (angkor 2026-11-19: EP0028 held 20, EP0026 69). A partial belonging to a live pid
 * is in flight and is never touched.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** `<name>.partial-12345`, `<name>.partial-12345-1795085965191` — and the trailing `.wav` variant. */
const STAGED_NAME = /\.partial-(\d+)(?:-\d+)?(?:\.\w+)?$/

/** A pid this process cannot signal does not exist; EPERM means it exists and is someone else's. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export async function sweepDeadPartials(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
): Promise<{ removed: number; kept: number }> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return { removed: 0, kept: 0 }
  }
  let removed = 0
  let kept = 0
  for (const name of names) {
    const match = STAGED_NAME.exec(name)
    if (!match) continue
    if (isAlive(Number(match[1]))) { kept += 1; continue }
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
    removed += 1
  }
  return { removed, kept }
}
