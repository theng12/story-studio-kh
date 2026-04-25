#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — pre-build script that produces the universal
 * ffmpeg + ffprobe binaries we ship inside the .app bundle.
 *
 * Why this exists:
 *   evermeet.cx (our long-time download source) only serves Intel x86_64
 *   builds. On Apple Silicon Macs without Rosetta 2, spawning the Intel
 *   binary fails with `spawn Unknown system error -86` (EBADARCH). Instead
 *   of asking users to install Rosetta or hunt down a compatible build,
 *   we fuse the Intel + arm64 binaries into a single `lipo` universal2
 *   executable that runs natively on either architecture. Bundling that
 *   inside the .dmg means the app works offline on first launch — no
 *   download, no Gatekeeper round-trip, no Rosetta dependency.
 *
 * Sources (verified at write time):
 *   - Intel x86_64: evermeet.cx (https://evermeet.cx/ffmpeg/) — used by
 *     many established Mac apps; one-person operation but has shipped
 *     reliably for 10+ years.
 *   - arm64:        osxexperts.net — the ffmpeg.org-recommended source
 *     for Apple Silicon static builds.
 *
 * Output:
 *   bundled/ffmpeg/ffmpeg     (universal2, chmod 755)
 *   bundled/ffmpeg/ffprobe    (universal2, chmod 755)
 *   bundled/ffmpeg/MANIFEST.json  (records source URLs + sizes for
 *                                  license/audit traceability)
 *
 * NB: this directory is OUTSIDE `build/` because electron-builder treats
 * `build/` as `directories.buildResources` and silently excludes its
 * contents from the .app via a "!build{,/ ** / *}" files pattern (spaces
 * added here because a literal asterisk-slash inside this comment would
 * close the block). Putting the binaries in a sibling `bundled/` dir lets
 * `extraResources` actually copy them into Contents/Resources/.
 *
 * Run manually for testing:
 *   node scripts/fetch-ffmpeg.mjs
 *
 * Run automatically: hooked from package.json's `prebuild:ffmpeg` script,
 * which the `build` script invokes before the Nuxt + tsc compile.
 */

import { mkdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
// `bundled/` lives next to (not inside) `build/` because electron-builder
// excludes `build/` from packaged output — see fetch script header.
const OUT_DIR = path.join(REPO_ROOT, 'bundled', 'ffmpeg')
const TMP_DIR = path.join(REPO_ROOT, 'bundled', 'ffmpeg-tmp')

// Pinned version + URLs. Bump these together when a new ffmpeg version is
// available on BOTH sources — mismatched arch versions are technically OK
// (lipo doesn't care) but keep them aligned so behaviour is consistent
// across slices.
const FFMPEG_VERSION = '8.1'
const SOURCES = {
  arm64: {
    ffmpeg:  `https://www.osxexperts.net/ffmpeg${FFMPEG_VERSION.replace('.', '')}arm.zip`,
    ffprobe: `https://www.osxexperts.net/ffprobe${FFMPEG_VERSION.replace('.', '')}arm.zip`,
  },
  intel: {
    ffmpeg:  `https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip`,
    ffprobe: `https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip`,
  },
}

// Pinned SHA-256 of each upstream zip, captured on 2026-04-24 from the URLs
// above. Both upstream sources (evermeet.cx, osxexperts.net) are one-person
// operations — a hostile or compromised upstream could serve a trojaned
// binary on next build. Verifying against a pinned hash turns any change in
// upstream content into a loud build failure rather than a silent supply-
// chain compromise.
//
// When bumping FFMPEG_VERSION above, also bump these hashes. The correct
// procedure is: bump the version, run the script once, observe the
// "hash mismatch" error, verify the new hashes independently (e.g. by
// downloading manually and cross-checking from a different network), and
// only then paste the new values here.
const EXPECTED_SHA256 = {
  arm64: {
    ffmpeg:  'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
    ffprobe: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
  },
  intel: {
    ffmpeg:  'd67db25908eff64b7d0eaa73784f0c55728d9e036a96931095fcf8e8968eefab',
    ffprobe: 'b6e9bf4f4ab2992dace205498d99d9e2ede684e3e8ae89485cadd3b91711ea04',
  },
}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function verifyZipHash(label, zipPath, expected) {
  const got = await sha256OfFile(zipPath)
  if (got !== expected) {
    throw new Error(
      `${label}: hash mismatch.\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${got}\n` +
      `Either upstream silently changed the artifact at this URL ` +
      `(supply-chain risk), or the expected hash in fetch-ffmpeg.mjs is ` +
      `stale. Verify the new content independently before updating the ` +
      `pinned hash.`,
    )
  }
  return got
}

// ── Helpers ─────────────────────────────────────────────────────────────

function log(msg) { console.log(`[fetch-ffmpeg] ${msg}`) }

async function download(url, savePath) {
  log(`  download ${url}`)
  const resp = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
    headers: { 'User-Agent': 'story-studio-build/1.0' },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`)
  if (!resp.body) throw new Error(`No body for ${url}`)
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(savePath))
  const s = await stat(savePath)
  log(`  saved ${path.basename(savePath)} (${(s.size / 1024 / 1024).toFixed(1)} MB)`)
  return s.size
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe', ...opts })
    let stdout = '', stderr = ''
    proc.stdout?.on('data', d => { stdout += d.toString() })
    proc.stderr?.on('data', d => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

async function unzipTo(zipPath, destDir) {
  await mkdir(destDir, { recursive: true })
  // -o: overwrite, -q: quiet, -j: junk paths (flatten — evermeet/osxexperts
  //  zips have the binary at the root anyway, but -j is defensive).
  await run('unzip', ['-oqj', zipPath, '-d', destDir])
}

async function findExtractedBinary(dir, expectedName) {
  // Both sources put `ffmpeg` (or `ffprobe`) at the zip root with no
  // extension. After `unzip -j`, the file lands directly in `dir`.
  const candidate = path.join(dir, expectedName)
  if (existsSync(candidate)) return candidate
  throw new Error(`expected binary ${expectedName} not found in ${dir}`)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  log(`platform=${process.platform} arch=${process.arch} target=universal2 ffmpeg=${FFMPEG_VERSION}`)

  if (process.platform !== 'darwin') {
    // lipo is macOS-only. Bundling for win/linux is a separate build path
    // (different sources, no fat binary needed) — not implemented yet
    // (Session 05 P3). No-op here so CI dry-runs on Win/Linux can complete
    // and surface any other packaging regressions; the resulting artifact
    // won't have a working bundled ffmpeg, which is fine for a dry-run.
    console.warn(`[fetch-ffmpeg] platform=${process.platform} not supported; skipping (macOS-only).`)
    return
  }

  await rm(TMP_DIR, { recursive: true, force: true })
  await mkdir(TMP_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  const manifest = {
    generated_at: new Date().toISOString(),
    ffmpeg_version: FFMPEG_VERSION,
    sources: SOURCES,
    sizes: /** @type {Record<string, number>} */ ({}),
    sha256: /** @type {Record<string, string>} */ ({}),
    binaries: /** @type {Record<string, string>} */ ({}),
  }

  for (const tool of /** @type {const} */ (['ffmpeg', 'ffprobe'])) {
    log(`--- ${tool} ---`)

    // 1. Download both arches
    const armZip   = path.join(TMP_DIR, `${tool}-arm.zip`)
    const intelZip = path.join(TMP_DIR, `${tool}-intel.zip`)
    manifest.sizes[`${tool}_arm_zip`]   = await download(SOURCES.arm64[tool], armZip)
    manifest.sizes[`${tool}_intel_zip`] = await download(SOURCES.intel[tool], intelZip)

    // 1b. Verify against pinned hashes BEFORE touching the bytes further.
    //     A mismatch here means upstream changed — fail loudly rather than
    //     lipo-fuse a possibly-trojaned binary into the shipped .app.
    manifest.sha256[`${tool}_arm_zip`]   = await verifyZipHash(`${tool} arm64 zip`,   armZip,   EXPECTED_SHA256.arm64[tool])
    manifest.sha256[`${tool}_intel_zip`] = await verifyZipHash(`${tool} intel zip`, intelZip, EXPECTED_SHA256.intel[tool])
    log(`  hash ok: arm=${manifest.sha256[`${tool}_arm_zip`].slice(0,12)}… intel=${manifest.sha256[`${tool}_intel_zip`].slice(0,12)}…`)

    // 2. Extract each into its own subdir so they don't overwrite each other
    const armDir   = path.join(TMP_DIR, `${tool}-arm`)
    const intelDir = path.join(TMP_DIR, `${tool}-intel`)
    await unzipTo(armZip, armDir)
    await unzipTo(intelZip, intelDir)
    const armBin   = await findExtractedBinary(armDir, tool)
    const intelBin = await findExtractedBinary(intelDir, tool)

    // 3. Sanity-check each slice is the expected arch BEFORE fusing —
    //    catches the case where a source silently changed what it serves.
    const { stdout: armInfo }   = await run('lipo', ['-info', armBin])
    const { stdout: intelInfo } = await run('lipo', ['-info', intelBin])
    if (!/arm64/.test(armInfo))   throw new Error(`arm slice is not arm64: ${armInfo.trim()}`)
    if (!/x86_64/.test(intelInfo)) throw new Error(`intel slice is not x86_64: ${intelInfo.trim()}`)

    // 4. Fuse with lipo. -create produces a fat (universal) Mach-O.
    const outBin = path.join(OUT_DIR, tool)
    await run('lipo', ['-create', armBin, intelBin, '-output', outBin])
    await chmod(outBin, 0o755)

    // 5. Verify the result is what we expected.
    const { stdout: outInfo } = await run('lipo', ['-info', outBin])
    log(`  → ${outBin}`)
    log(`    ${outInfo.trim()}`)
    if (!/arm64/.test(outInfo) || !/x86_64/.test(outInfo)) {
      throw new Error(`lipo produced an incomplete fat binary: ${outInfo.trim()}`)
    }

    const finalStat = await stat(outBin)
    manifest.sizes[`${tool}_universal`] = finalStat.size
    manifest.binaries[tool] = path.relative(REPO_ROOT, outBin)
  }

  // 6. Write the manifest. Useful for license text + reproducibility +
  //    future "what version is bundled?" debugging.
  await writeFile(path.join(OUT_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

  // 7. Clean up extraction tmp.
  await rm(TMP_DIR, { recursive: true, force: true })

  log('done.')
}

main().catch(err => {
  console.error('[fetch-ffmpeg] FAILED:', err.message)
  process.exit(1)
})
