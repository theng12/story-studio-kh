/**
 * The shipped 1.4.383 baseline, read from its pinned git object.
 *
 * These tests used to reach into a sibling `release-383` worktree. That made
 * the baseline disappear with the worktree, and a missing baseline skipped the
 * test instead of failing it. The commit below is the exact shipped 1.4.383,
 * so the checkout's own object database is enough — no sibling tree, no skip.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const RELEASE_383_COMMIT = '1883af817be4133bccdbe665e6529ea8ed314665'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The pinned file as shipped in 1.4.383. Missing object = loud failure, never a skip. */
export function release383Source(relativePath: string): string {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', `${RELEASE_383_COMMIT}:${relativePath}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      `release 1.4.383 baseline is unavailable: git object ${RELEASE_383_COMMIT}:${relativePath} in ${REPO_ROOT}. `
      + 'The baseline is pinned by commit and must be present — it is not optional.',
      { cause: error },
    )
  }
}

/**
 * Load the ACTUAL 1.4.383 audio-merge generator, running against this
 * checkout's current dependencies.
 *
 * Only the one pinned file is old. Its relative imports are rewritten to
 * absolute file URLs into this checkout, so every service/lib/model it uses is
 * the current source — the comparison pins this generator's own behaviour, not
 * a copy of its dependencies. The generated module lives under `.test-work/`
 * (gitignored, isolated) and is retained there for inspection; its imports
 * point at this checkout, never at the generated module's directory.
 */
export async function loadRelease383AudioMerge(): Promise<{
  generateAudioMerge: (job: any) => Promise<unknown>
}> {
  const source = release383Source('electron/server/generators/audio-merge.ts')
  const serverRoot = path.join(REPO_ROOT, 'electron', 'server')
  const workRoot = path.join(REPO_ROOT, '.test-work')
  await fs.mkdir(workRoot, { recursive: true })
  const dir = await fs.mkdtemp(path.join(workRoot, 'release-383-audio-'))
  const outfile = path.join(dir, 'audio-merge.383.mjs')

  // The pinned generator imports `mergedAudioMasterPath` from level-audio. 1.4.408 removed that symbol
  // with the MP3-only change (76af7d4a0), and this harness resolves the old file's relative imports
  // against the current checkout — so the baseline stopped loading with "does not provide an export
  // named 'mergedAudioMasterPath'". The shim restores that one pure function, reproduced exactly from
  // 1883af817:electron/server/lib/level-audio.ts, and re-exports everything else from the real module:
  // the old generator runs as it was written, and the current tree still supplies all its other helpers.
  const levelAudioAbs = path.join(serverRoot, 'lib', 'level-audio.ts')
  const shimPath = path.join(dir, 'level-audio.383-shim.ts')
  await fs.writeFile(shimPath, [
    "export * from '@current-level-audio'",
    'export function mergedAudioMasterPath(mp3: string): string {',
    '  return mp3.replace(/\\.mp3$/i, "") + ".master.flac"',
    '}',
    '',
  ].join('\n'))
  await build({
    stdin: {
      contents: source,
      resolveDir: path.join(serverRoot, 'generators'),
      sourcefile: 'audio-merge.383.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    plugins: [{
      name: 'current-shared-dependencies',
      setup(build) {
        // Every relative import in the pinned file resolves against this
        // checkout's generators dir and stays external, so the current
        // .ts source loads through the same tsx hook the suite already uses.
        // A file:// specifier is not something esbuild resolves; the shim asks for the real module by
        // a name only this plugin knows, and it is emitted as an external URL like every other import.
        build.onResolve({ filter: /^@current-level-audio$/ }, () => ({
          path: pathToFileURL(levelAudioAbs).href,
          external: true,
        }))
        build.onResolve({ filter: /^\.\.?\// }, args => {
          const resolved = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
          if (resolved === levelAudioAbs) return { path: shimPath }
          return { path: pathToFileURL(resolved).href, external: true }
        })
      },
    }],
  })
  // Retained under gitignored .test-work for inspection; finished fixtures are not deleted.
  return await import(pathToFileURL(outfile).href) as {
    generateAudioMerge: (job: any) => Promise<unknown>
  }
}
