/**
 * Shared test-isolation guard for the per-machine JSON/file stores.
 *
 * The bug this exists to catch (fixed once in `services/app-settings.ts`, then
 * again in `services/named-roots.ts` and `services/last-session.ts`, then again
 * — a softer variant that memoises on first CALL rather than at module load —
 * in `services/preview-cache.ts` and `services/logger.ts`):
 * a store resolved its target path once and cached it, whether at module-load
 * time (a module-scope `const`) or on first access (a lazily-set module-scope
 * variable). `STORY_STUDIO_DATA_DIR` is what redirects these stores into an
 * isolated directory, and a test only sets it inside `before()` /
 * `useTempDataDir()`. Any code path that resolved the target before that —
 * whether via a static import chain or an incidental first call — froze the
 * path to the developer's REAL file/directory and read/wrote it for the rest
 * of the process (or, for the softer variant, until the cache happened to be
 * cleared).
 *
 * The structural fix is to resolve the path lazily, per access, with no
 * caching at all. This guard is the belt-and-braces half: under the node test
 * runner, a write whose RESOLVED TARGET falls outside the currently-claimed
 * data dir is a hard error instead of a silent write to the developer's real
 * state. It compares the target, not just the presence of the env var, so a
 * stale frozen path is caught too — not only the simpler "never claimed a temp
 * dir at all" case.
 *
 * `target` may be the exact file being written OR a directory the caller is
 * about to write into (e.g. `mkdirSync`, or a directory whose contents are
 * about to be pruned) — either is checked the same way: it must resolve to the
 * claimed data dir itself, or to something nested under it at any depth (a
 * store may keep its file directly in the data dir, or in a named
 * subdirectory like `logs/` or `preview-cache/`).
 *
 * No effect outside tests: the app itself legitimately writes the real files.
 */

import path from 'path'

/**
 * @param target resolved absolute path (file or directory) the caller is
 *   about to write
 * @param store  short store name, used in the error message (e.g. 'app-settings')
 */
export function assertWriteIsolatedInTests(target: string, store: string): void {
  // node:test sets NODE_TEST_CONTEXT in every test child process.
  if (!process.env.NODE_TEST_CONTEXT) return
  const dataDir = process.env.STORY_STUDIO_DATA_DIR
  if (dataDir) {
    const resolvedDataDir = path.resolve(dataDir)
    const resolvedTarget = path.resolve(target)
    const rel = path.relative(resolvedDataDir, resolvedTarget)
    // '' = target IS the data dir; otherwise it must be a nested descendant
    // (a relative path that doesn't escape upward via '..').
    if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) return
  }
  throw new Error(
    `${store} isolation violation: a test tried to write ${target}, which is not inside the `
    + `claimed data dir (STORY_STUDIO_DATA_DIR=${dataDir ?? '<unset>'}). `
    + 'Call useTempDataDir() before anything that writes this store. If a static import of the '
    + 'module runs first, import the module under test dynamically instead.',
  )
}
