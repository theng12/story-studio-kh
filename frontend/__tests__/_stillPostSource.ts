/**
 * The Still Posts page is a shell plus one component per step, and the workspace state lives in a
 * composable. Source-level checks read all of them, so a rule that moved to a step is still asserted.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function stillPostSource(): string {
  const page = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/still-posts.vue', import.meta.url)),
    'utf8',
  )
  const stepsDir = fileURLToPath(new URL('../components/still-posts/', import.meta.url))
  const steps = readdirSync(stepsDir)
    .filter(name => name.endsWith('.vue'))
    .sort()
    .map(name => readFileSync(`${stepsDir}${name}`, 'utf8'))
  const composable = readFileSync(
    fileURLToPath(new URL('../composables/useStillPostsWorkspace.ts', import.meta.url)),
    'utf8',
  )
  return [page, ...steps, composable].join('\n')
}
