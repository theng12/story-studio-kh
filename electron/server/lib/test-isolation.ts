/**
 * Shared test-isolation guard for the per-machine JSON stores.
 *
 * The bug this exists to catch (fixed once in `services/app-settings.ts`, then
 * again in `services/named-roots.ts` and `services/last-session.ts`):
 * a store resolved its file path ONCE into a module-scope `const`.
 * `STORY_STUDIO_DATA_DIR` is what redirects these stores into an isolated
 * directory, and a test only sets it inside `before()` / `useTempDataDir()` —
 * which runs AFTER every static import in the file has been evaluated. Any test
 * file whose static import chain reached such a module therefore froze the path
 * to the developer's REAL file and read/wrote it for the rest of the process.
 *
 * The structural fix is to resolve the path lazily, per access. This guard is
 * the belt-and-braces half: under the node test runner, a write whose RESOLVED
 * TARGET falls outside the currently-claimed data dir is a hard error instead of
 * a silent write to the developer's real state. It compares the target, not just
 * the presence of the env var, so a stale frozen path is caught too — not only
 * the simpler "never claimed a temp dir at all" case.
 *
 * No effect outside tests: the app itself legitimately writes the real files.
 */

import path from 'path'

/**
 * @param target resolved absolute path the caller is about to write
 * @param store  short store name, used in the error message (e.g. 'app-settings')
 */
export function assertWriteIsolatedInTests(target: string, store: string): void {
  // node:test sets NODE_TEST_CONTEXT in every test child process.
  if (!process.env.NODE_TEST_CONTEXT) return
  const dataDir = process.env.STORY_STUDIO_DATA_DIR
  if (dataDir && path.resolve(path.dirname(target)) === path.resolve(dataDir)) return
  throw new Error(
    `${store} isolation violation: a test tried to write ${target}, which is not inside the `
    + `claimed data dir (STORY_STUDIO_DATA_DIR=${dataDir ?? '<unset>'}). `
    + 'Call useTempDataDir() before anything that writes this store. If a static import of the '
    + 'module runs first, import the module under test dynamically instead.',
  )
}
